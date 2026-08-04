from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import (
    PRIORITY_RULE_VERSION,
    ROUND_KEYWORD_LIMIT,
    KeywordClassification,
    MergedCandidate,
    RawKeyword,
    SeedCandidate,
    TopicDuplicatePair,
    TopicSelectionResolution,
    build_equal_volume_variant_pairs,
    build_initial_library_topics,
    build_topic_duplicate_pairs,
    build_topic_seed_decisions,
    business_dictionaries,
    business_match_score,
    classify_candidate,
    display_keyword,
    infer_business_model,
    merge_and_limit_candidates,
    normalize_keyword,
    prepare_seed_candidates,
    priority_score,
    resolve_bounded_topic_seed_selection,
    strong_seed_business_evidence,
    validate_keyword_classifications,
    validate_initial_library_filter,
    volume_percentiles,
)
from seo_workers.keywords.providers import (
    CHARGED_FAILURE,
    RETRYABLE_FAILURE,
    UNCERTAIN_FAILURE,
    CompetitorGap,
    DataForSEOClient,
    JsonHttpClient,
    OpenAICompatibleClient,
    ProviderError,
)
from seo_workers.keywords.repository import (
    ExternalRequestRecord,
    KeywordRepository,
    KeywordRunContext,
)

SEED_CANDIDATE_LIMIT = 500
MIN_INITIAL_LIBRARY_KEYWORDS = 50
LABS_SITE_LIMIT = 500
FALLBACK_KEYWORD_IDEAS_LIMIT = 500
FALLBACK_QUERY_SEED_LIMIT = 20
KEYWORD_IDEAS_BROAD_LIMIT = 400
KEYWORD_IDEAS_CLOSE_LIMIT = 300
LEGACY_EXPANSION_SEED_LIMIT = 20
DISCOVERY_SOURCES = (
    "labs_site",
    "google_ads_site",
    DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE,
    DataForSEOClient.KEYWORD_IDEAS_CLOSE_SOURCE,
)
KEYWORD_IDEAS_SOURCES = (
    "keyword_ideas",
    DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE,
    DataForSEOClient.KEYWORD_IDEAS_CLOSE_SOURCE,
)
GAP_LIMIT = 200
AI_CLASSIFICATION_BATCH = 100
AI_CLASSIFICATION_CONCURRENCY = 3
SEED_TOPIC_PROMPT_VERSION = "initial-library-general-filter-v20-single-request"
SEED_TOPIC_SELECTION_PROMPT_VERSION = "topic-duplicate-confirmation-v14-all-pairs"


