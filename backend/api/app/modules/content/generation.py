from __future__ import annotations

import asyncio
import hashlib
import json
import re
from copy import deepcopy
from typing import Any

from app.core.config import Settings
from app.modules.content.collection import _collect_research
from app.modules.content.competitor_analysis import (
    analyze_competitor,
    build_competitor_blueprint,
)
from app.modules.content.object_storage import S3ArtifactStore, S3TextReader, StoredTextError
from app.modules.content.quality import (
    ContentScorer,
    article_markdown,
    deterministic_quality_check,
    project_domain_matches,
    restore_link_only_claims,
    sanitize_allowed_links,
    sanitize_internal_links,
    sanitize_sections,
    sanitize_markdown_links,
)
from app.modules.content.repository import ContentRepository
from app.modules.content.serp_analysis import analyze_serp, serp_analysis_needs_refresh
from app.modules.content.source_verification import verify_source_claims
from app.modules.content.writing_gateway import (
    ArticleContract,
    ArticlePlan,
    ContractSection,
    EvidenceClaim,
    OutlineSection,
    RevisedSections,
    SectionDraft,
    SectionIssue,
    SemanticQualityResult,
    UnifiedArticle,
    WritingGateway,
    WritingOutputError,
    WritingRequestError,
    WritingResult,
    merge_usage,
)


def artifact_store(settings: Settings) -> S3ArtifactStore:
    return S3ArtifactStore(settings)


def writing_gateway(context: dict[str, Any] | None = None) -> WritingGateway:
    current = context or {}
    return WritingGateway(current.get("model_snapshot"))


def writing_failure(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, (WritingRequestError, WritingOutputError)):
        return {
            "code": exc.code,
            "attempts": int(getattr(exc, "attempts", 0)),
            "format_attempts": int(getattr(exc, "format_attempts", 0)),
        }
    return {"code": "writing_unexpected_error", "attempts": 0, "format_attempts": 0}


