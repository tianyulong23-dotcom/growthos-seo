from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlsplit

from temporalio.exceptions import WorkflowAlreadyStartedError

from app.cache.client import get_redis
from app.core.config import Settings
from app.modules.content.dataforseo import DataForSEOClient, DataForSEOError
from app.modules.content.object_storage import (
    ObjectWriteError,
    S3JSONWriter,
    S3TextReader,
    StoredTextError,
)
from app.modules.content.repository import ContentRepository, normalize_source_url
from app.modules.content.research_gateway import (
    ResearchError,
    ResearchGateway,
    ResearchCitation,
    ResearchProviderConfig,
    ResearchRequest,
    ResearchResult,
)
from app.modules.content.serp_analysis import (
    analyze_serp,
    select_dominant_type_results,
    serp_analysis_needs_refresh,
)
from app.modules.content.source_verification import (
    assess_source_page,
    classify_source_tier,
    evidence_similarity,
    select_upstream_source_links,
    verify_source_claim_with_quote,
)
from app.workflows.client import connect_temporal
from app.workflows.worker import get_crawler_worker_launcher


WARNING_MESSAGES = {
    "project_profile_missing": "项目业务资料暂不可用，已使用项目基础信息继续",
    "project_profile_incomplete": "项目业务资料不完整，已使用现有字段继续",
    "internal_sources_unavailable": "未取得可用站内页面，本次不插入内链",
    "dataforseo_unavailable": "关键词搜索数据暂不可用，已使用其他资料继续",
    "research_unavailable": "联网研究暂不可用，文章将避免无来源的数字和强结论",
    "competitor_sources_unavailable": "未取得竞争文章正文，已使用搜索摘要和联网研究继续",
    "competitor_sources_partial": "部分竞争文章未取得，已使用成功页面继续",
}


def warning(code: str) -> dict[str, str]:
    return {"code": code, "message": WARNING_MESSAGES[code]}


async def prepare_project(repo: ContentRepository, run_id: str) -> dict[str, Any]:
    snapshot, warning_codes = await repo.save_project_snapshot(run_id)
    return {
        "output_ref": f"db://article-runs/{run_id}/project-snapshot",
        "warnings": [warning(code) for code in warning_codes],
        "summary": {"snapshot_fields": sorted(snapshot)},
    }


async def collect_sources(
    repo: ContentRepository, settings: Settings, context: dict[str, Any]
) -> dict[str, Any]:
    run_id = str(context["run_id"])
    snapshot = dict(context.get("project_snapshot") or {})
    keyword = str(context["primary_keyword"])
    internal_task = asyncio.create_task(
        _collect_internal(repo, settings, run_id, keyword, snapshot)
    )
    serp_task = asyncio.create_task(_collect_serp(repo, settings, run_id, keyword, snapshot))
    research_task = asyncio.create_task(
        _collect_research(repo, settings, run_id, keyword, snapshot)
    )
    internal_outcome, serp_outcome, research_outcome = await asyncio.gather(
        internal_task, serp_task, research_task, return_exceptions=True
    )
    outcomes = [internal_outcome, serp_outcome, research_outcome]
    warning_codes: list[str] = []
    counts: dict[str, int] = {}
    fallback_codes = (
        "internal_sources_unavailable",
        "dataforseo_unavailable",
        "research_unavailable",
    )
    for index, outcome in enumerate(outcomes):
        if isinstance(outcome, BaseException):
            warning_codes.append(fallback_codes[index])
            counts[fallback_codes[index]] = 0
        else:
            code, count = outcome
            if code:
                warning_codes.append(code)
            counts[fallback_codes[index]] = count
    serp_sources = await repo.list_sources(run_id, "serp")
    serp_metadata = dict(serp_sources[0].get("metadata") or {}) if serp_sources else {}
    request_cost = float(serp_metadata.get("request_cost_usd") or 0.0)
    provider_request_id = serp_metadata.get("provider_request_id")
    return {
        "output_ref": f"db://article-runs/{run_id}/sources",
        "warnings": [warning(code) for code in dict.fromkeys(warning_codes)],
        "summary": counts,
        "usage": {
            "reported_cost": request_cost,
            "estimated_cost": None,
            "cost_currency": "USD",
            "estimation_basis": {},
            "provider_request_ids": (
                [str(provider_request_id)] if provider_request_id else []
            ),
        },
    }