class KeywordActivities:
    def __init__(
        self,
        repository: KeywordRepository,
        settings: KeywordWorkerSettings,
    ) -> None:
        self.repository = repository
        self.settings = settings

    @activity.defn(name="keyword_mark_started")
    async def mark_started(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        await self.repository.mark_started(context.run_id)
        return context_payload(await self.repository.load_context(task))

    @activity.defn(name="keyword_discover_seeds")
    async def discover_seeds(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "discovering_seeds"})
        await self.repository.set_stage(
            context.run_id,
            "discovering_seeds",
            "正在发现相关关键词",
            8,
        )
        labs_rows = await self.repository.request_ideas(context.run_id, "labs_site")
        try:
            if not labs_rows:
                labs_rows = await self._labs_site_request(context)
        except ApplicationError as exc:
            labs_rows = []
            await self.repository.record_partial_failure(
                context.run_id,
                source="labs_site",
                code=application_error_code(exc),
                message=str(exc),
            )
        if labs_rows:
            return {
                "source": "labs_site",
                "count": len(labs_rows),
                "fallback": False,
            }

        ads_rows = await self.repository.request_ideas(
            context.run_id,
            "google_ads_site",
        )
        if not ads_rows:
            ads_rows = await self._google_ads_site_request(context)
        if not ads_rows:
            return {
                "source": "none",
                "count": 0,
                "fallback": True,
            }
        return {
            "source": "google_ads_site",
            "count": len(ads_rows),
            "fallback": True,
        }

    @activity.defn(name="keyword_acquire_business_profile")
    async def acquire_business_profile(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "acquiring_business_profile"})
        if context.profile:
            return {
                "source": context.profile_source,
                "version": context.profile_version,
                "reused": True,
            }

        await self.repository.set_stage(
            context.run_id,
            "waiting_for_business_profile",
            "正在识别网站业务",
            12,
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(self.settings.keyword_profile_wait_seconds, 1)
        latest = await self.repository.poll_profile(context)
        while latest.profile is None and not latest.terminal and loop.time() < deadline:
            activity_heartbeat(
                {
                    "status": latest.status,
                    "message": latest.message,
                }
            )
            await asyncio.sleep(max(self.settings.keyword_profile_poll_seconds, 1))
            latest = await self.repository.poll_profile(context)

        if latest.profile is not None:
            profile = normalize_profile(latest.profile)
            await self.repository.save_profile_snapshot(
                context,
                profile,
                source=latest.source or "site_profile",
                version=latest.version,
            )
            return {
                "source": latest.source or "site_profile",
                "version": latest.version,
                "reused": False,
            }

        return await self._fallback_business_profile(
            context,
            page_hints=latest.page_hints,
        )

    @activity.defn(name="keyword_prepare_seeds")
    async def prepare_seeds(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "preparing_seeds"})
        existing = await self.repository.load_selected_topics(context.run_id)
        if existing:
            return {
                "selected_topic_count": len(existing),
                "reused": True,
            }
        await self.repository.set_stage(
            context.run_id,
            "selecting_seeds",
            "正在分析业务关键词",
            28,
        )
        ideas = await self.repository.load_ideas(
            context.run_id,
            list(DISCOVERY_SOURCES),
        )
        candidates: list[SeedCandidate] = []
        excluded: dict[str, str] = {}
        if ideas:
            candidates, excluded = prepare_seed_candidates(
                ideas,
                context.profile,
                context.language,
                limit=SEED_CANDIDATE_LIMIT,
                domain=context.domain,
            )
        google_ads_supplemented = False
        current_sources = {idea.source for idea in ideas}
        if not candidates and "google_ads_site" not in current_sources:
            try:
                ads_rows = await self._google_ads_site_request(context)
            except ApplicationError as exc:
                ads_rows = []
                await self.repository.record_partial_failure(
                    context.run_id,
                    source="seed_discovery_supplement",
                    code=application_error_code(exc),
                    message=str(exc),
                )
            current_sources.add("google_ads_site")
            if ads_rows:
                google_ads_supplemented = True
                ideas = await self.repository.load_ideas(
                    context.run_id,
                    list(DISCOVERY_SOURCES),
                )
                candidates, excluded = prepare_seed_candidates(
                    ideas,
                    context.profile,
                    context.language,
                    limit=SEED_CANDIDATE_LIMIT,
                    domain=context.domain,
                )
        fallback_keyword_ideas_used = False
        should_supplement_keyword_ideas = (
            not candidates
            and DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE not in current_sources
        )
        if should_supplement_keyword_ideas:
            query_seeds = fallback_query_seeds(
                context.profile,
                context.domain,
                limit=FALLBACK_QUERY_SEED_LIMIT,
            )
            if query_seeds:
                source = DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE
                try:
                    fallback_rows, _ = await self._keyword_ideas_request(
                        context,
                        keywords=query_seeds,
                        closely_variants=False,
                        limit=FALLBACK_KEYWORD_IDEAS_LIMIT,
                        request_scope="discovery-fallback",
                    )
                except ApplicationError as exc:
                    fallback_rows = []
                    await self.repository.record_partial_failure(
                        context.run_id,
                        source=f"keyword_discovery_fallback:{source}",
                        code=application_error_code(exc),
                        message=str(exc),
                    )
                current_sources.add(source)
                if fallback_rows:
                    fallback_keyword_ideas_used = True
                if fallback_keyword_ideas_used:
                    ideas = await self.repository.load_ideas(
                        context.run_id,
                        list(DISCOVERY_SOURCES),
                    )
                    candidates, excluded = prepare_seed_candidates(
                        ideas,
                        context.profile,
                        context.language,
                        limit=SEED_CANDIDATE_LIMIT,
                        domain=context.domain,
                    )
        competitor_supplemented = False
        competitor_status = "not_requested"
        if context.competitor_domain:
            gap_fetch = await self.fetch_competitor_gap(task)
            competitor_status = str(gap_fetch.get("status") or "failed")
            if competitor_status == "pending":
                gap_validation = await self.validate_competitor(task)
                competitor_status = str(gap_validation.get("status") or "failed")
            if competitor_status == "confirmed":
                gap_rows = await self.repository.load_confirmed_gap_keywords(context.run_id)
                if gap_rows:
                    competitor_supplemented = True
                    ideas = [*ideas, *gap_rows]
                    candidates, excluded = prepare_seed_candidates(
                        ideas,
                        context.profile,
                        context.language,
                        limit=SEED_CANDIDATE_LIMIT,
                        domain=context.domain,
                    )
        if not candidates:
            raise ApplicationError(
                "所有网站关键词来源完成后仍没有可用候选词",
                type="seed_candidates_empty",
            )

        config = await require_ai_config(
            self.repository,
            context.organization_id,
        )
        http = JsonHttpClient(
            timeout_seconds=config.timeout_seconds,
            max_retries=config.max_retries,
        )
        try:
            client = OpenAICompatibleClient(http, config)
            request_scope = "primary"
            all_topic_reused = True
            all_selection_reused = True
            decisions = []
            reviewed_decisions = {}
            while True:
                (
                    topics,
                    assessments,
                    resolution,
                    deterministic_pairs,
                    review_pairs,
                    topic_reused,
                    selection_reused,
                ) = await self._review_seed_candidates(
                    context,
                    candidates,
                    client,
                    request_scope=request_scope,
                )
                all_topic_reused = all_topic_reused and topic_reused
                all_selection_reused = all_selection_reused and selection_reused
                decisions = (
                    build_topic_seed_decisions(
                        candidates,
                        topics,
                        resolution,
                        assessments,
                    )
                    if resolution is not None
                    else []
                )
                reviewed_decisions.update(
                    {
                        decision.candidate.normalized_keyword: decision
                        for decision in decisions
                    }
                )
                usable_seed_count = sum(decision.selected for decision in decisions)
                if usable_seed_count >= MIN_INITIAL_LIBRARY_KEYWORDS:
                    break

                supplemental_rows: list[RawKeyword] = []
                supplemental_scope = ""
                while not supplemental_rows:
                    if "google_ads_site" not in current_sources:
                        current_sources.add("google_ads_site")
                        supplemental_scope = "after-google-ads"
                        try:
                            supplemental_rows = await self._google_ads_site_request(
                                context
                            )
                        except ApplicationError as exc:
                            await self.repository.record_partial_failure(
                                context.run_id,
                                source="seed_count_supplement:google_ads_site",
                                code=application_error_code(exc),
                                message=str(exc),
                            )
                        if supplemental_rows:
                            google_ads_supplemented = True
                        continue

                    ideas_source = DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE
                    if ideas_source not in current_sources:
                        current_sources.add(ideas_source)
                        supplemental_scope = "after-keyword-ideas"
                        query_seeds = fallback_query_seeds(
                            context.profile,
                            context.domain,
                            limit=FALLBACK_QUERY_SEED_LIMIT,
                        )
                        if query_seeds:
                            try:
                                supplemental_rows, _ = await self._keyword_ideas_request(
                                    context,
                                    keywords=query_seeds,
                                    closely_variants=False,
                                    limit=FALLBACK_KEYWORD_IDEAS_LIMIT,
                                    request_scope="low-final-count",
                                )
                            except ApplicationError as exc:
                                await self.repository.record_partial_failure(
                                    context.run_id,
                                    source=f"seed_count_supplement:{ideas_source}",
                                    code=application_error_code(exc),
                                    message=str(exc),
                                )
                        if supplemental_rows:
                            fallback_keyword_ideas_used = True
                        continue
                    break

                if not supplemental_rows:
                    break

                retained_candidates = [
                    decision.candidate for decision in decisions if decision.selected
                ]
                retained_normalized = {
                    candidate.normalized_keyword for candidate in retained_candidates
                }
                new_candidates, new_excluded = prepare_seed_candidates(
                    [
                        row
                        for row in supplemental_rows
                        if normalize_keyword(row.keyword) not in retained_normalized
                    ],
                    context.profile,
                    context.language,
                    limit=max(
                        SEED_CANDIDATE_LIMIT - len(retained_candidates),
                        0,
                    ),
                    domain=context.domain,
                )
                excluded.update(new_excluded)
                if not new_candidates:
                    continue
                candidates = [
                    replace(candidate, rank=index)
                    for index, candidate in enumerate(
                        [*retained_candidates, *new_candidates],
                        start=1,
                    )
                ]
                request_scope = supplemental_scope

            if not decisions or not any(decision.selected for decision in decisions):
                raise ApplicationError(
                    "所有关键词来源都没有找到与网站业务相关的候选词",
                    type="seed_candidates_empty",
                )
            decisions = list(reviewed_decisions.values())
        finally:
            await http.close()

        seeds = await self.repository.save_seed_decisions(
            context,
            decisions,
            excluded,
        )
        usable_seed_count = sum(decision.selected for decision in decisions)
        duplicate_topic_count = sum(
            len(group.drop_ids) for group in resolution.duplicate_groups
        )
        return {
            "business_model": infer_business_model(context.profile),
            "candidate_count": len(decisions),
            "topic_count": len(topics),
            "deterministic_duplicate_pair_count": len(deterministic_pairs),
            "possible_duplicate_pair_count": len(review_pairs),
            "duplicate_topic_count": duplicate_topic_count,
            "usable_seed_count": usable_seed_count,
            "selected_topic_count": len(seeds),
            "google_ads_supplemented": google_ads_supplemented,
            "fallback_keyword_ideas_used": fallback_keyword_ideas_used,
            "competitor_supplemented": competitor_supplemented,
            "competitor_status": competitor_status,
            "topic_reused": all_topic_reused,
            "selection_reused": all_selection_reused,
            "reused": all_topic_reused and all_selection_reused,
        }

    async def _review_seed_candidates(
        self,
        context: KeywordRunContext,
        candidates: list[SeedCandidate],
        client: OpenAICompatibleClient,
        *,
        request_scope: str,
    ) -> tuple[
        list[dict[str, Any]],
        dict[str, Any],
        TopicSelectionResolution | None,
        list[TopicDuplicatePair],
        list[TopicDuplicatePair],
        bool,
        bool,
    ]:
        topics, assessments, topic_reused = await self._select_seed_topics(
            context,
            candidates,
            client,
            request_scope=request_scope,
        )
        if not topics:
            return topics, assessments, None, [], [], topic_reused, True

        activity_heartbeat({"stage": "preparing_seeds", "topic_count": len(topics)})
        deterministic_pairs = build_equal_volume_variant_pairs(topics, context.language)
        deterministic_drop_ids = {pair.right_id for pair in deterministic_pairs}
        review_topics = [
            topic
            for topic in topics
            if str(topic["representative_id"]) not in deterministic_drop_ids
        ]
        review_pairs = build_topic_duplicate_pairs(review_topics, context.language)
        all_pairs = [*deterministic_pairs, *review_pairs]
        if review_pairs:
            resolution, selection_reused = await self._select_active_seed_topics(
                context,
                topics,
                all_pairs,
                review_pairs,
                [pair.pair_id for pair in deterministic_pairs],
                client,
            )
        else:
            topic_ids = [str(topic["representative_id"]) for topic in topics]
            resolution = resolve_bounded_topic_seed_selection(
                topic_ids,
                deterministic_pairs,
                {
                    "duplicate_pair_ids": [
                        pair.pair_id for pair in deterministic_pairs
                    ],
                    "ranked": topic_ids,
                },
                active_limit=len(topic_ids),
            )
            selection_reused = True
        activity_heartbeat(
            {
                "stage": "preparing_seeds",
                "ranked_topic_count": len(resolution.ranked_ids),
            }
        )
        return (
            topics,
            assessments,
            resolution,
            deterministic_pairs,
            review_pairs,
            topic_reused,
            selection_reused,
        )

    async def _select_seed_topics(
        self,
        context: KeywordRunContext,
        candidates: list[SeedCandidate],
        client: OpenAICompatibleClient,
        *,
        request_scope: str = "primary",
    ) -> tuple[list[dict[str, Any]], dict[str, Any], bool]:
        decisions, reused = await self._filter_seed_candidates(
            context,
            candidates,
            client,
            request_scope=request_scope,
        )
        assessments = validate_initial_library_filter(
            candidates,
            {"decisions": decisions},
            context.profile,
            context.language,
        )
        topics = build_initial_library_topics(candidates, assessments, context.profile)
        return topics, assessments, reused

    async def _filter_seed_candidates(
        self,
        context: KeywordRunContext,
        candidates: list[SeedCandidate],
        client: OpenAICompatibleClient,
        *,
        request_scope: str,
    ) -> tuple[list[str], bool]:
        request_payload = {
            "candidates": [
                {
                    "keyword": candidate.normalized_keyword,
                    "search_volume": candidate.raw.search_volume,
                }
                for candidate in candidates
            ],
            "profile_version": context.profile_version,
            "profile": context.profile,
            "country": context.country,
            "language": context.language,
            "model": client.config.effective_initial_filter_model,
            "provider_base_url": client.config.base_url,
            "prompt_version": SEED_TOPIC_PROMPT_VERSION,
            "request_scope": request_scope,
        }
        activity_heartbeat({"stage": "seed_topic_ai"})
        request_hash = stable_hash(request_payload)
        request_key = (
            f"keyword:{context.run_id}:ai:{SEED_TOPIC_PROMPT_VERSION}:"
            f"{request_scope}:{request_hash[:16]}"
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="ai",
            endpoint=f"chat/completions:{SEED_TOPIC_PROMPT_VERSION}",
            request_hash=request_hash,
        )
        cached_payload = request.response_metadata.get("payload")
        payload: dict[str, Any] | None = None
        usage: dict[str, Any] = {}
        model = client.config.effective_initial_filter_model
        cost_usd = 0.0
        try:
            if isinstance(cached_payload, dict):
                payload = cached_payload
                usage = request.response_metadata.get("usage")
                usage = usage if isinstance(usage, dict) else {}
                model = str(request.response_metadata.get("model") or "")
                cost_usd = 0.0
            else:
                if not request.should_execute:
                    raise external_request_error(request)
                await submit_external_request(self.repository, request)
                result = await client.filter_initial_library_candidates(
                    candidates=candidates,
                    profile=context.profile,
                    country=context.country,
                    language=context.language,
                )
                payload = result.payload
                usage = result.usage
                model = result.model
                cost_usd = result.cost_usd
            assessments = validate_initial_library_filter(
                candidates,
                payload,
                context.profile,
                context.language,
            )
            decisions = [assessment.category for assessment in assessments.values()]
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except (ProviderError, ValueError) as exc:
            code = exc.code if isinstance(exc, ProviderError) else "invalid_ai_seed_topics"
            ledger_error = ai_response_error(
                exc,
                code=code,
                cost_usd=cost_usd,
                metadata=ai_response_metadata(payload, usage, model),
            )
            await fail_external_request(
                self.repository,
                request,
                error=ledger_error,
                code=code,
            )
            if isinstance(exc, ProviderError) and should_retry_paid_request(exc):
                raise provider_application_error(exc) from exc
            decisions = [
                (
                    "keep"
                    if strong_seed_business_evidence(
                        candidate,
                        context.profile,
                        context.language,
                    )
                    else "remove_irrelevant"
                )
                for candidate in candidates
            ]
            await self.repository.record_partial_failure(
                context.run_id,
                source="seed_topic_ai",
                code=code,
                message=str(exc),
            )
            return decisions, False

        if isinstance(cached_payload, dict):
            return decisions, True
        await self.repository.complete_external_request(
            request.request_key,
            claim_token=required_claim_token(request),
            result_count=sum(assessment.approved for assessment in assessments.values()),
            metadata={
                "payload": payload,
                "usage": usage,
                "model": model,
                "prompt_version": SEED_TOPIC_PROMPT_VERSION,
                "business_model": infer_business_model(context.profile),
                "candidate_count": len(candidates),
            },
            cost_usd=cost_usd,
        )
        return decisions, False

    async def _select_active_seed_topics(
        self,
        context: KeywordRunContext,
        topics: list[dict[str, Any]],
        all_duplicate_pairs: list[TopicDuplicatePair],
        review_pairs: list[TopicDuplicatePair],
        preconfirmed_pair_ids: list[str],
        client: OpenAICompatibleClient,
    ) -> tuple[TopicSelectionResolution, bool]:
        request_payload = {
            "topics": topics,
            "review_pairs": [
                {
                    "pair_id": pair.pair_id,
                    "left_id": pair.left_id,
                    "right_id": pair.right_id,
                    "signals": list(pair.signals),
                }
                for pair in review_pairs
            ],
            "preconfirmed_pair_ids": preconfirmed_pair_ids,
            "profile_version": context.profile_version,
            "profile": context.profile,
            "country": context.country,
            "language": context.language,
            "model": client.config.effective_topic_dedup_model,
            "provider_base_url": client.config.base_url,
            "prompt_version": SEED_TOPIC_SELECTION_PROMPT_VERSION,
        }
        activity_heartbeat({"stage": "seed_selection_ai"})
        request_hash = stable_hash(request_payload)
        request_key = (
            f"keyword:{context.run_id}:ai:{SEED_TOPIC_SELECTION_PROMPT_VERSION}:"
            f"{request_hash[:16]}"
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="ai",
            endpoint=f"chat/completions:{SEED_TOPIC_SELECTION_PROMPT_VERSION}",
            request_hash=request_hash,
        )
        cached_payload = request.response_metadata.get("payload")
        payload: dict[str, Any] | None = None
        usage: dict[str, Any] = {}
        model = client.config.effective_topic_dedup_model
        cost_usd = 0.0
        try:
            if isinstance(cached_payload, dict):
                payload = cached_payload
                usage = request.response_metadata.get("usage")
                usage = usage if isinstance(usage, dict) else {}
                model = str(request.response_metadata.get("model") or "")
                cost_usd = 0.0
            else:
                if not request.should_execute:
                    raise external_request_error(request)
                await submit_external_request(self.repository, request)
                result = await client.select_active_topic_representatives(
                    topics=topics,
                    duplicate_pairs=review_pairs,
                    profile=context.profile,
                    country=context.country,
                    language=context.language,
                )
                payload = result.payload
                usage = result.usage
                model = result.model
                cost_usd = result.cost_usd
            topic_ids = [str(topic["representative_id"]) for topic in topics]
            resolution = resolve_bounded_topic_seed_selection(
                topic_ids,
                all_duplicate_pairs,
                {
                    "duplicate_pair_ids": [
                        *preconfirmed_pair_ids,
                        *(payload.get("duplicate_pair_ids") or []),
                    ],
                    "ranked": topic_ids,
                },
                active_limit=len(topic_ids),
            )
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except (ProviderError, ValueError) as exc:
            code = exc.code if isinstance(exc, ProviderError) else "invalid_ai_seed_selection"
            ledger_error = ai_response_error(
                exc,
                code=code,
                cost_usd=cost_usd,
                metadata=ai_response_metadata(payload, usage, model),
            )
            await fail_external_request(
                self.repository,
                request,
                error=ledger_error,
                code=code,
            )
            if isinstance(exc, ProviderError) and should_retry_paid_request(exc):
                raise provider_application_error(exc) from exc
            topic_ids = [str(topic["representative_id"]) for topic in topics]
            resolution = resolve_bounded_topic_seed_selection(
                topic_ids,
                all_duplicate_pairs,
                {
                    "duplicate_pair_ids": preconfirmed_pair_ids,
                    "ranked": topic_ids,
                },
                active_limit=len(topic_ids),
            )
            await self.repository.record_partial_failure(
                context.run_id,
                source="seed_selection_ai",
                code=code,
                message=str(exc),
            )
            return resolution, False

        if isinstance(cached_payload, dict):
            return resolution, True
        await self.repository.complete_external_request(
            request.request_key,
            claim_token=required_claim_token(request),
            result_count=len(resolution.ranked_ids),
            metadata={
                "payload": payload,
                "usage": usage,
                "model": model,
                "prompt_version": SEED_TOPIC_SELECTION_PROMPT_VERSION,
                "topic_count": len(topics),
                "deterministic_duplicate_pair_count": len(preconfirmed_pair_ids),
                "duplicate_pair_count": len(review_pairs),
                "business_model": infer_business_model(context.profile),
            },
            cost_usd=cost_usd,
        )
        return resolution, False

    @activity.defn(name="keyword_fetch_competitor_gap")
    async def fetch_competitor_gap(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "competitor_gap"})
        if not context.competitor_domain:
            await self.repository.set_gap_status(
                context,
                status="not_requested",
                message="未填写竞争对手",
                count=0,
            )
            return {"status": "not_requested", "count": 0}

        existing = await self.repository.load_gap_candidates(context.run_id)
        if existing:
            await self.repository.set_gap_status(
                context,
                status="pending",
                message="正在确认竞争关系",
                count=0,
            )
            return {"status": "pending", "count": len(existing), "reused": True}

        await self.repository.set_gap_status(
            context,
            status="running",
            message="正在分析竞争对手",
            count=0,
        )
        request_payload = {
            "target1": context.competitor_domain,
            "target2": context.domain,
            "intersections": False,
            "country": context.country,
            "language": context.language,
            "limit": GAP_LIMIT,
        }
        request_key = f"keyword:{context.run_id}:dataforseo:domain-intersection"
        config = await require_dataforseo_config(
            self.repository,
            context.organization_id,
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="dataforseo",
            endpoint=DataForSEOClient.DOMAIN_INTERSECTION_PATH,
            request_hash=stable_hash(request_payload),
        )
        if request.reusable:
            cached = await self.repository.load_gap_candidates(request.build_run_id)
            if cached:
                await self.repository.save_gap_candidates(context, cached)
                await self.repository.set_gap_status(
                    context,
                    status="pending",
                    message="正在确认竞争关系",
                    count=0,
                )
                return {"status": "pending", "count": len(cached), "reused": True}
            await self.repository.finalize_gap_candidates(
                context,
                accepted={},
                status="skipped_no_data",
                message="竞争对手没有可用的自然搜索差距数据",
            )
            return {"status": "skipped_no_data", "count": 0, "reused": True}
        if not request.should_execute:
            error = external_request_error(request)
            await self.repository.set_gap_status(
                context,
                status="failed",
                message="竞争对手分析暂时未完成",
                count=0,
            )
            await self.repository.record_partial_failure(
                context.run_id,
                source="competitor_gap",
                code=error.code,
                message=str(error),
            )
            return {"status": "failed", "count": 0, "error": str(error)}
        await submit_external_request(self.repository, request)

        http = JsonHttpClient(
            timeout_seconds=self.settings.keyword_http_timeout_seconds,
            max_retries=self.settings.keyword_http_max_retries,
        )
        try:
            rows, billing = await DataForSEOClient(config, http).domain_intersection(
                competitor_domain=context.competitor_domain,
                domain=context.domain,
                country=context.country,
                language=context.language,
                limit=GAP_LIMIT,
            )
            await persist_gap_response(
                self.repository,
                context,
                rows,
                request=request,
                metadata={
                    "path": billing.path,
                    "limit": GAP_LIMIT,
                },
                cost_usd=billing.cost_usd,
                expires_at=datetime.now(UTC) + timedelta(days=30),
            )
            if not rows:
                await self.repository.finalize_gap_candidates(
                    context,
                    accepted={},
                    status="skipped_no_data",
                    message="竞争对手没有可用的自然搜索差距数据",
                )
                return {"status": "skipped_no_data", "count": 0}
            await self.repository.set_gap_status(
                context,
                status="pending",
                message="正在确认竞争关系",
                count=0,
            )
            return {"status": "pending", "count": len(rows)}
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except ProviderError as exc:
            await fail_external_request(
                self.repository,
                request,
                error=exc,
            )
            await self.repository.set_gap_status(
                context,
                status="failed",
                message="竞争对手分析暂时未完成",
                count=0,
            )
            await self.repository.record_partial_failure(
                context.run_id,
                source="competitor_gap",
                code=exc.code,
                message=str(exc),
            )
            return {"status": "failed", "count": 0, "error": str(exc)}
        finally:
            await http.close()

    @activity.defn(name="keyword_validate_competitor")
    async def validate_competitor(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "competitor_validation"})
        if not context.competitor_domain:
            return {"status": "not_requested", "count": 0}
        rows = await self.repository.load_gap_candidates(context.run_id)
        if not rows:
            return {"status": "skipped_no_data", "count": 0}

        config = await require_ai_config(
            self.repository,
            context.organization_id,
        )
        request_payload = {
            "competitor_domain": context.competitor_domain,
            "profile": context.profile,
            "profile_version": context.profile_version,
            "gaps": [row.keyword for row in rows[:100]],
            "country": context.country,
            "language": context.language,
            "model": config.model,
            "provider_base_url": config.base_url,
            "prompt_version": "competitor-validation-v1",
        }
        request_key = f"keyword:{context.run_id}:ai:competitor-validation:v1"
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="ai",
            endpoint="chat/completions:competitor-validation-v1",
            request_hash=stable_hash(request_payload),
        )
        payload: dict[str, Any] | None = None
        usage: dict[str, Any] = {}
        model = config.model
        cost_usd = 0.0
        try:
            cached_payload = request.response_metadata.get("payload")
            if isinstance(cached_payload, dict):
                payload = cached_payload
                usage: dict[str, int] = {}
                model = ""
                cost_usd = 0.0
            else:
                if not request.should_execute:
                    raise external_request_error(request)
                await submit_external_request(self.repository, request)
                http = JsonHttpClient(
                    timeout_seconds=config.timeout_seconds,
                    max_retries=config.max_retries,
                )
                try:
                    result = await OpenAICompatibleClient(
                        http,
                        config,
                    ).validate_competitor(
                        competitor_domain=context.competitor_domain,
                        rows=rows,
                        profile=context.profile,
                        country=context.country,
                        language=context.language,
                    )
                finally:
                    await http.close()
                payload = result.payload
                usage = result.usage
                model = result.model
                cost_usd = result.cost_usd
            decision = validate_competitor_decision(payload, len(rows))
            if not isinstance(cached_payload, dict):
                await self.repository.complete_external_request(
                    request.request_key,
                    claim_token=required_claim_token(request),
                    result_count=len(decision["relevant_indices"]),
                    metadata={
                        "payload": payload,
                        "usage": usage,
                        "model": model,
                        "prompt_version": "competitor-validation-v1",
                    },
                    cost_usd=cost_usd,
                )
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except (ProviderError, ValueError) as exc:
            code = exc.code if isinstance(exc, ProviderError) else "invalid_competitor_validation"
            ledger_error = ai_response_error(
                exc,
                code=code,
                cost_usd=cost_usd,
                metadata=ai_response_metadata(payload, usage, model),
            )
            await fail_external_request(
                self.repository,
                request,
                error=ledger_error,
                code=code,
            )
            await self.repository.set_gap_status(
                context,
                status="failed",
                message="竞争关系暂时无法确认",
                count=0,
            )
            await self.repository.record_partial_failure(
                context.run_id,
                source="competitor_validation",
                code=code,
                message=str(exc),
            )
            return {"status": "failed", "count": 0, "error": str(exc)}

        if decision["status"] != "confirmed":
            count = await self.repository.finalize_gap_candidates(
                context,
                accepted={},
                status=decision["status"],
                message=decision["reason"],
            )
            return {"status": decision["status"], "count": count}

        accepted = accepted_gap_keywords(
            rows,
            relevant_indices=decision["relevant_indices"],
            confidence=decision["confidence"],
            profile=context.profile,
            language=context.language,
        )
        if not accepted:
            count = await self.repository.finalize_gap_candidates(
                context,
                accepted={},
                status="skipped_uncertain",
                message="差距词与网站核心业务的重合不足",
            )
            return {"status": "skipped_uncertain", "count": count}
        count = await self.repository.finalize_gap_candidates(
            context,
            accepted=accepted,
            status="confirmed",
            message="已确认竞争关系",
        )
        return {"status": "confirmed", "count": count}

    @activity.defn(name="keyword_prepare_topic_metrics")
    async def prepare_topic_metrics(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "enriching_topics"})
        topics = await self.repository.load_selected_topics(context.run_id)
        if not topics:
            raise ApplicationError(
                "AI没有返回可写入关键词库的有效主题",
                type="seed_candidates_empty",
                non_retryable=True,
            )

        candidates = await self._load_topic_candidates(context, topics)
        topic_count = len(candidates)

        await self.repository.mark_candidate_selection(
            context.run_id,
            [candidate for _, candidate in candidates],
            [],
        )

        missing_overview = [
            candidate.keyword
            for _, candidate in candidates
            if overview_required(metric_from_candidate(candidate))
        ]
        overview_rows: list[RawKeyword] = []
        overview_failed = False
        overview_retryable = False
        overview_failure_code = ""
        if missing_overview:
            await self.repository.set_stage(
                context.run_id,
                "enriching",
                "正在补充关键词指标",
                72,
                selected_count=topic_count,
            )
            try:
                overview_rows = await self._keyword_overview_request(
                    context,
                    keywords=missing_overview,
                )
            except ApplicationError as exc:
                overview_failed = True
                overview_retryable = not bool(exc.non_retryable)
                overview_failure_code = application_error_code(exc)
                await self.repository.record_partial_failure(
                    context.run_id,
                    source="keyword_overview",
                    code=overview_failure_code,
                    message=str(exc),
                )

        overview_by_keyword = {normalize_keyword(row.keyword): row for row in overview_rows}
        for _, candidate in candidates:
            overview = overview_by_keyword.get(candidate.normalized_keyword)
            if overview is not None:
                candidate.rows.append(overview)

        metrics_by_keyword = {
            candidate.normalized_keyword: metric_from_candidate(candidate)
            for _, candidate in candidates
        }
        for metric in metrics_by_keyword.values():
            if not overview_required(metric):
                metric["_status"] = "fresh"
            elif overview_failed and overview_retryable:
                metric["_status"] = "pending"
            else:
                metric["_status"] = "failed"
        await self.repository.save_staged_metrics(
            context.run_id,
            metrics_by_keyword,
        )
        return {
            "topic_count": topic_count,
            "pending_metrics_count": sum(
                metric.get("_status") == "pending" for metric in metrics_by_keyword.values()
            ),
            "failed_metrics_count": sum(
                metric.get("_status") == "failed" for metric in metrics_by_keyword.values()
            ),
            "overview_requested_count": len(missing_overview),
            "overview_returned_count": len(overview_rows),
            "overview_failed": overview_failed,
            "overview_retryable": overview_retryable,
            "overview_failure_code": overview_failure_code,
        }

    @activity.defn(name="keyword_commit_topics")
    async def commit_topics(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "committing_topics"})
        topics = await self.repository.load_selected_topics(context.run_id)
        if not topics:
            raise ApplicationError(
                "AI没有返回可写入关键词库的有效主题",
                type="seed_candidates_empty",
                non_retryable=True,
            )

        staged_by_keyword = {
            staged.candidate.normalized_keyword: staged
            for staged in await self.repository.load_staged_keywords(context.run_id)
        }
        candidates: list[tuple[dict[str, Any], MergedCandidate, dict[str, Any], str]] = []
        for topic in topics:
            normalized = str(topic["normalized_keyword"])
            staged = staged_by_keyword.get(normalized)
            if staged is None:
                raise RuntimeError(f"主题暂存数据缺失: {topic['keyword']}")
            metric = staged.metric or metric_from_candidate(staged.candidate)
            if staged.metrics_status == "fresh" and not overview_required(metric):
                metrics_status = "fresh"
            elif staged.metrics_status == "failed":
                metrics_status = "failed"
            else:
                metrics_status = "pending"
            candidates.append((topic, staged.candidate, metric, metrics_status))

        topic_count = len(candidates)
        records: list[dict[str, Any]] = []
        await self.repository.set_stage(
            context.run_id,
            "scoring",
            "正在计算关键词优先级",
            86,
            selected_count=topic_count,
        )
        metrics_by_keyword = {
            candidate.normalized_keyword: metric for _, candidate, metric, _ in candidates
        }
        percentiles = volume_percentiles(metrics_by_keyword)
        for topic, candidate, metric, metrics_status in candidates:
            score, confidence, details = priority_score(
                candidate,
                metric,
                context.profile,
                context.language,
                percentiles.get(candidate.normalized_keyword),
            )
            seed_id = str(topic["id"])
            records.append(
                {
                    "candidate": candidate,
                    "metric": metric,
                    "metrics_status": metrics_status,
                    "business_topic": topic.get("business_topic"),
                    "classification_confidence": candidate.relevance,
                    "review_status": "approved",
                    "primary_seed_id": seed_id,
                    "relations": [(seed_id, 1.0, "topic_representative")],
                    "source_seed_ids": [seed_id],
                    "priority_score": score,
                    "priority_confidence": confidence,
                    "priority_details": details,
                    "score_version": PRIORITY_RULE_VERSION,
                }
            )

        await self.repository.set_stage(
            context.run_id,
            "committing",
            "正在生成关键词库",
            95,
            selected_count=topic_count,
        )
        commit_result = await self.repository.commit_keywords(context, records)
        return {
            "keyword_count": commit_result.keyword_count,
            "pending_metrics_count": commit_result.pending_metrics_count,
            "result_version": commit_result.result_version,
        }

    async def _load_topic_candidates(
        self,
        context: KeywordRunContext,
        topics: list[dict[str, Any]],
    ) -> list[tuple[dict[str, Any], MergedCandidate]]:
        rows = await self.repository.load_ideas(
            context.run_id,
            list(DISCOVERY_SOURCES),
        )
        rows.extend(await self.repository.load_confirmed_gap_keywords(context.run_id))
        rows_by_keyword: dict[str, list[RawKeyword]] = {}
        for row in rows:
            rows_by_keyword.setdefault(normalize_keyword(row.keyword), []).append(row)

        candidates: list[tuple[dict[str, Any], MergedCandidate]] = []
        for topic in topics:
            normalized = str(topic["normalized_keyword"])
            source_rows = rows_by_keyword.get(normalized, [])
            if not source_rows:
                raise ApplicationError(
                    f"主题代表词缺少DataForSEO原始记录: {topic['keyword']}",
                    type="topic_source_missing",
                    non_retryable=True,
                )
            stored_relevance = topic.get("candidate_score")
            business_relevance = (
                min(max(float(stored_relevance), 0.0), 1.0)
                if isinstance(stored_relevance, (int, float))
                else 0.5
            )
            candidates.append(
                (
                    topic,
                    MergedCandidate(
                        keyword=str(topic["keyword"]),
                        normalized_keyword=normalized,
                        rows=list(source_rows),
                        relevance=round(business_relevance, 4),
                        included=True,
                    ),
                )
            )
        return candidates

    @activity.defn(name="keyword_refresh_pending_metrics")
    async def refresh_pending_metrics(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = dict(payload.get("task") or payload)
        attempt = max(int(payload.get("attempt") or 1), 1)
        context = await self.repository.load_context(task)
        keywords = await self.repository.load_pending_metric_keywords(context.run_id)
        if not keywords:
            return {"requested": 0, "updated": 0, "failed": 0, "no_data": 0}

        activity_heartbeat({"stage": "refreshing_pending_metrics", "count": len(keywords)})
        try:
            rows = await self._keyword_overview_request(
                context,
                keywords=keywords,
                request_scope=f"recovery-{attempt}",
            )
        except ApplicationError as exc:
            await self.repository.record_partial_failure(
                context.run_id,
                source="keyword_overview_recovery",
                code=application_error_code(exc),
                message=str(exc),
            )
            return {
                "requested": len(keywords),
                "updated": 0,
                "failed": 0,
                "no_data": 0,
                "pending_metrics_count": len(keywords),
                "retryable": not bool(exc.non_retryable),
                "failure_code": application_error_code(exc),
            }

        result = await self.repository.finish_pending_metrics(
            context,
            keywords,
            rows,
            failed=False,
        )
        if int(result.get("failed") or 0) > 0:
            await self.repository.record_partial_failure(
                context.run_id,
                source="keyword_overview_recovery",
                code="keyword_metrics_incomplete",
                message="DataForSEO未返回完整的关键词难度和搜索意图",
            )
        return {
            "requested": len(keywords),
            "retryable": int(result.get("pending_metrics_count") or 0) > 0,
            **result,
        }

    @activity.defn(name="keyword_settle_pending_metrics")
    async def settle_pending_metrics(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = dict(payload.get("task") or {})
        context = await self.repository.load_context(task)
        keywords = await self.repository.load_pending_metric_keywords(context.run_id)
        if not keywords:
            return {"requested": 0, "updated": 0, "failed": 0, "no_data": 0}
        await self.repository.record_partial_failure(
            context.run_id,
            source="keyword_overview_recovery",
            code=str(payload.get("code") or "metrics_recovery_failed")[:120],
            message=str(payload.get("detail") or "关键词指标后台补充中断"),
        )
        result = await self.repository.finish_pending_metrics(
            context,
            keywords,
            [],
            failed=True,
        )
        return {"requested": len(keywords), **result}

    @activity.defn(name="keyword_mark_metric_refresh_started")
    async def mark_metric_refresh_started(self, task: dict[str, Any]) -> dict[str, Any]:
        return await self.repository.start_metric_refresh_job(task)

    @activity.defn(name="keyword_schedule_metric_refresh_retry")
    async def schedule_metric_refresh_retry(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task = dict(payload.get("task") or {})
        context = await self.repository.load_context(task)
        workflow_id = str(task.get("_metric_workflow_id") or "")
        if not workflow_id:
            raise RuntimeError("指标恢复任务缺少工作流ID")
        return await self.repository.schedule_metric_refresh_retry(
            context,
            expected_workflow_id=workflow_id,
            attempt_count=max(int(payload.get("attempt") or 1), 1),
            code=str(payload.get("code") or "keyword_metrics_unavailable"),
            detail=str(payload.get("detail") or "关键词指标暂时不可用"),
        )

    @activity.defn(name="keyword_finish_metric_refresh_job")
    async def finish_metric_refresh_job(self, payload: dict[str, Any]) -> None:
        task = dict(payload.get("task") or {})
        context = await self.repository.load_context(task)
        workflow_id = str(task.get("_metric_workflow_id") or "")
        if not workflow_id:
            raise RuntimeError("指标恢复任务缺少工作流ID")
        await self.repository.finish_metric_refresh_job(
            context,
            expected_workflow_id=workflow_id,
            exhausted=bool(payload.get("exhausted")),
            code=str(payload.get("code") or ""),
            detail=str(payload.get("detail") or ""),
        )

    async def _keyword_overview_request(
        self,
        context: KeywordRunContext,
        *,
        keywords: list[str],
        request_scope: str = "initial",
    ) -> list[RawKeyword]:
        request_payload = {
            "keywords": keywords,
            "country": context.country,
            "language": context.language,
        }
        request_key = f"keyword:{context.run_id}:dataforseo:keyword-overview:{request_scope}"
        config = await require_dataforseo_config(
            self.repository,
            context.organization_id,
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="dataforseo",
            endpoint=DataForSEOClient.KEYWORD_OVERVIEW_PATH,
            request_hash=stable_hash(request_payload),
        )
        if request.reusable:
            cached_rows = request.response_metadata.get("rows")
            if isinstance(cached_rows, list):
                return [
                    row
                    for raw in cached_rows
                    if (row := raw_keyword_from_metadata(raw)) is not None
                ]
            if request.result_count:
                raise ApplicationError(
                    "DataForSEO Keyword Overview缓存不完整",
                    type="keyword_overview_cache_missing",
                    non_retryable=True,
                )
            return []
        if not request.should_execute:
            raise provider_application_error(external_request_error(request))
        await submit_external_request(self.repository, request)

        http = JsonHttpClient(
            timeout_seconds=self.settings.keyword_http_timeout_seconds,
            max_retries=self.settings.keyword_http_max_retries,
        )
        try:
            rows, billing = await DataForSEOClient(config, http).keyword_overview(
                keywords=keywords,
                country=context.country,
                language=context.language,
            )
            await self.repository.complete_external_request(
                request.request_key,
                claim_token=required_claim_token(request),
                result_count=len(rows),
                metadata={
                    "path": billing.path,
                    "keyword_count": len(keywords),
                    "rows": [raw_keyword_metadata(row) for row in rows],
                },
                cost_usd=billing.cost_usd,
                expires_at=datetime.now(UTC) + timedelta(days=30),
            )
            return rows
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except ProviderError as exc:
            await fail_external_request(
                self.repository,
                request,
                error=exc,
            )
            raise provider_application_error(exc) from exc
        finally:
            await http.close()

    @activity.defn(name="keyword_expand_ideas")
    async def expand_ideas(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "expanding"})
        legacy_rows = await self.repository.request_ideas(
            context.run_id,
            "keyword_ideas",
        )
        if legacy_rows:
            return {
                "count": len({normalize_keyword(row.keyword) for row in legacy_rows}),
                "fetched_count": len(legacy_rows),
                "broad_count": 0,
                "close_count": 0,
                "reused": True,
                "legacy": True,
            }
        seeds = await self.repository.load_active_seeds(context.run_id)
        if not seeds:
            raise ApplicationError(
                "没有可用于拓展的种子词",
                type="active_seeds_empty",
                non_retryable=True,
            )
        await self.repository.set_stage(
            context.run_id,
            "expanding",
            "正在拓展关键词",
            48,
            selected_count=len(seeds),
        )
        active_seed_keywords = [
            str(seed["keyword"]) for seed in seeds[:LEGACY_EXPANSION_SEED_LIMIT]
        ]
        broad_result, close_result = await asyncio.gather(
            self._keyword_ideas_request(
                context,
                keywords=active_seed_keywords,
                closely_variants=False,
                limit=KEYWORD_IDEAS_BROAD_LIMIT,
            ),
            self._keyword_ideas_request(
                context,
                keywords=active_seed_keywords,
                closely_variants=True,
                limit=KEYWORD_IDEAS_CLOSE_LIMIT,
            ),
            return_exceptions=True,
        )
        broad_rows: list[RawKeyword] = []
        close_rows: list[RawKeyword] = []
        broad_reused = False
        close_reused = False
        failures: list[dict[str, str]] = []
        for mode, result in (("broad", broad_result), ("close", close_result)):
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, BaseException):
                code = application_error_code(result)
                failures.append({"mode": mode, "code": code, "message": str(result)})
                await self.repository.record_partial_failure(
                    context.run_id,
                    source=f"keyword_ideas_{mode}",
                    code=code,
                    message=str(result),
                )
                continue
            mode_rows, mode_reused = result
            if mode == "broad":
                broad_rows, broad_reused = mode_rows, mode_reused
            else:
                close_rows, close_reused = mode_rows, mode_reused
        rows = [*broad_rows, *close_rows]
        if not rows:
            if not failures:
                raise ApplicationError(
                    "两种拓词方式均正常完成，但没有返回可用关键词",
                    type="expanded_keywords_empty",
                    non_retryable=True,
                )
            blocking_failure = next(
                (
                    result
                    for result in (broad_result, close_result)
                    if isinstance(result, BaseException)
                    and (
                        bool(getattr(result, "non_retryable", False))
                        or application_error_code(result)
                        in {
                            "external_request_charged_failure",
                            "external_request_uncertain",
                            "dataforseo_auth_failed",
                            "dataforseo_not_configured",
                            "unsupported_country",
                            "unsupported_language",
                        }
                    )
                ),
                None,
            )
            if isinstance(blocking_failure, BaseException):
                raise blocking_failure
            raise ApplicationError(
                "两种拓词方式暂时都没有返回可用关键词，系统将自动继续",
                type="keyword_expansion_recovery_required",
            )
        unique_count = len({normalize_keyword(row.keyword) for row in rows})
        result: dict[str, Any] = {
            "count": unique_count,
            "fetched_count": len(rows),
            "broad_count": len(broad_rows),
            "close_count": len(close_rows),
            "reused": not failures and broad_reused and close_reused,
        }
        if failures:
            result["partial_failures"] = failures
        return result

    async def _keyword_ideas_request(
        self,
        context: KeywordRunContext,
        *,
        keywords: list[str],
        closely_variants: bool,
        limit: int,
        request_scope: str = "expansion",
    ) -> tuple[list[RawKeyword], bool]:
        source = (
            DataForSEOClient.KEYWORD_IDEAS_CLOSE_SOURCE
            if closely_variants
            else DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE
        )
        existing = await self.repository.request_ideas(context.run_id, source)
        if existing:
            return existing, True
        request_payload = {
            "keywords": keywords,
            "country": context.country,
            "language": context.language,
            "limit": limit,
            "closely_variants": closely_variants,
        }
        mode = "close" if closely_variants else "broad"
        request_key = f"keyword:{context.run_id}:dataforseo:keyword-ideas:{request_scope}:{mode}"
        config = await require_dataforseo_config(
            self.repository,
            context.organization_id,
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="dataforseo",
            endpoint=DataForSEOClient.KEYWORD_IDEAS_PATH,
            request_hash=stable_hash(request_payload),
        )
        if request.reusable:
            cached = await self.repository.request_ideas(
                request.build_run_id,
                source,
            )
            if request.build_run_id != context.run_id and cached:
                await self.repository.save_ideas(context, cached)
            if not cached and request.result_count > 0:
                raise ApplicationError(
                    "DataForSEO 拓展结果缓存不完整",
                    type="keyword_ideas_cache_missing",
                    non_retryable=True,
                )
            return cached, True
        if not request.should_execute:
            raise provider_application_error(external_request_error(request))
        await submit_external_request(self.repository, request)

        http = JsonHttpClient(
            timeout_seconds=self.settings.keyword_http_timeout_seconds,
            max_retries=self.settings.keyword_http_max_retries,
        )
        try:
            rows, billing = await DataForSEOClient(config, http).keyword_ideas(
                keywords=keywords,
                country=context.country,
                language=context.language,
                closely_variants=closely_variants,
                limit=limit,
            )
            await persist_ideas_response(
                self.repository,
                context,
                rows,
                request=request,
                metadata={
                    "path": billing.path,
                    "seed_count": len(keywords),
                    "limit": limit,
                    "closely_variants": closely_variants,
                    "source": source,
                },
                cost_usd=billing.cost_usd,
                expires_at=datetime.now(UTC) + timedelta(days=30),
            )
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except ProviderError as exc:
            await fail_external_request(
                self.repository,
                request,
                error=exc,
            )
            raise provider_application_error(exc) from exc
        finally:
            await http.close()
        return rows, False

    @activity.defn(name="keyword_classify_score_commit")
    async def classify_score_commit(self, task: dict[str, Any]) -> dict[str, Any]:
        context = await self.repository.load_context(task)
        activity_heartbeat({"stage": "filtering"})
        seeds = await self.repository.load_active_seeds(context.run_id)
        rows = await self.repository.load_ideas(
            context.run_id,
            KEYWORD_IDEAS_SOURCES,
        )
        await self.repository.set_stage(
            context.run_id,
            "filtering",
            "正在清理关键词",
            62,
            discovered_count=len(rows),
        )
        candidates, rule_rejected = merge_and_limit_candidates(
            rows,
            context.profile,
            context.language,
            limit=ROUND_KEYWORD_LIMIT,
            excluded_normalized={
                normalize_keyword(str(seed["keyword"])): "seed_keyword" for seed in seeds
            },
        )
        if not candidates:
            raise ApplicationError(
                "拓展结果中没有可用关键词",
                type="expanded_keywords_empty",
                non_retryable=True,
            )

        await self.repository.set_stage(
            context.run_id,
            "classifying",
            "正在整理关键词分类",
            72,
        )
        batches = [
            candidates[start : start + AI_CLASSIFICATION_BATCH]
            for start in range(0, len(candidates), AI_CLASSIFICATION_BATCH)
        ]
        semaphore = asyncio.Semaphore(AI_CLASSIFICATION_CONCURRENCY)

        async def classify_one(
            batch_index: int,
            batch: list[MergedCandidate],
        ) -> list[KeywordClassification]:
            async with semaphore:
                activity_heartbeat(
                    {
                        "stage": "classifying",
                        "batch": batch_index,
                        "batch_count": len(batches),
                    }
                )
                result = await self._classify_batch(
                    context,
                    batch,
                    seeds,
                    batch_index=batch_index,
                )
                activity_heartbeat(
                    {
                        "stage": "classifying",
                        "completed_batch": batch_index,
                        "batch_count": len(batches),
                    }
                )
                return result

        batch_results = await asyncio.gather(
            *(
                classify_one(batch_index, batch)
                for batch_index, batch in enumerate(batches, start=1)
            )
        )
        decisions = [decision for batch in batch_results for decision in batch]

        selected: list[MergedCandidate] = []
        ai_rejected: list[MergedCandidate] = []
        accepted_decisions = []
        for decision in decisions:
            decision.candidate.relevance = decision.confidence
            if decision.relevant:
                decision.candidate.included = True
                decision.candidate.exclusion_reason = None
                selected.append(decision.candidate)
                accepted_decisions.append(decision)
            else:
                decision.candidate.included = False
                decision.candidate.exclusion_reason = f"ai_irrelevant:{decision.reason}"[:500]
                ai_rejected.append(decision.candidate)
        if not selected:
            raise ApplicationError(
                "AI 判断拓展结果中没有与网站业务相关的关键词",
                type="expanded_keywords_empty",
                non_retryable=True,
            )
        await self.repository.mark_candidate_selection(
            context.run_id,
            selected,
            [*rule_rejected, *ai_rejected],
        )

        metrics_by_keyword = {
            candidate.normalized_keyword: metric_from_candidate(candidate) for candidate in selected
        }
        percentiles = volume_percentiles(metrics_by_keyword)
        records: list[dict[str, Any]] = []
        await self.repository.set_stage(
            context.run_id,
            "scoring",
            "正在计算关键词优先级",
            86,
        )
        activity_heartbeat({"stage": "scoring"})
        seed_ids = [str(seed["id"]) for seed in seeds]
        for decision in accepted_decisions:
            candidate = decision.candidate
            metric = metrics_by_keyword[candidate.normalized_keyword]
            primary_seed_id = decision.primary_seed_id
            relations: list[tuple[str, float, str]] = []
            if primary_seed_id:
                relations.append(
                    (
                        primary_seed_id,
                        decision.confidence,
                        "ai_inferred",
                    )
                )
            relations.extend(
                (
                    seed_id,
                    round(decision.confidence * 0.8, 4),
                    "ai_inferred",
                )
                for seed_id in decision.related_seed_ids
                if seed_id != primary_seed_id
            )
            if primary_seed_id is None:
                fallback_primary, fallback_relations = classify_candidate(
                    candidate,
                    seeds,
                    context.language,
                )
                primary_seed_id = fallback_primary
                relations = [
                    (seed_id, confidence, "system_inferred")
                    for seed_id, confidence, _ in fallback_relations
                ]
            score, confidence, details = priority_score(
                candidate,
                metric,
                context.profile,
                context.language,
                percentiles.get(candidate.normalized_keyword),
            )
            records.append(
                {
                    "candidate": candidate,
                    "metric": metric,
                    "metrics_status": "fresh",
                    "business_topic": decision.business_topic,
                    "classification_confidence": decision.confidence,
                    "review_status": decision.review_status,
                    "primary_seed_id": primary_seed_id,
                    "relations": relations,
                    "source_seed_ids": seed_ids,
                    "priority_score": score,
                    "priority_confidence": confidence,
                    "priority_details": details,
                    "score_version": PRIORITY_RULE_VERSION,
                }
            )

        await self.repository.set_stage(
            context.run_id,
            "committing",
            "正在生成关键词库",
            95,
        )
        activity_heartbeat({"stage": "committing", "record_count": len(records)})
        commit_result = await self.repository.commit_keywords(context, records)
        return {
            "keyword_count": commit_result.keyword_count,
            "filtered_count": len(rule_rejected) + len(ai_rejected),
            "needs_review_count": sum(
                decision.review_status == "needs_review" for decision in accepted_decisions
            ),
            "result_version": commit_result.result_version,
        }

    @activity.defn(name="keyword_fail_run")
    async def fail_run(self, payload: dict[str, Any]) -> None:
        task = dict(payload["task"])
        context = await self.repository.load_context(task)
        code = str(payload.get("code") or "keyword_build_failed")
        detail = str(payload.get("detail") or "关键词任务执行失败")
        await self.repository.fail_run(
            context,
            code=code,
            message=human_failure_message(code),
            detail=detail,
        )

    @activity.defn(name="keyword_defer_run")
    async def defer_run(self, payload: dict[str, Any]) -> None:
        task = dict(payload["task"])
        context = await self.repository.load_context(task)
        code = str(payload.get("code") or "keyword_recovery_required")
        detail = str(payload.get("detail") or "关键词任务等待后台恢复")
        retry_seconds = min(max(int(payload.get("retry_seconds") or 60), 5), 3600)
        await self.repository.defer_run(
            context,
            code=code,
            detail=detail,
            retry_at=datetime.now(UTC) + timedelta(seconds=retry_seconds),
        )

    @activity.defn(name="keyword_block_run")
    async def block_run(self, payload: dict[str, Any]) -> None:
        task = dict(payload["task"])
        context = await self.repository.load_context(task)
        code = str(payload.get("code") or "keyword_recovery_exhausted")
        detail = str(payload.get("detail") or "关键词任务暂时无法继续")
        raw_retry_seconds = payload.get("retry_seconds")
        retry_seconds = (
            min(max(int(raw_retry_seconds), 60), 86400) if raw_retry_seconds is not None else None
        )
        stage, message = blocked_run_presentation(code, retry_seconds is not None)
        await self.repository.block_run(
            context,
            code=code,
            detail=detail,
            stage=stage,
            message=message,
            retry_at=(
                datetime.now(UTC) + timedelta(seconds=retry_seconds)
                if retry_seconds is not None
                else None
            ),
        )

    @activity.defn(name="keyword_complete_empty")
    async def complete_empty(self, payload: dict[str, Any]) -> None:
        task = dict(payload["task"])
        context = await self.repository.load_context(task)
        code = str(payload.get("code") or "site_seed_empty")
        await self.repository.complete_empty_run(
            context,
            message=empty_result_message(code),
        )

    @activity.defn(name="keyword_record_gap_failure")
    async def record_gap_failure(self, payload: dict[str, Any]) -> None:
        task = dict(payload["task"])
        context = await self.repository.load_context(task)
        code = str(payload.get("code") or "competitor_gap_failed")
        detail = str(payload.get("detail") or "竞争对手分析未完成")
        await self.repository.set_gap_status(
            context,
            status="failed",
            message="竞争对手分析暂时未完成",
            count=0,
        )
        await self.repository.record_partial_failure(
            context.run_id,
            source="competitor_gap",
            code=code,
            message=detail,
        )

    async def _labs_site_request(
        self,
        context: KeywordRunContext,
    ) -> list[RawKeyword]:
        request_payload = {
            "target": context.domain,
            "country": context.country,
            "language": context.language,
            "limit": LABS_SITE_LIMIT,
        }
        request_key = f"keyword:{context.run_id}:dataforseo:labs-site:v2-500"
        config = await require_dataforseo_config(
            self.repository,
            context.organization_id,
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="dataforseo",
            endpoint=DataForSEOClient.LABS_SITE_PATH,
            request_hash=stable_hash(request_payload),
        )
        if request.reusable:
            cached = await self.repository.request_ideas(
                request.build_run_id,
                "labs_site",
            )
            if request.build_run_id != context.run_id and cached:
                await self.repository.save_ideas(context, cached)
            return cached
        if not request.should_execute:
            raise provider_application_error(external_request_error(request))
        await submit_external_request(self.repository, request)
        http = JsonHttpClient(
            timeout_seconds=self.settings.keyword_http_timeout_seconds,
            max_retries=self.settings.keyword_http_max_retries,
        )
        try:
            rows, billing = await DataForSEOClient(
                config,
                http,
            ).labs_keywords_for_site(
                domain=context.domain,
                country=context.country,
                language=context.language,
                limit=LABS_SITE_LIMIT,
            )
            await persist_ideas_response(
                self.repository,
                context,
                rows,
                request=request,
                metadata={"path": billing.path, "limit": LABS_SITE_LIMIT},
                cost_usd=billing.cost_usd,
                expires_at=datetime.now(UTC) + timedelta(days=30),
            )
            return rows
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except ProviderError as exc:
            await fail_external_request(
                self.repository,
                request,
                error=exc,
            )
            raise provider_application_error(exc) from exc
        finally:
            await http.close()

    async def _google_ads_site_request(
        self,
        context: KeywordRunContext,
    ) -> list[RawKeyword]:
        request_payload = {
            "target": context.domain,
            "target_type": "site",
            "country": context.country,
            "language": context.language,
        }
        request_key = f"keyword:{context.run_id}:dataforseo:google-ads-site"
        config = await require_dataforseo_config(
            self.repository,
            context.organization_id,
        )
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="dataforseo",
            endpoint=DataForSEOClient.ADS_SITE_PATH,
            request_hash=stable_hash(request_payload),
        )
        if request.reusable:
            cached = await self.repository.request_ideas(
                request.build_run_id,
                "google_ads_site",
            )
            if request.build_run_id != context.run_id and cached:
                await self.repository.save_ideas(context, cached)
            return cached
        if not request.should_execute:
            raise provider_application_error(external_request_error(request))
        await submit_external_request(self.repository, request)
        http = JsonHttpClient(
            timeout_seconds=self.settings.keyword_http_timeout_seconds,
            max_retries=self.settings.keyword_http_max_retries,
        )
        try:
            rows, billing = await DataForSEOClient(
                config,
                http,
            ).google_ads_keywords_for_site(
                domain=context.domain,
                country=context.country,
                language=context.language,
            )
            await persist_ideas_response(
                self.repository,
                context,
                rows,
                request=request,
                metadata={"path": billing.path},
                cost_usd=billing.cost_usd,
                expires_at=datetime.now(UTC) + timedelta(days=30),
            )
            return rows
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except ProviderError as exc:
            await fail_external_request(
                self.repository,
                request,
                error=exc,
            )
            raise provider_application_error(exc) from exc
        finally:
            await http.close()

    async def _fallback_business_profile(
        self,
        context: KeywordRunContext,
        *,
        page_hints: list[dict[str, Any]],
    ) -> dict[str, Any]:
        candidates = await self.repository.load_ideas(
            context.run_id,
            ["labs_site", "google_ads_site"],
        )
        config = await require_ai_config(
            self.repository,
            context.organization_id,
        )
        request_payload = {
            "domain": context.domain,
            "country": context.country,
            "language": context.language,
            "candidate_keywords": [normalize_keyword(row.keyword) for row in candidates[:100]]
            if candidates
            else [],
            "page_hints": page_hints[:10],
            "model": config.model,
            "provider_base_url": config.base_url,
            "prompt_version": "domain-profile-fallback-v1",
        }
        request_key = f"keyword:{context.run_id}:ai:domain-profile-fallback:v1"
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="ai",
            endpoint="chat/completions:domain-profile-fallback-v1",
            request_hash=stable_hash(request_payload),
        )
        cached_payload = request.response_metadata.get("payload")
        used_deterministic_fallback = False
        payload: dict[str, Any] | None = None
        usage: dict[str, Any] = {}
        model = config.model
        cost_usd = 0.0
        try:
            if isinstance(cached_payload, dict):
                payload = cached_payload
                usage: dict[str, int] = {}
                model = ""
                cost_usd = 0.0
            else:
                if not request.should_execute:
                    raise external_request_error(request)
                await submit_external_request(self.repository, request)
                http = JsonHttpClient(
                    timeout_seconds=config.timeout_seconds,
                    max_retries=config.max_retries,
                )
                try:
                    result = await OpenAICompatibleClient(
                        http,
                        config,
                    ).build_fallback_profile(
                        domain=context.domain,
                        country=context.country,
                        language=context.language,
                        candidates=candidates,
                        page_hints=page_hints,
                    )
                finally:
                    await http.close()
                payload = result.payload
                usage = result.usage
                model = result.model
                cost_usd = result.cost_usd
            profile = validate_fallback_profile(payload)
            profile["extraction_method"] = "ai_domain_fallback"
            profile["key_pages"] = page_hints
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except (ProviderError, ValueError) as exc:
            code = exc.code if isinstance(exc, ProviderError) else "invalid_fallback_profile"
            ledger_error = ai_response_error(
                exc,
                code=code,
                cost_usd=cost_usd,
                metadata=ai_response_metadata(payload, usage, model),
            )
            await fail_external_request(
                self.repository,
                request,
                error=ledger_error,
                code=code,
            )
            used_deterministic_fallback = True
            profile = deterministic_business_profile(
                context,
                candidates=candidates,
                page_hints=page_hints,
            )
            await self.repository.record_partial_failure(
                context.run_id,
                source="business_profile_ai",
                code=code,
                message=str(exc),
            )
        if not used_deterministic_fallback and not isinstance(cached_payload, dict):
            await self.repository.complete_external_request(
                request.request_key,
                claim_token=required_claim_token(request),
                result_count=1,
                metadata={
                    "payload": payload,
                    "usage": usage,
                    "model": model,
                    "prompt_version": "domain-profile-fallback-v1",
                },
                cost_usd=cost_usd,
            )
        version = stable_hash(request_payload)
        profile_source = (
            "domain_keyword_fallback" if used_deterministic_fallback else "ai_domain_fallback"
        )
        await self.repository.save_profile_snapshot(
            context,
            profile,
            source=profile_source,
            version=version,
        )
        return {
            "source": profile_source,
            "version": version,
            "reused": not used_deterministic_fallback and isinstance(cached_payload, dict),
            "degraded": used_deterministic_fallback,
        }

    async def _classify_batch(
        self,
        context: KeywordRunContext,
        candidates: list[MergedCandidate],
        seeds: list[dict[str, Any]],
        *,
        batch_index: int,
    ) -> list[KeywordClassification]:
        config = await require_ai_config(
            self.repository,
            context.organization_id,
        )
        request_payload = {
            "keywords": [candidate.normalized_keyword for candidate in candidates],
            "seeds": [seed["id"] for seed in seeds],
            "profile": context.profile,
            "profile_version": context.profile_version,
            "country": context.country,
            "language": context.language,
            "model": config.model,
            "provider_base_url": config.base_url,
            "prompt_version": "keyword-classification-v2",
        }
        request_key = f"keyword:{context.run_id}:ai:keyword-classification:v2:{batch_index}"
        request = await self.repository.begin_external_request(
            context=context,
            request_key=request_key,
            provider="ai",
            endpoint="chat/completions:keyword-classification-v2",
            request_hash=stable_hash(request_payload),
        )
        cached_payload = request.response_metadata.get("payload")
        payload: dict[str, Any] | None = None
        usage: dict[str, Any] = {}
        model = config.model
        cost_usd = 0.0
        try:
            if isinstance(cached_payload, dict):
                payload = cached_payload
                usage: dict[str, int] = {}
                model = ""
                cost_usd = 0.0
            else:
                if not request.should_execute:
                    raise external_request_error(request)
                await submit_external_request(self.repository, request)
                http = JsonHttpClient(
                    timeout_seconds=config.timeout_seconds,
                    max_retries=config.max_retries,
                )
                try:
                    result = await OpenAICompatibleClient(
                        http,
                        config,
                    ).classify_keywords(
                        rows=[candidate.rows[0] for candidate in candidates],
                        seeds=seeds,
                        profile=context.profile,
                        country=context.country,
                        language=context.language,
                    )
                finally:
                    await http.close()
                payload = result.payload
                usage = result.usage
                model = result.model
                cost_usd = result.cost_usd
            decisions = validate_keyword_classifications(
                candidates,
                payload,
                seeds,
            )
        except asyncio.CancelledError:
            await mark_cancelled_external_request(self.repository, request)
            raise
        except (ProviderError, ValueError) as exc:
            code = exc.code if isinstance(exc, ProviderError) else "invalid_ai_classification"
            ledger_error = ai_response_error(
                exc,
                code=code,
                cost_usd=cost_usd,
                metadata=ai_response_metadata(payload, usage, model),
            )
            await fail_external_request(
                self.repository,
                request,
                error=ledger_error,
                code=code,
            )
            await self.repository.record_partial_failure(
                context.run_id,
                source=f"keyword_classification_batch_{batch_index}",
                code=code,
                message=str(exc),
            )
            return deterministic_keyword_classifications(
                candidates,
                seeds,
                context.profile,
                context.language,
            )
        if not isinstance(cached_payload, dict):
            await self.repository.complete_external_request(
                request.request_key,
                claim_token=required_claim_token(request),
                result_count=len(decisions),
                metadata={
                    "payload": payload,
                    "usage": usage,
                    "model": model,
                    "prompt_version": "keyword-classification-v2",
                },
                cost_usd=cost_usd,
            )
        return decisions


