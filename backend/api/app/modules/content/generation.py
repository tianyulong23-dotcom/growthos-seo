from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from app.core.config import Settings
from app.modules.content.collection import _collect_research
from app.modules.content.document import document_to_markdown, normalize_document
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
    sanitize_sections,
    sanitize_markdown_links,
)
from app.modules.content.repository import ContentRepository
from app.modules.content.serp_analysis import analyze_serp, serp_analysis_needs_refresh
from app.modules.content.writing_gateway import (
    ArticleContract,
    ArticlePlan,
    ContractSection,
    EvidenceClaim,
    OutlineSection,
    RevisedSections,
    SectionDraft,
    SectionIssue,
    UnifiedArticle,
    WritingGateway,
    WritingOutputError,
    WritingRequestError,
    WritingResult,
    merge_usage,
)


MAX_PLANNING_SOURCES = 20
MAX_PLANNING_CLAIMS_PER_SOURCE = 3
MAX_PLAN_CLAIMS = 48
MAX_SECTION_CLAIMS = 8
MAX_SUPPLEMENTAL_RESEARCH_SECONDS = 180.0
GENERATION_DEADLINE_RESERVE_SECONDS = 300.0


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
        planning_context = {
            **context,
            "model_snapshot": {
                **dict(context.get("model_snapshot") or {}),
                "max_retries": 0,
            },
        }
        gateway = writing_gateway(planning_context)
        project_role = _project_article_role(pack)
        include_project_profile = project_role != "unrelated"
        planning_goal = "Create an article plan that answers the reader's real question."
        if include_project_profile:
            planning_goal += " Use the available research and project information."
        writing_brief = _article_writing_brief(pack)
        result = await cached_generate(
            gateway,
            settings,
            context,
            "plan_article",
            {
                "goal": planning_goal,
                "writing_brief": writing_brief,
                "research_decision": {
                    "rule": (
                        "After completing the outline, report a critical_research_gap only "
                        "when missing information prevents a correct core answer. Optional "
                        "statistics, examples, broader comparisons, freshness details, or "
                        "nonessential brand details are not critical gaps."
                    ),
                    "when_sufficient": "Return critical_research_gaps as an empty array.",
                    "when_blocked": (
                        "For each real gap, explain why it blocks the core answer and provide "
                        "one complete web-research query. Do not split one topic into several "
                        "small questions."
                    ),
                },
                "visual_planning": {
                    "goal": "Suggest only images that help the reader understand, compare, verify, orient, or act.",
                    "placement": "Bind each suggestion to one outline section_id.",
                    "source_choice": "Prefer a relevant project asset or real screenshot for product state, and a sourced chart for data. Use stock or AI only for suitable illustrative material.",
                    "screenshot_contract": "For screenshot, set target_url to an exact project or research source URL in the research pack.",
                    "chart_contract": "For chart, provide chart_data label, numeric value, unit, and claim_id. Every value must appear in that cited claim, and data_claim_ids must list those claims.",
                    "when_unhelpful": "Return visuals as an empty array.",
                },
                "research_pack": _planning_research_pack(
                    pack,
                    include_project_profile=include_project_profile,
                ),
            },
            ArticlePlan,
        )
        raw_plan = result.value
        supplemental_tasks = _critical_research_tasks(raw_plan)
        if supplemental_tasks:
            supplemental_warning: str | None = "research_unavailable"
            supplemental_count = 0
            supplemental_started = time.monotonic()
            timeout_seconds = _supplemental_research_timeout_seconds(
                context,
                supplemental_started,
            )
            if timeout_seconds > 0:
                try:
                    supplemental_warning, supplemental_count = await asyncio.wait_for(
                        _collect_research(
                            repo,
                            settings,
                            run_id,
                            str(pack["keyword"]),
                            dict(pack.get("project") or {}),
                            supplemental_tasks,
                            model_snapshot=dict(context.get("model_snapshot") or {}),
                        ),
                        timeout=timeout_seconds,
                    )
                    if supplemental_count:
                        pack = await build_research_pack(repo, settings, context)
                except Exception:
                    supplemental_warning = "research_unavailable"
            if supplemental_warning or not supplemental_count:
                warnings.append(
                    _warning(
                        "supplemental_research_degraded",
                        "关键资料补充研究暂不可用，已使用现有资料继续生成完整稿",
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


def _article_writing_brief(pack: dict[str, Any]) -> dict[str, Any]:
    keyword = str(pack.get("keyword") or "").strip()
    country = str(pack.get("country") or "").strip()
    requested_type = dict(pack.get("requested_article_type") or {})
    locked_type = str(requested_type.get("value") or "").strip()
    reader_questions = _unique(
        [
            str(item).strip()
            for item in pack.get("required_questions") or []
            if str(item).strip()
        ]
    )[:8]
    recommended_type = _recommended_article_type(pack)
    comparison_dimensions = _relevant_comparison_dimensions(pack)
    project_article_role = _project_article_role(pack)
    project_role = {
        "core": (
            "The project product is part of the reader's requested answer. Use it where it "
            "materially answers the task, with a natural next action when available."
        ),
        "conversion": (
            "The project product is a verified, relevant option but is not the article's core "
            "answer and must not become the automatic winner. Keep the article neutral, mention "
            "the product once where it naturally helps the decision, and use at most one CTA."
        ),
        "unrelated": (
            "The project product is unrelated to this reader task. Do not mention it or add a CTA."
        ),
    }[project_article_role]
    type_structures = {
        "Guide": (
            "Direct answer; H2s that explain the necessary background, key factors, reader "
            "meaning or application, and only needed limits or unanswered FAQs."
        ),
        "How-To": (
            "Direct answer and requirements; H2: Step-by-step process; H2: How to verify the "
            "result; H2: Common mistakes or troubleshooting; unanswered FAQ and next action only "
            "when useful."
        ),
        "Comparison": (
            "Direct verdict and comparison table; H2s for consistent decision dimensions; "
            "H2: Choose [option] if...; unanswered FAQ and conclusion only when useful."
        ),
        "Listicle / Best X": (
            "Direct answer and top-picks comparison table; H2: Best for [scenario]: [item] for "
            "each main option; H2: How we evaluated the options; H2: How to choose the right "
            "option; unanswered FAQ and conclusion only when useful."
        ),
        "Review": (
            "Direct verdict and key facts; H2s for who it suits, evidence basis, important use "
            "cases, pros and cons, value, alternatives, and only unanswered FAQs."
        ),
        "Directory": (
            "Data scope and provider list; H2s for selection method, choosing a provider, "
            "verification checks, comparing quotes, and a practical next action."
        ),
    }
    return {
        "reader_task": (
            f"Help a reader in {country} resolve the practical question behind '{keyword}'."
            if country
            else f"Resolve the reader's practical question behind '{keyword}'."
        ),
        "article_type": (
            f"Use the locked article type: {locked_type}."
            if locked_type and requested_type.get("policy") == "locked"
            else (
                "Choose the primary article type from the reader's task and research: guide, "
                "how-to, comparison, listicle, review, or directory. Mix in other structures "
                "only when they help answer the task."
            )
        ),
        "recommended_article_type": recommended_type,
        "article_type_structure": type_structures[recommended_type],
        "opening": (
            "Answer the main question in the first 1-3 sentences, state the important "
            "conditions, and tell the reader what decision or action the article enables."
        ),
        "structure": (
            "Build the outline around the reader's decision path. Use only useful modules; "
            "introduction, quick answer, table, FAQ, conclusion, and CTA are optional. "
            "Prefer 3-8 substantive H2 sections and never exceed 12 top-level sections."
        ),
        "heading_rule": (
            "Write each H2 as the specific answer or choice the reader will see, not as an "
            "instruction about what the writer should discuss. The direct-answer introduction "
            "is a generation unit, not a visible H2. Put recurring comparison fields such as "
            "price, devices, and limitations inside each option instead of making every field "
            "a separate H2."
        ),
        "section_logic": (
            "Each main section should lead with its answer or judgment, support it with the "
            "available research, and explain what it means for the reader. End with a practical "
            "choice, application, or next-step section when the topic calls for one."
        ),
        "scope_control": (
            "Choose one primary reader question. Include a secondary intent only when it is "
            "needed to solve that question; omit merely related meanings, repetitive FAQs, and "
            "background that does not change the reader's understanding or action. Give every "
            "section a distinct job."
        ),
        "worked_example": (
            "For a practical, analytical, or process topic, plan one end-to-end worked example "
            "or walkthrough that shows what the reader observes, how to interpret it, and what "
            "to do next. Use the available material and avoid false precision."
        ),
        "reader_questions": reader_questions,
        "comparison_dimensions": comparison_dimensions,
        "project_role": project_role,
    }


def _recommended_article_type(pack: dict[str, Any]) -> str:
    requested = dict(pack.get("requested_article_type") or {})
    requested_value = str(requested.get("value") or "").casefold()
    if requested.get("policy") == "locked" and requested_value:
        if "list" in requested_value or "best" in requested_value:
            return "Listicle / Best X"
        if "how" in requested_value:
            return "How-To"
        if "compar" in requested_value or " vs " in f" {requested_value} ":
            return "Comparison"
        if "review" in requested_value:
            return "Review"
        if "director" in requested_value or "local" in requested_value:
            return "Directory"
        return "Guide"

    text = " ".join(
        [
            str(pack.get("keyword") or ""),
            *[str(item) for item in pack.get("required_questions") or []],
        ]
    ).casefold()
    normalized = f" {_normalize_requirement(text)} "
    if re.search(r"\b(best|top|options|alternatives)\b", normalized):
        return "Listicle / Best X"
    if re.search(r"\bhow to\b|\bsteps?\b|\bfix\b", normalized):
        return "How-To"
    if re.search(r"\bversus\b|\bvs\b|\bcompare\b|\bdifference\b", normalized):
        return "Comparison"
    if re.search(r"\breview\b|\bis it worth\b", normalized):
        return "Review"
    if re.search(r"\bnear me\b|\bproviders? in\b|\bcompanies in\b", normalized):
        return "Directory"
    return "Guide"


def _canonical_article_type(value: str) -> str:
    normalized = _normalize_requirement(value)
    if ("listicle" in normalized and normalized != "listicle") or (
        "best" in normalized and any(item in normalized for item in ("options", "list"))
    ):
        return "Listicle / Best X"
    return value


def _relevant_comparison_dimensions(pack: dict[str, Any]) -> list[str]:
    candidates = _unique(
        str(item).strip()
        for item in (pack.get("competitor_blueprint") or {}).get(
            "comparison_dimensions"
        )
        or []
        if str(item).strip()
    )
    if not candidates:
        return []
    research_text = " ".join(
        [
            str(pack.get("keyword") or ""),
            *[str(item) for item in pack.get("required_questions") or []],
            *[
                " ".join(
                    [
                        str(item.get("title") or ""),
                        str(item.get("description") or ""),
                    ]
                )
                for item in (pack.get("serp") or {}).get("organic_results") or []
                if isinstance(item, dict)
            ],
            *[
                _source_mapping_source_text(item)
                for item in pack.get("authority_sources") or []
                if isinstance(item, dict)
            ],
        ]
    )
    research_terms = {
        _source_mapping_stem(item) for item in _source_mapping_words(research_text)
    }
    return [
        dimension
        for dimension in candidates
        if {
            _source_mapping_stem(item)
            for item in _source_mapping_words(dimension)
        }.intersection(research_terms)
    ][:8]


def _planning_research_pack(
    pack: dict[str, Any], *, compact: bool = False, include_project_profile: bool = True
) -> dict[str, Any]:
    source_limit = 10 if compact else MAX_PLANNING_SOURCES
    excerpt_limit = 500 if compact else 2000
    claim_limit = 1 if compact else MAX_PLANNING_CLAIMS_PER_SOURCE
    project_context = _project_answer_context(None, pack)
    project_role = _project_article_role(pack) if include_project_profile else "unrelated"
    project = dict(pack.get("project") or {})
    project_profile = (
        {
            **dict(project.get("profile") or {}),
            **{
                key: value
                for key, value in project_context.items()
                if key
                in {
                    "business_name",
                    "business_summary",
                    "products_services",
                    "value_propositions",
                    "conversion_actions",
                    "key_pages",
                    "cta_targets",
                    "product_evidence",
                }
            },
        }
        if project_role == "core"
        else _conversion_project_profile(pack)
        if project_role == "conversion"
        else {}
    )
    ranked_sources = _rank_planning_sources(pack)
    if project_role != "core":
        ranked_sources = [
            item for item in ranked_sources if not _source_is_project_owned(item, pack)
        ]
    all_authority_sources = [
        _planning_authority_source(item, excerpt_limit, claim_limit)
        for item in ranked_sources
    ]
    authority_sources = all_authority_sources[:source_limit]
    competitor_blueprint = dict(pack.get("competitor_blueprint") or {})
    if compact:
        competitor_blueprint = {
            key: list(competitor_blueprint.get(key) or [])[:4]
            for key in (
                "structure_to_match",
                "must_fill_gaps",
                "data_needed",
                "outdated_to_update",
            )
        }
    serp_results = [
        {
            "url": item.get("url"),
            "title": item.get("title"),
            "description": item.get("description"),
        }
        for item in list((pack.get("serp") or {}).get("organic_results") or [])[:10]
    ]
    competitor_articles = _competitor_reference_materials(pack, compact=compact)
    if project_role != "core":
        serp_results = _exclude_project_owned_sources(serp_results, pack)
        competitor_articles = _exclude_project_owned_sources(competitor_articles, pack)
    payload = {
        "keyword": pack.get("keyword"),
        "secondary_keywords": list(pack.get("secondary_keywords") or [])[ :10 if compact else None],
        "planned_title": dict(pack.get("planned_title") or {}),
        "writing_direction": dict(pack.get("writing_direction") or {}),
        "requested_article_type": dict(pack.get("requested_article_type") or {}),
        "country": pack.get("country"),
        "language": pack.get("language"),
        "project": (
            {
                "domain": project.get("domain"),
                "role": project_role,
                "profile": project_profile,
            }
            if project_role != "unrelated"
            else {}
        ),
        "serp_results": serp_results,
        "serp_observations": {
            key: value
            for key, value in dict(pack.get("serp_analysis") or {}).items()
            if key not in {"dominant_content_type", "content_brief"}
        },
        "reader_questions": list(pack.get("required_questions") or [])[ :8 if compact else None],
        "competitor_research": {
            "observed_structures": competitor_blueprint.get("structure_to_match") or [],
            "coverage_opportunities": competitor_blueprint.get("must_fill_gaps") or [],
            "useful_data_topics": competitor_blueprint.get("data_needed") or [],
            "possibly_outdated_topics": competitor_blueprint.get("outdated_to_update") or [],
        },
        "competitor_articles": competitor_articles,
        "research_sources": authority_sources,
        "internal_sources": (
            [
                {
                    "url": item.get("url"),
                    "title": item.get("title"),
                    "description": str(item.get("description") or "")[:500],
                }
                for item in list(pack.get("internal_sources") or [])[ :10 if compact else None]
            ]
            if project_role == "core"
            else [
                {
                    "url": item.get("url"),
                    "title": item.get("title"),
                    "description": str(item.get("description") or "")[:500],
                }
                for item in pack.get("internal_sources") or []
                if str(item.get("url") or "")
                in {
                    str(target.get("url") or "")
                    for target in project_profile.get("cta_targets") or []
                }
            ]
            if project_role == "conversion"
            else []
        ),
    }
    if compact:
        return {
            key: value
            for key, value in payload.items()
            if value not in (None, "", [], {})
        }
    return payload


def _planning_authority_source(
    source: dict[str, Any], excerpt_limit: int | None, claim_limit: int | None
) -> dict[str, Any]:
    def text(value: Any) -> str:
        output = str(value or "")
        return output[:excerpt_limit] if excerpt_limit else output

    verification_claims = [
        {
            "claim": text(item.get("claim")),
            "evidence": text(item.get("evidence")),
        }
        for item in source.get("verification_claims") or []
        if isinstance(item, dict)
    ]
    if claim_limit:
        verification_claims = verification_claims[:claim_limit]
    return {
        "url": source.get("url"),
        "title": source.get("title"),
        "excerpt": text(source.get("excerpt")),
        "research_answer": text(source.get("research_answer")),
        "citation_excerpt": text(source.get("citation_excerpt")),
        "research_claim": text(source.get("research_claim")),
        "queries": list(source.get("queries") or []),
        "verification_claims": verification_claims,
    }


def _writing_source_material(source: dict[str, Any]) -> dict[str, Any]:
    material = {
        "url": source.get("url"),
        "title": source.get("title"),
        "excerpt": source.get("excerpt"),
        "research_answer": source.get("research_answer"),
        "citation_excerpt": source.get("citation_excerpt"),
        "research_claim": source.get("research_claim"),
        "queries": list(source.get("queries") or []),
        "verification_claims": [
            {
                "claim": item.get("claim"),
                "evidence": item.get("evidence"),
            }
            for item in source.get("verification_claims") or []
            if isinstance(item, dict)
        ],
    }
    return {key: value for key, value in material.items() if value not in (None, "", [])}


def _competitor_reference_materials(
    pack: dict[str, Any], *, compact: bool
) -> list[dict[str, Any]]:
    competitors = [
        deepcopy(item)
        for item in pack.get("competitors") or []
        if isinstance(item, dict)
    ]
    output: list[dict[str, Any]] = []
    competitor_limit = 3 if compact else 5
    content_limit = 1000 if compact else 2500
    for item in competitors[:competitor_limit]:
        analysis = dict(item.get("analysis") or item.get("summary") or {})
        output.append(
            {
                "url": item.get("url"),
                "title": item.get("title"),
                "content_type": item.get("content_type"),
                "word_count": item.get("word_count"),
                "content": str(item.get("content") or "")[:content_limit],
                "analysis": {
                    "structure": list(analysis.get("structure") or [])[:10],
                    "opening": str(analysis.get("opening") or "")[:500],
                    "key_points": list(analysis.get("key_points") or [])[:8],
                    "closing": str(analysis.get("closing") or "")[:500],
                    "named_entities": list(analysis.get("named_entities") or [])[:10],
                    "price_evidence": list(analysis.get("price_evidence") or [])[:10],
                    "comparison_dimensions": list(
                        analysis.get("comparison_dimensions") or []
                    )[:10],
                },
            }
        )
    return output


def _unique_source_records(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source in sources:
        url = str(source.get("url") or "")
        if not url or url in seen:
            continue
        seen.add(url)
        output.append(source)
    return output


def _rank_planning_sources(pack: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(item) for item in pack.get("authority_sources") or []]


def _full_article_material(
    plan: ArticlePlan, pack: dict[str, Any]
) -> dict[str, Any]:
    sources_by_url = {
        str(item.get("url") or ""): item
        for item in _rank_planning_sources(pack)
        if item.get("url")
    }
    claim_urls = {item.source_url for item in plan.claims}
    selected_sources = [
        _writing_source_material(source)
        for url, source in sources_by_url.items()
        if url in claim_urls
    ]
    if len(selected_sources) < 4:
        selected_urls = {
            str(item.get("url") or "") for item in selected_sources
        }
        selected_sources.extend(
            _writing_source_material(source)
            for url, source in sources_by_url.items()
            if url not in selected_urls
        )

    competitor_articles = _competitor_reference_materials(pack, compact=False)
    if not _project_answer_is_core(pack):
        competitor_articles = _exclude_project_owned_sources(
            competitor_articles, pack
        )
    return {
        "sources": selected_sources[:10],
        "competitors": competitor_articles[:3],
        "project": _project_answer_context(plan, pack),
    }


def _locked_article_inputs(pack: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": dict(pack.get("planned_title") or {}),
        "article_type": dict(pack.get("requested_article_type") or {}),
        "writing_direction": dict(pack.get("writing_direction") or {}),
    }


def _full_article_writing_payload(
    plan: ArticlePlan, pack: dict[str, Any]
) -> dict[str, Any]:
    material = _full_article_material(plan, pack)
    return {
        "task": "Write the complete article in one response from the approved plan.",
        "keyword": pack.get("keyword"),
        "language": pack.get("language"),
        "country": pack.get("country"),
        "primary_reader_task": plan.search_intent,
        "article_plan": plan.model_dump(
            mode="json", exclude={"critical_research_gaps", "visuals"}
        ),
        "relevant_research": material["sources"],
        "relevant_competitor_observations": material["competitors"],
        "project_information": material["project"],
        "locked_inputs": _locked_article_inputs(pack),
        "quality_target": {
            "reader_outcome": (
                "The reader should be able to complete the task or make the decision after "
                "reading, not merely understand definitions and cautions."
            ),
            "worked_example": (
                "When the topic is practical, use one complete example or walkthrough to show "
                "observation or input, interpretation, and next action."
            ),
            "voice": (
                "Prioritize the points that matter, make useful judgments, and vary the way "
                "sections develop instead of repeating a definition-warning-summary pattern."
            ),
        },
        "instructions": [
            "Write the whole article now, not separate disconnected section drafts.",
            "Keep one main reader task from beginning to end. Do not broaden into parallel interpretations of the keyword.",
            "Answer the main question in the first 1-3 sentences and give the reader a useful next step.",
            "Return every planned section exactly once, using its section_id and plan order.",
            "Use each H2 as written in the plan. H3s may be added only where they make the answer easier to use.",
            "Treat word targets as soft limits. Stop when the question is fully answered; do not pad sections.",
            "Use project information only when it naturally serves the primary reader task. Do not make the project the subject merely because it was supplied.",
            "When linking to a project page, make the anchor text and described action match that page's supplied title and description.",
            "Write clear, natural prose with concrete answers. Remove generic setup, empty summaries, repeated advice, and SEO filler.",
            "Explain a caveat once in the most useful place instead of repeating it in several sections.",
            "For practical topics, carry one complete example or walkthrough through observation or input, interpretation, and next action.",
            "Cite source URLs naturally where a sourced factual claim benefits the reader.",
        ],
    }


def _full_article_editing_payload(
    plan: ArticlePlan,
    sections: list[SectionDraft],
    pack: dict[str, Any],
) -> dict[str, Any]:
    material = _full_article_material(plan, pack)
    return {
        "task": (
            "Read the entire draft as a senior editor, find meaning-level problems, "
            "fix them in the same pass, and return the complete final article."
        ),
        "primary_reader_task": plan.search_intent,
        "article_type": plan.article_type,
        "section_responsibilities": [
            {
                "section_id": item.section_id,
                "heading": item.heading,
                "objective": item.objective,
                "required_questions": item.required_questions,
                "coverage_points": item.coverage_points,
            }
            for item in plan.sections
        ],
        "draft": {
            "title": plan.title,
            "meta_title": plan.meta_title,
            "meta_description": plan.meta_description,
            "slug": plan.slug,
            "sections": [item.model_dump(mode="json") for item in sections],
        },
        "relevant_research": material["sources"],
        "project_information": material["project"],
        "locked_inputs": _locked_article_inputs(pack),
        "editorial_checks": [
            "Does the article clearly solve the primary reader task?",
            "Did the draft replace the user's question with an easier or different one?",
            "Are several keyword meanings incorrectly competing as equal storylines?",
            "Does every section perform its assigned job and stay on topic?",
            "Does the opening give a direct answer rather than delay it?",
            "Is any material repetitive, generic, padded, or obvious without helping a decision or action?",
            "Is the project included only where naturally relevant?",
            "Does every project link accurately describe its supplied page title and description?",
            "Can a general reader understand the article without unpacking long or abstract sentences?",
            "Does the ending give a concrete next step rather than merely summarize?",
        ],
        "editorial_priorities": [
            "Keep the strongest occurrence of a repeated point and delete the others.",
            "Cut secondary intent, background, FAQs, and caveats that do not help solve the primary reader task.",
            "For a practical topic, make sure one end-to-end example or walkthrough connects what the reader sees, how to interpret it, and what to do next.",
            "Replace uniform definition-warning-summary sections with direct answers, useful judgment, demonstration, or decision guidance.",
            "Prefer a shorter article with distinct reader value over a comprehensive article padded with obvious or repetitive material.",
        ],
        "editing_rules": [
            "Fix every problem you find during this same call.",
            "Preserve every section_id exactly once and keep plan order.",
            "Keep useful specifics and remove tangents, filler, repetition, and artificial transitions.",
            "Make substantive cuts and rewrites when needed; do not limit the pass to copyediting.",
            "Prefer plain words, varied sentence lengths, and short paragraphs.",
            "When linking to a project page, describe the action shown by its supplied title and description.",
            "Do not introduce a new major topic during editing.",
        ],
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
    result = await cached_generate(
        writing_gateway(context),
        settings,
        context,
        "unify_article",
        _full_article_writing_payload(plan, pack),
        UnifiedArticle,
    )
    expected_section_ids = [item.section_id for item in plan.sections]
    generated_section_ids = [item.section_id for item in result.value.sections]
    if (
        generated_section_ids != expected_section_ids
        or any(not _has_section_prose(item.markdown) for item in result.value.sections)
    ):
        raise WritingOutputError("complete_article_missing_sections", attempts=1)
    unified = normalize_unified(result.value, plan, [])
    sections = sanitize_sections(
        unified.sections,
        plan,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
    )
    sections = _rebind_sections_to_markdown(
        sections, plan, allowed_sources, allowed_internal
    )
    plan = plan.model_copy(
        update={
            "title": unified.title,
            "meta_title": unified.meta_title,
            "meta_description": unified.meta_description,
            "slug": unified.slug,
        }
    )
    artifact = article_artifact(plan, sections, pack)
    output_ref = await artifact_store(settings).write_json(
        f"article-runs/{run_id}/writing/draft.json.gz", artifact
    )
    return {
        "output_ref": output_ref,
        "warnings": [],
        "summary": {
            "section_count": len(sections),
            "complete": True,
            "model_failures": [],
        },
        "usage": result.usage,
    }


async def _write_article_sections_by_section(
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
    content_score_history = list(existing_history or [])
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
    return (
        plan,
        current,
        score,
        content_score_history,
        existing_revision_count,
        [],
        [],
        [],
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
        if claim.section_id and claim.source_url in allowed_sources:
            claims_by_section.setdefault(claim.section_id, []).append(claim)
    rebound: list[SectionDraft] = []
    for section in sections:
        links = set(_MARKDOWN_LINK_PATTERN.findall(section.markdown))
        claims = claims_by_section.get(section.section_id, [])
        bound_claims = [item for item in claims if item.source_url in links]
        rebound.append(
            section.model_copy(
                update={
                    "used_claim_ids": _unique(
                        [*section.used_claim_ids, *[item.claim_id for item in bound_claims]]
                    )[:30],
                    "used_source_urls": sorted(
                        links.difference(links.intersection(allowed_internal))
                    )[:30],
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
    require_inline_citations: bool = True,
    require_claim_bindings: bool = True,
    require_measurable_improvement: bool = True,
) -> tuple[bool, list[str]]:
    candidate_report = deterministic_quality_check(
        candidate_plan,
        candidate_sections,
        allowed_source_urls=allowed_sources,
        allowed_internal_urls=allowed_internal,
        competitor_passages=competitor_passages,
    )
    del (
        baseline_plan,
        baseline_sections,
        baseline_score,
        candidate_score,
        require_inline_citations,
        require_claim_bindings,
        require_measurable_improvement,
    )
    reasons = [
        item.code
        for item in candidate_report.issues
        if item.code in {"title_missing", "section_missing", "malformed_link"}
    ]
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
            _full_article_editing_payload(plan, current, pack),
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
                require_inline_citations=False,
                require_claim_bindings=False,
                require_measurable_improvement=False,
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
    del repo, policy
    run_id = str(context["run_id"])
    input_step_key = str(context.get("input_step_key") or "editing")
    current = await _required_stage_artifact(settings, context, input_step_key)
    sections = [SectionDraft.model_validate(item) for item in current["sections"]]
    pack = await _pack_from_context(settings, context)
    plan = _ensure_article_contract(ArticlePlan.model_validate(current["plan"]), pack)
    allowed_sources, allowed_internal = allowed_urls(pack)
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
    check_status = "completed"
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
    repairable_issues = [item for item in unique if item.code == "fallback_section"]
    repair_scope = sorted({item.section_id for item in repairable_issues})
    repairable = bool(repairable_issues)
    blocking_issue_codes = sorted(
        {item.code for item in unique if item.code == "fallback_section"}
    )
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
        "blocking_issue_codes": blocking_issue_codes,
        "issues": [item.model_dump(mode="json") for item in unique],
        "locked_requirement_checks": [],
        "required_questions": {
            "total": len(plan.contract.required_questions),
            "covered": _covered_questions(plan.contract.required_questions, sections),
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
        "warnings": [],
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
            "blocking_issue_codes": blocking_issue_codes,
            "model_failure": None,
            **content_score_summary,
        },
        "usage": None,
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
                "goal": "Improve these article sections for the reader.",
                "sections": [
                    item.model_dump(mode="json")
                    for item in sections
                    if item.section_id in failed_ids
                ],
                "section_goals": [
                    {
                        "section_id": item.section_id,
                        "heading": item.heading,
                        "objective": item.objective,
                        "coverage_points": item.coverage_points,
                        "official_product": _section_project_context(plan, item, pack),
                    }
                    for item in failed_plans
                ],
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
        baseline_sections = _rebind_sections_to_markdown(
            sections, plan, allowed_sources, allowed_internal
        )
        scorer = ContentScorer()
        sections = baseline_sections
        current_score = _score_article_content(scorer, plan, sections, pack)
        revised_ids: set[str] = set()
        rejected: list[dict[str, Any]] = []
        for section in baseline_sections:
            replacement = replacements.get(section.section_id)
            if replacement is None:
                continue
            candidate_sections = [
                replacement if item.section_id == section.section_id else item
                for item in sections
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
            candidate_score = _score_article_content(
                scorer, plan, candidate_sections, pack
            )
            accepted, rejection_reasons = _candidate_improves_article(
                plan,
                sections,
                current_score,
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
                current_score = candidate_score
                revised_ids.add(section.section_id)
            else:
                rejected.append(
                    {
                        "section_id": section.section_id,
                        "reasons": rejection_reasons,
                    }
                )
        if rejected:
            warnings.append(
                _warning(
                    "revision_candidate_rejected",
                    "Some section revisions were discarded because they did not preserve the protected draft.",
                )
            )
            quality_failures.append(
                {"mode": "revision_candidate_rejected", "sections": rejected}
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
        content_score = current_score
        content_score_history = [
            *list(checked.get("content_score_history") or []),
            {
                **content_score,
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
                {"model_failures": quality_failures}
                if quality_failures
                else {}
            ),
            **(
                {
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
    competitors = await _competitor_summaries(
        settings,
        source_groups["competitor"],
        len(source_groups["competitor"]),
    )
    competitor_blueprint = build_competitor_blueprint(competitors)
    internal = _internal_link_candidates(source_groups["internal"], 30)
    authority = [
        _authority_pack_item(item)
        for item in source_groups["authority"]
        if _authority_source_usable(item)
    ]
    authority = list({item["url"]: item for item in authority}.values())
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
    requested_article_type = dict(plan_input.get("article_type") or {})
    if requested_article_type.get("value"):
        content_brief["content_type"] = requested_article_type["value"]
    return {
        "keyword": context["primary_keyword"],
        "secondary_keywords": list(plan_input.get("secondary_keywords") or []),
        "planned_title": dict(plan_input.get("title") or {}),
        "writing_direction": dict(plan_input.get("writing_direction") or {}),
        "requested_article_type": requested_article_type,
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
                "content": text,
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


def _source_supports_requirement(source: dict[str, Any], requirement: str) -> bool:
    source_text = " ".join(
        [
            _source_mapping_source_text(source),
            *[
                " ".join(
                    [str(item.get("claim") or ""), str(item.get("evidence") or "")]
                )
                for item in source.get("verification_claims") or []
                if isinstance(item, dict)
            ],
        ]
    )
    requirement_stems = {
        _source_mapping_stem(item) for item in _source_mapping_words(requirement)
    }
    source_stems = {
        _source_mapping_stem(item) for item in _source_mapping_words(source_text)
    }
    if not requirement_stems or not source_stems:
        return False
    overlap = requirement_stems.intersection(source_stems)
    return len(overlap) >= 2 and len(overlap) / len(requirement_stems) >= 0.5


def _critical_research_tasks(plan: ArticlePlan) -> list[str]:
    return _unique(
        gap.research_query.strip()
        for gap in plan.critical_research_gaps
        if gap.research_query.strip()
    )[:4]


def _supplemental_research_timeout_seconds(
    context: dict[str, Any], started_at: float
) -> float:
    elapsed = max(0.0, time.monotonic() - started_at)
    remaining = MAX_SUPPLEMENTAL_RESEARCH_SECONDS - elapsed
    hard_deadline = context.get("hard_deadline_at")
    if isinstance(hard_deadline, datetime):
        if hard_deadline.tzinfo is None:
            hard_deadline = hard_deadline.replace(tzinfo=UTC)
        deadline_remaining = (
            hard_deadline.astimezone(UTC) - datetime.now(UTC)
        ).total_seconds() - GENERATION_DEADLINE_RESERVE_SECONDS
        remaining = min(remaining, deadline_remaining)
    return max(0.0, remaining)


def normalize_plan(plan: ArticlePlan, pack: dict[str, Any]) -> ArticlePlan:
    claims: list[EvidenceClaim] = []
    claim_id_map: dict[str, str] = {}
    for index, claim in enumerate(plan.claims[:MAX_PLAN_CLAIMS]):
        claim_id = f"claim-{index + 1}"
        claim_id_map[claim.claim_id] = claim_id
        claims.append(claim.model_copy(update={"claim_id": claim_id, "section_id": None}))
    existing_claims = {
        (claim.source_url, _normalize_requirement(claim.claim)) for claim in claims
    }
    imported_research_claim_ids: list[str] = []
    project_claim_ids: list[str] = []
    next_claim_number = len(claims) + 1
    project_evidence = (
        _project_article_evidence(pack)
        if _project_article_role(pack) != "unrelated"
        else []
    )
    for evidence in project_evidence:
        if len(claims) >= MAX_PLAN_CLAIMS:
            break
        field = str(evidence.get("field") or "").strip()
        claim_text = str(evidence.get("value") or "").strip()
        quote = str(evidence.get("quote") or claim_text).strip()
        source_url = str(evidence.get("source_url") or "").strip()
        identity = (source_url, _normalize_requirement(claim_text))
        if (
            field == "conversion_actions"
            or not claim_text
            or not quote
            or identity in existing_claims
        ):
            continue
        existing_claims.add(identity)
        claims.append(
            EvidenceClaim(
                claim_id=f"claim-{next_claim_number}",
                claim=claim_text[:1000],
                source_url=source_url,
                source_title=str(
                    _project_answer_context(None, pack).get("business_name") or ""
                )[:500],
                quote=quote[:2000],
            )
        )
        project_claim_ids.append(f"claim-{next_claim_number}")
        next_claim_number += 1
    for item in _research_source_claims(pack):
        if len(claims) >= MAX_PLAN_CLAIMS:
            break
        identity = (item["source_url"], _normalize_requirement(item["claim"]))
        if identity in existing_claims:
            continue
        existing_claims.add(identity)
        claim_id = f"claim-{next_claim_number}"
        next_claim_number += 1
        claims.append(EvidenceClaim(claim_id=claim_id, **item))
        imported_research_claim_ids.append(claim_id)
    sections: list[OutlineSection] = []
    section_id_map: dict[str, str] = {}
    for index, section in enumerate(plan.sections[:12]):
        section_id = f"section-{index + 1}"
        section_id_map[section.section_id] = section_id
        sections.append(
            section.model_copy(
                update={
                    "section_id": section_id,
                    "claim_ids": [
                        claim_id_map[item]
                        for item in section.claim_ids
                        if item in claim_id_map
                    ][:MAX_SECTION_CLAIMS],
                    "internal_urls": _unique(section.internal_urls)[:10],
                }
            )
        )
    if not sections:
        return fallback_plan(pack)
    sections = _ensure_project_answer_plan_section(sections, pack)[:12]
    sections = _finalize_section_plans(sections, pack)
    sections = _assign_research_claims(
        sections,
        claims,
        [*project_claim_ids, *imported_research_claim_ids],
        pack,
        require_relevance_claim_ids=set(project_claim_ids),
    )
    valid_section_ids = {section.section_id for section in sections}
    valid_claim_ids = {claim.claim_id for claim in claims}
    permitted_visual_urls = _permitted_visual_urls(pack)
    chart_claim_ids = {
        claim.claim_id
        for claim in claims
        if claim.source_url in permitted_visual_urls
    }
    visuals = []
    used_visual_ids: set[str] = set()
    used_visual_sections: set[str] = set()
    for visual in plan.visuals[:12]:
        section_id = section_id_map.get(visual.section_id)
        if section_id not in valid_section_ids or section_id in used_visual_sections:
            continue
        if visual.source_strategy == "ai" and visual.reader_job == "prove":
            continue
        if (
            visual.source_strategy == "screenshot"
            and visual.target_url not in permitted_visual_urls
        ):
            continue
        data_claim_ids = [
            claim_id_map[item]
            for item in visual.data_claim_ids
            if item in claim_id_map
            and claim_id_map[item] in valid_claim_ids
            and claim_id_map[item] in chart_claim_ids
        ]
        chart_data = [
            item.model_copy(update={"claim_id": claim_id_map[item.claim_id]})
            for item in visual.chart_data
            if item.claim_id in claim_id_map
            and claim_id_map[item.claim_id] in data_claim_ids
        ]
        if visual.source_strategy == "chart" and (not data_claim_ids or not chart_data):
            continue
        visual_id = f"visual-{len(visuals) + 1}"
        if visual_id in used_visual_ids:
            continue
        used_visual_ids.add(visual_id)
        used_visual_sections.add(section_id)
        visuals.append(
            visual.model_copy(
                update={
                    "visual_id": visual_id,
                    "section_id": section_id,
                    "required": False,
                    "data_claim_ids": data_claim_ids,
                    "chart_data": chart_data,
                }
            )
        )
    requested_article_type = dict(pack.get("requested_article_type") or {})
    article_type = str(
        requested_article_type.get("value")
        if requested_article_type.get("policy") == "locked"
        else _canonical_article_type(plan.article_type)
    )
    normalized_claims = [
        claim.model_copy(
            update={
                "section_id": next(
                    (
                        section.section_id
                        for section in sections
                        if claim.claim_id in section.claim_ids
                    ),
                    None,
                )
            }
        )
        for claim in claims
    ]
    normalized = plan.model_copy(
        update={
            "title": _locked_title(pack) or plan.title,
            "slug": normalize_slug(plan.slug, str(pack["keyword"])),
            "article_type": article_type,
            "claims": normalized_claims,
            "sections": sections,
            "visuals": visuals,
            "total_word_target": sum(item.word_target for item in sections),
            "gap_to_section_mapping": _gap_to_section_mapping(sections),
        }
    )
    return normalized.model_copy(update={"contract": _build_article_contract(normalized, pack)})


def _permitted_visual_urls(pack: dict[str, Any]) -> set[str]:
    source_urls, internal_urls = allowed_urls(pack)
    result = {*source_urls, *internal_urls}
    project_domain = str((pack.get("project") or {}).get("domain") or "").strip()
    normalized = (
        project_domain.removeprefix("https://").removeprefix("http://").strip("/")
    )
    if normalized:
        result.update({f"https://{normalized}", f"https://{normalized}/"})
    return result


def _ensure_project_answer_plan_section(
    sections: list[OutlineSection], pack: dict[str, Any]
) -> list[OutlineSection]:
    if not _project_answer_is_core(pack):
        return sections
    context = _project_answer_context(None, pack)
    business_name = str(context.get("business_name") or "").strip()
    keyword = str(pack.get("keyword") or "").strip()
    if not business_name:
        return sections
    facts = _unique(
        [
            str(context.get("business_summary") or "").strip(),
            *[str(item).strip() for item in context.get("products_services") or []],
            *[str(item).strip() for item in context.get("value_propositions") or []],
        ]
    )
    facts = [item for item in facts if item]
    project_domain = str((pack.get("project") or {}).get("domain") or "")
    cta = next(
        (
            item
            for item in context.get("cta_targets") or []
            if project_domain_matches(str(item.get("url") or ""), project_domain)
        ),
        None,
    )
    cta_url = str((cta or {}).get("url") or "")
    business_key = _normalize_requirement(business_name)
    answer_index = next(
        (
            index
            for index, section in enumerate(sections)
            if business_key
            in _normalize_requirement(
                " ".join([section.heading, section.objective, *section.coverage_points])
            )
        ),
        None,
    )
    if answer_index is None:
        answer = OutlineSection(
            section_id="project-answer",
            heading=f"{business_name}: {keyword}",
            objective=f"Explain how {business_name} answers the reader's question about {keyword}.",
            coverage_points=facts[:12],
            internal_urls=[cta_url] if cta_url else [],
            cta_type="strong" if cta_url else None,
        )
        return [answer, *sections[:11]]
    answer = sections[answer_index]
    updated = answer.model_copy(
        update={
            "coverage_points": _unique([*answer.coverage_points, *facts])[:12],
            "internal_urls": _unique(
                [*answer.internal_urls, *([cta_url] if cta_url else [])]
            )[:10],
            "cta_type": "strong" if cta_url else answer.cta_type,
        }
    )
    return [
        updated if index == answer_index else section
        for index, section in enumerate(sections)
    ]


def assign_internal_links_to_sections(
    sections: list[OutlineSection], pack: dict[str, Any], max_links: int = 5
) -> list[OutlineSection]:
    cta_assignment = _select_cta_assignment(sections, pack)
    assigned: dict[str, str] = {}
    used_urls: set[str] = set()
    if cta_assignment is not None and max_links > 0:
        cta_section_id, cta_url = cta_assignment
        assigned[cta_section_id] = cta_url
        used_urls.add(cta_url)

    candidates = {
        str(item.get("url") or ""): item
        for item in pack.get("internal_sources") or []
        if item.get("url")
        and str(item.get("url") or "") not in used_urls
    }
    if max_links <= 0:
        return [section.model_copy(update={"internal_urls": []}) for section in sections]

    eligible_types = {
        "body_how_to",
        "body_comparison",
        "body_explanation",
        "body_list",
    }
    ranked_pairs: list[tuple[int, int, int, int, str, str]] = []
    for section_index, section in enumerate(sections):
        if section.section_id in assigned:
            continue
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
    del pack
    required_questions = _unique(
        question
        for section in plan.sections
        for question in section.required_questions
        if question
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
        sections.append(
            ContractSection(
                section_id=section.section_id,
                required_questions=_unique(section.required_questions)[:10],
            )
        )
    return ArticleContract(
        article_type=plan.article_type,
        search_intent=plan.search_intent,
        required_questions=required_questions,
        sections=sections,
        faq_questions=faq_questions,
    )


def _ensure_article_contract(plan: ArticlePlan, pack: dict[str, Any]) -> ArticlePlan:
    if plan.contract is not None:
        return plan
    return plan.model_copy(update={"contract": _build_article_contract(plan, pack)})


def _source_evidence_excerpt(source: dict[str, Any]) -> str:
    summary_value = source.get("summary")
    summary = dict(summary_value) if isinstance(summary_value, dict) else {}
    for field in (
        "research_excerpt",
        "citation_excerpt",
        "research_claim",
        "research_answer",
    ):
        excerpt = str(summary.get(field) or "").strip()
        if excerpt:
            return excerpt[:6000]
    return ""


def _authority_source_usable(source: dict[str, Any]) -> bool:
    return bool(
        str(source.get("url") or "").strip()
        and _source_evidence_excerpt(source)
    )


def _authority_pack_item(source: dict[str, Any]) -> dict[str, Any]:
    summary_value = source.get("summary")
    summary = dict(summary_value) if isinstance(summary_value, dict) else {}
    metadata_value = source.get("metadata")
    metadata = dict(metadata_value) if isinstance(metadata_value, dict) else {}
    verification_claims = [
        dict(item)
        for item in summary.get("verification_claims") or []
        if isinstance(item, dict)
    ]
    return {
        "url": source["url"],
        "title": source.get("title") or "",
        "excerpt": _source_evidence_excerpt(source),
        "research_answer": str(summary.get("research_answer") or "")[:12000],
        "citation_excerpt": str(summary.get("citation_excerpt") or "")[:4000],
        "research_claim": str(summary.get("research_claim") or ""),
        "provider": metadata.get("provider") or "",
        "model": metadata.get("model") or "",
        "queries": list(metadata.get("queries") or []),
        "failed_queries": list(metadata.get("failed_queries") or []),
        "cached": bool(metadata.get("cached")),
        "verification_claims": verification_claims,
    }


def _select_cta_assignment(
    sections: list[OutlineSection], pack: dict[str, Any]
) -> tuple[str, str] | None:
    project_role = _project_article_role(pack)
    if project_role == "unrelated":
        return None
    project_domain = str((pack.get("project") or {}).get("domain") or "")
    context = _project_answer_context(None, pack)
    cta_targets = [
        item
        for item in context["cta_targets"]
        if project_domain_matches(str(item.get("url") or ""), project_domain)
    ]
    if not sections or not cta_targets:
        return None

    profile = dict((pack.get("project") or {}).get("profile") or {})

    def candidate(target: dict[str, Any]) -> dict[str, Any]:
        return {
            **target,
            "description": " ".join(
                [
                    str(target.get("description") or ""),
                    str(profile.get("business_summary") or ""),
                    *[str(item) for item in profile.get("products_services") or []],
                    *[str(item) for item in profile.get("value_propositions") or []],
                ]
            ),
        }

    project_is_core = project_role == "core"
    targets_by_url = {str(item["url"]): item for item in cta_targets}
    explicit = next(
        (
            (section.section_id, url)
            for section in sections
            for url in section.internal_urls
            if url in targets_by_url
            and (
                project_is_core
                or _internal_link_section_score(section, candidate(targets_by_url[url]))
                >= 1
            )
        ),
        None,
    )
    if explicit is not None:
        return explicit

    prompted = next(
        (section for section in reversed(sections) if section.cta_type == "strong"),
        next((section for section in reversed(sections) if section.cta_type), None),
    )
    if prompted is not None:
        prompted_targets = sorted(
            (
                (_internal_link_section_score(prompted, candidate(target)), target)
                for target in cta_targets
            ),
            key=lambda item: (item[0], str(item[1].get("url") or "")),
            reverse=True,
        )
        prompted_score, prompted_target = prompted_targets[0]
        if project_is_core or prompted_score >= 1:
            return prompted.section_id, str(prompted_target["url"])

    ranked = sorted(
        (
            (
                _internal_link_section_score(section, candidate(target)),
                index,
                section,
                target,
            )
            for index, section in enumerate(sections)
            for target in cta_targets
        ),
        key=lambda item: (item[0], item[1], str(item[3].get("url") or "")),
        reverse=True,
    )
    score, _, selected, selected_target = ranked[0]
    if score < 1 and not project_is_core:
        return None
    return selected.section_id, str(selected_target["url"])


def _evidence_contains_quote(evidence: str, quote: str) -> bool:
    normalized_evidence = re.sub(r"\s+", " ", evidence).strip().casefold()
    normalized_quote = re.sub(r"\s+", " ", quote).strip().casefold()
    return bool(normalized_quote and normalized_quote in normalized_evidence)


def fallback_plan(pack: dict[str, Any]) -> ArticlePlan:
    keyword = str(pack["keyword"])
    questions = list(pack.get("required_questions") or [])
    requested_article_type = dict(pack.get("requested_article_type") or {})
    article_type = str(requested_article_type.get("value") or "guide")
    headings = [
        (f"Understanding {keyword}", "Explain the topic and the user's core intent"),
        ("Key considerations", "Cover the practical factors that affect the decision"),
        ("A practical process", "Give a clear step-by-step approach"),
        ("Common questions", "Answer the remaining user questions directly"),
    ]
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
    sections = _ensure_project_answer_plan_section(sections, pack)
    sections = _finalize_section_plans(sections, pack)
    sections = assign_internal_links_to_sections(sections, pack)
    title = _fallback_title(pack, sections)
    plan = ArticlePlan(
        title=title,
        search_intent=f"Understand and act on {keyword}",
        article_type=article_type,
        meta_title=title,
        meta_description=f"Find practical options and next steps for {keyword}.",
        slug=normalize_slug(keyword, keyword),
        sections=sections,
        total_word_target=sum(item.word_target for item in sections),
        gap_to_section_mapping=_gap_to_section_mapping(sections),
    )
    plan = _bind_fallback_evidence(plan, pack)
    return plan.model_copy(update={"contract": _build_article_contract(plan, pack)})


def _fallback_title(pack: dict[str, Any], sections: list[OutlineSection]) -> str:
    locked = _locked_title(pack)
    if locked:
        return locked
    keyword = str(pack.get("keyword") or "").strip()
    display_keyword = " ".join(
        item.upper() if item.casefold() in {"ai", "api", "pc", "seo", "tv", "vpn"}
        else item.capitalize()
        for item in keyword.split()
    )
    business_name = str(
        ((pack.get("project") or {}).get("profile") or {}).get("business_name") or ""
    ).strip()
    project_is_core = bool(
        business_name
        and any(business_name.casefold() in section.heading.casefold() for section in sections)
    )
    if project_is_core:
        return f"{business_name}: {display_keyword}"
    return f"{display_keyword}: What to Know and How to Get Started"


def _bind_fallback_evidence(plan: ArticlePlan, pack: dict[str, Any]) -> ArticlePlan:
    source_by_url = {
        str(item.get("url") or ""): dict(item)
        for item in _rank_planning_sources(pack)
        if item.get("url") and item.get("excerpt")
        and (
            _project_answer_is_core(pack)
            or not _source_is_project_owned(item, pack)
        )
    }
    claims: list[EvidenceClaim] = []
    seen: set[tuple[str, str]] = set()
    for source_url, source in source_by_url.items():
        candidates = [
            dict(item)
            for item in source.get("verification_claims") or []
            if isinstance(item, dict)
        ]
        if not candidates:
            candidates = [
                {
                    "claim": source.get("research_claim") or source.get("excerpt"),
                    "evidence": source.get("excerpt"),
                }
            ]
        for candidate in candidates:
            if len(claims) >= MAX_PLAN_CLAIMS:
                break
            claim_text = str(candidate.get("claim") or "").strip()
            evidence = str(candidate.get("evidence") or "").strip()
            excerpt = str(source.get("excerpt") or "").strip()
            quote = evidence if _evidence_contains_quote(excerpt, evidence) else excerpt
            identity = (source_url, claim_text.casefold())
            if not claim_text or not quote or identity in seen:
                continue
            seen.add(identity)
            claims.append(
                EvidenceClaim(
                    claim_id=f"claim-{len(claims) + 1}",
                    claim=claim_text[:1000],
                    source_url=source_url,
                    source_title=str(source.get("title") or "")[:500],
                    quote=quote[:2000],
                )
            )
    if not claims:
        return plan

    claim_ids_by_section = {section.section_id: [] for section in plan.sections}
    assigned_claims: list[EvidenceClaim] = []
    body_indexes = [
        index
        for index, section in enumerate(plan.sections)
        if section.section_type not in {"intro", "conclusion"}
    ] or list(range(len(plan.sections)))
    for index, claim in enumerate(claims):
        source = source_by_url[claim.source_url]
        scores = [
            (
                _source_semantic_score(section, source)
                + _source_keyword_score(section, source, pack),
                section_index,
            )
            for section_index, section in enumerate(plan.sections)
        ]
        best_score, section_index = max(scores, key=lambda item: (item[0], -item[1]))
        if best_score <= 0:
            section_index = body_indexes[index % len(body_indexes)]
        section_id = plan.sections[section_index].section_id
        claim_ids_by_section[section_id].append(claim.claim_id)
        assigned_claims.append(claim.model_copy(update={"section_id": section_id}))
    sections = [
        section.model_copy(
            update={
                "claim_ids": _unique(
                    [*section.claim_ids, *claim_ids_by_section[section.section_id]]
                )[:MAX_SECTION_CLAIMS]
            }
        )
        for section in plan.sections
    ]
    return plan.model_copy(update={"claims": assigned_claims, "sections": sections})


def _project_answer_is_core(pack: dict[str, Any]) -> bool:
    context = _project_answer_context(None, pack)
    business_name = str(context.get("business_name") or "").strip()
    keyword = str(context.get("keyword") or "").strip()
    if not business_name or not keyword:
        return False
    business_key = _normalize_requirement(business_name)
    keyword_key = _normalize_requirement(keyword)
    locked_title_key = _normalize_requirement(_locked_title(pack) or "")
    return business_key in keyword_key or bool(
        locked_title_key and business_key in locked_title_key
    )


def _project_article_role(pack: dict[str, Any]) -> str:
    if _project_answer_is_core(pack):
        return "core"
    context = _project_answer_context(None, pack)
    if not context.get("cta_targets"):
        return "unrelated"
    topic_terms = _internal_link_terms(
        " ".join(
            [
                str(pack.get("keyword") or ""),
                *[str(item) for item in pack.get("required_questions") or []],
            ]
        )
    )
    evidence_terms: set[str] = set()
    for item in context.get("product_evidence") or []:
        if str(item.get("field") or "") == "conversion_actions":
            continue
        evidence_terms.update(
            _internal_link_terms(
                " ".join(
                    [
                        str(item.get("value") or ""),
                        str(item.get("quote") or ""),
                    ]
                )
            )
        )
    return "conversion" if topic_terms.intersection(evidence_terms) else "unrelated"


def _conversion_project_profile(pack: dict[str, Any]) -> dict[str, Any]:
    context = _project_answer_context(None, pack)
    topic_terms = _internal_link_terms(
        " ".join(
            [
                str(pack.get("keyword") or ""),
                *[str(item) for item in pack.get("required_questions") or []],
            ]
        )
    )
    relevant_evidence = [
        item
        for item in context.get("product_evidence") or []
        if str(item.get("field") or "") != "conversion_actions"
        and topic_terms.intersection(
            _internal_link_terms(
                " ".join(
                    [
                        str(item.get("value") or ""),
                        str(item.get("quote") or ""),
                    ]
                )
            )
        )
    ]
    cta_targets = list(context.get("cta_targets") or [])[:1]
    cta_urls = {str(item.get("url") or "") for item in cta_targets}
    cta_evidence = [
        item
        for item in context.get("product_evidence") or []
        if str(item.get("field") or "") == "conversion_actions"
        and str(item.get("source_url") or "") in cta_urls
    ]
    fields: dict[str, list[str]] = {}
    for item in relevant_evidence:
        field = str(item.get("field") or "")
        fields.setdefault(field, []).append(str(item.get("value") or ""))
    return {
        "business_name": context.get("business_name") or "",
        "products_services": _unique(fields.get("products_services") or []),
        "value_propositions": _unique(fields.get("value_propositions") or []),
        "conversion_actions": [
            str(item.get("label") or "") for item in cta_targets if item.get("label")
        ],
        "key_pages": [
            item
            for item in context.get("key_pages") or []
            if str(item.get("url") or "") in cta_urls
        ],
        "cta_targets": cta_targets,
        "product_evidence": [*relevant_evidence, *cta_evidence],
    }


def _source_is_project_owned(source: dict[str, Any], pack: dict[str, Any]) -> bool:
    project = dict(pack.get("project") or {})
    project_domain = str(project.get("domain") or "").strip()
    source_url = str(source.get("url") or "").strip()
    if project_domain_matches(source_url, project_domain):
        return True
    business_name = str(
        _project_answer_context(None, pack).get("business_name") or ""
    ).strip()
    business_key = _normalize_requirement(business_name)
    if not business_key:
        return False
    source_identity = _normalize_requirement(
        " ".join(
            [
                str(source.get("title") or ""),
                urlsplit(source_url).netloc,
            ]
        )
    )
    return f" {business_key} " in f" {source_identity} "


def _exclude_project_owned_sources(
    sources: list[dict[str, Any]], pack: dict[str, Any]
) -> list[dict[str, Any]]:
    return [item for item in sources if not _source_is_project_owned(item, pack)]


def _plan_has_unrequested_project_focus(
    plan: ArticlePlan, pack: dict[str, Any]
) -> bool:
    if _project_answer_is_core(pack):
        return False
    business_name = str(
        _project_answer_context(None, pack).get("business_name") or ""
    ).strip()
    if not business_name:
        return False

    business_key = _normalize_requirement(business_name)

    def mentions_business(value: str) -> bool:
        normalized = _normalize_requirement(value)
        return bool(
            business_key
            and f" {business_key} " in f" {normalized} "
        )

    if mentions_business(plan.title) or mentions_business(plan.search_intent):
        return True
    focused_sections = sum(
        mentions_business(" ".join([section.heading, section.objective]))
        for section in plan.sections
    )
    return bool(plan.sections) and focused_sections > len(plan.sections) / 2


def _project_article_evidence(pack: dict[str, Any]) -> list[dict[str, str]]:
    context = _project_answer_context(None, pack)
    if _project_article_role(pack) == "conversion":
        return list(_conversion_project_profile(pack).get("product_evidence") or [])
    return [
        item
        for item in context["product_evidence"]
        if str(item.get("field") or "").strip() != "conversion_actions"
        and str(item.get("value") or "").strip()
        and str(item.get("source_url") or "").strip()
    ]


def _research_source_claims(pack: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    project_role = _project_article_role(pack)
    conversion_urls = {
        str(item.get("source_url") or "")
        for item in _project_article_evidence(pack)
    }
    for source in pack.get("authority_sources") or []:
        if (
            project_role != "core"
            and _source_is_project_owned(source, pack)
            and str(source.get("url") or "") not in conversion_urls
        ):
            continue
        source_url = str(source.get("url") or "").strip()
        if not source_url:
            continue
        for item in source.get("verification_claims") or []:
            if not isinstance(item, dict):
                continue
            claim = str(item.get("claim") or "").strip()
            evidence = str(item.get("evidence") or "").strip()
            if not claim:
                continue
            output.append(
                {
                    "claim": claim[:1000],
                    "source_url": source_url,
                    "source_title": str(source.get("title") or "")[:500],
                    "quote": (evidence or claim)[:2000],
                }
            )
    return output


def _assign_research_claims(
    sections: list[OutlineSection],
    claims: list[EvidenceClaim],
    claim_ids: list[str],
    pack: dict[str, Any],
    *,
    require_relevance_claim_ids: set[str] | None = None,
) -> list[OutlineSection]:
    if not sections:
        return sections
    claims_by_id = {item.claim_id: item for item in claims}
    sources_by_url = {
        str(item.get("url") or ""): dict(item)
        for item in _evidence_sources(pack)
        if item.get("url")
    }
    assigned = {section.section_id: list(section.claim_ids) for section in sections}
    for claim_id in claim_ids:
        claim = claims_by_id[claim_id]
        source = sources_by_url.get(claim.source_url, {})
        claim_source = {
            **source,
            "research_claim": claim.claim,
            "excerpt": claim.quote,
        }
        target = max(
            sections,
            key=lambda section: (
                _source_semantic_score(section, claim_source),
                -sections.index(section),
            ),
        )
        if (
            claim.claim_id in (require_relevance_claim_ids or set())
            and not _project_answer_is_core(pack)
            and _source_semantic_score(target, claim_source) < 0.1
        ):
            continue
        assigned[target.section_id] = _unique(
            [*assigned[target.section_id], claim_id]
        )[:MAX_SECTION_CLAIMS]
    return [
        section.model_copy(update={"claim_ids": assigned[section.section_id]})
        for section in sections
    ]


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
    section_count = min(len(sections), 12)
    output: list[OutlineSection] = []
    for index, section in enumerate(sections[:section_count]):
        inferred_section_type = _classify_section_type(section.heading, index)
        section_type = section.section_type
        if section_type == "body_explanation" or (
            section_type == "conclusion"
            and inferred_section_type
            in {"body_how_to", "body_comparison", "body_list"}
            and not _is_explicit_conclusion_heading(section.heading)
        ):
            section_type = inferred_section_type
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
        word_target = section.word_target or base_target
        strategic_angle = section.strategic_angle.strip() or section.objective
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
                    "cta_type": section.cta_type,
                    "featured_snippet_target": featured_snippet,
                }
            )
        )
    deduplicated = _deduplicate_section_requirements(output)
    if pack.get("required_questions"):
        deduplicated = [
            section
            for section in deduplicated
            if section.section_type != "faq" or section.required_questions
        ]
    return deduplicated


def _deduplicate_section_requirements(
    sections: list[OutlineSection],
) -> list[OutlineSection]:
    seen_questions: set[str] = set()
    output: list[OutlineSection] = []
    for section in sections:
        questions: list[str] = []
        for question in section.required_questions:
            normalized = _normalize_requirement(question)
            if not normalized or normalized in seen_questions:
                continue
            seen_questions.add(normalized)
            questions.append(question)
        output.append(
            section.model_copy(
                update={
                    "required_questions": questions,
                    "coverage_points": _unique(section.coverage_points),
                    "competitor_gaps": _unique(section.competitor_gaps),
                    "data_requirements": _unique(section.data_requirements),
                }
            )
        )
    cta_index = next(
        (
            index
            for index in range(len(output) - 1, -1, -1)
            if output[index].cta_type == "strong"
        ),
        next(
            (
                index
                for index in range(len(output) - 1, -1, -1)
                if output[index].cta_type
            ),
            None,
        ),
    )
    return [
        item.model_copy(update={"cta_type": None})
        if cta_index is not None and index != cta_index
        else item
        for index, item in enumerate(output)
    ]


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


def _classify_section_type(heading: str, index: int) -> str:
    normalized = _normalize_requirement(heading)
    normalized_tokens = set(normalized.split())
    section_type = "body_explanation"
    if normalized_tokens.intersection({"intro", "introduction"}) or any(
        item in normalized for item in ("direct answer", "opening answer")
    ):
        section_type = "intro"
    elif any(
        item in normalized
        for item in (
            "how to",
            "steps",
            "guide",
            "tutorial",
            "process",
            "choose",
            "choice",
            "select",
            "selection",
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

    if (
        normalized_tokens.intersection({"faq", "question", "questions"})
        or any(item in normalized for item in ("常见问题", "问答"))
    ):
        section_type = "faq"
    return section_type


def _is_explicit_conclusion_heading(heading: str) -> bool:
    normalized = _normalize_requirement(heading)
    return normalized.startswith(("conclusion", "summary", "final thoughts", "结论", "总结"))


def _engagement_hook(section_type: str) -> str:
    return {
        "intro": "Acknowledge the reader's situation, promise a useful answer, and preview it directly.",
        "body_how_to": "Open with the outcome and the first concrete action.",
        "body_comparison": "State the decision criteria before comparing options fairly.",
        "body_explanation": "Begin with a plain-language answer before adding detail.",
        "body_list": "Explain how the items were selected before listing them consistently.",
        "faq": "Answer each real user question directly before adding context.",
        "conclusion": "Turn the main findings into specific next steps.",
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
    mapped_sources = _unique_source_records(
        map_authority_sources_to_section(plan, section, pack)
    )
    claims = [
        item for item in plan.claims if item.claim_id in section.claim_ids
    ][:MAX_SECTION_CLAIMS]
    internal = [
        item for item in pack.get("internal_sources", []) if item.get("url") in section.internal_urls
    ]
    project_answer_context = _section_project_context(plan, section, pack)
    competitor_articles = _competitor_reference_materials(pack, compact=compact)
    serp_results = [
        {
            "url": item.get("url"),
            "title": item.get("title"),
            "description": item.get("description"),
        }
        for item in list((pack.get("serp") or {}).get("organic_results") or [])[:10]
    ]
    if not _project_answer_is_core(pack):
        competitor_articles = _exclude_project_owned_sources(competitor_articles, pack)
        serp_results = _exclude_project_owned_sources(serp_results, pack)
    return {
        "goal": "Write this section as part of the article and make it useful to the reader.",
        "language": pack["language"],
        "keyword": pack["keyword"],
        "article_title": plan.title,
        "section": {
            "section_id": section.section_id,
            "heading": section.heading,
            "objective": section.objective,
            "coverage_points": section.coverage_points,
            "word_target": section.word_target,
        },
        "facts": [item.model_dump(mode="json") for item in claims],
        "sources": [_writing_source_material(item) for item in mapped_sources],
        "competitor_articles": competitor_articles,
        "serp_results": serp_results,
        "internal_links": internal,
        "official_product": project_answer_context,
        "previous_section_summaries": previous_summaries,
        "length": "concise" if compact else "complete",
    }


def _section_project_context(
    plan: ArticlePlan, section: OutlineSection, pack: dict[str, Any]
) -> dict[str, Any]:
    context = _project_answer_context(plan, pack)
    cta_assignment = _select_cta_assignment(plan.sections, pack)
    section_cta_targets = [
        item
        for item in context["cta_targets"]
        if cta_assignment == (section.section_id, str(item.get("url") or ""))
    ]
    project_domain = str((pack.get("project") or {}).get("domain") or "")
    section_claims = [
        item for item in plan.claims if item.claim_id in section.claim_ids
    ]
    project_relevant = _project_answer_is_core(pack) or bool(section_cta_targets) or any(
        project_domain_matches(item.source_url, project_domain) for item in section_claims
    )
    return {
        **(context if project_relevant else {}),
        "conversion_actions": [
            str(item["label"])
            for item in section_cta_targets
            if item.get("label")
        ],
        "cta_targets": section_cta_targets,
    }


def _project_answer_context(
    plan: ArticlePlan | None, pack: dict[str, Any]
) -> dict[str, Any]:
    project = dict(pack.get("project") or {})
    profile = dict(project.get("profile") or {})
    product_evidence = [
        {
            "field": str(item.get("field") or "").strip(),
            "value": str(item.get("value") or "").strip(),
            "quote": str(item.get("quote") or "").strip(),
            "source_url": str(item.get("source_url") or "").strip(),
        }
        for item in profile.get("evidence") or []
        if isinstance(item, dict)
        and str(item.get("field") or "").strip()
        and str(item.get("value") or "").strip()
        and _real_web_url(str(item.get("source_url") or ""))
    ]
    key_pages = [
        {
            "url": str(item.get("url") or "").strip(),
            "title": str(item.get("title") or "").strip(),
            "description": str(item.get("description") or "").strip(),
        }
        for item in profile.get("key_pages") or []
        if isinstance(item, dict) and _real_web_url(str(item.get("url") or ""))
    ]
    evidence_actions = [
        {
            "label": str(item.get("value") or "").strip(),
            "url": str(item.get("source_url") or "").strip(),
            "description": str(item.get("quote") or "").strip(),
        }
        for item in profile.get("evidence") or []
        if isinstance(item, dict)
        and item.get("field") == "conversion_actions"
        and str(item.get("value") or "").strip()
        and _real_web_url(str(item.get("source_url") or ""))
    ]
    actions = _unique(
        [
            *[
                str(item).strip()
                for item in profile.get("conversion_actions") or []
                if str(item).strip()
            ],
            *[item["label"] for item in evidence_actions],
        ]
    )
    for item in evidence_actions:
        if any(page["url"] == item["url"] for page in key_pages):
            continue
        key_pages.append(
            {
                "url": item["url"],
                "title": item["label"],
                "description": item["description"],
            }
        )
    cta_targets: list[dict[str, str]] = []
    used_urls: set[str] = set()
    for action in sorted(actions, key=len, reverse=True):
        evidence_match = next(
            (
                item
                for item in evidence_actions
                if item["label"] == action and item["url"] not in used_urls
            ),
            None,
        )
        if evidence_match is not None:
            candidates = [
                item for item in key_pages if item["url"] not in used_urls
            ]
            if not any(item["url"] == evidence_match["url"] for item in candidates):
                candidates.append(
                    {
                    "url": evidence_match["url"],
                    "title": evidence_match["label"],
                    "description": evidence_match["description"],
                    }
                )
            page = max(
                candidates,
                key=lambda item: (_cta_page_score(action, item), item["url"]),
            )
            used_urls.add(page["url"])
            cta_targets.append(
                {
                    "label": action,
                    "url": page["url"],
                    "title": page["title"],
                    "description": page["description"],
                }
            )
            continue
        ranked = sorted(
            (
                (_cta_page_score(action, page), page)
                for page in key_pages
                if page["url"] not in used_urls
            ),
            key=lambda item: (item[0], item[1]["url"]),
            reverse=True,
        )
        if not ranked or ranked[0][0] <= 0:
            continue
        page = ranked[0][1]
        used_urls.add(page["url"])
        cta_targets.append(
            {
                "label": action,
                "url": page["url"],
                "title": page["title"],
                "description": page["description"],
            }
        )
    return {
        "profile": profile,
        "keyword": str(pack.get("keyword") or ""),
        "original_intent": plan.search_intent if plan else str(pack.get("keyword") or ""),
        "business_name": str(profile.get("business_name") or ""),
        "business_summary": str(profile.get("business_summary") or ""),
        "products_services": list(profile.get("products_services") or []),
        "value_propositions": list(profile.get("value_propositions") or []),
        "conversion_actions": actions,
        "key_pages": key_pages,
        "cta_targets": cta_targets,
        "product_evidence": product_evidence,
    }


def _project_evidence_sources(pack: dict[str, Any]) -> list[dict[str, Any]]:
    context = _project_answer_context(None, pack)
    business_name = str(context.get("business_name") or "Project website").strip()
    grouped: dict[str, list[dict[str, str]]] = {}
    for evidence in context.get("product_evidence") or []:
        if not isinstance(evidence, dict) or evidence.get("field") == "conversion_actions":
            continue
        source_url = str(evidence.get("source_url") or "").strip()
        claim = str(evidence.get("value") or "").strip()
        quote = str(evidence.get("quote") or claim).strip()
        if not source_url or not claim or not quote:
            continue
        grouped.setdefault(source_url, []).append(
            {"claim": claim, "evidence": quote}
        )
    return [
        {
            "url": source_url,
            "title": business_name,
            "excerpt": " ".join(
                dict.fromkeys(item["evidence"] for item in claims)
            )[:4000],
            "research_claim": claims[0]["claim"],
            "verification_claims": claims[:8],
        }
        for source_url, claims in grouped.items()
    ]


def _evidence_sources(pack: dict[str, Any]) -> list[dict[str, Any]]:
    by_url = {
        str(item.get("url") or ""): dict(item)
        for item in pack.get("authority_sources") or []
        if item.get("url")
    }
    for source in _project_evidence_sources(pack):
        by_url.setdefault(str(source["url"]), source)
    return list(by_url.values())


def _real_web_url(value: str) -> bool:
    parsed = urlsplit(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _cta_page_score(action: str, page: dict[str, str]) -> int:
    action_terms = _semantic_terms(action)
    page_terms = _semantic_terms(
        " ".join([page.get("url", ""), page.get("title", ""), page.get("description", "")])
    )
    score = len(action_terms.intersection(page_terms)) * 3
    action_text = action.casefold()
    page_text = " ".join(page.values()).casefold()
    for term in (
        "download",
        "install",
        "register",
        "signup",
        "sign up",
        "trial",
        "buy",
        "purchase",
        "contact",
        "book",
        "demo",
        "下载",
        "安装",
        "注册",
        "试用",
        "购买",
        "联系",
    ):
        if term in action_text and term in page_text:
            score += 8
    return score


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
    direct_claim_urls = {
        claim.source_url
        for claim in plan.claims
        if claim.claim_id in section.claim_ids
    }
    sources = [
        dict(item)
        for item in _evidence_sources(pack)
        if item.get("url") and item.get("excerpt")
        and (
            _project_answer_is_core(pack)
            or not _source_is_project_owned(item, pack)
            or str(item.get("url") or "") in direct_claim_urls
        )
    ]
    if not sources:
        return []
    by_url = {str(item["url"]): item for item in sources}
    direct_urls = _unique(
        [
            claim.source_url
            for claim in plan.claims
            if claim.claim_id in section.claim_ids
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


def fallback_section(
    section: OutlineSection,
    language: str,
    pack: dict[str, Any] | None = None,
    plan: ArticlePlan | None = None,
) -> SectionDraft:
    pack = pack or {}
    keyword = str(pack.get("keyword") or (plan.title if plan else section.heading))
    answer_context = _project_answer_context(plan, pack)
    coverage = _unique(
        [section.objective, *section.coverage_points, *section.competitor_gaps]
    )[:5]
    claims = [
        claim
        for claim in (plan.claims if plan else [])
        if claim.claim_id in section.claim_ids
    ][:3]
    sources = (
        map_authority_sources_to_section(plan, section, pack)[:3]
        if plan
        else list(pack.get("authority_sources") or [])[:3]
    )
    business_name = str(answer_context.get("business_name") or "").strip()
    business_summary = str(answer_context.get("business_summary") or "").strip()
    products = [str(item) for item in answer_context.get("products_services") or []]
    values = [str(item) for item in answer_context.get("value_propositions") or []]
    cta_targets = list(answer_context.get("cta_targets") or [])
    if language.lower().startswith("zh"):
        paragraphs = [
            f"## {section.heading}",
            f"{section.objective.rstrip('。')}。"
            + (f"{business_name}：{business_summary}" if business_summary else ""),
        ]
        if products or values:
            details = [*products[:3], *values[:3]]
            paragraphs.append("可以直接参考：\n" + "\n".join(f"- {item}" for item in details))
        if coverage:
            paragraphs.append(
                f"处理“{keyword}”时，重点看这些内容：\n"
                + "\n".join(f"- {item.rstrip('。')}" for item in coverage)
            )
        if claims:
            paragraphs.append(
                "相关资料：\n"
                + "\n".join(
                    f"- [{claim.claim}]({claim.source_url})" for claim in claims
                )
            )
        elif sources:
            paragraphs.append(
                "相关资料：\n"
                + "\n".join(
                    f"- [{str(item.get('title') or item.get('url'))}]({item.get('url')})："
                    f"{str(item.get('excerpt') or '')[:350]}"
                    for item in sources
                )
            )
        if cta_targets:
            target = cta_targets[0]
            paragraphs.append(f"[{target['label']}]({target['url']})")
    else:
        paragraphs = [
            f"## {section.heading}",
            f"{section.objective.rstrip('.')}. "
            + (f"{business_name}: {business_summary}" if business_summary else ""),
        ]
        if products or values:
            details = [*products[:3], *values[:3]]
            paragraphs.append("What is available:\n" + "\n".join(f"- {item}" for item in details))
        if coverage:
            paragraphs.append(
                f"For {keyword}, focus on:\n"
                + "\n".join(f"- {item.rstrip('.')}" for item in coverage)
            )
        if claims:
            paragraphs.append(
                "Related sources:\n"
                + "\n".join(
                    f"- [{claim.claim}]({claim.source_url})" for claim in claims
                )
            )
        elif sources:
            paragraphs.append(
                "Related sources:\n"
                + "\n".join(
                    f"- [{str(item.get('title') or item.get('url'))}]({item.get('url')}): "
                    f"{str(item.get('excerpt') or '')[:350]}"
                    for item in sources
                )
            )
        if cta_targets:
            target = cta_targets[0]
            paragraphs.append(f"[{target['label']}]({target['url']})")
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
    aligned_sections = [by_id[item.section_id] for item in plan.sections]
    return unified.model_copy(
        update={
            "title": locked_title or unified.title,
            "slug": normalize_slug(unified.slug, plan.slug),
            "sections": aligned_sections,
        }
    )


def _align_unified_section_heading(
    section: SectionDraft,
    expected: OutlineSection,
    article_title: str,
) -> SectionDraft:
    lines = section.markdown.strip().splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        first_heading = re.fullmatch(r"#{1,2}\s+(.+?)\s*", lines[0].strip())
        if (
            first_heading
            and _normalize_requirement(first_heading.group(1))
            == _normalize_requirement(article_title)
            and _normalize_requirement(article_title)
            != _normalize_requirement(expected.heading)
        ):
            lines.pop(0)
            while lines and not lines[0].strip():
                lines.pop(0)
    markdown = "\n".join(lines).strip()
    if re.search(r"(?m)^##\s+", markdown):
        markdown = re.sub(
            r"(?m)^##\s+.*$", f"## {expected.heading}", markdown, count=1
        )
    else:
        markdown = f"## {expected.heading}\n\n{markdown}"
    return section.model_copy(
        update={"section_id": expected.section_id, "markdown": markdown}
    )


def _has_section_prose(markdown: str) -> bool:
    return any(
        line.strip() and not re.match(r"^#{1,6}\s+", line.strip())
        for line in markdown.splitlines()
    )


FORMAT_ISSUE_CODES = {
    "malformed_link",
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
}


def _classify_quality_issue(issue: SectionIssue) -> SectionIssue:
    code = issue.code.casefold()
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


def _ensure_project_cta(
    plan: ArticlePlan,
    sections: list[SectionDraft],
    pack: dict[str, Any],
) -> tuple[ArticlePlan, list[SectionDraft]]:
    project_context = _project_answer_context(plan, pack)
    assignment = _select_cta_assignment(plan.sections, pack)
    if assignment is None:
        return plan, sections
    cta_section_id, target_url = assignment
    target = next(
        (
            item
            for item in project_context["cta_targets"]
            if str(item.get("url") or "") == target_url
        ),
        None,
    )
    if target is None or not plan.sections or not sections:
        return plan, sections

    target_label = str(target.get("label") or target.get("title") or target_url)
    cta_plan = next(
        item for item in plan.sections if item.section_id == cta_section_id
    )
    updated_plan_sections = [
        item.model_copy(
            update={
                "internal_urls": _unique(
                    [*item.internal_urls, *([target_url] if item.section_id == cta_plan.section_id else [])]
                )[:10]
            }
        )
        for item in plan.sections
    ]
    updated_sections = []
    for section in sections:
        if section.section_id != cta_plan.section_id or target_url in section.markdown:
            updated_sections.append(section)
            continue
        updated_sections.append(
            section.model_copy(
                update={
                    "markdown": f"{section.markdown.rstrip()}\n\n[{target_label}]({target_url})",
                    "used_internal_urls": _unique(
                        [*section.used_internal_urls, target_url]
                    )[:20],
                }
            )
        )
    return plan.model_copy(update={"sections": updated_plan_sections}), updated_sections


_STRONG_MARKER_PATTERN = re.compile(r"(?<![\\*])\*\*(?!\*)")


def _remove_unmatched_strong_markers(markdown: str) -> tuple[str, int]:
    parts = re.split(r"(\n\s*\n)", markdown)
    removed = 0
    for index in range(0, len(parts), 2):
        paragraph = parts[index]
        matches = list(_STRONG_MARKER_PATTERN.finditer(paragraph))
        if len(matches) % 2 == 0:
            continue
        unmatched = matches[-1]
        parts[index] = (
            paragraph[: unmatched.start()] + paragraph[unmatched.end() :]
        )
        removed += 1
    return "".join(parts), removed


def _repair_generated_markdown(markdown: str) -> tuple[str, int, int]:
    repaired = 0
    fragments_removed = 0
    normalized = markdown
    mojibake_replacements = {
        "\u00e2\u0080\u0098": "'",
        "\u00e2\u0080\u0099": "'",
        "\u00e2\u0080\u009c": '"',
        "\u00e2\u0080\u009d": '"',
        "\u00e2\u0080\u0093": "-",
        "\u00e2\u0080\u0094": "-",
        "\u00e2\u0086\u0092": "->",
        "\u00c2\u00a0": " ",
    }
    for damaged, replacement in mojibake_replacements.items():
        count = normalized.count(damaged)
        if count:
            normalized = normalized.replace(damaged, replacement)
            repaired += count
    normalized, bold_repairs = re.subn(
        r"\*\*([^\n*]*?\S)\s+\*\*", r"**\1**", normalized
    )
    repaired += bold_repairs
    adjacent_repairs = 0

    def space_strong(match: re.Match[str]) -> str:
        nonlocal adjacent_repairs
        prefix = match.group("prefix") or ""
        suffix = match.group("suffix") or ""
        adjacent_repairs += bool(prefix) + bool(suffix)
        return f"{prefix}{' ' if prefix else ''}{match.group('strong')}{' ' if suffix else ''}{suffix}"

    normalized = re.sub(
        r"(?P<prefix>[A-Za-z0-9'])?(?P<strong>\*\*[^*\n]+\*\*)(?P<suffix>[A-Za-z0-9])?",
        space_strong,
        normalized,
    )
    repaired += adjacent_repairs

    lines = normalized.splitlines()
    index = 0
    while index < len(lines):
        if not _markdown_table_line(lines[index]):
            index += 1
            continue
        end = index
        while end < len(lines) and _markdown_table_line(lines[end]):
            end += 1
        block = lines[index:end]
        expected_columns = len(_markdown_table_cells(block[0]))
        if expected_columns >= 2:
            for row_index, line in enumerate(block):
                cells = _markdown_table_cells(line)
                if len(cells) == expected_columns:
                    continue
                cells = (cells + [""] * expected_columns)[:expected_columns]
                lines[index + row_index] = "| " + " | ".join(cells) + " |"
                repaired += 1
        index = end
    normalized = "\n".join(lines)
    normalized, fragments_removed = re.subn(
        r"(?i)\bFor example,\s*[a-z]\.\s*(?=(?:See|Read|Visit)\b)",
        "",
        normalized,
    )
    return normalized, repaired, fragments_removed


def _markdown_table_line(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and stripped.endswith("|") and stripped.count("|") >= 3


def _markdown_table_cells(line: str) -> list[str]:
    return [item.strip() for item in line.strip().strip("|").split("|")]


def finalize_article_artifact(
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    finalized = deepcopy(artifact)
    known_urls = {
        str(url)
        for key in ("source_urls", "internal_urls")
        for url in finalized.get(key) or []
        if url
    }
    malformed_count = 0
    markdown_repair_count = 0
    broken_fragment_count = 0
    unmatched_marker_count = 0
    sections: list[dict[str, Any]] = []
    all_urls: set[str] = set()
    internal_urls = {str(url) for url in finalized.get("internal_urls") or [] if url}
    for raw_section in finalized.get("sections") or []:
        section = dict(raw_section)
        markdown = str(section.get("markdown") or "")
        markdown, repaired, fragments_removed = _repair_generated_markdown(markdown)
        markdown_repair_count += repaired
        broken_fragment_count += fragments_removed
        markdown, markers_removed = _remove_unmatched_strong_markers(markdown)
        unmatched_marker_count += markers_removed
        markdown, removed = sanitize_markdown_links(markdown, known_urls)
        malformed_count += removed
        markdown_urls = set(_MARKDOWN_LINK_PATTERN.findall(markdown))
        all_urls.update(markdown_urls)
        section["markdown"] = markdown
        section["used_source_urls"] = sorted(markdown_urls.difference(internal_urls))
        section["used_internal_urls"] = sorted(markdown_urls.intersection(internal_urls))
        sections.append(section)
    finalized["sections"] = sections
    if sections:
        finalized["markdown"] = (
            "\n\n".join(
                str(section.get("markdown") or "").strip()
                for section in sections
                if str(section.get("markdown") or "").strip()
            )
            + "\n"
        )
    else:
        markdown, repaired, fragments_removed = _repair_generated_markdown(
            str(finalized.get("markdown") or "")
        )
        markdown_repair_count += repaired
        broken_fragment_count += fragments_removed
        markdown, markers_removed = _remove_unmatched_strong_markers(markdown)
        unmatched_marker_count += markers_removed
        finalized["markdown"], malformed_count = sanitize_markdown_links(markdown, known_urls)
        all_urls.update(_MARKDOWN_LINK_PATTERN.findall(finalized["markdown"]))
    finalized["source_urls"] = sorted(
        set(finalized.get("source_urls") or []).union(all_urls.difference(internal_urls))
    )
    if isinstance(finalized.get("document"), dict):
        document = normalize_document(finalized["document"])
        finalized["document"] = document
        finalized["markdown"] = document_to_markdown(document)
    warnings = []
    if malformed_count:
        warnings.append(
            _warning(
                "malformed_links_removed",
                "最终正文中的残缺链接已移除，并保留了可见文字",
            )
        )
    if markdown_repair_count:
        warnings.append(
            _warning("generated_markdown_repaired", "Common generated Markdown damage was repaired.")
        )
    if broken_fragment_count:
        warnings.append(
            _warning("broken_sentence_fragments_removed", "Broken sentence fragments were removed.")
        )
    if unmatched_marker_count:
        warnings.append(
            _warning(
                "unmatched_markdown_markers_removed",
                "最终正文中未配对的 Markdown 粗体标记已移除",
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
            "writing": "部分章节已生成备用稿",
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
        repairable_issues = [
            item for item in unique_issues if item.get("code") == "fallback_section"
        ]
        repair_scope = sorted(
            {
                str(item["section_id"])
                for item in repairable_issues
                if item.get("section_id")
            }
        )
        blocking_issue_codes = sorted(
            {str(item["code"]) for item in repairable_issues if item.get("code")}
        )
        artifact["quality"] = {
            **report.to_dict(),
            "passed": False,
            "check_status": "unavailable",
            "repairable": bool(repairable_issues),
            "repair_scope": repair_scope,
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
            "blocking_issue_codes": blocking_issue_codes,
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
            "repairable": artifact["quality"]["repairable"],
            "repair_scope": artifact["quality"]["repair_scope"],
            "repairable_issue_count": artifact["quality"]["repairable_issue_count"],
            "blocking_issue_codes": artifact["quality"]["blocking_issue_codes"],
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
        for item in [*_evidence_sources(pack), *list(pack.get("competitors") or [])]
        if item.get("url")
    }
    internal_urls = {
        str(item["url"])
        for item in pack.get("internal_sources", [])
        if item.get("url")
        and project_domain_matches(str(item["url"]), str((pack.get("project") or {}).get("domain") or ""))
    }
    project_domain = str((pack.get("project") or {}).get("domain") or "")
    internal_urls.update(
        str(item["url"])
        for item in _project_answer_context(None, pack)["cta_targets"]
        if item.get("url")
        and project_domain_matches(str(item["url"]), project_domain)
    )
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