async def collect_competitors(
    repo: ContentRepository, settings: Settings, context: dict[str, Any]
) -> dict[str, Any]:
    run_id = str(context["run_id"])
    serp_sources = await repo.list_sources(run_id, "serp")
    serp_payload = serp_sources[0]["summary"] if serp_sources else {}
    project_domain = str((context.get("project_snapshot") or {}).get("domain") or "")
    serp_analysis = dict(serp_payload.get("serp_analysis") or {})
    if not serp_analysis or serp_analysis_needs_refresh(
        serp_analysis, serp_payload.get("organic_results") or []
    ):
        serp_analysis = analyze_serp(
            str(serp_payload.get("keyword") or context.get("primary_keyword") or ""),
            serp_payload.get("organic_results") or [],
            serp_features=_serp_features(serp_payload),
        )
    selected_results = select_dominant_type_results(
        serp_analysis, project_domain=project_domain, limit=8
    )
    urls = [str(item["url"]) for item in selected_results]
    if not urls:
        return _competitor_result(run_id, 0, 0)

    crawl_run, task = await repo.ensure_competitor_crawl(run_id, urls)
    if crawl_run.status not in {"completed", "partial", "failed"}:
        try:
            await get_crawler_worker_launcher().ensure_started()
            client = await connect_temporal()
            try:
                handle = await client.start_workflow(
                    "CrawlWorkflow",
                    task,
                    id=str(crawl_run.temporal_workflow_id),
                    task_queue=settings.crawler_task_queue,
                )
            except WorkflowAlreadyStartedError:
                handle = client.get_workflow_handle(str(crawl_run.temporal_workflow_id))
            await asyncio.wait_for(handle.result(), timeout=300)
        except Exception:
            pass

    pages = await repo.list_competitor_pages(crawl_run.run_id)
    selected_by_url = {
        normalize_source_url(str(item["url"])): item for item in selected_results
    }
    source_payloads: list[dict[str, Any]] = []
    for page in pages:
        parsed = urlsplit(page["url"])
        requested_url = str(page.get("requested_url") or page["url"])
        selected = selected_by_url.get(normalize_source_url(requested_url), {})
        source_payloads.append(
            {
                "source_type": "competitor",
                "url": page["url"],
                "status": page["status"],
                "title": page["title"],
                "domain": parsed.netloc,
                "content_ref": page["content_ref"],
                "summary": {
                    "word_count": page["word_count"],
                    "html_ref": page.get("html_ref"),
                    "serp_position": selected.get("position"),
                    "organic_position": selected.get("organic_position"),
                    "content_type": selected.get("content_type"),
                    "heading_structure": _competitor_heading_structure(page),
                },
                "metadata": {
                    "error_type": page["error_type"],
                    "selection_reason": "dominant_serp_content_type",
                    "dominant_content_type": serp_analysis.get(
                        "dominant_content_type"
                    ),
                },
            }
        )

    failed_payloads: list[dict[str, Any]] = []
    for payload in source_payloads:
        try:
            await repo.upsert_source(run_id, **payload)
        except Exception:
            failed_payloads.append(payload)

    if failed_payloads:
        await asyncio.sleep(0.1)
        retry_failures: list[dict[str, Any]] = []
        for payload in failed_payloads:
            try:
                await repo.upsert_source(run_id, **payload)
            except Exception:
                retry_failures.append(payload)
        failed_payloads = retry_failures

    failed_sync_urls = {
        normalize_source_url(str(payload["url"])) for payload in failed_payloads
    }
    persisted_sources = await repo.list_sources(run_id, "competitor")
    persisted_by_url = {
        normalize_source_url(str(source["url"])): source for source in persisted_sources
    }
    available = 0
    failed = 0
    for payload in source_payloads:
        normalized_url = normalize_source_url(str(payload["url"]))
        source = persisted_by_url.get(normalized_url)
        if (
            normalized_url not in failed_sync_urls
            and source is not None
            and source["status"] == "available"
            and source.get("content_ref")
        ):
            available += 1
        else:
            failed += 1
    return _competitor_result(run_id, available, failed)