async def persist_ideas_response(
    repository: Any,
    context: KeywordRunContext,
    rows: list[RawKeyword],
    *,
    request: ExternalRequestRecord,
    metadata: dict[str, Any],
    cost_usd: float,
    expires_at: datetime | None,
) -> None:
    atomic_save = getattr(
        repository,
        "save_ideas_and_complete_external_request",
        None,
    )
    if callable(atomic_save):
        await atomic_save(
            context,
            rows,
            request_key=request.request_key,
            claim_token=required_claim_token(request),
            metadata=metadata,
            cost_usd=cost_usd,
            expires_at=expires_at,
        )
        return
    await repository.save_ideas(context, rows)
    await repository.complete_external_request(
        request.request_key,
        claim_token=required_claim_token(request),
        result_count=len(rows),
        metadata=metadata,
        cost_usd=cost_usd,
        expires_at=expires_at,
    )


async def persist_gap_response(
    repository: Any,
    context: KeywordRunContext,
    rows: list[CompetitorGap],
    *,
    request: ExternalRequestRecord,
    metadata: dict[str, Any],
    cost_usd: float,
    expires_at: datetime | None,
) -> None:
    atomic_save = getattr(
        repository,
        "save_gap_candidates_and_complete_external_request",
        None,
    )
    if callable(atomic_save):
        await atomic_save(
            context,
            rows,
            request_key=request.request_key,
            claim_token=required_claim_token(request),
            metadata=metadata,
            cost_usd=cost_usd,
            expires_at=expires_at,
        )
        return
    await repository.save_gap_candidates(context, rows)
    await repository.complete_external_request(
        request.request_key,
        claim_token=required_claim_token(request),
        result_count=len(rows),
        metadata=metadata,
        cost_usd=cost_usd,
        expires_at=expires_at,
    )