async def cached_generate(
    gateway: WritingGateway,
    settings: Settings,
    context: dict[str, Any],
    call_type: str,
    payload: dict[str, Any],
    output_type: type[Any],
) -> WritingResult[Any]:
    canonical = json.dumps(
        {
            "run_id": context.get("run_id"),
            "step_key": context.get("step_key"),
            "repair_iteration": context.get("repair_iteration", 0),
            "call_type": call_type,
            "payload": payload,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    request_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    key = (
        f"article-runs/{context['run_id']}/model-calls/"
        f"{call_type}-{request_key}.json.gz"
    )
    store = artifact_store(settings)
    try:
        cached = await store.read_json(f"s3://{settings.s3_bucket}/{key}")
        value = output_type.model_validate(cached["value"])
        return WritingResult(
            value=value,
            model=str(cached.get("model") or "cached"),
            base_url=str(cached.get("base_url") or "cached"),
            provider_request_id=cached.get("provider_request_id"),
            usage=dict(cached.get("usage") or {}),
        )
    except Exception:
        pass
    if isinstance(gateway, WritingGateway):
        generation_call = gateway.generate(
            call_type, payload, output_type, request_key=request_key
        )
    else:
        generation_call = gateway.generate(call_type, payload, output_type)
    request = asyncio.create_task(generation_call)
    cancelled = False
    try:
        result = await asyncio.shield(request)
    except asyncio.CancelledError:
        cancelled = True
        result = await request
    cache_payload = {
        "kind": "article_model_call",
        "request_key": request_key,
        "call_type": call_type,
        "value": result.value.model_dump(mode="json"),
        "model": str(getattr(result, "model", "")),
        "base_url": str(getattr(result, "base_url", "")),
        "provider_request_id": getattr(result, "provider_request_id", None),
        "usage": result.usage,
    }
    cache_write = asyncio.create_task(store.write_json(key, cache_payload))
    try:
        await asyncio.shield(cache_write)
    except asyncio.CancelledError:
        cancelled = True
        await cache_write
    if cancelled:
        raise asyncio.CancelledError
    return result


async def plan_article(
    repo: ContentRepository,
    settings: Settings,
    context: dict[str, Any],
    policy: dict[str, bool],
) -> dict[str, Any]:
    run_id = str(context["run_id"])
    pack = await build_research_pack(repo, settings, context)
    store = artifact_store(settings)
    warnings: list[dict[str, str]] = []
    usage: dict[str, Any] | None = None
    model_failure = None
    try:
        result = await cached_generate(
            writing_gateway(context),
            settings,
            context,
            "plan_article",
            {"research_pack": pack},
            ArticlePlan,
        )
        raw_plan = result.value
        supplemental_queries = _supplemental_research_queries(raw_plan, pack)
        if supplemental_queries:
            try:
                supplemental_warning, supplemental_count = await _collect_research(
                    repo,
                    settings,
                    run_id,
                    str(pack["keyword"]),
                    dict(pack.get("project") or {}),
                    supplemental_queries,
                )
                if supplemental_count:
                    pack = await build_research_pack(repo, settings, context)
            except Exception:
                supplemental_warning = "research_unavailable"
            if supplemental_warning:
                warnings.append(
                    _warning(
                        "supplemental_research_degraded",
                        "关键事实补充研究暂不可用，已按现有证据边界继续生成完整稿",
                    )
                )
        plan = normalize_plan(raw_plan, pack)
        usage = result.usage
    except Exception as exc:
        plan = fallback_plan(pack)
        model_failure = writing_failure(exc)
        warnings.append(_warning("planning_degraded", "大纲增强暂不可用，已使用基础结构继续"))
    pack["search_intent"] = plan.search_intent
    pack["article_type"] = plan.article_type
    pack["evidence_claims"] = [item.model_dump(mode="json") for item in plan.claims]
    pack_ref = await store.write_json(
        f"article-runs/{run_id}/planning/research-pack.json.gz", pack
    )
    await repo.bind_plan_sources(run_id, plan.model_dump(mode="json"))
    artifact = {
        "kind": "article_plan",
        "research_pack_ref": pack_ref,
        "plan": plan.model_dump(mode="json"),
    }
    output_ref = await store.write_json(
        f"article-runs/{run_id}/planning/plan.json.gz", artifact
    )
    return {
        "output_ref": output_ref,
        "warnings": warnings,
        "summary": {
            "section_count": len(plan.sections),
            "claim_count": len(plan.claims),
            "research_pack_ref": pack_ref,
            "model_failure": model_failure,
        },
        "usage": usage,
    }


async def write_article_sections(
    repo: ContentRepository,
    settings: Settings,
    context: dict[str, Any],
    policy: dict[str, bool],
) -> dict[str, Any]:
    del repo, policy
    run_id = str(context["run_id"])
    planning = await _required_stage_artifact(settings, context, "planning")
    pack = await artifact_store(settings).read_json(str(planning["research_pack_ref"]))
    plan = _ensure_article_contract(ArticlePlan.model_validate(planning["plan"]), pack)
    allowed_sources, allowed_internal = allowed_urls(pack)
    warnings: list[dict[str, str]] = []
    model_failures: list[dict[str, Any]] = []
    gateway = writing_gateway(context)
    semaphore = asyncio.Semaphore(settings.article_writing_max_concurrency)

    async def write_one(
        section: OutlineSection, previous_summaries: list[str]
    ) -> tuple[SectionDraft, dict[str, Any]]:
        key = f"article-runs/{run_id}/writing/{section.section_id}.json.gz"
        store = artifact_store(settings)
        try:
            existing = await store.read_json(f"s3://{settings.s3_bucket}/{key}")
            if existing.get("write_and_edit_completed") is True:
                return SectionDraft.model_validate(existing["section"]), dict(existing.get("usage") or {})
        except Exception:
            pass
        usages: list[dict[str, Any]] = []
        async with semaphore:
            draft = await _generate_section_with_retry(
                gateway,
                settings,
                context,
                plan,
                section,
                pack,
                previous_summaries,
                section_payload(
                    plan, section, pack, previous_summaries, compact=False
                ),
                usages,
                warnings,
                model_failures,
            )
            draft = normalize_section(draft, section)
            draft = sanitize_sections(
                [draft],
                plan,
                allowed_source_urls=allowed_sources,
                allowed_internal_urls=allowed_internal,
            )[0]
            if not _has_section_prose(draft.markdown):
                draft = concise_section_fallback(
                    section, str(pack.get("language") or "en"), pack, plan
                )
                warnings.append(
                    _warning("writing_degraded", "部分章节已按精简版本完成")
                )
        usage = merge_usage(usages)
        await store.write_json(
            key,
            {
                "kind": "article_section",
                "section": draft.model_dump(mode="json"),
                "usage": usage,
                "write_and_edit_completed": True,
            },
        )
        return draft, usage

    body_plans = [
        item
        for item in plan.sections
        if item.section_type not in {"intro", "conclusion", "faq"}
    ]
    body_results: list[tuple[SectionDraft, dict[str, Any]]] = []
    if body_plans:
        body_results.append(await write_one(body_plans[0], []))
        batch_size = settings.article_writing_max_concurrency
        for offset in range(1, len(body_plans), batch_size):
            previous_summaries = [
                _section_context_summary(item[0]) for item in body_results[-2:]
            ]
            batch = body_plans[offset : offset + batch_size]
            body_results.extend(
                await asyncio.gather(
                    *(write_one(item, previous_summaries) for item in batch)
                )
            )
    body_summaries = [
        _section_context_summary(item[0]) for item in body_results[-2:]
    ]
    supporting_results = await asyncio.gather(
        *(
            write_one(item, body_summaries)
            for item in plan.sections
            if item.section_type in {"intro", "conclusion", "faq"}
        )
    )
    result_by_id = {
        draft.section_id: (draft, usage)
        for draft, usage in [*body_results, *supporting_results]
    }
    results = [result_by_id[item.section_id] for item in plan.sections]
    sections = [item[0] for item in results]
    usage = merge_usage([item[1] for item in results])
    degraded_section_ids = [
        item.section_id
        for item in sections
        if item.summary.startswith("degraded_fallback:")
    ]
    artifact = article_artifact(
        plan, sections, pack, degraded_section_ids=degraded_section_ids
    )
    output_ref = await artifact_store(settings).write_json(
        f"article-runs/{run_id}/writing/draft.json.gz", artifact
    )
    return {
        "output_ref": output_ref,
        "warnings": list({item["code"]: item for item in warnings}.values()),
        "summary": {
            "section_count": len(sections),
            "complete": len(sections) == len(plan.sections),
            "model_failures": model_failures,
        },
        "usage": usage,
    }


async def _generate_section_with_retry(
    gateway: WritingGateway,
    settings: Settings,
    context: dict[str, Any],
    plan: ArticlePlan,
    section: OutlineSection,
    pack: dict[str, Any],
    previous_summaries: list[str],
    payload: dict[str, Any],
    usages: list[dict[str, Any]],
    warnings: list[dict[str, str]],
    model_failures: list[dict[str, Any]],
) -> SectionDraft:
    try:
        result = await cached_generate(
            gateway, settings, context, "write_and_edit_section", payload, SectionDraft
        )
        usages.append(result.usage)
        return result.value
    except Exception as exc:
        model_failures.append(
            {
                "section_id": section.section_id,
                "mode": "full",
                **writing_failure(exc),
            }
        )
        try:
            result = await cached_generate(
                gateway,
                settings,
                context,
                "write_and_edit_section",
                section_payload(
                    plan, section, pack, previous_summaries, compact=True
                ),
                SectionDraft,
            )
            usages.append(result.usage)
            return result.value
        except Exception as compact_exc:
            model_failures.append(
                {
                    "section_id": section.section_id,
                    "mode": "compact",
                    **writing_failure(compact_exc),
                }
            )
            warnings.append(
                _warning(
                    "writing_degraded",
                    "部分章节已按精简版本完成",
                )
            )
            return fallback_section(
                section, str(pack.get("language") or "en"), pack, plan
            )


async def _apply_content_quality_loop(
    gateway: WritingGateway,
    settings: Settings,
    context: dict[str, Any],
    plan: ArticlePlan,
    sections: list[SectionDraft],
    pack: dict[str, Any],
    allowed_sources: set[str],
    allowed_internal: set[str],
    *,
    existing_history: list[dict[str, Any]] | None = None,
    existing_revision_count: int = 0,
) -> tuple[
    ArticlePlan,
    list[SectionDraft],
    dict[str, Any],
    list[dict[str, Any]],
    int,
    list[dict[str, str]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    current = _rebind_sections_to_markdown(sections, plan, allowed_sources, allowed_internal)
    warnings: list[dict[str, str]] = []
    model_failures: list[dict[str, Any]] = []
    usages: list[dict[str, Any]] = []
    content_score_history = list(existing_history or [])
    revision_count = existing_revision_count
    scorer = ContentScorer()

    def score_current(current_plan: ArticlePlan, current_sections: list[SectionDraft]) -> dict[str, Any]:
        return scorer.score(
            article_markdown(current_plan.title, current_sections),
            {
                "meta_title": current_plan.meta_title,
                "meta_description": current_plan.meta_description,
                "primary_keyword": pack["keyword"],
                "language": pack.get("language") or "en",
            },
        )

    score = score_current(plan, current)
    content_score_history.append({**score, "accepted": True, "candidate": "baseline"})
    for revision_iteration in range(existing_revision_count + 1, 3):
        if score["passed"] or not score["priority_fixes"]:
            break
        try:
            result = await cached_generate(
                gateway,
                settings,
                context,
                "revise_quality",
                {
                    "iteration": revision_iteration,
                    "article": {
                        "title": plan.title,
                        "meta_title": plan.meta_title,
                        "meta_description": plan.meta_description,
                        "slug": plan.slug,
                        "sections": [item.model_dump(mode="json") for item in current],
                    },
                    "priority_fixes": score["priority_fixes"][:5],
                    "locked_requirements": _locked_requirements(pack),
                },
                UnifiedArticle,
            )
            candidate = normalize_unified(
                result.value,
                plan,
                current,
                locked_title=_locked_title(pack),
            )
            candidate_plan = plan.model_copy(
                update={
                    "title": candidate.title,
                    "meta_title": candidate.meta_title,
                    "meta_description": candidate.meta_description,
                    "slug": candidate.slug,
                }
            )
            candidate_sections = sanitize_sections(
                candidate.sections,
                candidate_plan,
                allowed_source_urls=allowed_sources,
                allowed_internal_urls=allowed_internal,
            )
            candidate_sections = _rebind_sections_to_markdown(
                candidate_sections, candidate_plan, allowed_sources, allowed_internal
            )
            usages.append(result.usage)
            revision_count += 1
            candidate_score = score_current(candidate_plan, candidate_sections)
            accepted, reasons = _candidate_improves_article(
                plan,
                current,
                score,
                candidate_plan,
                candidate_sections,
                candidate_score,
                allowed_sources,
                allowed_internal,
                _competitor_passages(pack),
            )
            content_score_history.append(
                {
                    **candidate_score,
                    "accepted": accepted,
                    "candidate": f"quality_revision_{revision_iteration}",
                    "rejection_reasons": reasons,
                }
            )
            if accepted:
                plan = candidate_plan
                current = candidate_sections
                score = candidate_score
        except Exception as exc:
            model_failures.append(
                {
                    "mode": "quality_revision",
                    "iteration": revision_iteration,
                    **writing_failure(exc),
                }
            )
            warnings.append(
                _warning(
                    "content_quality_revision_degraded",
                    "内容质量修订暂不可用，已保留当前完整稿",
                )
            )
            break
    if not score["passed"]:
        warnings.append(
            _warning(
                "content_quality_below_threshold",
                "文章已保留完整稿；五维内容评分仍低于 70，已保存评分和自动修订结果",
            )
        )
    return (
        plan,
        current,
        score,
        content_score_history,
        revision_count,
        warnings,
        model_failures,
        usages,
    )


_MARKDOWN_LINK_PATTERN = re.compile(r"\[[^\]]+\]\((https?://[^\s)]+)\)")


def _rebind_sections_to_markdown(
    sections: list[SectionDraft],
    plan: ArticlePlan,
    allowed_sources: set[str],
    allowed_internal: set[str],
) -> list[SectionDraft]:
    claims_by_section: dict[str, list[EvidenceClaim]] = {}
    for claim in plan.claims:
        if claim.supported and claim.section_id and claim.source_url in allowed_sources:
            claims_by_section.setdefault(claim.section_id, []).append(claim)
    rebound: list[SectionDraft] = []
    for section in sections:
        links = set(_MARKDOWN_LINK_PATTERN.findall(section.markdown))
        claims = claims_by_section.get(section.section_id, [])
        source_urls = sorted({item.source_url for item in claims if item.source_url in links})
        rebound.append(
            section.model_copy(
                update={
                    "used_claim_ids": [
                        item.claim_id for item in claims if item.source_url in links
                    ],
                    "used_source_urls": source_urls,
                    "used_internal_urls": sorted(links.intersection(allowed_internal)),
                }
            )
        )
    return rebound


def _score_article_content(
    scorer: ContentScorer,
    plan: ArticlePlan,
    sections: list[SectionDraft],
    pack: dict[str, Any],
) -> dict[str, Any]:
    return scorer.score(
        article_markdown(plan.title, sections),
        {
            "meta_title": plan.meta_title,
            "meta_description": plan.meta_description,
            "primary_keyword": pack["keyword"],
            "language": pack.get("language") or "en",
        },
    )


def _candidate_improves_article(
    baseline_plan: ArticlePlan,
    baseline_sections: list[SectionDraft],
    baseline_score: dict[str, Any],
    candidate_plan: ArticlePlan,
    candidate_sections: list[SectionDraft],
    candidate_score: dict[str, Any],
    allowed_sources: set[str],
    allowed_internal: set[str],
    competitor_passages: list[str],
    *,
    require_measurable_improvement: bool = True,
) -> tuple[bool, list[str]]:
    baseline_report = deterministic_quality_check(
        baseline_plan,
        baseline_sections,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
        competitor_passages=competitor_passages,
    )
    candidate_report = deterministic_quality_check(
        candidate_plan,
        candidate_sections,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
        competitor_passages=competitor_passages,
    )
    baseline_links = {
        url
        for section in baseline_sections
        for url in _MARKDOWN_LINK_PATTERN.findall(section.markdown)
        if url in allowed_sources
    }
    candidate_links = {
        url
        for section in candidate_sections
        for url in _MARKDOWN_LINK_PATTERN.findall(section.markdown)
        if url in allowed_sources
    }
    baseline_claims = {
        claim_id for section in baseline_sections for claim_id in section.used_claim_ids
    }
    candidate_claims = {
        claim_id for section in candidate_sections for claim_id in section.used_claim_ids
    }
    baseline_present = int(baseline_report.checks.get("present_sections") or 0)
    candidate_present = int(candidate_report.checks.get("present_sections") or 0)
    reasons: list[str] = []
    if not baseline_links.issubset(candidate_links):
        reasons.append("citation_links_lost")
    if not baseline_claims.issubset(candidate_claims):
        reasons.append("claim_bindings_lost")
    if candidate_present < baseline_present:
        reasons.append("contract_coverage_reduced")
    if len(candidate_report.issues) > len(baseline_report.issues):
        reasons.append("hard_issues_increased")
    hard_improved = len(candidate_report.issues) < len(baseline_report.issues)
    score_improved = float(candidate_score.get("composite_score") or 0) > float(
        baseline_score.get("composite_score") or 0
    )
    if require_measurable_improvement and not hard_improved and not score_improved:
        reasons.append("no_quality_improvement")
    return not reasons, reasons


async def unify_article(
    repo: ContentRepository,
    settings: Settings,
    context: dict[str, Any],
    policy: dict[str, bool],
) -> dict[str, Any]:
    del repo, policy
    run_id = str(context["run_id"])
    draft = await _required_stage_artifact(settings, context, "writing")
    current = [SectionDraft.model_validate(item) for item in draft["sections"]]
    pack = await _pack_from_context(settings, context)
    plan = _ensure_article_contract(ArticlePlan.model_validate(draft["plan"]), pack)
    allowed_sources, allowed_internal = allowed_urls(pack)
    warnings: list[dict[str, str]] = []
    usages: list[dict[str, Any]] = []
    model_failures: list[dict[str, Any]] = []
    gateway = writing_gateway(context)
    try:
        result = await cached_generate(
            gateway,
            settings,
            context,
            "unify_article",
            {
                "plan": plan.model_dump(mode="json"),
                "sections": [item.model_dump(mode="json") for item in current],
                "locked_requirements": _locked_requirements(pack),
            },
            UnifiedArticle,
        )
        candidate = normalize_unified(
            result.value,
            plan,
            current,
            locked_title=_locked_title(pack),
        )
        candidate_plan = plan.model_copy(
            update={
                "title": candidate.title,
                "meta_title": candidate.meta_title,
                "meta_description": candidate.meta_description,
                "slug": candidate.slug,
            }
        )
        candidate_sections = sanitize_sections(
            candidate.sections,
            candidate_plan,
            allowed_source_urls=allowed_sources,
            allowed_internal_urls=allowed_internal,
        )
        candidate_sections = _rebind_sections_to_markdown(
            candidate_sections, candidate_plan, allowed_sources, allowed_internal
        )
        candidate_changed = candidate_plan != plan or candidate_sections != current
        if candidate_changed:
            scorer = ContentScorer()
            baseline_score = _score_article_content(scorer, plan, current, pack)
            candidate_score = _score_article_content(
                scorer, candidate_plan, candidate_sections, pack
            )
            accepted, rejection_reasons = _candidate_improves_article(
                plan,
                current,
                baseline_score,
                candidate_plan,
                candidate_sections,
                candidate_score,
                allowed_sources,
                allowed_internal,
                _competitor_passages(pack),
            )
            if accepted:
                plan = candidate_plan
                current = candidate_sections
            else:
                warnings.append(
                    _warning(
                        "editing_candidate_rejected",
                        "Unified editing was discarded because it did not improve the protected draft.",
                    )
                )
                model_failures.append(
                    {"mode": "unify_candidate_rejected", "reasons": rejection_reasons}
                )
        usages.append(result.usage)
    except Exception as exc:
        model_failures.append({"mode": "unify", **writing_failure(exc)})
        warnings.append(
            _warning("editing_degraded", "全文编辑暂不可用，已保留合并后的完整稿")
        )
    current = sanitize_sections(
        current,
        plan,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
    )
    (
        plan,
        current,
        score,
        content_score_history,
        content_score_revision_count,
        quality_warnings,
        quality_failures,
        quality_usages,
    ) = await _apply_content_quality_loop(
        gateway,
        settings,
        context,
        plan,
        current,
        pack,
        allowed_sources,
        allowed_internal,
    )
    warnings.extend(quality_warnings)
    model_failures.extend(quality_failures)
    usages.extend(quality_usages)
    artifact = article_artifact(
        plan,
        current,
        pack,
        degraded_section_ids=list(draft.get("degraded_section_ids") or []),
    )
    artifact["content_score"] = score
    artifact["content_score_history"] = content_score_history
    artifact["content_score_revision_count"] = content_score_revision_count
    output_ref = await artifact_store(settings).write_json(
        f"article-runs/{run_id}/editing/article.json.gz", artifact
    )
    return {
        "output_ref": output_ref,
        "warnings": list({item["code"]: item for item in warnings}.values()),
        "warning": warnings[0] if warnings else None,
        "summary": {
            "section_count": len(current),
            "complete": True,
            "content_score": score["composite_score"],
            "content_score_passed": score["passed"],
            "content_score_iterations": content_score_revision_count,
            "model_failures": model_failures,
        },
        "usage": merge_usage(usages),
    }


async def check_article(
    repo: ContentRepository,
    settings: Settings,
    context: dict[str, Any],
    policy: dict[str, bool],
) -> dict[str, Any]:
    del repo
    run_id = str(context["run_id"])
    input_step_key = str(context.get("input_step_key") or "editing")
    current = await _required_stage_artifact(settings, context, input_step_key)
    sections = [SectionDraft.model_validate(item) for item in current["sections"]]
    pack = await _pack_from_context(settings, context)
    plan = _ensure_article_contract(ArticlePlan.model_validate(current["plan"]), pack)
    allowed_sources, allowed_internal = allowed_urls(pack)
    conversion_actions = list(
        ((pack.get("project") or {}).get("profile") or {}).get("conversion_actions")
        or []
    )
    sections = sanitize_sections(
        sections,
        plan,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
    )
    deterministic = deterministic_quality_check(
        plan,
        sections,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
        competitor_passages=_competitor_passages(pack),
    )
    issues = list(deterministic.issues)
    warnings: list[dict[str, str]] = []
    usage = None
    check_status = "completed"
    model_failure = None
    expected_locked_requirements = _locked_requirements(pack)
    locked_requirement_checks: list[dict[str, Any]] = []
    try:
        result = await cached_generate(
            writing_gateway(context),
            settings,
            context,
            "check_article",
            {
                "keyword": pack["keyword"],
                "search_intent": plan.search_intent,
                "required_questions": pack["required_questions"],
                "plan": plan.model_dump(mode="json"),
                "article_contract": plan.contract.model_dump(mode="json"),
                "sections": [item.model_dump(mode="json") for item in sections],
                "section_requirements": _section_requirements(plan.sections),
                "conversion_actions": conversion_actions,
                "locked_requirements": expected_locked_requirements,
            },
            SemanticQualityResult,
        )
        issues.extend(result.value.issues)
        locked_requirement_checks = [
            item.model_dump(mode="json")
            for item in result.value.locked_requirement_checks
        ]
        checks_by_key = {
            (item["field"], item["requirement"]): item
            for item in locked_requirement_checks
        }
        for requirement in expected_locked_requirements:
            check = checks_by_key.get(
                (requirement["field"], requirement["requirement"])
            )
            if check is None or check["passed"] is not True:
                issues.append(
                    SectionIssue(
                        section_id=plan.sections[0].section_id,
                        code="locked_requirement_failed",
                        message=(
                            "The generated article did not satisfy the locked writing "
                            "direction."
                        ),
                    )
                )
        usage = result.usage
    except Exception as exc:
        model_failure = writing_failure(exc)
        check_status = "unavailable"
        warnings.append(
            _warning("checking_degraded", "检查服务暂不可用，已保留确定性检查结果")
        )
    for section_id in current.get("degraded_section_ids") or []:
        issues.append(
            SectionIssue(
                section_id=str(section_id),
                code="fallback_section",
                message="章节使用了确定性降级稿，需要自动重写并重新检查",
            )
        )
    unique = list(
        {
            (item.section_id, item.code): _classify_quality_issue(item)
            for item in issues
        }.values()
    )
    repairable_issues = [item for item in unique if item.repairable]
    repair_scope = sorted(
        {item.section_id for item in repairable_issues if item.section_id}
    )
    repairable = check_status == "completed" and bool(repair_scope)
    passed = check_status == "completed" and not unique
    issue_fingerprint = _issue_fingerprint(unique)
    repairable_issue_fingerprint = _issue_fingerprint(repairable_issues)
    evidence_issue_count = sum(
        1
        for item in unique
        if item.category == "evidence" and not item.repairable
    )
    artifact = article_artifact(
        plan,
        sections,
        pack,
        degraded_section_ids=list(current.get("degraded_section_ids") or []),
    )
    _copy_content_score(artifact, current)
    artifact["quality"] = {
        **deterministic.to_dict(),
        "passed": passed,
        "check_status": check_status,
        "repairable": repairable,
        "repair_scope": repair_scope,
        "issue_fingerprint": issue_fingerprint,
        "repairable_issue_fingerprint": repairable_issue_fingerprint,
        "repairable_issue_count": len(repairable_issues),
        "evidence_issue_count": evidence_issue_count,
        "issues": [item.model_dump(mode="json") for item in unique],
        "locked_requirement_checks": locked_requirement_checks,
        "required_questions": {
            "total": len(pack.get("required_questions", [])),
            "covered": _covered_questions(pack.get("required_questions", []), sections),
        },
    }
    content_score = current.get("content_score")
    content_score_summary = (
        {
            "content_score": content_score.get("composite_score"),
            "content_score_passed": content_score.get("passed") is True,
        }
        if isinstance(content_score, dict)
        else {}
    )
    output_ref = await artifact_store(settings).write_json(
        f"article-runs/{run_id}/{context.get('step_key') or 'checking'}/article.json.gz",
        artifact,
    )
    return {
        "output_ref": output_ref,
        "warnings": warnings,
        "summary": {
            "issue_count": len(unique),
            "passed": passed,
            "check_status": check_status,
            "repairable": repairable,
            "repair_scope": repair_scope,
            "issue_fingerprint": issue_fingerprint,
            "repairable_issue_fingerprint": repairable_issue_fingerprint,
            "repairable_issue_count": len(repairable_issues),
            "evidence_issue_count": evidence_issue_count,
            "model_failure": model_failure,
            **content_score_summary,
        },
        "usage": usage,
    }


async def revise_article_sections(
    repo: ContentRepository,
    settings: Settings,
    context: dict[str, Any],
    policy: dict[str, bool],
) -> dict[str, Any]:
    del repo, policy
    run_id = str(context["run_id"])
    input_step_key = str(context.get("input_step_key") or "checking")
    checked = await _required_stage_artifact(settings, context, input_step_key)
    sections = [SectionDraft.model_validate(item) for item in checked["sections"]]
    quality = dict(checked.get("quality") or {})
    issues = [
        item
        for item in quality.get("issues") or []
        if bool(item.get("repairable", True))
    ]
    if quality.get("repairable") is False:
        return {
            "output_ref": str(context["completed_steps"][input_step_key]["output_ref"]),
            "summary": {
                "revised_sections": 0,
                "passed": bool(quality.get("passed")),
                "repairable": False,
            },
        }
    if not issues:
        return {
            "output_ref": str(context["completed_steps"][input_step_key]["output_ref"]),
            "summary": {"revised_sections": 0, "passed": True},
        }
    pack = await _pack_from_context(settings, context)
    plan = _ensure_article_contract(ArticlePlan.model_validate(checked["plan"]), pack)
    allowed_sources, allowed_internal = allowed_urls(pack)
    if "repair_scope" in quality:
        repair_scope = {
            str(item) for item in quality.get("repair_scope") or [] if str(item)
        }
    else:
        repair_scope = {
            str(item.get("section_id")) for item in issues if item.get("section_id")
        }
    failed_ids = {
        str(item.get("section_id"))
        for item in issues
        if item.get("section_id") and str(item.get("section_id")) in repair_scope
    }
    issues = [item for item in issues if str(item.get("section_id")) in failed_ids]
    if not failed_ids:
        return {
            "output_ref": str(context["completed_steps"][input_step_key]["output_ref"]),
            "summary": {
                "revised_sections": 0,
                "passed": bool(quality.get("passed")),
                "repairable": False,
            },
        }
    failed_plans = [item for item in plan.sections if item.section_id in failed_ids]
    failed_claim_ids = {
        claim_id for item in failed_plans for claim_id in item.claim_ids
    }
    conversion_actions = list(
        ((pack.get("project") or {}).get("profile") or {}).get("conversion_actions")
        or []
    )
    warnings: list[dict[str, str]] = []
    usages: list[dict[str, Any]] = []
    model_failure = None
    quality_failures: list[dict[str, Any]] = []
    try:
        result = await cached_generate(
            writing_gateway(context),
            settings,
            context,
            "revise_sections",
            {
                "issues": issues,
                "article_contract": plan.contract.model_dump(mode="json"),
                "sections": [
                    item.model_dump(mode="json")
                    for item in sections
                    if item.section_id in failed_ids
                ],
                "section_plans": [
                    item.model_dump(mode="json") for item in failed_plans
                ],
                "section_contracts": [
                    _section_contract_payload(plan, item.section_id)
                    for item in failed_plans
                ],
                "section_requirements": _section_requirements(failed_plans),
                "conversion_actions": (
                    conversion_actions
                    if any(item.cta_type for item in failed_plans)
                    else []
                ),
                "locked_requirements": _locked_requirements(pack),
                "claims": [
                    item.model_dump(mode="json")
                    for item in plan.claims
                    if item.claim_id in failed_claim_ids
                ],
            },
            RevisedSections,
        )
        replacements = {
            item.section_id: item
            for item in result.value.sections
            if item.section_id in failed_ids and _has_section_prose(item.markdown)
        }
        if not replacements:
            raise WritingOutputError("writing_revision_empty")
        candidate_ids = set(replacements)
        baseline_sections = _rebind_sections_to_markdown(
            sections, plan, allowed_sources, allowed_internal
        )
        candidate_sections = [
            replacements.get(item.section_id, item) for item in baseline_sections
        ]
        candidate_sections = sanitize_sections(
            candidate_sections,
            plan,
            allowed_source_urls=allowed_sources,
            allowed_internal_urls=allowed_internal,
        )
        candidate_sections = _rebind_sections_to_markdown(
            candidate_sections, plan, allowed_sources, allowed_internal
        )
        scorer = ContentScorer()
        baseline_score = _score_article_content(scorer, plan, baseline_sections, pack)
        candidate_score = _score_article_content(scorer, plan, candidate_sections, pack)
        accepted, rejection_reasons = _candidate_improves_article(
            plan,
            baseline_sections,
            baseline_score,
            plan,
            candidate_sections,
            candidate_score,
            allowed_sources,
            allowed_internal,
            _competitor_passages(pack),
            require_measurable_improvement=False,
        )
        if accepted:
            sections = candidate_sections
            revised_ids = candidate_ids
        else:
            sections = baseline_sections
            revised_ids = set()
            warnings.append(
                _warning(
                    "revision_candidate_rejected",
                    "Section revisions were discarded because they did not improve the protected draft.",
                )
            )
            quality_failures.append(
                {"mode": "revision_candidate_rejected", "reasons": rejection_reasons}
            )
        usages.append(result.usage)
    except Exception as exc:
        model_failure = writing_failure(exc)
        revised_ids = set()
        warnings.append(
            _warning("revising_degraded", "局部修订暂不可用，已保存修订前完整稿")
        )
    sections = sanitize_sections(
        sections,
        plan,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
    )
    remaining_degraded = [
        section_id
        for section_id in checked.get("degraded_section_ids") or []
        if section_id not in revised_ids
    ]
    if revised_ids:
        content_score = candidate_score
        content_score_history = [
            *list(checked.get("content_score_history") or []),
            {
                **candidate_score,
                "accepted": True,
                "candidate": "section_revision",
            },
        ]
        content_score_revision_count = int(
            checked.get("content_score_revision_count") or 0
        )
    artifact = article_artifact(
        plan,
        sections,
        pack,
        degraded_section_ids=remaining_degraded,
    )
    if revised_ids:
        artifact["content_score"] = content_score
        artifact["content_score_history"] = content_score_history
        artifact["content_score_revision_count"] = content_score_revision_count
    else:
        _copy_content_score(artifact, checked)
    artifact["quality"] = {
        "passed": False,
        "issues": issues,
        "repair_iteration": int(context.get("repair_iteration") or 0),
        "revised_section_ids": sorted(revised_ids),
    }
    if not revised_ids and not any(
        item.get("code") in {"revising_degraded", "revision_candidate_rejected"}
        for item in warnings
    ):
        warnings.append(
            _warning("revising_degraded", "局部修订暂不可用，已保存修订前完整稿")
        )
    output_ref = await artifact_store(settings).write_json(
        f"article-runs/{run_id}/{context.get('step_key') or 'revising'}/article.json.gz",
        artifact,
    )
    return {
        "output_ref": output_ref,
        "warnings": warnings,
        "summary": {
            "revised_sections": len(revised_ids),
            "passed": False,
            "model_failure": model_failure,
            **(
                {
                    "model_failures": quality_failures,
                    "content_score": content_score["composite_score"],
                    "content_score_passed": content_score["passed"],
                    "content_score_iterations": content_score_revision_count,
                }
                if revised_ids
                else {}
            ),
        },
        "usage": merge_usage(usages),
    }


async def build_research_pack(
    repo: ContentRepository, settings: Settings, context: dict[str, Any]
) -> dict[str, Any]:
    run_id = str(context["run_id"])
    snapshot = dict(context.get("project_snapshot") or {})
    plan_input = dict(context.get("plan_input") or {})
    source_groups = {
        source_type: await repo.list_sources(run_id, source_type)
        for source_type in ("serp", "competitor", "authority", "internal")
    }
    serp = next(
        (item["summary"] for item in source_groups["serp"] if item["status"] == "available"),
        {},
    )
    serp_analysis = dict(serp.get("serp_analysis") or {})
    organic_results = serp.get("organic_results") or []
    if organic_results and (
        not serp_analysis or serp_analysis_needs_refresh(serp_analysis, organic_results)
    ):
        serp_analysis = analyze_serp(
            str(serp.get("keyword") or context["primary_keyword"]),
            organic_results,
            serp_features=_serp_features_from_payload(serp),
        )
    questions = _unique(
        [
            *serp.get("people_also_ask", []),
            *serp.get("related_searches", []),
        ]
    )[:20]
    competitors = await _competitor_summaries(settings, source_groups["competitor"], 5)
    competitor_blueprint = build_competitor_blueprint(competitors)
    internal = _internal_link_candidates(source_groups["internal"], 30)
    authority = [
        _authority_pack_item(item)
        for item in source_groups["authority"]
        if _authority_source_usable(item)
    ]
    authority = list({item["url"]: item for item in authority}.values())
    evidence_capabilities = _build_evidence_capabilities(
        competitor_blueprint=competitor_blueprint,
        competitors=competitors,
        authority_sources=authority,
        internal_sources=internal,
    )
    content_brief = dict(serp_analysis.get("content_brief") or {})
    secondary_keywords = [
        str(item.get("keyword"))
        for item in plan_input.get("secondary_keywords") or []
        if isinstance(item, dict) and item.get("keyword")
    ]
    if secondary_keywords:
        content_brief["secondary_keywords"] = _unique(
            [*content_brief.get("secondary_keywords", []), *secondary_keywords]
        )
    return {
        "keyword": context["primary_keyword"],
        "secondary_keywords": list(plan_input.get("secondary_keywords") or []),
        "planned_title": dict(plan_input.get("title") or {}),
        "writing_direction": dict(plan_input.get("writing_direction") or {}),
        "country": snapshot.get("country") or "US",
        "language": snapshot.get("language") or "en",
        "project": snapshot,
        "serp": serp,
        "serp_analysis": serp_analysis,
        "content_brief": content_brief,
        "questions": questions,
        "required_questions": questions[:8],
        "competitors": competitors,
        "competitor_blueprint": competitor_blueprint,
        "authority_sources": authority,
        "internal_sources": internal,
        "evidence_capabilities": evidence_capabilities,
    }


def _locked_requirements(pack: dict[str, Any]) -> list[dict[str, str]]:
    writing_direction = dict(pack.get("writing_direction") or {})
    value = str(writing_direction.get("value") or "")
    if writing_direction.get("policy") != "locked" or not value:
        return []
    return [{"field": "writing_direction", "requirement": value}]


def _locked_title(pack: dict[str, Any]) -> str | None:
    planned_title = dict(pack.get("planned_title") or {})
    value = str(planned_title.get("value") or "").strip()
    if planned_title.get("policy") != "locked" or not value:
        return None
    return value


def _serp_features_from_payload(serp: dict[str, Any]) -> list[str]:
    features = [str(item) for item in serp.get("features") or [] if item]
    if serp.get("featured_snippet"):
        features.append("featured_snippet")
    if serp.get("people_also_ask"):
        features.append("people_also_ask")
    if serp.get("related_searches"):
        features.append("related_searches")
    return _unique(features)


async def _source_summaries(
    settings: Settings, sources: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    reader = S3TextReader(settings)
    output: list[dict[str, Any]] = []
    for source in sources:
        if source["status"] != "available" or not source.get("content_ref"):
            continue
        try:
            text = (await reader.read_text(str(source["content_ref"]))).text
        except StoredTextError:
            continue
        output.append(
            {
                "url": source["url"],
                "title": source.get("title") or "",
                "summary": _structured_summary(text),
                "word_count": source.get("summary", {}).get("word_count"),
            }
        )
        if len(output) >= limit:
            break
    return output


def _internal_link_candidates(
    sources: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for source in sources:
        if source["status"] != "available" or not source.get("url"):
            continue
        summary = dict(source.get("summary") or {})
        output.append(
            {
                "url": str(source["url"]),
                "title": str(source.get("title") or ""),
                "description": str(summary.get("description") or ""),
                "headings": _unique(list(summary.get("headings") or []))[:20],
                "anchor_texts": _unique(list(summary.get("anchor_texts") or []))[:10],
                "candidate_kind": str(summary.get("candidate_kind") or "navigation"),
                "selection_score": int(summary.get("selection_score") or 0),
                "selection_reason": str(summary.get("selection_reason") or ""),
            }
        )
    output.sort(
        key=lambda item: (int(item["selection_score"]), item["title"]),
        reverse=True,
    )
    return output[: max(1, min(limit, 50))]


async def _competitor_summaries(
    settings: Settings, sources: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    reader = S3TextReader(settings)
    output: list[dict[str, Any]] = []
    ranked_sources = sorted(sources, key=_competitor_source_rank)
    for source in ranked_sources:
        if source["status"] != "available" or not source.get("content_ref"):
            continue
        try:
            text = (await reader.read_text(str(source["content_ref"]))).text
        except StoredTextError:
            continue
        source_summary_value = source.get("summary")
        source_summary = (
            dict(source_summary_value) if isinstance(source_summary_value, dict) else {}
        )
        main_html = None
        if source_summary.get("html_ref"):
            try:
                main_html = (await reader.read_text(str(source_summary["html_ref"]))).text
            except StoredTextError:
                pass
        try:
            analysis = analyze_competitor(
                text,
                content_type=str(source_summary.get("content_type") or "General Article"),
                heading_structure=list(source_summary.get("heading_structure") or []),
                main_html=main_html,
            )
        except Exception:
            analysis = _fallback_competitor_analysis(text, source_summary)
        output.append(
            {
                "url": source["url"],
                "title": source.get("title") or "",
                "word_count": source_summary.get("word_count") or analysis["word_count"],
                "content_type": analysis["content_type"],
                "analysis": analysis,
                "summary": analysis,
            }
        )
        if len(output) >= limit:
            break
    return output


def _competitor_source_rank(source: dict[str, Any]) -> tuple[int, int, str]:
    summary_value = source.get("summary")
    summary = dict(summary_value) if isinstance(summary_value, dict) else {}
    position = summary.get("serp_position")
    organic_position = summary.get("organic_position")
    effective_position = position if isinstance(position, int) and position > 0 else organic_position
    return (
        0 if isinstance(effective_position, int) and effective_position > 0 else 1,
        int(effective_position) if isinstance(effective_position, int) else 1_000_000,
        str(source.get("url") or ""),
    )


_LOAD_BEARING_REQUIREMENT_PATTERNS = (
    re.compile(r"\b(?:statistic|percentage|rate|survey|study|sample|dataset|price|cost)\b", re.I),
    re.compile(r"(?:%|[$€£¥]|\b\d+(?:[.,]\d+)?\b)"),
    re.compile(
        r"\b(?:policy|legal|law|regulation|regulatory|compliance|tax credit|eligibility|standard)\b",
        re.I,
    ),
    re.compile(
        r"\b(?:product|platform|model|feature|availability|supports?|behavior|documentation)\b",
        re.I,
    ),
    re.compile(r"\b(?:rank|ranking|compare|comparison|best|top|versus|\bvs\b)\b", re.I),
    re.compile(r"\b(?:methodology|method|measured|measurement|research design)\b", re.I),
    re.compile(r"\b(?:current|latest|fresh|today|now|recent|\b20\d{2}\b)\b", re.I),
)


def _supplemental_research_queries(
    plan: ArticlePlan, pack: dict[str, Any]
) -> list[str]:
    keyword = str(pack.get("keyword") or "").strip()
    country = str(pack.get("country") or "US").strip()
    queries: list[str] = []
    for section in plan.sections:
        if map_authority_sources_to_section(plan, section, pack):
            continue
        for requirement in section.data_requirements:
            normalized = " ".join(str(requirement).split())
            if not normalized or not any(
                pattern.search(normalized)
                for pattern in _LOAD_BEARING_REQUIREMENT_PATTERNS
            ):
                continue
            if normalized.endswith("?"):
                query = normalized
            else:
                query = (
                    f"What do current official or primary sources report about {normalized} "
                    f"for {keyword} in {country}?"
                )
            queries.append(query)
            if len(_unique(queries)) >= 4:
                return _unique(queries)[:4]
    return _unique(queries)[:4]


def normalize_plan(plan: ArticlePlan, pack: dict[str, Any]) -> ArticlePlan:
    source_urls, internal_urls = allowed_urls(pack)
    evidence_by_url = {
        str(item["url"]): str(item.get("excerpt") or "")
        for item in pack.get("authority_sources", [])
        if item.get("url")
    }
    claims: list[EvidenceClaim] = []
    claim_id_map: dict[str, str] = {}
    for index, claim in enumerate(plan.claims):
        source_evidence = evidence_by_url.get(claim.source_url, "")
        if (
            not claim.supported
            or claim.source_url not in source_urls
            or not claim.quote.strip()
            or not _evidence_contains_quote(source_evidence, claim.quote)
            or verify_source_claims(claim.claim, claim.quote).status
            not in {"verified", "paraphrase"}
        ):
            continue
        claim_id = f"claim-{index + 1}"
        claim_id_map[claim.claim_id] = claim_id
        claims.append(claim.model_copy(update={"claim_id": claim_id, "section_id": None}))
    sections: list[OutlineSection] = []
    for index, section in enumerate(plan.sections[:10]):
        section_id = f"section-{index + 1}"
        sections.append(
            section.model_copy(
                update={
                    "section_id": section_id,
                    "claim_ids": [
                        claim_id_map[item]
                        for item in section.claim_ids
                        if item in claim_id_map
                    ],
                    "internal_urls": _unique(
                        [item for item in section.internal_urls if item in internal_urls]
                    )[:1],
                }
            )
        )
    if not sections:
        return fallback_plan(pack)
    assigned_claims: list[EvidenceClaim] = []
    for claim in claims:
        section_id = next(
            (item.section_id for item in sections if claim.claim_id in item.claim_ids), None
        )
        if section_id is not None:
            assigned_claims.append(claim.model_copy(update={"section_id": section_id}))
    dominant_content_type = str(
        (pack.get("serp_analysis") or {}).get("dominant_content_type") or plan.article_type
    )
    capabilities = _evidence_capabilities(pack)
    if _commercial_article_type(dominant_content_type) and int(
        capabilities.get("named_product_count") or 0
    ) < 3:
        dominant_content_type = "Selection Guide"
    sections = _align_sections_with_content_brief(sections, pack, dominant_content_type)
    sections = _align_sections_with_competitor_blueprint(sections, pack)
    sections = _finalize_section_plans(sections, pack)
    sections = assign_internal_links_to_sections(sections, pack)
    sections = [_constrain_section_to_evidence(item, capabilities) for item in sections]
    gap_mapping = _gap_to_section_mapping(sections)
    title = _locked_title(pack) or _constrain_metadata_to_evidence(
        plan.title, str(pack["keyword"]), capabilities
    )
    meta_title = _constrain_metadata_to_evidence(
        plan.meta_title, str(pack["keyword"]), capabilities
    )
    meta_description = _constrain_metadata_to_evidence(
        plan.meta_description, str(pack["keyword"]), capabilities
    )
    normalized = plan.model_copy(
        update={
            "title": title,
            "meta_title": meta_title,
            "meta_description": meta_description,
            "slug": normalize_slug(plan.slug, str(pack["keyword"])),
            "article_type": dominant_content_type,
            "claims": assigned_claims,
            "sections": sections,
            "total_word_target": sum(item.word_target for item in sections),
            "gap_to_section_mapping": gap_mapping,
        }
    )
    return normalized.model_copy(update={"contract": _build_article_contract(normalized, pack)})


def assign_internal_links_to_sections(
    sections: list[OutlineSection], pack: dict[str, Any], max_links: int = 5
) -> list[OutlineSection]:
    candidates = {
        str(item.get("url") or ""): item
        for item in pack.get("internal_sources") or []
        if item.get("url")
    }
    if not candidates or max_links <= 0:
        return [section.model_copy(update={"internal_urls": []}) for section in sections]

    eligible_types = {
        "body_how_to",
        "body_comparison",
        "body_explanation",
        "body_list",
    }
    ranked_pairs: list[tuple[int, int, int, int, str, str]] = []
    for section_index, section in enumerate(sections):
        preferred_urls = set(section.internal_urls)
        for url, candidate in candidates.items():
            if section.section_type not in eligible_types and url not in preferred_urls:
                continue
            score = _internal_link_section_score(section, candidate)
            if score < 2:
                continue
            ranked_pairs.append(
                (
                    score,
                    1 if url in preferred_urls else 0,
                    int(candidate.get("selection_score") or 0),
                    -section_index,
                    url,
                    section.section_id,
                )
            )

    used_urls: set[str] = set()
    assigned: dict[str, str] = {}
    for _, _, _, _, url, section_id in sorted(ranked_pairs, reverse=True):
        if section_id in assigned or url in used_urls:
            continue
        assigned[section_id] = url
        used_urls.add(url)
        if len(used_urls) >= max_links:
            break

    return [
        section.model_copy(
            update={
                "internal_urls": (
                    [assigned[section.section_id]]
                    if section.section_id in assigned
                    else []
                )
            }
        )
        for section in sections
    ]


def _internal_link_section_score(
    section: OutlineSection, candidate: dict[str, Any]
) -> int:
    section_text = " ".join(
        [
            section.heading,
            section.objective,
            section.strategic_angle,
            *section.required_questions,
            *section.coverage_points,
        ]
    )
    candidate_text = " ".join(
        [
            str(candidate.get("url") or ""),
            str(candidate.get("title") or ""),
            str(candidate.get("description") or ""),
            *[str(item) for item in candidate.get("anchor_texts") or []],
        ]
    )
    exact_overlap = len(
        _internal_link_terms(section_text).intersection(
            _internal_link_terms(candidate_text)
        )
    )
    concept_overlap = len(
        _semantic_concepts(section_text).intersection(
            _semantic_concepts(candidate_text)
        )
    )
    return exact_overlap + concept_overlap * 3


def _internal_link_terms(value: str) -> set[str]:
    normalized = _normalize_requirement(value)
    terms = {
        item
        for item in re.findall(r"[a-z0-9]+", normalized)
        if len(item) > 2
        and not item.isdigit()
        and item not in _SOURCE_MAPPING_STOP_WORDS
    }
    for block in re.findall(r"[\u4e00-\u9fff]+", normalized):
        terms.add(block)
        for size in (2, 3):
            terms.update(block[index : index + size] for index in range(len(block) - size + 1))
    return terms


def _build_article_contract(plan: ArticlePlan, pack: dict[str, Any]) -> ArticleContract:
    claims_by_id = {item.claim_id: item for item in plan.claims if item.supported}
    required_questions = _unique(
        [str(item).strip() for item in pack.get("required_questions") or [] if str(item).strip()]
    )[:20]
    faq_questions = _unique(
        [
            question
            for section in plan.sections
            if section.section_type == "faq"
            for question in section.required_questions
            if question
        ]
    )[:10]
    sections = []
    for section in plan.sections:
        section_claims = [
            claims_by_id[claim_id]
            for claim_id in section.claim_ids
            if claim_id in claims_by_id
        ]
        mapped_urls = [
            str(item["url"])
            for item in map_authority_sources_to_section(plan, section, pack)
            if item.get("url")
        ]
        sections.append(
            ContractSection(
                section_id=section.section_id,
                required_questions=_unique(section.required_questions)[:10],
                allowed_claim_ids=[item.claim_id for item in section_claims],
                allowed_source_urls=_unique(
                    [*[item.source_url for item in section_claims], *mapped_urls]
                )[:20],
                allowed_internal_urls=_unique(section.internal_urls)[:10],
            )
        )
    capabilities = _evidence_capabilities(pack)
    boundaries = _unique(
        [str(item) for item in capabilities.get("unsupported_promises") or [] if item]
    )[:20]
    return ArticleContract(
        article_type=plan.article_type,
        search_intent=plan.search_intent,
        required_questions=required_questions,
        sections=sections,
        faq_questions=faq_questions,
        unsupported_claim_boundaries=boundaries,
    )


def _ensure_article_contract(plan: ArticlePlan, pack: dict[str, Any]) -> ArticlePlan:
    if plan.contract is not None:
        return plan
    return plan.model_copy(update={"contract": _build_article_contract(plan, pack)})


def _source_evidence_excerpt(source: dict[str, Any]) -> str:
    summary_value = source.get("summary")
    summary = dict(summary_value) if isinstance(summary_value, dict) else {}
    metadata_value = source.get("metadata")
    metadata = dict(metadata_value) if isinstance(metadata_value, dict) else {}
    if metadata.get("source") == "web_research":
        return str(summary.get("research_excerpt") or "").strip()[:6000]
    for field in (
        "research_excerpt",
        "citation_excerpt",
        "research_claim",
        "research_answer",
    ):
        excerpt = str(summary.get(field) or "").strip()
        if excerpt:
            return excerpt[:6000]
    if metadata.get("provider") == "dataforseo" and metadata.get("source") == "featured_snippet":
        return str(summary.get("research_answer") or "").strip()[:6000]
    return ""


def _authority_source_usable(source: dict[str, Any]) -> bool:
    if source.get("status") != "available" or not _source_evidence_excerpt(source):
        return False
    metadata_value = source.get("metadata")
    metadata = dict(metadata_value) if isinstance(metadata_value, dict) else {}
    if metadata.get("source") != "web_research":
        return False
    status = metadata.get("verification_status")
    summary_value = source.get("summary")
    summary = dict(summary_value) if isinstance(summary_value, dict) else {}
    return (
        status in {"verified", "paraphrase"}
        and bool(str(summary.get("research_excerpt") or "").strip())
        and metadata.get("independent_source") is not False
    )


def _authority_pack_item(source: dict[str, Any]) -> dict[str, Any]:
    summary_value = source.get("summary")
    summary = dict(summary_value) if isinstance(summary_value, dict) else {}
    metadata_value = source.get("metadata")
    metadata = dict(metadata_value) if isinstance(metadata_value, dict) else {}
    web_research = metadata.get("source") == "web_research"
    verification_claims = [
        dict(item)
        for item in summary.get("verification_claims") or []
        if isinstance(item, dict) and item.get("status") in {"verified", "paraphrase"}
    ]
    verified_claim_text = "\n".join(
        dict.fromkeys(
            str(item.get("claim") or "").strip()
            for item in verification_claims
            if str(item.get("claim") or "").strip()
        )
    )
    return {
        "url": source["url"],
        "title": source.get("title") or "",
        "excerpt": _source_evidence_excerpt(source),
        "research_answer": "" if web_research else str(summary.get("research_answer") or "")[:12000],
        "citation_excerpt": "" if web_research else str(summary.get("citation_excerpt") or "")[:4000],
        "research_claim": (
            verified_claim_text
            if web_research
            else str(summary.get("research_claim") or "")
        ),
        "verification_status": metadata.get("verification_status") or "legacy_available",
        "verification_method": metadata.get("verification_method") or "",
        "source_tier": metadata.get("source_tier") or "",
        "provider": metadata.get("provider") or "",
        "model": metadata.get("model") or "",
        "queries": list(metadata.get("queries") or []),
        "failed_queries": list(metadata.get("failed_queries") or []),
        "cached": bool(metadata.get("cached")),
        "verified_url": metadata.get("verified_url") or source["url"],
        "echo_cluster_id": metadata.get("echo_cluster_id") or "",
        "independent_source": metadata.get("independent_source"),
        "verification_claims": verification_claims,
        "crawler": dict(metadata.get("crawler") or {}),
    }


def _build_evidence_capabilities(
    *,
    competitor_blueprint: dict[str, Any],
    competitors: list[dict[str, Any]],
    authority_sources: list[dict[str, Any]],
    internal_sources: list[dict[str, Any]],
) -> dict[str, Any]:
    named_entities = list(competitor_blueprint.get("named_entities") or [])
    authority_text = " ".join(
        f"{item.get('title', '')} {item.get('excerpt', '')}"
        for item in authority_sources
    )
    price_pattern = re.compile(
        r"(?:[$€£¥]\s?\d+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP|CNY))",
        re.IGNORECASE,
    )
    source_tiers = {
        str(item.get("source_tier") or "") for item in authority_sources
    }
    verified_claim_count = sum(
        max(1, len(item.get("verification_claims") or []))
        for item in authority_sources
        if item.get("research_claim") or item.get("verification_claims")
    )
    named_products = [
        item
        for item in named_entities
        if item.get("entity_type") == "product_or_brand" and item.get("name")
    ]
    supported_dimensions = list(
        competitor_blueprint.get("comparison_dimensions") or []
    )
    price_available = bool(price_pattern.search(authority_text))
    professional_available = any(
        any(term in f"{item.get('title', '')} {item.get('excerpt', '')}".casefold()
            for term in ("professional", "specialist", "technician", "clinician", "engineer"))
        for item in authority_sources
    )
    unsupported_promises: list[str] = []
    if len(named_products) < 3:
        unsupported_promises.extend(["fixed product count", "ranking", "winner"])
    if not price_available:
        unsupported_promises.append("current prices")
    if not professional_available:
        unsupported_promises.append("professional recommendation")
    unsupported_promises.extend(["hands-on test", "award"])
    return {
        "verified_claim_count": verified_claim_count,
        "verified_source_count": len(authority_sources),
        "competitor_count": len(competitors),
        "internal_source_count": len(internal_sources),
        "named_entities": named_products[:30],
        "named_product_count": len(named_products),
        "price_evidence_available": price_available,
        "professional_source_available": professional_available,
        "official_source_available": any(tier.startswith("tier_1") for tier in source_tiers),
        "supported_comparison_dimensions": supported_dimensions,
        "unsupported_promises": _unique(unsupported_promises),
    }


def _evidence_capabilities(pack: dict[str, Any]) -> dict[str, Any]:
    capabilities = pack.get("evidence_capabilities")
    if isinstance(capabilities, dict):
        return dict(capabilities)
    # Old stored packs predate capability tracking; preserve their plans on replay.
    return {
        "named_product_count": 100,
        "price_evidence_available": True,
        "professional_source_available": True,
        "unsupported_promises": [],
    }


def _commercial_article_type(article_type: str) -> bool:
    normalized = article_type.casefold()
    return any(
        item in normalized
        for item in ("listicle", "comparison", "review", "product", "best")
    )


UNSUPPORTED_PROMISE_PATTERNS = (
    re.compile(r"\b(?:top|best)\s+\d+\b", re.IGNORECASE),
    re.compile(r"\b\d+\s+(?:best|top)\b", re.IGNORECASE),
    re.compile(r"\b\d+\s+(?:products?|models?|options?|picks?)\b", re.IGNORECASE),
    re.compile(r"(?:最佳\s*\d+|\d+\s*款最佳|\d+\s*(?:款|个)(?:产品|型号|选择))"),
)
UNVERIFIED_EVALUATION_PATTERN = re.compile(
    r"\b(?:winners?|award(?:ed)?|rank(?:ed|ing)?|hands-on tests?|we tested|tested)\b|"
    r"(?:获胜者|冠军|获奖|排名|实测|我们测试了)",
    re.IGNORECASE,
)
BEST_PROMISE_PATTERN = re.compile(r"\bbest\b|最佳", re.IGNORECASE)
PRICE_PROMISE_PATTERN = re.compile(
    r"\b(?:current|exact|latest|live)\s+(?:price|pricing|cost)s?\b|"
    r"(?:当前|准确|最新|实时)(?:价格|定价|成本)",
    re.IGNORECASE,
)
PROFESSIONAL_PROMISE_PATTERN = re.compile(
    r"\b(?:professional|expert|specialist)\s+(?:pick|choice|recommendation|recommended)\b|"
    r"\b(?:our\s+)?experts?\b|"
    r"(?:专业人士|专家)(?:选择|推荐)",
    re.IGNORECASE,
)


def _constrain_metadata_to_evidence(
    value: str, keyword: str, capabilities: dict[str, Any]
) -> str:
    constrained = UNVERIFIED_EVALUATION_PATTERN.sub("evaluated", value)
    if int(capabilities.get("named_product_count") or 0) < 3:
        for pattern in UNSUPPORTED_PROMISE_PATTERNS:
            constrained = pattern.sub("selection guide", constrained)
        constrained = BEST_PROMISE_PATTERN.sub("suitable", constrained)
    if not capabilities.get("price_evidence_available"):
        constrained = PRICE_PROMISE_PATTERN.sub("budget considerations", constrained)
    if not capabilities.get("professional_source_available"):
        constrained = PROFESSIONAL_PROMISE_PATTERN.sub("practical guidance", constrained)
    constrained = re.sub(r"\s+", " ", constrained).strip(" -:|")
    return constrained or f"{keyword} selection guide"


def _constrain_requirement_to_evidence(
    value: str, capabilities: dict[str, Any]
) -> str:
    constrained = _constrain_metadata_to_evidence(value, "", capabilities)
    if int(capabilities.get("named_product_count") or 0) < 3:
        constrained = re.sub(
            r"\b(?:recommend|rank|compare)\s+(?:the\s+)?(?:top|best)?\s*\d*\s*(?:products?|models?|options?)\b",
            "explain selection criteria and suitable option types",
            constrained,
            flags=re.IGNORECASE,
        )
    if not capabilities.get("price_evidence_available"):
        constrained = re.sub(
            r"\b(?:add|include|show|compare|provide)\s+(?:current\s+)?(?:prices?|pricing)\b",
            "explain budget factors without quoting unsupported prices",
            constrained,
            flags=re.IGNORECASE,
        )
    return constrained.strip()


def _constrain_section_to_evidence(
    section: OutlineSection, capabilities: dict[str, Any]
) -> OutlineSection:
    heading = _constrain_requirement_to_evidence(section.heading, capabilities)
    objective = _constrain_requirement_to_evidence(section.objective, capabilities)
    coverage_points = _unique(
        [
            constrained
            for item in section.coverage_points
            if (constrained := _constrain_requirement_to_evidence(item, capabilities))
        ]
    )[:12]
    competitor_gaps = _unique(
        [
            constrained
            for item in section.competitor_gaps
            if (constrained := _constrain_requirement_to_evidence(item, capabilities))
        ]
    )[:10]
    data_requirements = _unique(
        [
            constrained
            for item in section.data_requirements
            if (constrained := _constrain_requirement_to_evidence(item, capabilities))
        ]
    )[:10]
    return section.model_copy(
        update={
            "heading": heading or "Selection criteria",
            "objective": objective or "Explain practical selection criteria",
            "coverage_points": coverage_points,
            "competitor_gaps": competitor_gaps,
            "data_requirements": data_requirements,
            "strategic_angle": _constrain_requirement_to_evidence(
                section.strategic_angle, capabilities
            ),
        }
    )


def _evidence_contains_quote(evidence: str, quote: str) -> bool:
    normalized_evidence = re.sub(r"\s+", " ", evidence).strip().casefold()
    normalized_quote = re.sub(r"\s+", " ", quote).strip().casefold()
    return bool(normalized_quote and normalized_quote in normalized_evidence)


def fallback_plan(pack: dict[str, Any]) -> ArticlePlan:
    keyword = str(pack["keyword"])
    questions = list(pack.get("required_questions") or [])
    content_brief = dict(pack.get("content_brief") or {})
    article_type = str(content_brief.get("content_type") or "guide")
    recommendations = list(content_brief.get("structure_recommendations") or [])
    headings = (
        [(str(item), f"Cover the required {article_type} element: {item}") for item in recommendations]
        if recommendations
        else [
            (f"Understanding {keyword}", "Explain the topic and the user's core intent"),
            ("Key considerations", "Cover the practical factors that affect the decision"),
            ("A practical process", "Give a clear step-by-step approach"),
            ("Common questions", "Answer the remaining user questions directly"),
        ]
    )
    sections = [
        OutlineSection(
            section_id=f"section-{index + 1}",
            heading=heading,
            objective=objective,
            required_questions=questions[index:: len(headings)][:3],
            coverage_points=[objective],
        )
        for index, (heading, objective) in enumerate(headings)
    ]
    sections = _align_sections_with_content_brief(sections, pack, article_type)
    sections = _align_sections_with_competitor_blueprint(sections, pack)
    sections = _finalize_section_plans(sections, pack)
    sections = assign_internal_links_to_sections(sections, pack)
    capabilities = _evidence_capabilities(pack)
    sections = [_constrain_section_to_evidence(item, capabilities) for item in sections]
    if _commercial_article_type(article_type) and int(
        capabilities.get("named_product_count") or 0
    ) < 3:
        article_type = "Selection Guide"
    plan = ArticlePlan(
        title=_locked_title(pack) or keyword,
        search_intent=f"Understand and act on {keyword}",
        article_type=article_type,
        meta_title=keyword,
        meta_description=f"A practical guide to {keyword}, including key considerations and next steps.",
        slug=normalize_slug(keyword, keyword),
        sections=sections,
        total_word_target=sum(item.word_target for item in sections),
        gap_to_section_mapping=_gap_to_section_mapping(sections),
    )
    return plan.model_copy(update={"contract": _build_article_contract(plan, pack)})


def _align_sections_with_content_brief(
    sections: list[OutlineSection], pack: dict[str, Any], article_type: str
) -> list[OutlineSection]:
    content_brief = dict(pack.get("content_brief") or {})
    capabilities = _evidence_capabilities(pack)
    recommendations = _unique(
        [
            constrained
            for item in content_brief.get("structure_recommendations") or []
            if (constrained := _constrain_requirement_to_evidence(str(item), capabilities))
        ]
    )[:10]
    must_have = _unique(
        [
            constrained
            for item in content_brief.get("must_have_elements") or []
            if (constrained := _constrain_requirement_to_evidence(str(item), capabilities))
        ]
    )
    feature_targets = _unique(
        list(content_brief.get("serp_features_to_target") or [])
    )
    aligned = list(sections[:10])

    for index, recommendation in enumerate(recommendations):
        requirement = f"SERP structure: {recommendation}"
        if index < len(aligned):
            section = aligned[index]
            aligned[index] = section.model_copy(
                update={
                    "coverage_points": _unique(
                        [requirement, *section.coverage_points]
                    )[:12]
                }
            )
            continue
        aligned.append(
            OutlineSection(
                section_id=f"section-{index + 1}",
                heading=recommendation,
                objective=(
                    f"Cover the required {article_type} structure: {recommendation}"
                ),
                coverage_points=[requirement],
            )
        )

    for index, element in enumerate(must_have):
        if not aligned:
            break
        target = index % len(aligned)
        section = aligned[target]
        aligned[target] = section.model_copy(
            update={
                "coverage_points": _unique(
                    [f"Required element: {element}", *section.coverage_points]
                )[:12]
            }
        )
    for index, target_requirement in enumerate(feature_targets):
        if not aligned:
            break
        target = index % len(aligned)
        section = aligned[target]
        aligned[target] = section.model_copy(
            update={
                "coverage_points": _unique(
                    [
                        f"SERP feature target: {target_requirement}",
                        *section.coverage_points,
                    ]
                )[:12]
            }
        )
    return aligned


def _align_sections_with_competitor_blueprint(
    sections: list[OutlineSection], pack: dict[str, Any]
) -> list[OutlineSection]:
    blueprint = dict(pack.get("competitor_blueprint") or {})
    capabilities = _evidence_capabilities(pack)
    aligned = list(sections[:12])
    if not aligned:
        return aligned

    for item in blueprint.get("structure_to_match") or []:
        heading = _constrain_requirement_to_evidence(
            str(item.get("heading") or "").strip(), capabilities
        )
        if not heading:
            continue
        target = _best_section_index(aligned, heading)
        requirement = f"Common competitor structure: {heading}"
        if target is None and len(aligned) < 12:
            aligned.append(
                OutlineSection(
                    section_id=f"section-{len(aligned) + 1}",
                    heading=heading,
                    objective=f"Cover the structure shared by ranking competitors: {heading}",
                    coverage_points=[requirement],
                )
            )
        elif target is not None:
            section = aligned[target]
            aligned[target] = section.model_copy(
                update={
                    "coverage_points": _unique([requirement, *section.coverage_points])[:12]
                }
            )

    for item in blueprint.get("must_fill_gaps") or []:
        gap = dict(item)
        requirement = _constrain_requirement_to_evidence(
            str(gap.get("opportunity") or gap.get("description") or "").strip(),
            capabilities,
        )
        location = str(gap.get("location") or "").strip()
        if not requirement:
            continue
        target = _ensure_relevant_section(aligned, location, requirement)
        if target is None:
            continue
        section = aligned[target]
        aligned[target] = section.model_copy(
            update={
                "competitor_gaps": _unique([requirement, *section.competitor_gaps])[:10],
                "coverage_points": _unique(
                    [f"Competitor opportunity: {requirement}", *section.coverage_points]
                )[:12]
            }
        )

    for item in blueprint.get("data_needed") or []:
        value = dict(item)
        topic = str(value.get("topic") or "Article").strip()
        reason = str(value.get("reason") or "Supporting evidence is needed").strip()
        requirement = _constrain_requirement_to_evidence(
            f"Verify with a current named source or express qualitatively: {topic} ({reason})",
            capabilities,
        )
        if not requirement:
            continue
        target = _ensure_relevant_section(aligned, topic, requirement)
        if target is not None:
            section = aligned[target]
            aligned[target] = section.model_copy(
                update={
                    "data_requirements": _unique(
                        [requirement, *section.data_requirements]
                    )[:10]
                }
            )

    for item in blueprint.get("outdated_to_update") or []:
        value = dict(item)
        location = str(value.get("location") or "Article").strip()
        quote = str(value.get("quote") or value.get("year") or "old information").strip()
        requirement = f"Replace with current sourced information or omit: {quote[:240]}"
        target = _ensure_relevant_section(aligned, location, requirement)
        if target is not None:
            section = aligned[target]
            aligned[target] = section.model_copy(
                update={
                    "data_requirements": _unique(
                        [requirement, *section.data_requirements]
                    )[:10]
                }
            )
    return aligned


def _ensure_relevant_section(
    sections: list[OutlineSection], location: str, requirement: str
) -> int | None:
    target = _best_section_index(sections, location or requirement)
    if target is not None:
        return target
    if len(sections) >= 12:
        return None
    generic = _normalize_requirement(location) in {
        "",
        "article",
        "article structure",
        "introduction",
    }
    heading = "Evidence and current information" if generic else location
    sections.append(
        OutlineSection(
            section_id=f"section-{len(sections) + 1}",
            heading=heading,
            objective=requirement,
            coverage_points=[f"Competitor opportunity: {requirement}"],
        )
    )
    return len(sections) - 1


def _best_section_index(sections: list[OutlineSection], requirement: str) -> int | None:
    normalized = _normalize_requirement(requirement)
    if not normalized:
        return None
    terms = _semantic_terms(requirement)
    best_index = None
    best_score = 0
    for index, section in enumerate(sections):
        section_text = " ".join(
            [section.heading, section.objective, *section.coverage_points]
        )
        normalized_section = _normalize_requirement(section_text)
        section_terms = _semantic_terms(section_text)
        score = len(terms.intersection(section_terms))
        if normalized in normalized_section or _normalize_requirement(section.heading) in normalized:
            score += 5
        if score > best_score:
            best_index = index
            best_score = score
    return best_index if best_score > 0 else None


_SEMANTIC_GROUPS = (
    {"price", "pricing", "cost", "costs", "fee", "fees", "价格", "成本", "费用"},
    {"use", "uses", "case", "cases", "scenario", "application", "用例", "场景", "适用"},
    {"install", "installation", "setup", "configure", "安装", "配置", "设置"},
    {"guide", "guidance", "tutorial", "指南", "教程"},
    {"implement", "implementation", "deployment", "rollout", "实施", "部署", "落地"},
    {"migration", "migrate", "import", "迁移", "导入"},
    {"adoption", "onboarding", "training", "采用", "上手", "培训"},
    {"measure", "measurement", "monitor", "tracking", "衡量", "监控", "跟踪"},
    {"faq", "question", "questions", "asked", "常见问题", "问答", "问题"},
    {"conclusion", "summary", "final", "next", "结论", "总结", "下一步"},
    {"compare", "comparison", "versus", "difference", "区别", "比较", "对比"},
    {"risk", "risks", "drawback", "drawbacks", "disadvantage", "风险", "缺点"},
    {"benefit", "benefits", "advantage", "advantages", "价值", "优势", "好处"},
)


def _semantic_concepts(value: str) -> set[int]:
    normalized = _normalize_requirement(value)
    latin_tokens = set(re.findall(r"[a-z0-9]+", normalized))
    return {
        index
        for index, group in enumerate(_SEMANTIC_GROUPS)
        if latin_tokens.intersection(
            {item for item in group if not re.search(r"[\u4e00-\u9fff]", item)}
        )
        or any(
            item in normalized
            for item in group
            if re.search(r"[\u4e00-\u9fff]", item)
        )
    }


def _semantic_terms(value: str) -> set[str]:
    normalized = _normalize_requirement(value)
    terms = {
        item for item in normalized.split() if len(item) > 2 or re.search(r"[\u4e00-\u9fff]", item)
    }
    latin_tokens = set(re.findall(r"[a-z0-9]+", normalized))
    for group in _SEMANTIC_GROUPS:
        latin_aliases = {item for item in group if not re.search(r"[\u4e00-\u9fff]", item)}
        chinese_aliases = group - latin_aliases
        if latin_tokens.intersection(latin_aliases) or any(
            item in normalized for item in chinese_aliases
        ):
            terms.update(group)
    return terms


def _finalize_section_plans(
    sections: list[OutlineSection], pack: dict[str, Any]
) -> list[OutlineSection]:
    blueprint = dict(pack.get("competitor_blueprint") or {})
    common_structure = list(blueprint.get("structure_to_match") or [])
    conversions = list(
        ((pack.get("project") or {}).get("profile") or {}).get("conversion_actions")
        or []
    )
    section_count = min(len(sections), 12)
    cta_locations = (
        ("soft", min(2, section_count)),
        ("medium", section_count // 2 + 1),
        ("strong", section_count),
    )
    output: list[OutlineSection] = []
    for index, section in enumerate(sections[:12]):
        section_type = _classify_section_type(section.heading, index)
        required_questions = (
            _faq_questions(section, pack)
            if section_type == "faq"
            else section.required_questions
        )
        base_target = {
            "intro": 200,
            "body_how_to": 350,
            "body_comparison": 400,
            "body_explanation": 300,
            "body_list": 400,
            "faq": 250,
            "conclusion": 200,
        }[section_type]
        competitor_average = _competitor_average_word_count(section, common_structure)
        word_target = max(base_target, int(competitor_average * 1.1))
        if section.competitor_gaps:
            word_target = max(word_target, int(base_target * 1.3))
        strategic_angle = section.strategic_angle.strip() or section.objective
        if section.competitor_gaps:
            strategic_angle = "Resolve documented competitor gaps: " + "; ".join(
                section.competitor_gaps[:2]
            )
        section_number = index + 1
        cta_type = (
            next(
                (cta for cta, location in cta_locations if location == section_number),
                None,
            )
            if conversions
            else None
        )
        featured_snippet = (
            section.featured_snippet_target
            or section_type in {"faq", "body_explanation"}
            or any("featured snippet" in item.casefold() for item in section.coverage_points)
        )
        output.append(
            section.model_copy(
                update={
                    "section_id": f"section-{index + 1}",
                    "section_type": section_type,
                    "required_questions": required_questions,
                    "word_target": min(word_target, 1200),
                    "strategic_angle": strategic_angle,
                    "engagement_hook": section.engagement_hook.strip()
                    or _engagement_hook(section_type),
                    "cta_type": cta_type,
                    "featured_snippet_target": featured_snippet,
                }
            )
        )
    return output


def _faq_questions(section: OutlineSection, pack: dict[str, Any]) -> list[str]:
    available = _unique(
        [str(item).strip() for item in pack.get("required_questions") or [] if str(item).strip()]
    )
    if not available:
        return []
    by_normalized = {_normalize_requirement(item): item for item in available}
    selected = [
        by_normalized[normalized]
        for item in section.required_questions
        if (normalized := _normalize_requirement(item)) in by_normalized
    ]
    selected = _unique(selected)
    target_count = max(min(4, len(available)), min(6, len(selected)))
    return _unique([*selected, *available])[:target_count]


def _competitor_average_word_count(
    section: OutlineSection, common_structure: list[dict[str, Any]]
) -> int:
    section_text = " ".join(
        [section.heading, section.objective, *section.coverage_points]
    )
    normalized_section = _normalize_requirement(section_text)
    section_terms = _semantic_terms(section_text)
    best_score = 0
    best_average = 0
    for item in common_structure:
        heading = str(item.get("heading") or "").strip()
        average = int(item.get("average_word_count") or 0)
        if not heading or average <= 0:
            continue
        normalized_heading = _normalize_requirement(heading)
        score = len(section_terms.intersection(_semantic_terms(heading)))
        if normalized_heading in normalized_section:
            score += 5
        if score > best_score:
            best_score = score
            best_average = average
    return best_average


def _classify_section_type(heading: str, index: int) -> str:
    normalized = _normalize_requirement(heading)
    normalized_tokens = set(normalized.split())
    section_type = "body_explanation"
    if any(
        item in normalized
        for item in (
            "how to",
            "steps",
            "guide",
            "tutorial",
            "process",
            "步骤",
            "指南",
            "教程",
            "流程",
        )
    ):
        section_type = "body_how_to"
    elif (
        normalized_tokens.intersection({"vs", "versus"})
        or any(
            item in normalized
            for item in (
                "compare",
                "comparison",
                "difference",
                "best",
                "最佳",
                "比较",
                "对比",
                "区别",
            )
        )
    ):
        section_type = "body_comparison"
    elif any(
        item in normalized
        for item in (
            "what is",
            "why",
            "overview",
            "understand",
            "什么是",
            "为什么",
            "概述",
            "理解",
        )
    ):
        section_type = "body_explanation"
    elif normalized_tokens.intersection({"top"}) or any(
        item in normalized
        for item in (
            "best",
            "tips",
            "ways",
            "methods",
            "strategies",
            "list",
            "技巧",
            "方法",
            "策略",
            "清单",
        )
    ):
        section_type = "body_list"
    elif normalized_tokens.intersection({"faq", "questions", "asked"}) or any(
        item in normalized for item in ("常见问题", "问答")
    ):
        section_type = "faq"
    elif any(
        item in normalized
        for item in (
            "conclusion",
            "summary",
            "final",
            "next step",
            "wrap",
            "结论",
            "总结",
            "下一步",
        )
    ):
        section_type = "conclusion"

    if index == 0:
        section_type = "intro"
    if (
        normalized_tokens.intersection({"faq", "question", "questions"})
        or any(item in normalized for item in ("常见问题", "问答"))
    ):
        section_type = "faq"
    return section_type


def _engagement_hook(section_type: str) -> str:
    return {
        "intro": "Acknowledge the reader's situation, promise a useful answer, and preview it directly.",
        "body_how_to": "Open with the outcome and the first concrete action.",
        "body_comparison": "State the decision criteria before comparing options fairly.",
        "body_explanation": "Begin with a plain-language answer before adding detail.",
        "body_list": "Explain how the items were selected before listing them consistently.",
        "faq": "Answer each real user question directly before adding context.",
        "conclusion": "Turn the main findings into specific next steps without adding new facts.",
    }[section_type]


def _gap_to_section_mapping(sections: list[OutlineSection]) -> dict[str, str]:
    return {
        gap: section.section_id
        for section in sections
        for gap in section.competitor_gaps
    }


def _normalize_requirement(value: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]+", " ", value.casefold()).strip()


def section_payload(
    plan: ArticlePlan,
    section: OutlineSection,
    pack: dict[str, Any],
    previous_summaries: list[str],
    *,
    compact: bool,
) -> dict[str, Any]:
    mapped_sources = map_authority_sources_to_section(plan, section, pack)
    mapped_urls = {str(item.get("url") or "") for item in mapped_sources}
    claims = [
        item
        for item in plan.claims
        if item.claim_id in section.claim_ids and item.source_url in mapped_urls
    ]
    internal = [
        item for item in pack.get("internal_sources", []) if item.get("url") in section.internal_urls
    ]
    conversions = list(
        ((pack.get("project") or {}).get("profile") or {}).get("conversion_actions")
        or []
    )
    return {
        "language": pack["language"],
        "keyword": pack["keyword"],
        "title": plan.title,
        "article_type": plan.article_type,
        "article_contract": plan.contract.model_dump(mode="json") if plan.contract else None,
        "section_contract": _section_contract_payload(plan, section.section_id),
        "section": section.model_dump(mode="json"),
        "writing_requirements": _section_writing_requirements(section),
        "universal_editing_checks": list(SECTION_EDITING_CHECKS),
        "section_specific_checks": list(
            SECTION_SPECIFIC_EDITING_CHECKS[section.section_type]
        ),
        "ai_phrases_to_remove": list(AI_PHRASES_TO_REMOVE[:8]),
        "vague_words_to_replace": dict(list(VAGUE_WORD_REPLACEMENTS.items())[:6]),
        "supported_claims": [item.model_dump(mode="json") for item in claims],
        "authority_sources": mapped_sources,
        "internal_links": internal,
        "conversion_actions": conversions if section.cta_type else [],
        "previous_section_summaries": previous_summaries,
        "project_writing_rules": (pack.get("project") or {}).get("profile", {}),
        "locked_requirements": _locked_requirements(pack),
        "target": "complete concise section" if compact else "complete useful section",
    }


_SOURCE_MAPPING_STOP_WORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "with", "by", "is", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "must", "can", "this", "that", "these", "those", "how", "what", "when", "where",
    "why", "who", "which", "more", "most", "some", "any", "all", "each", "every",
    "other", "another", "such", "no", "not", "only", "same", "so", "than", "too",
    "very", "just", "also", "into", "about", "from", "however", "therefore",
}
_SOURCE_MAPPING_SYNONYMS = {
    "ai": ("artificial intelligence", "machine intelligence"),
    "ml": ("machine learning",),
    "nlp": ("natural language processing",),
    "iot": ("internet of things",),
    "saas": ("software as a service",),
    "b2b": ("business to business",),
    "b2c": ("business to consumer",),
    "roi": ("return on investment",),
    "kpi": ("key performance indicator",),
    "seo": ("search engine optimization",),
}
_SOURCE_MAPPING_INTENT_TERMS = {
    "informational": ("what", "how", "why", "guide", "tutorial", "explain", "learn"),
    "navigational": ("find", "locate", "search", "where", "site", "website", "page"),
    "transactional": ("buy", "purchase", "order", "price", "cost", "deal", "offer"),
    "commercial": ("compare", "review", "best", "top", "vs", "versus", "alternative"),
}
_SOURCE_MAPPING_SUFFIXES = (
    "ization", "ation", "tion", "sion", "ment", "ness", "ity", "ing", "able", "ible",
    "ful", "less", "ous", "ive", "ally", "ly", "er", "ed", "es", "s",
)


def map_authority_sources_to_section(
    plan: ArticlePlan, section: OutlineSection, pack: dict[str, Any]
) -> list[dict[str, Any]]:
    sources = [
        dict(item)
        for item in pack.get("authority_sources") or []
        if item.get("url") and item.get("excerpt")
    ]
    if not sources:
        return []
    by_url = {str(item["url"]): item for item in sources}
    direct_urls = _unique(
        [
            claim.source_url
            for claim in plan.claims
            if claim.supported
            and claim.claim_id in section.claim_ids
            and claim.source_url in by_url
        ]
    )
    selected = [by_url[url] for url in direct_urls[:3]]
    if len(selected) == 3:
        return selected

    scored: list[tuple[float, str, dict[str, Any]]] = []
    for source in sources:
        url = str(source["url"])
        if url in direct_urls:
            continue
        semantic = _source_semantic_score(section, source)
        keyword = _source_keyword_score(section, source, pack)
        contextual = _source_contextual_score(plan, section, source, pack)
        total = semantic * 0.4 + keyword * 0.3 + contextual * 0.3
        if total >= 0.4:
            scored.append((total, url, source))
    scored.sort(key=lambda item: (-item[0], item[1]))
    selected.extend(item[2] for item in scored[: 3 - len(selected)])
    return selected


def _source_mapping_words(value: str) -> list[str]:
    return [
        word
        for word in re.findall(r"\b[a-zA-Z]+\b", value.casefold())
        if word not in _SOURCE_MAPPING_STOP_WORDS and len(word) > 2
    ]


def _source_mapping_stem(word: str) -> str:
    if len(word) <= 3:
        return word
    for suffix in _SOURCE_MAPPING_SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


def _source_mapping_bigrams(value: str) -> set[str]:
    words = _source_mapping_words(value)
    return {f"{words[index]} {words[index + 1]}" for index in range(len(words) - 1)}


def _source_mapping_section_text(section: OutlineSection) -> str:
    return " ".join(
        [
            section.heading,
            section.objective,
            *section.coverage_points,
            *section.required_questions,
            *section.data_requirements,
            section.strategic_angle,
        ]
    )


def _source_mapping_source_text(source: dict[str, Any]) -> str:
    return " ".join(
        [
            str(source.get("title") or ""),
            str(source.get("research_claim") or ""),
            str(source.get("citation_excerpt") or ""),
            str(source.get("excerpt") or ""),
            str(source.get("research_answer") or "")[:500],
        ]
    )


def _source_synonym_score(section_words: list[str], source_words: list[str]) -> float:
    section_set = set(section_words)
    source_set = set(source_words)
    matches = 0
    for abbreviation, expansions in _SOURCE_MAPPING_SYNONYMS.items():
        for expansion in expansions:
            expansion_words = set(expansion.split())
            if (
                abbreviation in section_set and expansion_words.issubset(source_set)
            ) or (
                abbreviation in source_set and expansion_words.issubset(section_set)
            ):
                matches += 1
    return min(0.2, matches * 0.05)


def _source_semantic_score(section: OutlineSection, source: dict[str, Any]) -> float:
    section_text = _source_mapping_section_text(section)
    source_text = _source_mapping_source_text(source)
    section_words = _source_mapping_words(section_text)
    source_words = _source_mapping_words(source_text)
    if not section_words or not source_words:
        return 0.0
    section_set = set(section_words)
    source_set = set(source_words)
    union = section_set | source_set
    jaccard = len(section_set & source_set) / len(union) if union else 0.0
    section_stems = {_source_mapping_stem(item) for item in section_words}
    source_stems = {_source_mapping_stem(item) for item in source_words}
    stem_union = section_stems | source_stems
    stem_score = len(section_stems & source_stems) / len(stem_union) if stem_union else 0.0
    bigram_score = min(
        0.3,
        len(_source_mapping_bigrams(section_text) & _source_mapping_bigrams(source_text))
        * 0.1,
    )
    heading_words = set(_source_mapping_words(section.heading))
    title_words = set(_source_mapping_words(str(source.get("title") or "")))
    title_union = heading_words | title_words
    title_overlap = len(heading_words & title_words) / len(title_union) if title_union else 0.0
    title_boost = min(0.3, title_overlap * 0.5)
    return min(
        1.0,
        max(jaccard, stem_score)
        + bigram_score
        + title_boost
        + _source_synonym_score(section_words, source_words),
    )


def _source_keyword_score(
    section: OutlineSection, source: dict[str, Any], pack: dict[str, Any]
) -> float:
    section_keywords = set(_source_mapping_words(_source_mapping_section_text(section)))
    source_keywords = set(
        _source_mapping_words(
            f"{source.get('title', '')} {source.get('excerpt', '')} "
            f"{source.get('research_claim', '')}"
        )
    )
    brief = dict(pack.get("content_brief") or {})
    research_keywords = set(
        _source_mapping_words(
            " ".join(
                [
                    str(pack.get("keyword") or ""),
                    *[str(item) for item in brief.get("secondary_keywords") or []],
                    *[str(item) for item in brief.get("semantic_keywords") or []],
                ]
            )
        )
    )
    section_overlap = (
        len(section_keywords & source_keywords) / len(section_keywords)
        if section_keywords
        else 0.0
    )
    research_overlap = (
        len(research_keywords & source_keywords) / len(research_keywords)
        if research_keywords
        else 0.0
    )
    return min(1.0, section_overlap * 0.7 + research_overlap * 0.3)


def _source_contextual_score(
    plan: ArticlePlan,
    section: OutlineSection,
    source: dict[str, Any],
    pack: dict[str, Any],
) -> float:
    section_text = _source_mapping_section_text(section).casefold()
    source_text = _source_mapping_source_text(source).casefold()
    score = 0.0
    angles = _unique(
        [
            section.strategic_angle,
            *section.competitor_gaps,
            *[str(item) for item in (pack.get("content_brief") or {}).get("content_angles") or []],
        ]
    )
    for angle in angles:
        words = _source_mapping_words(angle)
        if not words:
            continue
        section_match = sum(word in section_text for word in words) / len(words)
        source_match = sum(word in source_text for word in words) / len(words)
        score += (section_match + source_match) * 0.3
    intent = plan.search_intent.casefold()
    intent_name = next(
        (name for name in _SOURCE_MAPPING_INTENT_TERMS if name in intent),
        "informational",
    )
    intent_score = sum(
        0.1
        for term in _SOURCE_MAPPING_INTENT_TERMS[intent_name]
        if term in section_text or term in source_text
    )
    return min(1.0, score + min(0.3, intent_score))


SECTION_EDITING_CHECKS = [
    "Remove AI phrases from the removal list",
    "Replace vague words with specific data/examples",
    "Ensure no paragraph exceeds 4 sentences",
    "Mix short sentences (5-10 words) with longer ones (15-25 words)",
    "Add contractions for natural voice",
    "Use active voice (target 80%+)",
    "Add parenthetical asides or questions for engagement",
    "Verify brand voice consistency",
]

SECTION_SPECIFIC_EDITING_CHECKS = {
    "intro": [
        "Hook is compelling (not generic)",
        "APP formula present",
        "Primary keyword in first 100 words",
        "Trust signal included",
    ],
    "body_how_to": [
        "Steps are numbered",
        "Each step is actionable",
        "Specific tools/platforms named",
        "Outcomes are clear",
    ],
    "body_comparison": [
        "Comparison is fair",
        "Specific data points present",
        "'Best for' recommendations included",
        "Not overly promotional",
    ],
    "body_explanation": [
        "Complexity builds appropriately",
        "Analogies/examples present",
        "Technical terms defined",
    ],
    "body_list": [
        "Items are consistently formatted",
        "Each item has explanation",
        "Order is logical",
    ],
    "faq": [
        "Questions are authentic",
        "Answers are 40-60 words",
        "Direct answer first in each",
    ],
    "conclusion": [
        "More than summary",
        "Specific action items",
        "Strong CTA present",
        "Empowering tone",
    ],
}

AI_PHRASES_TO_REMOVE = [
    "In today's",
    "When it comes to",
    "It's important to note",
    "It's worth noting",
    "In the world of",
    "At the end of the day",
    "Moving forward",
    "In order to",
    "First and foremost",
    "Last but not least",
    "Without further ado",
    "Needless to say",
    "As mentioned earlier",
    "It goes without saying",
    "In conclusion",
    "To summarize",
]

VAGUE_WORD_REPLACEMENTS = {
    "many": "specific number or percentage",
    "some": "specific count",
    "various": "list specific examples",
    "numerous": "specific number",
    "significant": "specific percentage or amount",
    "substantial": "specific quantity",
    "a lot of": "specific number",
    "several": "exact count",
    "often": "specific frequency",
    "usually": "percentage of time",
    "sometimes": "specific scenarios",
    "things": "specific items",
    "stuff": "specific items",
    "good": "specific benefit",
    "bad": "specific drawback",
    "nice": "specific quality",
    "great": "specific advantage",
}


def _section_contract_payload(plan: ArticlePlan, section_id: str) -> dict[str, Any]:
    if plan.contract is None:
        return {}
    section = next(
        (item for item in plan.contract.sections if item.section_id == section_id), None
    )
    return section.model_dump(mode="json") if section is not None else {}


def _section_writing_requirements(section: OutlineSection) -> dict[str, list[str]]:
    requirements: dict[str, dict[str, list[str]]] = {
        "intro": {
            "must": [
                "Open with a concrete reader situation or direct answer in the first two sentences",
                "Acknowledge the problem, promise the value, and preview what follows",
                "Use the primary keyword naturally near the opening",
            ],
            "do": [
                "Establish trust only with supplied project facts or supported evidence",
                "Make clear what the reader will learn or be able to decide",
            ],
            "avoid": [
                "Dictionary definitions and generic scene-setting",
                "Openings such as 'when it comes to', 'in today's world', or 'welcome to'",
            ],
            "checks": [
                "The hook is specific and the promised value is clear",
                "No unsupported trust signal or statistic was added",
            ],
        },
        "body_how_to": {
            "must": [
                "Present sequential work as numbered steps",
                "Make every step actionable and state the expected outcome",
                "Include prerequisites, substeps, and common mistakes when relevant",
            ],
            "do": [
                "Start steps with action verbs",
                "Name tools or platforms only when supplied by the evidence or project data",
            ],
            "avoid": [
                "Vague instructions or skipped dependencies",
                "Invented time estimates, tool behavior, or success claims",
            ],
            "checks": [
                "Steps are in a usable order and can be followed without guessing",
                "Outcomes are explicit",
            ],
        },
        "body_comparison": {
            "must": [
                "State the decision criteria before comparing options",
                "Give a fair, balanced comparison and clear best-for recommendations",
                "Use a compact table when comparing three or more options and evidence supports it",
            ],
            "do": [
                "Acknowledge meaningful strengths and drawbacks",
                "Use prices, features, and measurements only from supported claims",
            ],
            "avoid": [
                "Unsupported superiority claims or promotional dismissal of alternatives",
                "Specific comparison data that is not in the supplied evidence",
            ],
            "checks": [
                "The reader can make a decision from the stated criteria",
                "Every concrete comparison claim is supported",
            ],
        },
        "body_explanation": {
            "must": [
                "Start with a plain-language answer and build from simple to advanced",
                "Define necessary technical terms",
                "Use concrete examples only when they can be grounded in supplied information",
            ],
            "do": [
                "Connect the explanation to the reader's practical decision",
                "Use an analogy only when it clarifies rather than replaces the explanation",
            ],
            "avoid": [
                "Unexplained jargon and abstract filler",
                "Fabricated people, case studies, outcomes, or examples presented as real",
            ],
            "checks": [
                "A beginner can understand the answer without losing necessary detail",
                "Examples do not introduce unsupported facts",
            ],
        },
        "body_list": {
            "must": [
                "Use a numbered or bulleted list with a consistent item structure",
                "Explain each item instead of naming it only",
                "Order items by importance, sequence, or another stated criterion",
            ],
            "do": [
                "Keep items scannable and use parallel phrasing",
                "Explain why each item matters to the reader",
            ],
            "avoid": [
                "An unexplained list or inconsistent item depth",
                "Arbitrary rankings that are not supported by supplied evidence",
            ],
            "checks": [
                "Every item has useful explanation and the ordering makes sense",
                "The list does not repeat the same point in different words",
            ],
        },
        "faq": {
            "must": [
                "Use the supplied real user questions and format them as clear question-answer pairs",
                "Answer four to six questions when at least four supplied questions are available; otherwise answer every supplied question",
                "Give the direct answer first, followed by only necessary context",
                "Keep each answer about 40-60 words when the language permits for featured-snippet extraction",
            ],
            "do": [
                "Prefer questions not already fully answered by another section",
                "Use supported evidence for concrete facts in answers",
            ],
            "avoid": [
                "Manufactured questions when supplied user questions are available",
                "Essay-length answers or unsupported yes/no claims",
            ],
            "checks": [
                "Each question is answered immediately and without repetition",
                "Concrete answers remain evidence-grounded",
            ],
        },
        "conclusion": {
            "must": [
                "Turn the main findings into three to five concrete next steps",
                "Add no new factual claims",
                "Include a CTA only when conversion_actions are supplied",
            ],
            "do": [
                "Help the reader choose or act based on the article",
                "Use the primary keyword naturally when it fits",
            ],
            "avoid": [
                "A paragraph that merely repeats the introduction",
                "A forced CTA, new evidence, or generic encouragement",
            ],
            "checks": [
                "The reader knows what to do next",
                "Any CTA matches one of the supplied conversion actions",
            ],
        },
    }
    selected = requirements[section.section_type]
    return {key: list(values) for key, values in selected.items()}


def _section_requirements(
    sections: list[OutlineSection],
) -> dict[str, dict[str, list[str]]]:
    return {
        section.section_id: _section_writing_requirements(section)
        for section in sections
    }


def fallback_section(
    section: OutlineSection,
    language: str,
    pack: dict[str, Any] | None = None,
    plan: ArticlePlan | None = None,
) -> SectionDraft:
    pack = pack or {}
    keyword = str(pack.get("keyword") or (plan.title if plan else section.heading))
    coverage = _unique(
        [section.objective, *section.coverage_points, *section.competitor_gaps]
    )[:5]
    questions = _unique(section.required_questions)[:4]
    claims = [
        claim
        for claim in (plan.claims if plan else [])
        if claim.claim_id in section.claim_ids and claim.supported
    ][:3]
    if language.lower().startswith("zh"):
        paragraphs = [
            f"## {section.heading}",
            f"围绕“{keyword}”，这一部分先解决读者最需要判断的问题：{section.objective.rstrip('。')}。"
            "应先区分已经由资料支持的结论、项目自身信息和仍需谨慎表达的判断，避免把推测写成事实。",
        ]
        if coverage:
            paragraphs.append(
                "实际处理时可以按以下顺序核对：\n"
                + "\n".join(f"- {item.rstrip('。')}" for item in coverage)
            )
        if questions:
            paragraphs.append(
                "读者关心的问题应直接回答：\n"
                + "\n".join(
                    f"- **{question}** 当前资料不足以支持具体数字时，应给出判断方法和适用条件，而不是编造结论。"
                    for question in questions
                )
            )
        if claims:
            paragraphs.append(
                "当前可引用的事实依据包括：\n"
                + "\n".join(
                    f"- [{claim.claim}]({claim.source_url})" for claim in claims
                )
            )
        paragraphs.append(
            "执行时先核对自身条件，再按上述要点逐项判断；没有可靠来源的价格、比例、日期或效果承诺不应写入结论。"
        )
    else:
        paragraphs = [
            f"## {section.heading}",
            f"For {keyword}, this section focuses on the reader's practical decision: "
            f"{section.objective.rstrip('.')}. Separate supported evidence, project information, "
            "and judgment calls so assumptions are not presented as facts.",
        ]
        if coverage:
            paragraphs.append(
                "Use this sequence to evaluate the topic:\n"
                + "\n".join(f"- {item.rstrip('.')}" for item in coverage)
            )
        if questions:
            paragraphs.append(
                "Address the reader's questions directly:\n"
                + "\n".join(
                    f"- **{question}** When the supplied evidence does not support a specific "
                    "figure, explain the decision method and conditions instead of inventing one."
                    for question in questions
                )
            )
        if claims:
            paragraphs.append(
                "The available factual support includes:\n"
                + "\n".join(
                    f"- [{claim.claim}]({claim.source_url})" for claim in claims
                )
            )
        paragraphs.append(
            "Check the reader's situation first, work through the relevant factors, and leave out "
            "prices, percentages, dates, or performance promises that the supplied sources do not verify."
        )
    return SectionDraft(
        section_id=section.section_id,
        markdown="\n\n".join(paragraphs),
        summary=f"degraded_fallback:{section.objective}",
    )


def concise_section_fallback(
    section: OutlineSection,
    language: str,
    pack: dict[str, Any] | None = None,
    plan: ArticlePlan | None = None,
) -> SectionDraft:
    return fallback_section(section, language, pack, plan)


def _section_context_summary(section: SectionDraft) -> str:
    if section.summary and not section.summary.startswith("degraded_fallback:"):
        return section.summary[:1000]
    text = re.sub(r"(?m)^#{1,6}\s+", "", section.markdown)
    text = re.sub(r"\[([^\]]+)\]\(https?://[^\s)]+\)", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()[:1000]


def normalize_section(draft: SectionDraft, expected: OutlineSection) -> SectionDraft:
    markdown = draft.markdown.strip()
    if not re.search(r"^##\s+", markdown, flags=re.MULTILINE):
        markdown = f"## {expected.heading}\n\n{markdown}"
    return draft.model_copy(update={"section_id": expected.section_id, "markdown": markdown})


def normalize_unified(
    unified: UnifiedArticle,
    plan: ArticlePlan,
    fallback: list[SectionDraft],
    *,
    locked_title: str | None = None,
) -> UnifiedArticle:
    by_id = {item.section_id: item for item in unified.sections}
    if any(
        item.section_id not in by_id or not _has_section_prose(by_id[item.section_id].markdown)
        for item in plan.sections
    ):
        return UnifiedArticle(
            title=plan.title,
            meta_title=plan.meta_title,
            meta_description=plan.meta_description,
            slug=plan.slug,
            sections=fallback,
        )
    return unified.model_copy(
        update={
            "title": locked_title or unified.title,
            "slug": normalize_slug(unified.slug, plan.slug),
            "sections": [by_id[item.section_id] for item in plan.sections],
        }
    )


def _has_section_prose(markdown: str) -> bool:
    return any(
        line.strip() and not re.match(r"^#{1,6}\s+", line.strip())
        for line in markdown.splitlines()
    )


NON_REPAIRABLE_EVIDENCE_CODES = {
    "missing_authority_evidence",
    "authority_evidence_missing",
    "missing_product_evidence",
    "product_evidence_missing",
    "missing_price_evidence",
    "price_evidence_missing",
    "missing_professional_source",
    "professional_source_missing",
    "no_internal_source",
    "internal_source_missing",
    "required_claim_unsupported",
    "research_gap",
}
FORMAT_ISSUE_CODES = {
    "invalid_heading_hierarchy",
    "how_to_steps_missing",
    "list_structure_missing",
    "faq_qa_structure_missing",
    "conclusion_actions_missing",
}
STRUCTURE_ISSUE_CODES = {
    "section_missing",
    "duplicate_section",
    "section_too_short",
    "competitor_copy",
}
EVIDENCE_ISSUE_CODES = {
    "unsupported_number",
    "unsupported_strong_claim",
    "source_not_assigned_to_section",
    "invalid_link",
}


def _classify_quality_issue(issue: SectionIssue) -> SectionIssue:
    code = issue.code.casefold()
    message = issue.message.casefold()
    missing_evidence = (
        code in NON_REPAIRABLE_EVIDENCE_CODES
        or (
            any(term in code for term in ("missing", "unavailable", "not_found", "gap"))
            and any(
                term in f"{code} {message}"
                for term in (
                    "evidence",
                    "source",
                    "research",
                    "product",
                    "price",
                    "internal",
                    "authority",
                    "citation",
                )
            )
        )
    )
    if missing_evidence:
        return issue.model_copy(update={"category": "evidence", "repairable": False})
    if code in EVIDENCE_ISSUE_CODES:
        return issue.model_copy(update={"category": "evidence", "repairable": True})
    if code in FORMAT_ISSUE_CODES:
        return issue.model_copy(update={"category": "format", "repairable": True})
    if code in STRUCTURE_ISSUE_CODES:
        return issue.model_copy(update={"category": "structure", "repairable": True})
    return issue.model_copy(update={"category": "prose", "repairable": True})


def _issue_fingerprint(issues: list[SectionIssue]) -> list[str]:
    return sorted(
        {
            f"{item.category}:{item.section_id}:{item.code}"
            for item in issues
        }
    )


def article_artifact(
    plan: ArticlePlan,
    sections: list[SectionDraft],
    pack: dict[str, Any],
    *,
    degraded_section_ids: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "kind": "article_draft",
        "title": plan.title,
        "slug": plan.slug,
        "meta_title": plan.meta_title,
        "meta_description": plan.meta_description,
        "plan": plan.model_dump(mode="json"),
        "sections": [item.model_dump(mode="json") for item in sections],
        "markdown": article_markdown(plan.title, sections),
        "source_urls": sorted(allowed_urls(pack)[0]),
        "internal_urls": sorted(allowed_urls(pack)[1]),
        "quality": {},
        "degraded_section_ids": sorted(set(degraded_section_ids or [])),
    }


def finalize_article_artifact(
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    finalized = deepcopy(artifact)
    globally_allowed_source_urls = {
        str(url) for url in finalized.get("source_urls") or [] if url
    }
    globally_allowed_internal_urls = {
        str(url) for url in finalized.get("internal_urls") or [] if url
    }
    globally_allowed_urls = {
        str(url)
        for key in ("source_urls", "internal_urls")
        for url in finalized.get(key) or []
        if url
    }
    plan = ArticlePlan.model_validate(finalized.get("plan") or {})
    claim_urls_by_section: dict[str, set[str]] = {}
    for claim in plan.claims:
        if claim.supported and claim.section_id and claim.source_url in globally_allowed_urls:
            claim_urls_by_section.setdefault(claim.section_id, set()).add(claim.source_url)
    internal_urls_by_section = {
        section.section_id: set(section.internal_urls).intersection(globally_allowed_urls)
        for section in plan.sections
    }
    malformed_count = 0
    removed_internal_count = 0
    seen_internal_urls: set[str] = set()
    sections: list[dict[str, Any]] = []
    for raw_section in finalized.get("sections") or []:
        section = dict(raw_section)
        section_id = str(section.get("section_id") or "")
        section_urls = claim_urls_by_section.get(section_id, set()).union(
            internal_urls_by_section.get(section_id, set())
        )
        section["markdown"], removed = sanitize_markdown_links(
            str(section.get("markdown") or ""), section_urls
        )
        malformed_count += removed
        raw_urls = _MARKDOWN_LINK_PATTERN.findall(section["markdown"])
        removed_internal_count += sum(
            1
            for url in raw_urls
            if url in globally_allowed_internal_urls
            and url not in internal_urls_by_section.get(section_id, set())
        )
        section["markdown"] = sanitize_allowed_links(section["markdown"], section_urls)
        section["markdown"], used_internal_urls, removed_internal = sanitize_internal_links(
            section["markdown"],
            internal_urls_by_section.get(section_id, set()),
            seen_internal_urls,
            remaining=max(0, 5 - len(seen_internal_urls)),
        )
        removed_internal_count += removed_internal
        used_claim_ids = set(section.get("used_claim_ids") or [])
        used_claims = [
            claim
            for claim in plan.claims
            if claim.claim_id in used_claim_ids
            and claim.section_id == section_id
            and claim.source_url in section_urls
        ]
        section["markdown"], _ = restore_link_only_claims(
            section["markdown"], used_claims
        )
        markdown_urls = set(_MARKDOWN_LINK_PATTERN.findall(section["markdown"]))
        section["used_source_urls"] = sorted(
            markdown_urls.intersection(globally_allowed_source_urls)
        )
        section["used_internal_urls"] = sorted(used_internal_urls)
        sections.append(section)
    finalized["sections"] = sections
    if sections:
        finalized["markdown"] = article_markdown(
            str(finalized.get("title") or ""),
            [SectionDraft.model_validate(section) for section in sections],
        )
    else:
        finalized["markdown"], removed = sanitize_markdown_links(
            str(finalized.get("markdown") or ""), set()
        )
        malformed_count += removed
    warnings = []
    if malformed_count:
        warnings.append(
            _warning(
                "malformed_links_removed",
                "最终正文中的残缺链接已移除，并保留了可见文字",
            )
        )
    if removed_internal_count:
        warnings.append(
            _warning(
                "invalid_internal_links_removed",
                "未按章节分配、重复或超量的内链已移除，并保留了锚文本",
            )
        )
    return finalized, warnings


def _copy_content_score(
    target: dict[str, Any], source: dict[str, Any]
) -> None:
    if "content_score" in source:
        target["content_score"] = deepcopy(source["content_score"])
    if "content_score_history" in source:
        target["content_score_history"] = deepcopy(source["content_score_history"])
    if "content_score_revision_count" in source:
        target["content_score_revision_count"] = int(
            source["content_score_revision_count"]
        )


async def recover_generation_stage(
    repo: ContentRepository,
    settings: Settings,
    context: dict[str, Any],
    policy: dict[str, bool],
    stage_kind: str,
) -> dict[str, Any]:
    del policy
    run_id = str(context["run_id"])
    store = artifact_store(settings)
    warning = _warning(
        f"{stage_kind}_degraded",
        {
            "planning": "大纲增强暂不可用，已使用基础结构继续",
            "writing": "部分章节已按可验证资料生成降级稿",
            "editing": "全文编辑暂不可用，已保留合并后的完整稿",
            "checking": "检查服务暂不可用，已保留完整稿并记录未完成检查",
            "revising": "局部修订暂不可用，已保留修订前完整稿",
        }[stage_kind],
    )
    if stage_kind == "planning":
        try:
            pack = await build_research_pack(repo, settings, context)
        except Exception:
            snapshot = dict(context.get("project_snapshot") or {})
            pack = {
                "keyword": context["primary_keyword"],
                "country": snapshot.get("country") or "US",
                "language": snapshot.get("language") or "en",
                "project": snapshot,
                "serp": {},
                "serp_analysis": {},
                "content_brief": {},
                "questions": [],
                "required_questions": [],
                "competitors": [],
                "competitor_blueprint": {},
                "authority_sources": [],
                "internal_sources": [],
                "evidence_capabilities": _build_evidence_capabilities(
                    competitor_blueprint={},
                    competitors=[],
                    authority_sources=[],
                    internal_sources=[],
                ),
            }
        plan = fallback_plan(pack)
        pack["search_intent"] = plan.search_intent
        pack["article_type"] = plan.article_type
        pack["evidence_claims"] = []
        pack_ref = await store.write_json(
            f"article-runs/{run_id}/planning/research-pack.json.gz", pack
        )
        await repo.bind_plan_sources(run_id, plan.model_dump(mode="json"))
        output_ref = await store.write_json(
            f"article-runs/{run_id}/planning/plan.json.gz",
            {
                "kind": "article_plan",
                "research_pack_ref": pack_ref,
                "plan": plan.model_dump(mode="json"),
            },
        )
        return {
            "output_ref": output_ref,
            "warning": warning,
            "summary": {"section_count": len(plan.sections), "recovered": True},
        }

    if stage_kind == "writing":
        recovered = await write_article_sections(repo, settings, context, {})
        warnings = [warning, *list(recovered.get("warnings") or [])]
        recovered["warning"] = warning
        recovered["warnings"] = list(
            {item["code"]: item for item in warnings}.values()
        )
        recovered["summary"] = {
            **dict(recovered.get("summary") or {}),
            "recovered": True,
        }
        return recovered

    source_key = str(
        context.get("input_step_key")
        or {"editing": "writing", "checking": "editing", "revising": "checking"}[
            stage_kind
        ]
    )
    artifact = await _required_stage_artifact(settings, context, source_key)
    if stage_kind == "editing":
        plan = ArticlePlan.model_validate(artifact["plan"])
        sections = [SectionDraft.model_validate(item) for item in artifact["sections"]]
        pack = await _pack_from_context(settings, context)
        allowed_sources, allowed_internal = allowed_urls(pack)
        sections = sanitize_sections(
            sections,
            plan,
            allowed_source_urls=allowed_sources,
            allowed_internal_urls=allowed_internal,
        )
        (
            plan,
            sections,
            score,
            content_score_history,
            content_score_revision_count,
            quality_warnings,
            model_failures,
            usages,
        ) = await _apply_content_quality_loop(
            writing_gateway(context),
            settings,
            context,
            plan,
            sections,
            pack,
            allowed_sources,
            allowed_internal,
        )
        artifact = article_artifact(
            plan,
            sections,
            pack,
            degraded_section_ids=list(artifact.get("degraded_section_ids") or []),
        )
        artifact["content_score"] = score
        artifact["content_score_history"] = content_score_history
        artifact["content_score_revision_count"] = content_score_revision_count
        output_ref = await store.write_json(
            f"article-runs/{run_id}/{context.get('step_key') or stage_kind}/article.json.gz",
            artifact,
        )
        return {
            "output_ref": output_ref,
            "warning": warning,
            "warnings": quality_warnings,
            "summary": {
                "section_count": len(sections),
                "complete": True,
                "content_score": score["composite_score"],
                "content_score_passed": score["passed"],
                "content_score_iterations": content_score_revision_count,
                "model_failures": model_failures,
                "recovered": True,
            },
            "usage": merge_usage(usages),
        }
    if stage_kind == "checking":
        plan = ArticlePlan.model_validate(artifact["plan"])
        sections = [SectionDraft.model_validate(item) for item in artifact["sections"]]
        pack = await _pack_from_context(settings, context)
        allowed_sources, allowed_internal = allowed_urls(pack)
        report = deterministic_quality_check(
            plan,
            sections,
            allowed_source_urls=allowed_sources,
            allowed_internal_urls=allowed_internal,
            competitor_passages=_competitor_passages(pack),
        )
        classified_issues = [
            _classify_quality_issue(item) for item in report.issues
        ]
        issues = [item.model_dump(mode="json") for item in classified_issues]
        for section_id in artifact.get("degraded_section_ids") or []:
            issues.append(
                {
                    "section_id": section_id,
                    "code": "fallback_section",
                    "message": "章节使用了确定性降级稿，需要自动重写并重新检查",
                    "category": "prose",
                    "repairable": True,
                }
            )
        unique_issues = list(
            {
                (item["section_id"], item["code"]): item for item in issues
            }.values()
        )
        repairable_issues = [item for item in unique_issues if item.get("repairable")]
        artifact["quality"] = {
            **report.to_dict(),
            "passed": False,
            "check_status": "unavailable",
            "repairable": False,
            "repair_scope": [],
            "issues": unique_issues,
            "issue_fingerprint": sorted(
                f"{item['category']}:{item['section_id']}:{item['code']}"
                for item in unique_issues
            ),
            "repairable_issue_fingerprint": sorted(
                f"{item['category']}:{item['section_id']}:{item['code']}"
                for item in repairable_issues
            ),
            "repairable_issue_count": len(repairable_issues),
            "evidence_issue_count": sum(
                1
                for item in unique_issues
                if item.get("category") == "evidence" and not item.get("repairable")
            ),
        }
        summary = {
            "issue_count": len(artifact["quality"]["issues"]),
            "passed": False,
            "check_status": "unavailable",
            "repairable": False,
            "repair_scope": artifact["quality"]["repair_scope"],
            "repairable_issue_count": artifact["quality"]["repairable_issue_count"],
            "evidence_issue_count": artifact["quality"]["evidence_issue_count"],
        }
        content_score = artifact.get("content_score")
        if isinstance(content_score, dict):
            summary.update(
                {
                    "content_score": content_score.get("composite_score"),
                    "content_score_passed": content_score.get("passed") is True,
                }
            )
    else:
        summary = {"revised_sections": 0, "passed": False, "recovered": True}
    output_ref = await store.write_json(
        f"article-runs/{run_id}/{context.get('step_key') or stage_kind}/article.json.gz",
        artifact,
    )
    return {"output_ref": output_ref, "warning": warning, "summary": summary}


def allowed_urls(pack: dict[str, Any]) -> tuple[set[str], set[str]]:
    source_urls = {
        str(item["url"])
        for group in ("authority_sources", "competitors")
        for item in pack.get(group, [])
        if item.get("url")
    }
    internal_urls = {
        str(item["url"])
        for item in pack.get("internal_sources", [])
        if item.get("url")
        and project_domain_matches(str(item["url"]), str((pack.get("project") or {}).get("domain") or ""))
    }
    return source_urls, internal_urls


async def _required_stage_artifact(
    settings: Settings, context: dict[str, Any], step_key: str
) -> dict[str, Any]:
    ref = (context.get("completed_steps") or {}).get(step_key, {}).get("output_ref")
    if not ref:
        raise LookupError(f"article_{step_key}_artifact_missing")
    return await artifact_store(settings).read_json(str(ref))


async def _pack_from_context(settings: Settings, context: dict[str, Any]) -> dict[str, Any]:
    planning = await _required_stage_artifact(settings, context, "planning")
    return await artifact_store(settings).read_json(str(planning["research_pack_ref"]))


def _structured_summary(text: str) -> dict[str, Any]:
    headings = [
        match.group(1).strip()[:160]
        for match in re.finditer(r"(?m)^#{1,6}\s+(.+?)\s*$", text)
    ][:12]
    cleaned = re.sub(r"\s+", " ", re.sub(r"(?m)^#{1,6}\s+", "", text)).strip()
    sentences = [
        item.strip()
        for item in re.split(r"(?<=[.!?。！？])\s+", cleaned)
        if item.strip()
    ]
    return {
        "headings": list(dict.fromkeys(headings)),
        "opening": " ".join(sentences[:2])[:400],
        "key_points": [item[:240] for item in sentences[2:10]],
        "closing": " ".join(sentences[-2:])[:400] if len(sentences) > 2 else "",
    }


def _fallback_competitor_analysis(
    text: str, source_summary: dict[str, Any]
) -> dict[str, Any]:
    summary = _structured_summary(text)
    structure = []
    for item in source_summary.get("heading_structure") or []:
        if not isinstance(item, dict):
            continue
        heading = str(item.get("heading") or "").strip()
        level = item.get("level")
        if heading and level in {2, 3}:
            structure.append({"heading": heading, "level": level, "word_count": 0})
    word_count = source_summary.get("word_count")
    if not isinstance(word_count, int):
        word_count = len(re.findall(r"[A-Za-z0-9]+|[\u4e00-\u9fff]", text))
    return {
        "content_type": str(source_summary.get("content_type") or "General Article"),
        "word_count": word_count,
        "structure": structure[:20],
        "strengths": [],
        "gaps": [],
        "outdated_items": [],
        "opening": summary["opening"],
        "key_points": summary["key_points"],
        "closing": summary["closing"],
    }


def _competitor_passages(pack: dict[str, Any]) -> list[str]:
    passages: list[str] = []
    for competitor in pack.get("competitors") or []:
        summary = competitor.get("summary") or {}
        passages.extend(
            str(value)
            for value in (summary.get("opening"), summary.get("closing"))
            if value
        )
        passages.extend(str(value) for value in summary.get("key_points") or [] if value)
    return passages


def _covered_questions(
    questions: list[Any], sections: list[SectionDraft]
) -> list[str]:
    article_text = re.sub(
        r"[^\w\u4e00-\u9fff]+",
        " ",
        " ".join(item.markdown for item in sections).casefold(),
    )
    covered: list[str] = []
    for value in questions:
        question = str(value).strip()
        tokens = [
            token
            for token in re.sub(r"[^\w\u4e00-\u9fff]+", " ", question.casefold()).split()
            if len(token) >= 3
        ]
        if tokens and all(token in article_text for token in tokens):
            covered.append(question)
    return covered


def normalize_slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not slug:
        slug = re.sub(r"[^a-z0-9]+", "-", fallback.lower()).strip("-")
    return (slug or "article")[:200]


def _unique(values: list[Any]) -> list[str]:
    return list(dict.fromkeys(str(item).strip() for item in values if str(item).strip()))


def _warning(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}