def _competitor_heading_structure(page: dict[str, Any]) -> list[dict[str, Any]]:
    h2 = {str(item).strip() for item in page.get("h2") or [] if str(item).strip()}
    h3 = {str(item).strip() for item in page.get("h3") or [] if str(item).strip()}
    output: list[dict[str, Any]] = []
    for value in page.get("headings") or []:
        heading = str(value).strip()
        if heading in h2:
            output.append({"level": 2, "heading": heading})
        elif heading in h3:
            output.append({"level": 3, "heading": heading})
    return output[:30]


async def _collect_internal(
    repo: ContentRepository,
    settings: Settings,
    run_id: str,
    keyword: str,
    snapshot: dict[str, Any],
) -> tuple[str | None, int]:
    del settings
    profile = dict(snapshot.get("profile") or {})
    key_pages = [
        dict(item)
        for item in profile.get("key_pages") or []
        if isinstance(item, dict)
    ]
    candidates = await repo.list_internal_link_candidates(
        run_id, keyword, key_pages, limit=30
    )
    sources: list[dict[str, Any]] = []
    for item in candidates:
        parsed = urlsplit(str(item["url"]))
        sources.append(
            {
                "url": str(item["url"]),
                "title": item.get("title"),
                "domain": parsed.netloc,
                "summary": {
                "description": str(item.get("description") or ""),
                "headings": list(item.get("headings") or [])[:20],
                "anchor_texts": list(item.get("anchor_texts") or [])[:10],
                "candidate_kind": str(item.get("candidate_kind") or "navigation"),
                "selection_score": int(item.get("selection_score") or 0),
                "selection_reason": str(item.get("selection_reason") or ""),
                "word_count": int(item.get("word_count") or 0),
                },
            },
        )
    await repo.replace_internal_sources(run_id, sources)
    available = len(candidates)
    return (None if available else "internal_sources_unavailable", available)


async def _collect_serp(
    repo: ContentRepository,
    settings: Settings,
    run_id: str,
    keyword: str,
    snapshot: dict[str, Any],
) -> tuple[str | None, int]:
    existing = await repo.list_sources(run_id, "serp")
    if existing and existing[0]["status"] == "available":
        source = existing[0]
        serp_payload = dict(source["summary"])
        serp_analysis = dict(serp_payload.get("serp_analysis") or {})
        if not serp_analysis or serp_analysis_needs_refresh(
            serp_analysis, serp_payload.get("organic_results") or []
        ):
            serp_payload["serp_analysis"] = analyze_serp(
                str(serp_payload.get("keyword") or keyword),
                serp_payload.get("organic_results") or [],
                serp_features=_serp_features(serp_payload),
            )
            await repo.upsert_source(
                run_id,
                source_type="serp",
                url=str(source["url"]),
                status="available",
                title=source.get("title") or keyword,
                domain=source.get("domain"),
                content_ref=source.get("content_ref"),
                summary=serp_payload,
                metadata=dict(source.get("metadata") or {}),
            )
        return None, len(serp_payload.get("organic_results", []))
    client = DataForSEOClient(
        login=settings.dataforseo_login,
        password=settings.dataforseo_password,
        base_url=settings.dataforseo_base_url,
        cache=get_redis(),
        cache_ttl_seconds=settings.dataforseo_cache_ttl_seconds,
        timeout_seconds=settings.dataforseo_timeout_seconds,
    )
    try:
        result = await client.search(
            keyword,
            str(snapshot.get("country") or "United States"),
            str(snapshot.get("language") or "en"),
        )
    except DataForSEOError as exc:
        await repo.upsert_source(
            run_id,
            source_type="serp",
            url=f"serp://google/{run_id}",
            status="failed",
            metadata={"error_code": str(exc)},
        )
        return "dataforseo_unavailable", 0
    content_ref = None
    raw_storage_error = None
    if result.raw_response is not None:
        try:
            content_ref = await S3JSONWriter(settings).write_json(
                f"article-runs/{run_id}/sources/dataforseo-serp.json.gz",
                result.raw_response,
            )
        except ObjectWriteError as exc:
            raw_storage_error = exc.code
    metadata: dict[str, Any] = {
        "cached": result.cached,
        "request_cost_usd": result.request_cost_usd,
        "cost_currency": "USD",
    }
    if result.provider_request_id:
        metadata["provider_request_id"] = result.provider_request_id
    if raw_storage_error:
        metadata["raw_response_storage_error"] = raw_storage_error
    serp_payload = result.to_dict()
    serp_payload["serp_analysis"] = analyze_serp(
        keyword,
        serp_payload["organic_results"],
        serp_features=_serp_features(serp_payload),
    )
    await repo.upsert_source(
        run_id,
        source_type="serp",
        url=f"serp://google/{run_id}",
        status="available",
        title=keyword,
        content_ref=content_ref,
        summary=serp_payload,
        metadata=metadata,
    )
    featured = result.featured_snippet or {}
    if featured.get("url"):
        parsed = urlsplit(str(featured["url"]))
        await repo.upsert_source(
            run_id,
            source_type="authority",
            url=str(featured["url"]),
            status="available",
            title=keyword,
            domain=parsed.netloc,
            summary={"research_excerpt": str(featured.get("text") or "")},
            metadata={
                "provider": "dataforseo",
                "source": "featured_snippet",
                "verification_status": "candidate_only",
            },
        )
    return None, len(result.organic_results)