async def fail_external_request(
    repository: Any,
    request: ExternalRequestRecord,
    *,
    error: Exception,
    code: str | None = None,
) -> None:
    if isinstance(error, ProviderError) and error.code.startswith("external_request_"):
        return
    provider_error = error if isinstance(error, ProviderError) else None
    metadata = dict(provider_error.metadata) if provider_error is not None else {}
    if provider_error is not None and provider_error.path:
        metadata["path"] = provider_error.path
    updated = await repository.fail_external_request(
        request.request_key,
        claim_token=required_claim_token(request),
        code=code or (provider_error.code if provider_error else "invalid_provider_response"),
        detail=str(error),
        failure_status=(provider_error.failure_status if provider_error else CHARGED_FAILURE),
        metadata=metadata,
        cost_usd=provider_error.cost_usd if provider_error else 0.0,
    )
    if updated is False and not request.reusable:
        raise ProviderError(
            "external_request_claim_lost",
            "外部请求执行权已失效，系统不会接受过期结果",
            failure_status=UNCERTAIN_FAILURE,
        )


async def mark_cancelled_external_request(
    repository: Any,
    request: ExternalRequestRecord,
) -> None:
    await fail_external_request(
        repository,
        request,
        error=ProviderError(
            "paid_request_cancelled",
            "付费请求提交后被中断，最终结果需要核对",
            failure_status=UNCERTAIN_FAILURE,
        ),
    )


def should_retry_paid_request(error: ProviderError) -> bool:
    return error.transient and error.failure_status == RETRYABLE_FAILURE


def ai_response_error(
    error: ProviderError | ValueError,
    *,
    code: str,
    cost_usd: float,
    metadata: dict[str, Any] | None = None,
) -> ProviderError:
    if isinstance(error, ProviderError):
        error.metadata = {
            **dict(metadata or {}),
            **error.metadata,
        }
        return error
    return ProviderError(
        code,
        str(error),
        failure_status=CHARGED_FAILURE,
        cost_usd=cost_usd,
        metadata=metadata,
    )


def ai_response_metadata(
    payload: dict[str, Any] | None,
    usage: dict[str, Any],
    model: str,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "model": model,
        "usage": usage,
    }
    if payload is not None:
        metadata["payload"] = payload
    return metadata


async def submit_external_request(
    repository: Any,
    request: ExternalRequestRecord,
) -> None:
    claim_token = required_claim_token(request)
    submitted = await repository.mark_external_request_submitted(
        request.request_key,
        claim_token=claim_token,
    )
    if not submitted:
        raise ProviderError(
            "external_request_in_progress",
            "外部请求已由其他任务接管",
            transient=True,
            failure_status=UNCERTAIN_FAILURE,
        )