def _serp_features(serp_payload: dict[str, Any]) -> list[str]:
    features = [str(item) for item in serp_payload.get("features") or [] if item]
    if serp_payload.get("featured_snippet"):
        features.append("featured_snippet")
    if serp_payload.get("people_also_ask"):
        features.append("people_also_ask")
    if serp_payload.get("related_searches"):
        features.append("related_searches")
    return list(dict.fromkeys(features))


async def _collect_research(
    repo: ContentRepository,
    settings: Settings,
    run_id: str,
    keyword: str,
    snapshot: dict[str, Any],
    exact_questions: list[str] | None = None,
) -> tuple[str | None, int]:
    existing_sources = await repo.list_sources(run_id, "authority")
    completed_research = [
        item
        for item in existing_sources
        if (item.get("metadata") or {}).get("source") == "web_research"
        and (item.get("metadata") or {}).get("verification_status")
    ]
    if completed_research and not exact_questions:
        available = sum(item["status"] == "available" for item in completed_research)
        return (None if available else "research_unavailable"), available
    serp_sources = await repo.list_sources(run_id, "serp")
    serp = next(
        (item.get("summary") or {} for item in serp_sources if item["status"] == "available"),
        {},
    )
    questions = (
        list(dict.fromkeys(str(item).strip() for item in exact_questions if str(item).strip()))[:4]
        if exact_questions
        else list(
            dict.fromkeys(
                [
                    *[str(item) for item in serp.get("people_also_ask") or [] if item],
                    *[str(item) for item in serp.get("related_searches") or [] if item],
                ]
            )
        )[:6]
    )
    gateway = ResearchGateway(
        ResearchProviderConfig(
            settings.article_research_provider,
            settings.article_research_base_url,
            settings.article_research_api_key,
            settings.article_research_model,
        ),
        ResearchProviderConfig(
            settings.article_research_fallback_provider,
            settings.article_research_fallback_base_url,
            settings.article_research_fallback_api_key,
            settings.article_research_fallback_model,
        ),
        settings.article_research_timeout_seconds,
        cache=get_redis(),
        cache_ttl_seconds=settings.article_research_cache_ttl_seconds,
        max_concurrency=settings.article_research_max_concurrency,
        max_retries=settings.article_research_max_retries,
        timeout_max_retries=settings.article_research_timeout_max_retries,
        circuit_failure_threshold=settings.article_research_circuit_failure_threshold,
        retry_initial_seconds=settings.article_research_retry_initial_seconds,
        retry_max_seconds=settings.article_research_retry_max_seconds,
    )
    try:
        result = await gateway.research(
            ResearchRequest(
                keyword,
                str(snapshot.get("country") or "US"),
                str(snapshot.get("language") or "en"),
                questions,
                exact_queries=bool(exact_questions),
            )
        )
    except Exception as exc:
        error_code = exc.code if isinstance(exc, ResearchError) else "research_unexpected_error"
        research_failures = (
            exc.failure_details() if isinstance(exc, ResearchError) else []
        )
        await repo.upsert_source(
            run_id,
            source_type="authority",
            url=f"research://web/{run_id}",
            status="failed",
            metadata={
                "source": "web_research",
                "verification_status": "research_failed",
                "error_code": error_code,
                "research_failures": research_failures,
            },
        )
        return "research_unavailable", 0
    verified_sources = await _verify_research_sources(
        repo, settings, run_id, result
    )
    source_payloads: dict[str, dict[str, Any]] = {}
    for citation, verification in verified_sources:
        accepted = verification["verification_status"] in {
            "verified",
            "paraphrase",
        }
        verification_claims = [
            dict(item) for item in verification.get("verification_claims") or []
        ]
        if not accepted:
            failed_status = str(verification["verification_status"])
            verification_claims = [
                {**item, "status": failed_status, "evidence": ""}
                for item in verification_claims
            ] or [
                {
                    "claim": citation.claim or citation.excerpt,
                    "status": failed_status,
                    "evidence": "",
                }
            ]
        source_url = (
            str(verification.get("verified_url") or citation.url)
            if accepted
            else citation.url
        )
        parsed = urlsplit(source_url)
        payload = {
            "source_type": "authority",
            "url": source_url,
            "status": "available" if accepted else "failed",
            "title": str(verification.get("verified_title") or citation.title),
            "domain": parsed.netloc,
            "content_ref": verification.get("content_ref"),
            "summary": {
                "research_answer": result.answer[:12000],
                "citation_excerpt": citation.exact_quote,
                "research_claim": citation.claim or citation.excerpt,
                "research_excerpt": (
                    verification.get("research_excerpt") or "" if accepted else ""
                ),
                "verification_claims": verification_claims,
            },
            "metadata": {
                "provider": citation.provider or result.provider,
                "model": citation.model or result.model,
                "source": "web_research",
                "queries": list(citation.queries),
                "failed_queries": result.failed_queries,
                "research_failures": result.research_failures,
                "cached": bool(
                    set(citation.queries).intersection(result.cached_queries)
                ),
                "source_tier": verification["source_tier"],
                "verification_status": verification["verification_status"],
                "verification_method": verification["verification_method"],
                "verified_url": verification.get("verified_url"),
                "cited_url": citation.url,
                "cited_urls": [citation.url],
                "upstream_candidates": verification.get("upstream_candidates") or [],
                "source_role": verification.get("source_role") or "cited_page",
                "source_rejection_reason": (
                    verification.get("source_rejection_reason") or ""
                ),
                "echo_cluster_id": verification.get("echo_cluster_id"),
                "independent_source": verification.get("independent_source", False),
                "crawler": verification.get("crawler") or {},
            },
        }
        payload_key = normalize_source_url(source_url)
        existing_payload = source_payloads.get(payload_key)
        if existing_payload is None:
            source_payloads[payload_key] = payload
        else:
            _merge_research_source_payload(existing_payload, payload)
    available = sum(
        payload["status"] == "available" for payload in source_payloads.values()
    )
    existing_by_url = {
        normalize_source_url(str(item["url"])): item
        for item in existing_sources
        if (item.get("metadata") or {}).get("source") == "web_research"
    }
    for payload_key, payload in source_payloads.items():
        persisted = existing_by_url.get(payload_key)
        if persisted is not None:
            merged = _research_source_payload(persisted)
            _merge_research_source_payload(merged, payload)
            source_payloads[payload_key] = merged
    for payload in source_payloads.values():
        await repo.upsert_source(run_id, **payload)
    return (None if available else "research_unavailable"), available