def required_claim_token(request: ExternalRequestRecord) -> str:
    if not request.claim_token:
        raise ProviderError(
            "external_request_invalid_claim",
            "外部请求缺少有效的执行凭据",
            failure_status=UNCERTAIN_FAILURE,
        )
    return request.claim_token


async def require_dataforseo_config(
    repository: Any,
    organization_id: str,
) -> Any:
    config = await repository.load_dataforseo_config(organization_id)
    if not config.configured:
        raise provider_application_error(
            ProviderError(
                "dataforseo_not_configured",
                "服务器尚未配置 DataForSEO",
            )
        )
    return config


async def require_ai_config(
    repository: Any,
    organization_id: str,
) -> Any:
    config = await repository.load_ai_config(organization_id)
    if not config.configured:
        raise provider_application_error(
            ProviderError(
                "ai_not_configured",
                "服务器尚未配置 AI 模型",
            )
        )
    return config


def external_request_error(request: ExternalRequestRecord) -> ProviderError:
    detail = request.error_detail or "外部请求已有未完成记录"
    if request.status == CHARGED_FAILURE:
        return ProviderError(
            "external_request_charged_failure",
            detail,
            failure_status=CHARGED_FAILURE,
        )
    if request.status == UNCERTAIN_FAILURE:
        return ProviderError(
            "external_request_uncertain",
            "上次付费请求的结果无法确认，系统不会重复提交",
            failure_status=UNCERTAIN_FAILURE,
        )
    return ProviderError(
        "external_request_in_progress",
        "同一外部请求仍在处理中",
        transient=True,
        failure_status=RETRYABLE_FAILURE,
    )


def deterministic_business_profile(
    context: KeywordRunContext,
    *,
    candidates: list[RawKeyword],
    page_hints: list[dict[str, Any]],
) -> dict[str, Any]:
    domain_label = context.domain.split(".", 1)[0].replace("-", " ").strip()
    titles = [
        display_keyword(str(page.get("title") or ""))
        for page in page_hints
        if display_keyword(str(page.get("title") or ""))
    ]
    descriptions = [
        display_keyword(str(page.get("description") or ""))
        for page in page_hints
        if display_keyword(str(page.get("description") or ""))
    ]
    keyword_topics = list(
        dict.fromkeys(
            display_keyword(row.keyword) for row in candidates[:30] if display_keyword(row.keyword)
        )
    )
    summary = (descriptions[0] if descriptions else "") or (
        f"{titles[0]} website" if titles else f"Website for {domain_label or context.domain}"
    )
    profile = normalize_profile(
        {
            "business_name": domain_label.title(),
            "business_type": titles[0] if titles else "Website",
            "business_summary": summary,
            "products_services": keyword_topics[:12],
            "target_audiences": [],
            "use_cases": [],
            "content_topics": keyword_topics[:20],
            "exclusion_terms": [],
            "confidence": 0.35,
            "evidence_summary": "Built from the domain, saved page hints and search keywords.",
            "extraction_method": "domain_keyword_fallback",
            "key_pages": page_hints,
        }
    )
    return profile


def deterministic_seed_topics(
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    language: str,
) -> list[dict[str, Any]]:
    business_model = infer_business_model(profile)
    default_intent = {
        "product": "product",
        "service": "service",
        "software": "product",
        "content": "informational",
        "mixed": "commercial",
    }[business_model]
    topics: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates, start=1):
        has_business_evidence = strong_seed_business_evidence(candidate, profile, language)
        provider_intent = normalize_keyword(str(candidate.raw.intent or ""))
        page_intent = (
            provider_intent
            if provider_intent in {"informational", "commercial"}
            else default_intent
        )
        topics.append(
            {
                "topic_rank": len(topics) + 1,
                "representative_id": f"k{index:03d}",
                "representative_keyword": candidate.keyword,
                "object": display_keyword(candidate.keyword)[:120],
                "need": f"{page_intent} search need",
                "page_intent": page_intent,
                "search_volume": candidate.raw.search_volume,
                "member_ids": (f"k{index:03d}",),
                "business_relevance": 0.65 if has_business_evidence else 0.5,
                "relevance_tier": (
                    "rule_supported_fallback"
                    if has_business_evidence
                    else "uncertain_fallback"
                ),
            }
        )
    return topics


def deterministic_topic_resolution(
    topics: list[dict[str, Any]],
    duplicate_pairs: list[TopicDuplicatePair],
) -> TopicSelectionResolution:
    ordered = sorted(
        topics,
        key=lambda topic: (
            -(int(topic["search_volume"]) if topic.get("search_volume") is not None else -1),
            int(topic.get("topic_rank") or 10**9),
            str(topic["representative_id"]),
        ),
    )
    return resolve_bounded_topic_seed_selection(
        [str(topic["representative_id"]) for topic in topics],
        duplicate_pairs,
        {
            "duplicate_pair_ids": [],
            "ranked": [str(topic["representative_id"]) for topic in ordered],
        },
    )


def preserve_topic_order_resolution(
    topics: list[dict[str, Any]],
) -> TopicSelectionResolution:
    topic_ids = [str(topic["representative_id"]) for topic in topics]
    return resolve_bounded_topic_seed_selection(
        topic_ids,
        [],
        {
            "duplicate_pair_ids": [],
            "ranked": topic_ids,
        },
        active_limit=len(topic_ids),
    )


def deterministic_keyword_classifications(
    candidates: list[MergedCandidate],
    seeds: list[dict[str, Any]],
    profile: dict[str, Any],
    language: str,
) -> list[KeywordClassification]:
    dictionaries = business_dictionaries(profile)
    seed_by_id = {str(seed["id"]): seed for seed in seeds}
    decisions: list[KeywordClassification] = []
    for candidate in candidates:
        primary_seed_id, relations = classify_candidate(candidate, seeds, language)
        relation_confidence = max((relation[1] for relation in relations), default=0.0)
        lexical_confidence = min(
            max(business_match_score(candidate.keyword, dictionaries, language) / 40, 0),
            1,
        )
        confidence = round(max(0.35, relation_confidence, lexical_confidence), 4)
        primary_seed = seed_by_id.get(primary_seed_id or "")
        decisions.append(
            KeywordClassification(
                candidate=candidate,
                relevant=True,
                business_topic=(
                    str(primary_seed.get("business_topic") or primary_seed["keyword"])
                    if primary_seed
                    else candidate.keyword
                ),
                confidence=confidence,
                review_status=(
                    "approved"
                    if max(relation_confidence, lexical_confidence) >= 0.5
                    else "needs_review"
                ),
                reason="deterministic_fallback",
                primary_seed_id=primary_seed_id,
                related_seed_ids=[
                    seed_id for seed_id, _, _ in relations if seed_id != primary_seed_id
                ][:4],
            )
        )
    return decisions