def _research_source_payload(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_type": "authority",
        "url": str(source["url"]),
        "status": str(source["status"]),
        "title": source.get("title"),
        "domain": source.get("domain"),
        "content_ref": source.get("content_ref"),
        "summary": dict(source.get("summary") or {}),
        "metadata": dict(source.get("metadata") or {}),
    }


def _merge_research_source_payload(
    existing: dict[str, Any], incoming: dict[str, Any]
) -> None:
    existing_available = existing["status"] == "available"
    incoming_available = incoming["status"] == "available"
    if incoming_available and not existing_available:
        for field in ("status", "title", "domain", "content_ref"):
            existing[field] = incoming.get(field)
    existing_summary = existing["summary"]
    incoming_summary = incoming["summary"]
    for field in (
        "research_answer",
        "citation_excerpt",
        "research_claim",
        "research_excerpt",
    ):
        values = [
            value
            for value in (existing_summary.get(field), incoming_summary.get(field))
            if value
        ]
        existing_summary[field] = "\n".join(dict.fromkeys(values))
    claims = [
        *existing_summary.get("verification_claims", []),
        *incoming_summary.get("verification_claims", []),
    ]
    existing_summary["verification_claims"] = list(
        {
            (
                str(item.get("claim") or ""),
                str(item.get("status") or ""),
                str(item.get("evidence") or ""),
            ): item
            for item in claims
        }.values()
    )
    existing_metadata = existing["metadata"]
    incoming_metadata = incoming["metadata"]
    if incoming_available and not existing_available:
        for field in (
            "provider",
            "model",
            "source_tier",
            "verification_status",
            "verification_method",
            "verified_url",
            "source_role",
            "source_rejection_reason",
            "echo_cluster_id",
            "independent_source",
            "crawler",
        ):
            existing_metadata[field] = incoming_metadata.get(field)
    for field in ("cited_urls", "queries", "failed_queries", "upstream_candidates"):
        existing_metadata[field] = list(
            dict.fromkeys(
                [
                    *existing_metadata.get(field, []),
                    *incoming_metadata.get(field, []),
                ]
            )
        )
    existing_failures = existing_metadata.get("research_failures", [])
    incoming_failures = incoming_metadata.get("research_failures", [])
    existing_metadata["research_failures"] = list(
        {
            json.dumps(item, ensure_ascii=False, sort_keys=True): item
            for item in [*existing_failures, *incoming_failures]
        }.values()
    )
    if incoming_metadata.get("verification_status") == "verified":
        existing_metadata["verification_status"] = "verified"
    crawler = incoming_metadata.get("crawler") or {}
    if crawler and not existing_metadata.get("crawler"):
        existing_metadata["crawler"] = crawler


async def _verify_research_sources(
    repo: ContentRepository,
    settings: Settings,
    run_id: str,
    result: ResearchResult,
) -> list[tuple[ResearchCitation, dict[str, Any]]]:
    selected_urls: list[str] = []
    selected_url_keys: set[str] = set()
    for citation in result.citations:
        normalized = normalize_source_url(citation.url)
        if normalized in selected_url_keys:
            continue
        if len(selected_urls) == 12:
            break
        selected_url_keys.add(normalized)
        selected_urls.append(citation.url)
    citations = [
        citation
        for citation in result.citations
        if normalize_source_url(citation.url) in selected_url_keys
    ]
    pages = await _crawl_source_verification_pages(
        repo, settings, run_id, selected_urls
    )

    pages_by_url = _pages_by_url(pages)
    upstream_by_citation: dict[str, list[str]] = {}
    upstream_urls: list[str] = []
    for citation in citations:
        if not classify_source_tier(citation.url).startswith("tier_3"):
            continue
        page = pages_by_url.get(normalize_source_url(citation.url))
        if page is None:
            continue
        candidates = select_upstream_source_links(
            citation.url, list(page.get("outbound_links") or [])
        )
        if not candidates:
            continue
        upstream_by_citation[normalize_source_url(citation.url)] = candidates
        upstream_urls.extend(candidates)
    upstream_urls = list(dict.fromkeys(upstream_urls))[:6]
    upstream_pages = (
        await _crawl_source_verification_pages(repo, settings, run_id, upstream_urls)
        if upstream_urls
        else []
    )
    upstream_pages_by_url = _pages_by_url(upstream_pages)

    reader = S3TextReader(settings)

    async def checked_page(
        page: dict[str, Any] | None, citation: ResearchCitation
    ) -> tuple[Any, str] | None:
        if (
            page is None
            or page.get("status") != "available"
            or not page.get("content_ref")
        ):
            return None
        try:
            page_text = (await reader.read_text(str(page["content_ref"]))).text
        except StoredTextError:
            return None
        claim = citation.claim or citation.excerpt
        return (
            verify_source_claim_with_quote(claim, citation.exact_quote, page_text),
            page_text,
        )

    def verification_payload(
        checked: Any,
        page: dict[str, Any],
        tier: str,
        citation: ResearchCitation,
        upstream_candidates: list[str],
        source_role: str,
        source_rejection_reason: str = "",
    ) -> dict[str, Any]:
        return {
            "source_tier": tier,
            "verification_status": checked.status,
            "verification_method": checked.method,
            "verified_url": page.get("url"),
            "verified_title": page.get("title") or "",
            "content_ref": page.get("content_ref"),
            "research_excerpt": checked.evidence,
            "verification_claims": [
                {
                    "claim": item.claim,
                    "status": item.status,
                    "evidence": item.evidence,
                    "numeric_tokens": list(item.numeric_tokens),
                    "lexical_overlap": round(item.lexical_overlap, 4),
                    "context_tokens": list(item.context_tokens),
                    "context_mismatches": list(item.context_mismatches),
                }
                for item in checked.claims
            ],
            "upstream_candidates": upstream_candidates,
            "source_role": source_role,
            "source_rejection_reason": source_rejection_reason,
            "independent_source": checked.status in {"verified", "paraphrase"},
        }

    async def verify(citation: ResearchCitation) -> tuple[ResearchCitation, dict[str, Any]]:
        tier = classify_source_tier(citation.url)
        claim = citation.claim or citation.excerpt
        if tier.startswith("tier_4"):
            return citation, {
                "source_tier": tier,
                "verification_status": "rejected_source",
                "verification_method": "source_tier_rejection_v1",
                "independent_source": False,
            }
        normalized_cited_url = normalize_source_url(citation.url)
        candidates = [
            item
            for item in upstream_by_citation.get(normalized_cited_url, [])
            if item in upstream_urls
        ]
        for upstream_url in candidates:
            upstream_page = upstream_pages_by_url.get(normalize_source_url(upstream_url))
            upstream_checked = await checked_page(upstream_page, citation)
            if upstream_checked is None:
                continue
            checked, upstream_text = upstream_checked
            if checked.status in {"verified", "paraphrase"}:
                upstream_tier, rejection_reason = assess_source_page(
                    upstream_url,
                    upstream_text,
                    list(upstream_page.get("outbound_links") or []),
                    claim,
                )
                if rejection_reason:
                    continue
                return citation, verification_payload(
                    checked,
                    upstream_page,
                    upstream_tier,
                    citation,
                    candidates,
                    "primary_upstream",
                )

        page = pages_by_url.get(normalized_cited_url)
        checked_result = await checked_page(page, citation)
        if checked_result is None:
            return citation, {
                "source_tier": tier,
                "verification_status": "unreachable",
                "verification_method": "crawler_page_unavailable_v1",
                "research_excerpt": "",
                "upstream_candidates": candidates,
                "independent_source": False,
                "crawler": {
                    "status": str((page or {}).get("status") or "unavailable"),
                    "requested_url": str(
                        (page or {}).get("requested_url") or citation.url
                    ),
                    "url": str((page or {}).get("url") or citation.url),
                    "content_ref": (page or {}).get("content_ref"),
                    "failure": (page or {}).get("failure")
                    or (page or {}).get("error")
                    or (page or {}).get("error_code"),
                },
            }
        checked, page_text = checked_result
        assessed_tier, rejection_reason = assess_source_page(
            citation.url,
            page_text,
            list(page.get("outbound_links") or []),
            claim,
        )
        if rejection_reason:
            payload = verification_payload(
                checked,
                page,
                assessed_tier,
                citation,
                candidates,
                "cited_page",
                rejection_reason,
            )
            payload["verification_status"] = "rejected_source"
            payload["verification_method"] = "source_quality_rejection_v1"
            payload["independent_source"] = False
            return citation, payload
        return citation, verification_payload(
            checked, page, assessed_tier, citation, candidates, "cited_page"
        )

    outcomes = list(
        await asyncio.gather(*(verify(citation) for citation in citations))
    )
    _mark_echo_clusters(outcomes)
    return outcomes