def activity_heartbeat(details: dict[str, Any]) -> None:
    try:
        activity.heartbeat(details)
    except RuntimeError:
        # Direct unit tests run activity methods outside a Temporal activity context.
        return


def application_error_code(error: BaseException | None) -> str:
    if error is None:
        return ""
    current: BaseException | None = error
    for _ in range(8):
        if isinstance(current, ApplicationError):
            return current.type or "keyword_provider_failed"
        current = getattr(current, "cause", None)
        if current is None:
            break
    return error.code if isinstance(error, ProviderError) else "keyword_provider_failed"


def normalize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    result = dict(profile)
    for field in (
        "products_services",
        "target_audiences",
        "use_cases",
        "content_topics",
        "exclusion_terms",
        "value_propositions",
        "conversion_actions",
    ):
        value = result.get(field)
        result[field] = (
            list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))
            if isinstance(value, list)
            else []
        )
    result["business_model"] = infer_business_model(result)
    return result


def validate_fallback_profile(payload: dict[str, Any]) -> dict[str, Any]:
    profile = normalize_profile(payload)
    profile["business_name"] = clean_text(payload.get("business_name"))
    profile["business_type"] = clean_text(payload.get("business_type"))
    profile["business_summary"] = clean_text(payload.get("business_summary"))
    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise ValueError("AI 临时业务资料缺少可信度")
    profile["confidence"] = min(max(float(confidence), 0), 1)
    profile["evidence_summary"] = clean_text(payload.get("evidence_summary"))
    if not (
        profile["business_summary"] or profile["products_services"] or profile["content_topics"]
    ):
        raise ValueError("AI 无法识别网站的最低可用业务信息")
    return profile


def validate_competitor_decision(
    payload: dict[str, Any],
    row_count: int,
) -> dict[str, Any]:
    status = str(payload.get("status") or "")
    if status not in {
        "confirmed",
        "skipped_unrelated",
        "skipped_uncertain",
    }:
        raise ValueError("AI 竞争关系判断状态无效")
    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise ValueError("AI 竞争关系判断缺少可信度")
    relevant_raw = payload.get("relevant_ids")
    relevant_indices: set[int] = set()
    if isinstance(relevant_raw, list):
        for value in relevant_raw:
            match = value if isinstance(value, str) else ""
            if match.startswith("g") and match[1:].isdigit():
                index = int(match[1:])
                if 1 <= index <= min(row_count, 100):
                    relevant_indices.add(index)
    if status == "confirmed" and not relevant_indices:
        raise ValueError("AI 确认竞争关系但没有给出相关差距词")
    return {
        "status": status,
        "confidence": min(max(float(confidence), 0), 1),
        "reason": clean_text(payload.get("reason")) or "竞争关系判断完成",
        "relevant_indices": relevant_indices,
    }


def accepted_gap_keywords(
    rows: list[CompetitorGap],
    *,
    relevant_indices: set[int],
    confidence: float,
    profile: dict[str, Any],
    language: str,
) -> dict[str, tuple[float, str]]:
    dictionaries = business_dictionaries(profile)
    accepted: dict[str, tuple[float, str]] = {}
    for index, row in enumerate(rows, start=1):
        lexical = business_match_score(row.keyword, dictionaries, language) / 40
        ai_selected = index in relevant_indices
        if not ai_selected and lexical < 0.25:
            continue
        relevance = max(lexical, confidence if ai_selected else 0)
        review_status = "active" if relevance >= 0.5 else "needs_review"
        accepted[normalize_keyword(row.keyword)] = (
            round(min(max(relevance, 0), 1), 4),
            review_status,
        )
    return accepted


def metric_from_candidate(candidate: MergedCandidate) -> dict[str, Any]:
    source_priority = {
        "keyword_overview": 4,
        "labs_site": 3,
        "google_ads_site": 2,
        "competitor_gap": 1,
    }
    rows = sorted(
        candidate.rows,
        key=lambda item: source_priority.get(item.source, 0),
        reverse=True,
    )

    def first_value(field: str) -> Any:
        for row in rows:
            value = getattr(row, field)
            if value is not None:
                return value
        return None

    competition_level = None
    monthly_searches: list[dict[str, Any]] = []
    raw_payload: dict[str, Any] = {}
    for row in reversed(rows):
        raw_payload.update(row.raw_payload)
    for row in rows:
        info = row.raw_payload.get("keyword_info")
        info = info if isinstance(info, dict) else {}
        if competition_level is None and info.get("competition_level") is not None:
            competition_level = info.get("competition_level")
        if not monthly_searches and row.monthly_searches:
            monthly_searches = list(row.monthly_searches)

    return {
        "search_volume": first_value("search_volume"),
        "cpc": first_value("cpc"),
        "competition": first_value("competition"),
        "competition_level": competition_level,
        "keyword_difficulty": first_value("keyword_difficulty"),
        "intent": first_value("intent"),
        "monthly_searches": monthly_searches,
        "raw_payload": raw_payload,
    }


def overview_required(metric: dict[str, Any]) -> bool:
    return metric.get("keyword_difficulty") is None or metric.get("intent") is None


def raw_keyword_metadata(row: RawKeyword) -> dict[str, Any]:
    return {
        "keyword": row.keyword,
        "source": row.source,
        "provider_rank": row.provider_rank,
        "search_volume": row.search_volume,
        "cpc": row.cpc,
        "competition": row.competition,
        "keyword_difficulty": row.keyword_difficulty,
        "intent": row.intent,
        "monthly_searches": row.monthly_searches,
        "raw_payload": row.raw_payload,
    }


def raw_keyword_from_metadata(value: Any) -> RawKeyword | None:
    if not isinstance(value, dict):
        return None
    keyword = display_keyword(str(value.get("keyword") or ""))
    if not keyword:
        return None
    return RawKeyword(
        keyword=keyword,
        source=str(value.get("source") or "keyword_overview"),
        provider_rank=int(value.get("provider_rank") or 0),
        search_volume=optional_int(value.get("search_volume")),
        cpc=optional_float(value.get("cpc")),
        competition=optional_float(value.get("competition")),
        keyword_difficulty=optional_int(value.get("keyword_difficulty")),
        intent=(display_keyword(str(value.get("intent") or "")) or None),
        monthly_searches=(
            list(value["monthly_searches"])
            if isinstance(value.get("monthly_searches"), list)
            else []
        ),
        raw_payload=(
            dict(value["raw_payload"]) if isinstance(value.get("raw_payload"), dict) else {}
        ),
    )


def optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def optional_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fallback_query_seeds(
    profile: dict[str, Any],
    domain: str,
    *,
    limit: int,
) -> list[str]:
    values: list[str] = []
    for field in ("products_services", "use_cases", "content_topics"):
        raw = profile.get(field)
        if isinstance(raw, list):
            values.extend(display_keyword(str(value)) for value in raw)
    values.extend(
        display_keyword(str(profile.get(field) or ""))
        for field in ("business_type", "business_name")
    )
    domain_label = display_keyword(domain.split(".", 1)[0].replace("-", " "))
    values.append(domain_label)
    return list(
        dict.fromkeys(
            value
            for value in values
            if value and len(value) <= 120 and normalize_keyword(value) != "website"
        )
    )[: max(limit, 0)]


def profile_seed_rows(
    profile: dict[str, Any],
    domain: str,
    *,
    limit: int,
) -> list[RawKeyword]:
    return [
        RawKeyword(
            keyword=keyword,
            source="profile_seed",
            provider_rank=index,
            raw_payload={"selection_origin": "confirmed_business_profile"},
        )
        for index, keyword in enumerate(
            fallback_query_seeds(profile, domain, limit=limit),
            start=1,
        )
    ]


def context_payload(context: KeywordRunContext) -> dict[str, Any]:
    return {
        "organization_id": context.organization_id,
        "project_id": context.project_id,
        "run_id": context.run_id,
        "kind": context.kind,
        "round_number": context.round_number,
        "domain": context.domain,
        "country": context.country,
        "language": context.language,
        "competitor_domain": context.competitor_domain,
    }


def stable_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def provider_application_error(error: ProviderError) -> ApplicationError:
    code = error.code
    if error.failure_status == CHARGED_FAILURE:
        code = "external_request_charged_failure"
    elif error.failure_status == UNCERTAIN_FAILURE:
        code = "external_request_uncertain"
    return ApplicationError(
        str(error),
        type=code,
        non_retryable=not error.transient,
    )


def clean_text(value: Any) -> str:
    return " ".join(value.strip().split())[:5000] if isinstance(value, str) else ""


def human_failure_message(code: str) -> str:
    messages = {
        "dataforseo_not_configured": "搜索数据服务尚未配置",
        "dataforseo_auth_failed": "搜索数据服务凭证无效",
        "ai_not_configured": "AI 服务尚未配置，关键词库暂时无法创建",
        "business_profile_unavailable": "网站业务暂时无法识别",
        "site_seed_empty": "没有找到可用的网站关键词",
        "seed_candidates_empty": "没有找到可用于拓展的种子词",
        "invalid_ai_seed_response": "AI 未能正确完成种子词分析",
        "invalid_ai_classification": "AI 未能正确完成关键词分类",
        "expanded_keywords_empty": "没有找到可加入关键词库的结果",
        "active_seeds_empty": "没有可用于拓展的种子词",
    }
    return messages.get(code, "关键词库创建失败，请稍后重试")


def empty_result_message(code: str) -> str:
    messages = {
        "site_seed_empty": "数据源未发现该网站的可用关键词",
        "seed_candidates_empty": "未发现与网站业务匹配的种子词",
        "active_seeds_empty": "未发现可用于拓展的种子主题",
        "expanded_keywords_empty": "拓展结果中未发现可加入关键词库的词",
    }
    return messages.get(code, "暂未发现可加入关键词库的结果")


def blocked_run_presentation(code: str, delayed_retry: bool) -> tuple[str, str]:
    if code == "dataforseo_not_configured":
        return "waiting_for_configuration", "等待搜索数据服务配置后自动继续"
    if code == "dataforseo_auth_failed":
        return "waiting_for_configuration", "搜索数据服务凭证需要更新"
    if code == "ai_not_configured":
        return "waiting_for_configuration", "等待 AI 服务配置后自动继续"
    if code == "ai_auth_failed":
        return "waiting_for_configuration", "AI 服务凭证需要更新"
    if code in {"unsupported_country", "unsupported_language"}:
        return "waiting_for_project_update", "当前国家或语言暂不受数据源支持"
    if code in {
        "external_request_charged_failure",
        "external_request_uncertain",
    }:
        return "waiting_for_reconciliation", "外部请求结果待确认，系统不会重复提交"
    if delayed_retry:
        return "delayed", "外部服务持续繁忙，任务已转入后台延迟队列"
    return "blocked", "关键词任务暂时无法继续，系统已保留当前进度"