async def _crawl_source_verification_pages(
    repo: ContentRepository,
    settings: Settings,
    run_id: str,
    urls: list[str],
) -> list[dict[str, Any]]:
    if not urls:
        return []
    try:
        crawl_run, task = await repo.ensure_source_verification_crawl(
            run_id, urls
        )
        if crawl_run.status not in {"completed", "partial", "failed"}:
            await get_crawler_worker_launcher().ensure_started()
            client = await connect_temporal()
            try:
                handle = await client.start_workflow(
                    "CrawlWorkflow",
                    task,
                    id=str(crawl_run.temporal_workflow_id),
                    task_queue=settings.crawler_task_queue,
                )
            except WorkflowAlreadyStartedError:
                handle = client.get_workflow_handle(str(crawl_run.temporal_workflow_id))
            await handle.result()
        return await repo.list_competitor_pages(crawl_run.run_id)
    except Exception:
        return []


def _pages_by_url(pages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    pages_by_url: dict[str, dict[str, Any]] = {}
    for page in pages:
        for value in (page.get("requested_url"), page.get("url")):
            if value:
                pages_by_url[normalize_source_url(str(value))] = page
    return pages_by_url


def _mark_echo_clusters(
    outcomes: list[tuple[ResearchCitation, dict[str, Any]]],
) -> None:
    accepted: list[tuple[ResearchCitation, dict[str, Any]]] = []
    for citation, verification in outcomes:
        if verification["verification_status"] not in {"verified", "paraphrase"}:
            continue
        evidence = str(verification.get("research_excerpt") or "")
        verified_url = normalize_source_url(
            str(verification.get("verified_url") or citation.url)
        )
        shared_upstream = [
            existing
            for existing in accepted
            if normalize_source_url(
                str(existing[1].get("verified_url") or existing[0].url)
            )
            == verified_url
        ]
        if shared_upstream:
            verification["echo_cluster_id"] = shared_upstream[0][1]["echo_cluster_id"]
            if any(
                _same_supported_fact(citation, evidence, existing)
                for existing in shared_upstream
            ):
                verification["verification_status"] = "echo_duplicate"
                verification["independent_source"] = False
            else:
                accepted.append((citation, verification))
            continue
        duplicate = next(
            (
                existing
                for existing in accepted
                if _same_supported_fact(citation, evidence, existing)
            ),
            None,
        )
        if duplicate is None:
            verification["echo_cluster_id"] = f"source-{len(accepted) + 1}"
            accepted.append((citation, verification))
            continue
        verification["verification_status"] = "echo_duplicate"
        verification["echo_cluster_id"] = duplicate[1]["echo_cluster_id"]
        verification["independent_source"] = False


def _same_supported_fact(
    citation: ResearchCitation,
    evidence: str,
    existing: tuple[ResearchCitation, dict[str, Any]],
) -> bool:
    existing_citation, existing_verification = existing
    claim = citation.claim or citation.excerpt
    existing_claim = existing_citation.claim or existing_citation.excerpt
    return (
        evidence_similarity(
            evidence, str(existing_verification.get("research_excerpt") or "")
        )
        >= 0.82
        and evidence_similarity(claim, existing_claim) >= 0.82
    )


def _competitor_result(run_id: str, available: int, failed: int) -> dict[str, Any]:
    warning_code = None
    if available == 0:
        warning_code = "competitor_sources_unavailable"
    elif failed:
        warning_code = "competitor_sources_partial"
    return {
        "output_ref": f"db://article-runs/{run_id}/competitors",
        "warnings": [warning(warning_code)] if warning_code else [],
        "summary": {"available": available, "failed": failed},
    }


def _same_domain(url: str, domain: str) -> bool:
    host = urlsplit(url).hostname or ""
    value = domain.lower().removeprefix("www.")
    return host.lower().removeprefix("www.") == value
