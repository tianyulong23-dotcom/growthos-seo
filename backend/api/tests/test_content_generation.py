import asyncio
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from app.core.config import Settings
from app.modules.content import generation
from app.modules.content.generation import (
    article_artifact,
    build_research_pack,
    check_article,
    plan_article,
    revise_article_sections,
    finalize_article_artifact,
    unify_article,
    write_article_sections,
)
from app.modules.content.quality import (
    ContentScorer,
    deterministic_quality_check,
    markdown_to_html,
    sanitize_markdown_links,
    sanitize_sections,
)
from app.modules.content.writing_gateway import (
    ArticlePlan,
    CriticalResearchGap,
    EvidenceClaim,
    OutlineSection,
    SectionDraft,
    SectionIssue,
    UnifiedArticle,
    VisualPlanItem,
    WritingOutputError,
    WritingRequestError,
)


POLICY = {
    "hard_budget_reached": False,
}
QUALITY_PROSE = " ".join(
    [
        "This practical explanation gives the reader enough useful context to understand the decision and take the next appropriate action."
    ]
    * 8
)


class MemoryArtifactStore:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, Any]] = {}

    async def write_json(self, key: str, payload: dict[str, Any]) -> str:
        reference = f"s3://test-bucket/{key}"
        self.objects[reference] = deepcopy(payload)
        return reference

    async def read_json(self, reference: str) -> dict[str, Any]:
        return deepcopy(self.objects[reference])


class FakeRepository:
    def __init__(self, sources: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.sources = sources or {}
        self.bound_plan: dict[str, Any] | None = None

    async def list_sources(self, _run_id: str, source_type: str) -> list[dict[str, Any]]:
        return deepcopy(self.sources.get(source_type, []))

    async def bind_plan_sources(self, _run_id: str, plan: dict[str, Any]) -> None:
        self.bound_plan = deepcopy(plan)


def source(
    url: str,
    *,
    title: str = "Source",
    status: str = "available",
    content_ref: str | None = None,
    summary: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "url": url,
        "title": title,
        "status": status,
        "content_ref": content_ref,
        "summary": summary or {},
        "metadata": metadata or {},
    }


def base_context() -> dict[str, Any]:
    return {
        "run_id": "run-1",
        "primary_keyword": "solar battery payback",
        "project_snapshot": {
            "domain": "project.example",
            "country": "US",
            "language": "en",
            "profile": {"audience": "homeowners"},
        },
        "model_snapshot": {"model": "test-model"},
        "completed_steps": {},
    }


def plan_with_sections(count: int = 2) -> ArticlePlan:
    return ArticlePlan(
        title="Solar battery payback",
        search_intent="Understand solar battery payback",
        article_type="guide",
        meta_title="Solar battery payback guide",
        meta_description="A practical guide to solar battery payback and key decisions.",
        slug="solar-battery-payback",
        sections=[
            OutlineSection(
                section_id=f"section-{index}",
                heading=f"Section {index}",
                objective=f"Explain topic {index}",
                required_questions=[f"Question {index}"],
                coverage_points=[f"Topic {index}"],
                word_target=100,
            )
            for index in range(1, count + 1)
        ],
    )


def patch_store(monkeypatch: pytest.MonkeyPatch) -> MemoryArtifactStore:
    store = MemoryArtifactStore()
    monkeypatch.setattr(generation, "artifact_store", lambda _settings: store)
    return store


def test_cancelled_model_call_is_persisted_and_reused_without_second_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0
    plan = plan_with_sections(1)

    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return SimpleNamespace(
                value=plan,
                model="test-model",
                base_url="https://model.example/v1",
                provider_request_id="request-1",
                usage={"input_tokens": 10, "output_tokens": 20},
            )

    async def scenario() -> None:
        settings = Settings(app_env="test", s3_bucket="test-bucket")
        context = {
            **base_context(),
            "step_key": "planning",
            "repair_iteration": 0,
        }
        task = asyncio.create_task(
            generation.cached_generate(
                Gateway(),
                settings,
                context,
                "plan_article",
                {"research_pack": {"keyword": "solar battery payback"}},
                ArticlePlan,
            )
        )
        await started.wait()
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

        cached = await generation.cached_generate(
            Gateway(),
            settings,
            context,
            "plan_article",
            {"research_pack": {"keyword": "solar battery payback"}},
            ArticlePlan,
        )
        assert cached.value == plan
        assert cached.provider_request_id == "request-1"

    asyncio.run(scenario())

    assert calls == 1
    assert len(store.objects) == 1


def test_planning_saves_complete_pack_and_binds_normalized_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    authority_url = "https://authority.example/fact"
    internal_url = "https://project.example/guide"
    repo = FakeRepository(
        {
            "serp": [
                source(
                    "serp://google/run-1",
                    summary={
                        "organic_results": [
                            {
                                "url": "https://competitor.example/a",
                                "title": "How to Calculate Solar Battery Payback",
                            }
                        ],
                        "people_also_ask": ["How long is payback?"],
                        "related_searches": ["solar battery savings"],
                    },
                )
            ],
            "authority": [
                source(
                    authority_url,
                    summary={
                        "research_claim": "The model proposed this fact.",
                        "research_excerpt": "Verified fact",
                        "verification_claims": [
                            {
                                "claim": "The model proposed this fact.",
                                "status": "verified",
                                "evidence": "Verified fact",
                            }
                        ],
                    },
                    metadata={
                        "source": "web_research",
                        "provider": "responses",
                        "model": "research-model",
                        "queries": ["official facts"],
                        "failed_queries": ["current prices"],
                        "cached": True,
                        "source_tier": "tier_1_official_public_or_standards",
                        "verification_status": "verified",
                        "verification_method": "page_text_match_v1",
                        "verified_url": authority_url,
                        "echo_cluster_id": "source-1",
                        "independent_source": True,
                    },
                )
            ],
        }
    )
    planned = ArticlePlan(
        title="Solar battery payback",
        search_intent="Compare cost and savings",
        article_type="guide",
        meta_title="Solar battery payback guide",
        meta_description="Understand cost, savings, and the practical payback process.",
        slug="Solar Battery Payback",
        claims=[
            EvidenceClaim(
                claim_id="model-claim",
                claim="Verified fact",
                source_url=authority_url,
                quote="Verified fact",
            ),
            EvidenceClaim(
                claim_id="invented",
                claim="Unsupported",
                source_url="https://invented.example/fact",
            ),
        ],
        sections=[
            OutlineSection(
                section_id="model-section",
                heading="Costs and savings",
                objective="Explain the tradeoff",
                required_questions=["How long is payback?"],
                claim_ids=["model-claim", "invented"],
                internal_urls=[internal_url, "https://other.example/page"],
                coverage_points=["Cost", "Savings"],
            )
        ],
    )

    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            return SimpleNamespace(value=planned, usage={"input_tokens": 10})

    repo.sources["internal"] = [
        source(
            internal_url,
            title="Solar battery cost and savings guide",
            summary={
                "description": "Compare solar battery cost, savings, and payback",
                "candidate_kind": "published_article",
                "selection_score": 22,
            },
        )
    ]
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())

    result = asyncio.run(
        plan_article(repo, Settings(app_env="test"), base_context(), POLICY)
    )
    artifact = store.objects[result["output_ref"]]
    pack = store.objects[artifact["research_pack_ref"]]

    assert pack["keyword"] == "solar battery payback"
    assert pack["country"] == "US"
    assert pack["language"] == "en"
    assert pack["required_questions"] == [
        "How long is payback?",
        "solar battery savings",
    ]
    assert pack["search_intent"] == "Compare cost and savings"
    assert pack["article_type"] == "guide"
    assert pack["authority_sources"][0]["url"] == authority_url
    assert pack["authority_sources"][0]["excerpt"] == "Verified fact"
    assert pack["authority_sources"][0] == {
        "url": authority_url,
        "title": "Source",
        "excerpt": "Verified fact",
        "research_answer": "",
        "citation_excerpt": "",
        "research_claim": "The model proposed this fact.",
        "provider": "responses",
        "model": "research-model",
        "queries": ["official facts"],
        "failed_queries": ["current prices"],
        "cached": True,
        "verification_claims": [
            {
                "claim": "The model proposed this fact.",
                "status": "verified",
                "evidence": "Verified fact",
            }
        ],
    }
    assert pack["internal_sources"][0]["url"] == internal_url
    assert repo.bound_plan is not None
    assert repo.bound_plan["claims"][0]["claim_id"] == "claim-1"
    assert repo.bound_plan["claims"][0]["section_id"] == "section-1"
    assert repo.bound_plan["sections"][0]["claim_ids"] == [
        "claim-1",
        "claim-2",
        "claim-3",
    ]
    assert repo.bound_plan["sections"][0]["internal_urls"] == [
        internal_url,
        "https://other.example/page",
    ]


def unified_for_plan(
    plan: ArticlePlan, marker: str = "Complete article prose"
) -> UnifiedArticle:
    return UnifiedArticle(
        title=plan.title,
        meta_title=plan.meta_title,
        meta_description=plan.meta_description,
        slug=plan.slug,
        sections=[
            SectionDraft(
                section_id=section.section_id,
                markdown=f"## {section.heading}\n\n{marker} for {section.section_id}.",
                summary=f"{marker} summary for {section.section_id}",
            )
            for section in plan.sections
        ],
    )


def test_critical_research_tasks_use_only_explicit_plan_gaps_and_cap_batch() -> None:
    plan = plan_with_sections(1).model_copy(
        update={
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information=f"Missing information {index}",
                    why_it_blocks_core_answer="The core answer depends on it.",
                    research_query=f"Research complete topic {index}",
                )
                for index in range(1, 6)
            ]
        }
    )

    assert generation._critical_research_tasks(plan) == [
        "Research complete topic 1",
        "Research complete topic 2",
        "Research complete topic 3",
        "Research complete topic 4",
    ]


def test_full_article_payload_excludes_internal_research_gap_decision() -> None:
    plan = plan_with_sections(1).model_copy(
        update={
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information="Missing core fact",
                    why_it_blocks_core_answer="The answer depends on it.",
                    research_query="Research the missing core fact",
                )
            ],
            "visuals": [
                VisualPlanItem(
                    visual_id="visual-original",
                    section_id="section-1",
                    reader_job="explain",
                    source_strategy="project_asset",
                    title="Payback inputs",
                    alt_instruction="Explain the inputs shown in the image.",
                )
            ],
        }
    )
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "country": "US",
        "project": {},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation._full_article_writing_payload(plan, pack)

    assert "critical_research_gaps" not in payload["article_plan"]
    assert "visuals" not in payload["article_plan"]


def test_normalize_plan_keeps_only_safe_section_bound_visuals() -> None:
    sections = [
        OutlineSection(
            section_id=f"original-{index}",
            heading=f"Section {index}",
            objective=f"Explain topic {index}",
            word_target=100,
        )
        for index in range(1, 5)
    ]
    claim = EvidenceClaim(
        claim_id="original-claim",
        claim="The measured result is 42 units.",
        source_url="https://source.example/result",
        quote="The measured result is 42 units.",
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "sections": sections,
            "claims": [claim],
            "visuals": [
                VisualPlanItem(
                    visual_id="project-image",
                    section_id="original-1",
                    reader_job="demonstrate",
                    source_strategy="project_asset",
                    required=True,
                    title="Project example",
                    alt_instruction="Show the project example.",
                ),
                VisualPlanItem(
                    visual_id="same-section-image",
                    section_id="original-1",
                    reader_job="orient",
                    source_strategy="stock",
                    title="Duplicate section image",
                    alt_instruction="Show another image in the same section.",
                ),
                VisualPlanItem(
                    visual_id="ai-proof",
                    section_id="original-2",
                    reader_job="prove",
                    source_strategy="ai",
                    title="Generated proof",
                    alt_instruction="Prove the factual claim.",
                ),
                VisualPlanItem(
                    visual_id="chart-without-data",
                    section_id="original-3",
                    reader_job="compare",
                    source_strategy="chart",
                    title="Unsupported chart",
                    alt_instruction="Compare the unsupported values.",
                ),
                VisualPlanItem(
                    visual_id="chart-with-data",
                    section_id="original-4",
                    reader_job="compare",
                    source_strategy="chart",
                        title="Supported chart",
                        alt_instruction="Compare the measured result.",
                        data_claim_ids=["original-claim"],
                        chart_data=[
                            {
                                "label": "Measured result",
                                "value": 42,
                                "unit": " units",
                                "claim_id": "original-claim",
                            }
                        ],
                    ),
            ],
        }
    )
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {},
        "authority_sources": [
            {
                "url": "https://source.example/result",
                "title": "Measurement report",
            }
        ],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    assert [item.visual_id for item in normalized.visuals] == [
        "visual-1",
        "visual-2",
    ]
    assert [item.section_id for item in normalized.visuals] == [
        "section-1",
        "section-4",
    ]
    assert all(item.required is False for item in normalized.visuals)
    assert normalized.visuals[1].data_claim_ids == ["claim-1"]
    assert normalized.visuals[1].chart_data[0].claim_id == "claim-1"


def test_article_quality_guidance_prioritizes_scope_example_and_substantive_editing() -> None:
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "country": "US",
        "project": {},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    brief = generation._article_writing_brief(pack)
    writing = generation._full_article_writing_payload(plan, pack)
    editing = generation._full_article_editing_payload(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown="## Section 1\n\nComplete draft prose.",
            )
        ],
        pack,
    )

    assert "one primary reader question" in brief["scope_control"]
    assert "distinct job" in brief["scope_control"]
    assert "end-to-end worked example" in brief["worked_example"]
    assert "complete the task or make the decision" in writing["quality_target"][
        "reader_outcome"
    ]
    assert any("caveat once" in item for item in writing["instructions"])
    assert any(
        "strongest occurrence of a repeated point" in item
        for item in editing["editorial_priorities"]
    )
    assert any(
        "shorter article with distinct reader value" in item
        for item in editing["editorial_priorities"]
    )
    assert any(
        "do not limit the pass to copyediting" in item
        for item in editing["editing_rules"]
    )


def test_planning_receives_complete_plan_input_and_preserves_locked_title(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    repo = FakeRepository(
        {
            "serp": [
                source(
                    "serp://content-plan/serp-1",
                    summary={
                        "keyword": "content planning",
                        "organic_results": [],
                        "people_also_ask": [],
                        "related_searches": [],
                        "features": [],
                    },
                )
            ]
        }
    )
    context = {
        **base_context(),
        "primary_keyword": "content planning",
        "plan_input": {
            "secondary_keywords": [
                {"keyword": "editorial calendar", "type": "supporting"},
                {"keyword": "content workflow", "type": "supporting"},
            ],
            "title": {"value": "Locked Content Plan Title", "policy": "locked"},
            "writing_direction": {
                "value": "Explain the workflow with one complete worked example.",
                "policy": "locked",
            },
        },
    }
    received_payload: dict[str, Any] = {}

    async def generate(
        _gateway: Any,
        _settings: Settings,
        _context: dict[str, Any],
        call: str,
        payload: dict[str, Any],
        _output: Any,
    ) -> Any:
        assert call == "plan_article"
        received_payload.update(deepcopy(payload))
        return SimpleNamespace(
            value=plan_with_sections(1).model_copy(update={"title": "Model Rewritten Title"}),
            usage={"input_tokens": 10, "output_tokens": 20},
        )

    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(repo, Settings(app_env="test"), context, POLICY)
    )
    artifact = store.objects[result["output_ref"]]
    pack = received_payload["research_pack"]

    assert pack["planned_title"] == {
        "value": "Locked Content Plan Title",
        "policy": "locked",
    }
    assert pack["writing_direction"] == {
        "value": "Explain the workflow with one complete worked example.",
        "policy": "locked",
    }
    assert pack["secondary_keywords"] == [
        {"keyword": "editorial calendar", "type": "supporting"},
        {"keyword": "content workflow", "type": "supporting"},
    ]
    assert "content_brief" not in pack
    assert "dominant_content_type" not in json.dumps(pack)
    assert artifact["plan"]["title"] == "Locked Content Plan Title"
    assert generation.fallback_plan(pack).title == "Locked Content Plan Title"


def test_critical_research_rebuilds_pack_after_one_planning_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    authority_url = "https://irs.gov/solar-credit"
    initial_pack = {
        "keyword": "solar battery tax credit",
        "country": "US",
        "language": "en",
        "project": {},
        "questions": ["What is a solar battery?"],
        "required_questions": ["What is a solar battery?"],
        "competitors": [],
        "authority_sources": [],
        "internal_sources": [],
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "content_brief": {},
    }
    supplemented_pack = deepcopy(initial_pack)
    supplemented_pack["authority_sources"] = [
        {
            "url": authority_url,
            "title": "Official solar credit rules",
            "excerpt": "Eligible battery storage technology qualifies under current rules.",
        }
    ]
    section = plan_with_sections(1).sections[0].model_copy(
        update={
            "heading": "Current federal tax credit rules",
            "objective": "Explain current federal tax credit eligibility",
            "data_requirements": ["current federal tax credit rules"],
            "claim_ids": ["model-claim"],
        }
    )
    planned = plan_with_sections(1).model_copy(
        update={
            "sections": [section],
            "claims": [
                EvidenceClaim(
                    claim_id="model-claim",
                    claim="Eligible battery storage technology qualifies.",
                    source_url=authority_url,
                    quote="Eligible battery storage technology qualifies under current rules.",
                )
            ],
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information="Current federal tax credit eligibility",
                    why_it_blocks_core_answer="The reader cannot determine eligibility without it.",
                    research_query=(
                        "Research current US federal solar battery tax credit "
                        "eligibility as one complete task"
                    ),
                )
            ],
        }
    )
    packs = iter([initial_pack, supplemented_pack])
    pack_calls = 0
    research_queries: list[str] = []
    events: list[str] = []
    planning_payload: dict[str, Any] = {}

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal pack_calls
        pack_calls += 1
        return deepcopy(next(packs))

    async def collect_research(
        _repo: Any,
        _settings: Settings,
        _run_id: str,
        _keyword: str,
        _snapshot: dict[str, Any],
        exact_questions: list[str],
        model_snapshot: dict[str, Any],
    ) -> tuple[None, int]:
        events.append("research")
        research_queries.extend(exact_questions)
        assert model_snapshot == {"model": "test-model"}
        return None, 1

    async def generate(
        _gateway: Any,
        _settings: Settings,
        _context: dict[str, Any],
        _call: str,
        payload: dict[str, Any],
        _output: Any,
    ) -> Any:
        events.append("plan")
        planning_payload.update(deepcopy(payload))
        return SimpleNamespace(value=planned, usage={"input_tokens": 10})

    repo = FakeRepository()
    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "_collect_research", collect_research)
    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(repo, Settings(app_env="test"), base_context(), POLICY)
    )
    artifact = store.objects[result["output_ref"]]

    assert pack_calls == 2
    assert research_queries == [
        "Research current US federal solar battery tax credit eligibility as one complete task"
    ]
    assert "What is a solar battery?" not in research_queries
    assert events == ["plan", "research"]
    assert planning_payload["research_pack"]["research_sources"] == []
    assert planning_payload["writing_brief"]["reader_task"] == (
        "Help a reader in US resolve the practical question behind "
        "'solar battery tax credit'."
    )
    assert artifact["plan"]["claims"][0]["source_url"] == authority_url
    assert result["warnings"] == []


def test_supplemental_research_failure_keeps_planning_successful(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    pack = {
        "keyword": "solar battery tax credit",
        "country": "US",
        "language": "en",
        "project": {},
        "questions": [],
        "required_questions": [],
        "competitors": [],
        "authority_sources": [],
        "internal_sources": [],
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "content_brief": {},
    }
    planned = plan_with_sections(1).model_copy(
        update={
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"data_requirements": ["current federal tax credit rules"]}
                )
            ],
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information="Current federal tax credit eligibility",
                    why_it_blocks_core_answer="The reader cannot determine eligibility without it.",
                    research_query="Research current US federal solar battery tax credit eligibility",
                )
            ],
        }
    )
    pack_calls = 0

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal pack_calls
        pack_calls += 1
        return deepcopy(pack)

    async def collect_research(*_: Any, **__: Any) -> tuple[None, int]:
        raise RuntimeError("research provider unavailable")

    async def generate(*_: Any, **__: Any) -> Any:
        return SimpleNamespace(value=planned, usage={})

    repo = FakeRepository()
    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "_collect_research", collect_research)
    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(repo, Settings(app_env="test"), base_context(), POLICY)
    )

    assert pack_calls == 1
    assert store.objects[result["output_ref"]]["plan"]["sections"]
    assert [item["code"] for item in result["warnings"]] == [
        "supplemental_research_degraded"
    ]


def test_planning_preserves_model_claims_without_source_quote_filtering() -> None:
    first_url = "https://authority.example/first"
    second_url = "https://authority.example/second"
    pack = {
        "keyword": "solar battery",
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "authority_sources": [
            {"url": first_url, "title": "First", "excerpt": "Warranty is ten years."},
            {"url": second_url, "title": "Second", "excerpt": "Cycle limits vary."},
        ],
        "competitors": [],
        "internal_sources": [],
    }
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="cross-bound",
                    claim="Warranty is ten years",
                    source_url=second_url,
                    quote="Warranty is ten years.",
                ),
                EvidenceClaim(
                    claim_id="correct",
                    claim="Cycle limits vary",
                    source_url=second_url,
                    quote="Cycle limits vary.",
                ),
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["cross-bound", "correct"]}
                )
            ],
        }
    )

    normalized = generation.normalize_plan(plan, pack)

    assert [claim.claim for claim in normalized.claims] == [
        "Warranty is ten years",
        "Cycle limits vary",
    ]
    assert normalized.sections[0].claim_ids == ["claim-1", "claim-2"]


def test_planning_preserves_model_claim_without_contradiction_filtering() -> None:
    authority_url = "https://authority.example/warranty"
    quote = "The warranty covers installation labor."
    pack = {
        "keyword": "battery warranty",
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "authority_sources": [
            {"url": authority_url, "title": "Warranty", "excerpt": quote}
        ],
        "competitors": [],
        "internal_sources": [],
    }
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="contradiction",
                    claim="The warranty does not cover installation labor.",
                    source_url=authority_url,
                    quote=quote,
                )
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["contradiction"]}
                )
            ],
        }
    )

    normalized = generation.normalize_plan(plan, pack)

    assert [claim.claim for claim in normalized.claims] == [
        "The warranty does not cover installation labor."
    ]
    assert normalized.sections[0].claim_ids == ["claim-1"]


def test_planning_preserves_claim_not_assigned_to_any_section() -> None:
    authority_url = "https://authority.example/fact"
    pack = {
        "keyword": "solar battery",
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "authority_sources": [
            {
                "url": authority_url,
                "title": "Source",
                "excerpt": "Battery warranties commonly cover ten years.",
            }
        ],
        "competitors": [],
        "internal_sources": [],
    }
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="unassigned",
                    claim="Battery warranties commonly cover ten years.",
                    source_url=authority_url,
                    quote="Battery warranties commonly cover ten years.",
                )
            ]
        }
    )

    normalized = generation.normalize_plan(plan, pack)

    assert [claim.claim for claim in normalized.claims] == [
        "Battery warranties commonly cover ten years."
    ]
    assert normalized.claims[0].section_id is None


def test_explicit_non_independent_source_remains_available_to_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_url = "https://news.example/repeated-report"
    repo = FakeRepository(
        {
            "authority": [
                source(
                    source_url,
                    summary={"research_excerpt": "A repeated downstream claim."},
                    metadata={
                        "source": "web_research",
                        "verification_status": "verified",
                        "independent_source": False,
                    },
                )
            ]
        }
    )

    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(generation, "_source_summaries", no_summaries)
    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )

    assert [item["url"] for item in pack["authority_sources"]] == [source_url]


def test_legacy_authority_source_remains_available_to_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeRepository(
        {
            "authority": [
                source(
                    "https://legacy.example/unverified",
                    summary={"research_excerpt": "An unverified legacy excerpt."},
                )
            ],
            "research": [
                source(
                    "https://legacy.example/research-type",
                    summary={"research_excerpt": "A legacy research record."},
                    metadata={
                        "source": "web_research",
                        "verification_status": "verified",
                        "independent_source": True,
                    },
                )
            ],
        }
    )

    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(generation, "_source_summaries", no_summaries)
    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )

    assert [item["url"] for item in pack["authority_sources"]] == [
        "https://legacy.example/unverified"
    ]


def test_unreachable_research_source_remains_available_as_citation_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeRepository(
        {
            "authority": [
                source(
                    "https://authority.example/unreachable",
                    status="available",
                    summary={
                        "citation_excerpt": "A model-returned exact quote.",
                        "research_claim": "A model-returned claim.",
                    },
                    metadata={
                        "source": "web_research",
                        "verification_status": "unreachable",
                        "verification_method": "crawler_page_unavailable_v1",
                        "independent_source": False,
                    },
                )
            ]
        }
    )

    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(generation, "_source_summaries", no_summaries)
    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )

    assert "verification_status" not in pack["authority_sources"][0]
    assert pack["authority_sources"][0]["excerpt"] == "A model-returned exact quote."
    assert pack["authority_sources"][0]["research_claim"] == "A model-returned claim."


def test_supplemental_research_does_not_retry_as_separate_problem_queries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_store(monkeypatch)
    initial_pack = {
        "keyword": "ExampleTV download",
        "country": "US",
        "language": "en",
        "project": {
            "profile": {
                "business_name": "ExampleTV",
                "products_services": ["Streaming application"],
                "conversion_actions": ["Download ExampleTV"],
                "key_pages": [
                    {
                        "url": "https://example.com/download",
                        "title": "Download ExampleTV",
                        "description": "Official download page",
                    }
                ],
            }
        },
        "questions": [],
        "required_questions": [],
        "competitors": [],
        "authority_sources": [],
        "internal_sources": [],
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "content_brief": {},
    }
    planned = plan_with_sections(1).model_copy(
        update={
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"data_requirements": ["current official download instructions"]}
                )
            ],
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information="Current official download instructions",
                    why_it_blocks_core_answer="The reader cannot complete the requested download without them.",
                    research_query=(
                        "Research the current official ExampleTV download instructions "
                        "as one complete task"
                    ),
                )
            ],
        }
    )
    query_rounds: list[list[str]] = []

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        return deepcopy(initial_pack)

    async def collect_research(
        _repo: Any,
        _settings: Settings,
        _run_id: str,
        _keyword: str,
        _snapshot: dict[str, Any],
        exact_questions: list[str],
        model_snapshot: dict[str, Any],
    ) -> tuple[str | None, int]:
        del model_snapshot
        query_rounds.append(exact_questions)
        return "research_unavailable", 0

    async def generate(*_: Any, **__: Any) -> Any:
        return SimpleNamespace(value=planned, usage={})

    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "_collect_research", collect_research)
    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(FakeRepository(), Settings(app_env="test"), base_context(), POLICY)
    )

    assert len(query_rounds) == 1
    assert query_rounds[0] == [
        "Research the current official ExampleTV download instructions as one complete task"
    ]
    assert [item["code"] for item in result["warnings"]] == [
        "supplemental_research_degraded"
    ]


def test_plan_without_critical_gaps_does_not_trigger_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_store(monkeypatch)
    initial_pack = {
        "keyword": "streaming application",
        "country": "US",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "products_services": ["Streaming application"],
            },
        },
        "questions": [],
        "required_questions": [],
        "competitors": [],
        "authority_sources": [],
        "internal_sources": [],
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "content_brief": {},
    }
    planned = plan_with_sections(1)
    query_rounds: list[list[str]] = []
    pack_calls = 0

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal pack_calls
        pack_calls += 1
        return deepcopy(initial_pack)

    async def collect_research(
        _repo: Any,
        _settings: Settings,
        _run_id: str,
        _keyword: str,
        _snapshot: dict[str, Any],
        exact_questions: list[str],
        model_snapshot: dict[str, Any],
    ) -> tuple[str | None, int]:
        del model_snapshot
        query_rounds.append(exact_questions)
        return None, 1

    async def generate(*_: Any, **__: Any) -> Any:
        return SimpleNamespace(value=planned, usage={})

    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "_collect_research", collect_research)
    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(FakeRepository(), Settings(app_env="test"), base_context(), POLICY)
    )

    assert pack_calls == 1
    assert query_rounds == []
    assert result["warnings"] == []


def test_research_pack_preserves_all_research_content_and_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_url = "https://agency.gov/report"
    verified_claim = "The survey included 2,000 households."
    rejected_claim = "The survey guaranteed a 90 percent outcome."
    page_evidence = "The 2025 survey included 2,000 households."
    repo = FakeRepository(
        {
            "authority": [
                source(
                    source_url,
                    summary={
                        "research_answer": f"{verified_claim} {rejected_claim}",
                        "citation_excerpt": "A model-returned candidate passage.",
                        "research_claim": f"{verified_claim}\n{rejected_claim}",
                        "research_excerpt": page_evidence,
                        "verification_claims": [
                            {
                                "claim": verified_claim,
                                "status": "verified",
                                "evidence": page_evidence,
                            },
                            {
                                "claim": rejected_claim,
                                "status": "not_found",
                                "evidence": "",
                            },
                        ],
                    },
                    metadata={
                        "source": "web_research",
                        "verification_status": "verified",
                        "independent_source": True,
                    },
                )
            ]
        }
    )

    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(generation, "_source_summaries", no_summaries)
    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )
    authority = pack["authority_sources"][0]

    assert authority["excerpt"] == page_evidence
    assert authority["research_claim"] == f"{verified_claim}\n{rejected_claim}"
    assert authority["research_answer"] == f"{verified_claim} {rejected_claim}"
    assert authority["citation_excerpt"] == "A model-returned candidate passage."
    assert authority["verification_claims"] == [
        {
            "claim": verified_claim,
            "status": "verified",
            "evidence": page_evidence,
        },
        {
            "claim": rejected_claim,
            "status": "not_found",
            "evidence": "",
        },
    ]
    assert rejected_claim in json.dumps(authority)


def test_echo_duplicate_remains_available_and_model_claims_are_preserved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    verified_url = "https://agency.gov/original-report"
    echo_url = "https://news.example/repeated-report"
    repo = FakeRepository(
        {
            "authority": [
                source(
                    verified_url,
                    summary={"research_excerpt": "The survey included 2,000 households."},
                    metadata={
                        "source": "web_research",
                        "verification_status": "verified",
                    },
                ),
                source(
                    echo_url,
                    summary={"research_excerpt": "The survey included 2,000 households."},
                    metadata={
                        "source": "web_research",
                        "verification_status": "echo_duplicate",
                        "echo_cluster_id": "echo-1",
                    },
                ),
            ]
        }
    )

    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(generation, "_source_summaries", no_summaries)
    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="original",
                    claim="The survey included 2,000 households.",
                    source_url=verified_url,
                    quote="The survey included 2,000 households.",
                ),
                EvidenceClaim(
                    claim_id="echo",
                    claim="A second outlet repeated the same survey result.",
                    source_url=echo_url,
                    quote="The survey included 2,000 households.",
                ),
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["original", "echo"]}
                )
            ],
        }
    )

    normalized = generation.normalize_plan(plan, pack)

    assert [item["url"] for item in pack["authority_sources"]] == [
        verified_url,
        echo_url,
    ]
    assert [claim.source_url for claim in normalized.claims] == [verified_url, echo_url]
    assert normalized.sections[0].claim_ids == ["claim-1", "claim-2"]


def test_full_article_missing_a_planned_section_fails_instead_of_using_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections()
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    pack_ref = asyncio.run(store.write_json("pack.json.gz", pack))
    plan_ref = asyncio.run(
        store.write_json(
            "plan.json.gz",
            {"kind": "article_plan", "research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    context = base_context()
    context["completed_steps"] = {"planning": {"output_ref": plan_ref}}
    calls: list[tuple[str, dict[str, Any]]] = []

    class Gateway:
        async def generate(self, call: str, payload: dict[str, Any], _output: Any) -> Any:
            calls.append((call, deepcopy(payload)))
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[unified_for_plan(plan).sections[0]],
                ),
                usage={"input_tokens": 5, "output_tokens": 10},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    with pytest.raises(WritingOutputError, match="complete_article_missing_sections"):
        asyncio.run(
            write_article_sections(
                FakeRepository(), Settings(app_env="test"), context, POLICY
            )
        )

    assert len(calls) == 1
    assert calls[0][0] == "unify_article"
    assert [item["section_id"] for item in calls[0][1]["article_plan"]["sections"]] == [
        "section-1",
        "section-2",
    ]


def test_edit_check_and_revision_failures_keep_complete_article(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "questions": [],
        "required_questions": [],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1",
        markdown=f"## Section 1\n\nA complete useful answer. {QUALITY_PROSE}",
    )
    pack_ref = asyncio.run(store.write_json("pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    writing_ref = asyncio.run(
        store.write_json(
            "draft.json.gz",
            generation.article_artifact(plan, [section], pack),
        )
    )

    class FailingGateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise RuntimeError("model unavailable")

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: FailingGateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "writing": {"output_ref": writing_ref},
    }
    edited = asyncio.run(
        unify_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    assert edited["warning"]["code"] == "editing_degraded"
    assert "A complete useful answer." in store.objects[edited["output_ref"]]["markdown"]

    context["completed_steps"]["editing"] = {"output_ref": edited["output_ref"]}
    checked = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    assert checked["warnings"] == []
    assert "A complete useful answer." in store.objects[checked["output_ref"]]["markdown"]
    assert checked["summary"]["passed"] is True
    assert checked["summary"]["check_status"] == "completed"
    assert checked["summary"]["repairable"] is False
    assert checked["summary"]["model_failure"] is None
    assert store.objects[checked["output_ref"]]["quality"]["issues"] == []

    checked_artifact = store.objects[checked["output_ref"]]
    checked_artifact["quality"]["issues"] = [
        {"section_id": "section-1", "code": "empty_prose", "message": "Improve it"}
    ]
    checked_artifact["quality"]["check_status"] = "completed"
    checked_artifact["quality"]["repairable"] = True
    checked_artifact["quality"]["repair_scope"] = ["section-1"]
    checked_ref = asyncio.run(store.write_json("checked-with-issue.json.gz", checked_artifact))
    context["completed_steps"]["checking"] = {"output_ref": checked_ref}
    revised = asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    assert [item["code"] for item in revised["warnings"]] == ["revising_degraded"]
    assert "A complete useful answer." in store.objects[revised["output_ref"]]["markdown"]


def test_check_marks_fallback_sections_as_repairable_and_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "questions": [],
        "required_questions": [],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = generation.fallback_section(plan.sections[0], "en", pack, plan)
    pack_ref = asyncio.run(store.write_json("fallback-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "fallback-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    editing_ref = asyncio.run(
        store.write_json(
            "fallback-article.json.gz",
            generation.article_artifact(
                plan,
                [section],
                pack,
                degraded_section_ids=["section-1"],
            ),
        )
    )
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    checked = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )

    assert checked["summary"]["passed"] is False
    assert checked["summary"]["repairable"] is True
    assert checked["summary"]["repair_scope"] == ["section-1"]
    assert checked["summary"]["blocking_issue_codes"] == ["fallback_section"]


def test_empty_revision_result_keeps_issue_and_reports_no_revised_section(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "required_questions": [],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1",
        markdown=f"## Section 1\n\nA complete useful answer. {QUALITY_PROSE}",
    )
    pack_ref = asyncio.run(store.write_json("pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    checked = generation.article_artifact(plan, [section], pack)
    checked["quality"] = {
        "passed": False,
        "issues": [
            {"section_id": "section-1", "code": "empty_prose", "message": "Improve it"}
        ],
    }
    checked_ref = asyncio.run(store.write_json("checked.json.gz", checked))

    class EmptyRevisionGateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            return SimpleNamespace(
                value=generation.RevisedSections(sections=[]),
                usage={"input_tokens": 5, "output_tokens": 1},
            )

    monkeypatch.setattr(
        generation, "writing_gateway", lambda _context: EmptyRevisionGateway()
    )
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "checking": {"output_ref": checked_ref},
    }

    result = asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert result["summary"] == {
        "revised_sections": 0,
        "passed": False,
        "model_failure": {
            "code": "writing_revision_empty",
            "attempts": 0,
            "format_attempts": 0,
        },
    }
    assert [item["code"] for item in result["warnings"]] == ["revising_degraded"]
    assert artifact["quality"]["issues"][0]["code"] == "empty_prose"
    assert "A complete useful answer." in artifact["markdown"]


def test_check_does_not_send_required_questions_to_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "questions": ["Required question", "Optional question"],
        "required_questions": ["Required question"],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1",
        markdown=f"## Section 1\n\nA complete useful answer. {QUALITY_PROSE}",
    )
    pack_ref = asyncio.run(store.write_json("pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    editing_ref = asyncio.run(
        store.write_json(
            "article.json.gz",
            generation.article_artifact(plan, [section], pack),
        )
    )
    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("checking must not call the writing model")

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    result = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )

    assert result["summary"]["passed"] is True
    assert result["usage"] is None


def test_check_does_not_send_locked_writing_direction_to_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    requirement = "Explain the workflow with one complete worked example."
    pack = {
        "keyword": "content planning",
        "language": "en",
        "questions": [],
        "required_questions": [],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
        "writing_direction": {"value": requirement, "policy": "locked"},
    }
    section = SectionDraft(
        section_id="section-1",
        markdown=f"## Section 1\n\nA complete useful answer. {QUALITY_PROSE}",
    )
    pack_ref = asyncio.run(store.write_json("locked-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "locked-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    editing_ref = asyncio.run(
        store.write_json(
            "locked-article.json.gz",
            generation.article_artifact(plan, [section], pack),
        )
    )
    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("checking must not call the writing model")

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    result = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    artifact = store.objects[result["output_ref"]]

    assert artifact["quality"]["locked_requirement_checks"] == []
    assert result["summary"]["passed"] is True
    assert result["usage"] is None


def test_check_and_revision_do_not_receive_explicit_section_checklists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    base_plan = plan_with_sections(2)
    plan = base_plan.model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="Comparison fact",
                    source_url="https://authority.example/comparison",
                    section_id="section-1",
                ),
                EvidenceClaim(
                    claim_id="claim-2",
                    claim="Explanation fact",
                    source_url="https://authority.example/explanation",
                    section_id="section-2",
                ),
            ],
            "sections": [
                base_plan.sections[0].model_copy(
                    update={
                        "section_type": "body_comparison",
                        "cta_type": "soft",
                        "claim_ids": ["claim-1"],
                    }
                ),
                base_plan.sections[1].model_copy(
                    update={
                        "section_type": "body_explanation",
                        "claim_ids": ["claim-2"],
                    }
                ),
            ]
        }
    )
    pack = {
        "keyword": "solar battery comparison",
        "language": "en",
        "required_questions": [],
        "project": {
            "domain": "project.example",
            "profile": {"conversion_actions": ["Start a free assessment"]},
        },
        "authority_sources": [
            {"url": "https://authority.example/comparison"},
            {"url": "https://authority.example/explanation"},
        ],
        "competitors": [],
        "internal_sources": [],
    }
    sections = [
        SectionDraft(
            section_id=item.section_id,
            markdown=f"## {item.heading}\n\nA complete useful answer. {QUALITY_PROSE}",
        )
        for item in plan.sections
    ]
    pack_ref = asyncio.run(store.write_json("pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    editing_ref = asyncio.run(
        store.write_json(
            "article.json.gz", generation.article_artifact(plan, sections, pack)
        )
    )
    payloads: dict[str, dict[str, Any]] = {}

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            assert call == "revise_sections"
            payloads[call] = payload
            return SimpleNamespace(
                value=generation.RevisedSections(sections=[sections[0]]),
                usage={"input_tokens": 5, "output_tokens": 1},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    checked = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    checked_artifact = store.objects[checked["output_ref"]]
    checked_artifact["quality"].update(
        {
            "passed": False,
            "repairable": True,
            "repair_scope": ["section-1"],
            "issues": [
                {
                    "section_id": "section-1",
                    "code": "comparison_criteria_missing",
                    "message": "Add decision criteria",
                    "category": "prose",
                    "repairable": True,
                }
            ],
        }
    )
    checked_ref = asyncio.run(store.write_json("checked.json.gz", checked_artifact))
    context["completed_steps"]["checking"] = {"output_ref": checked_ref}
    asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )

    assert [item["section_id"] for item in payloads["revise_sections"]["section_goals"]] == [
        "section-1"
    ]
    assert [item["claim_id"] for item in payloads["revise_sections"]["claims"]] == [
        "claim-1"
    ]
    assert "official_product" not in payloads["revise_sections"]
    assert payloads["revise_sections"]["section_goals"][0]["official_product"] == {
        "conversion_actions": [],
        "cta_targets": [],
    }
    assert not {
        "issues",
        "section_requirements",
        "article_contract",
        "section_contracts",
        "locked_requirements",
    }.intersection(payloads["revise_sections"])


def test_check_does_not_infer_semantic_question_issues_with_a_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "required_questions": ["How long is solar battery payback?"],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\nA useful answer about installation choices. "
            f"{QUALITY_PROSE}"
        ),
    )
    pack_ref = asyncio.run(store.write_json("pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    editing_ref = asyncio.run(
        store.write_json(
            "article.json.gz", generation.article_artifact(plan, [section], pack)
        )
    )

    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("checking must not call the writing model")

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    result = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    artifact = store.objects[result["output_ref"]]

    assert result["summary"]["issue_count"] == 0
    assert result["summary"]["passed"] is True
    assert result["summary"]["repairable"] is False
    assert result["summary"]["model_failure"] is None
    assert artifact["quality"]["issues"] == []
    assert artifact["quality"]["locked_requirement_checks"] == []


def test_sanitizer_preserves_generated_claims_and_unknown_links() -> None:
    authority_url = "https://authority.example/fact"
    internal_url = "https://project.example/guide"
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="Battery life is 10 years",
                    source_url=authority_url,
                    section_id="section-1",
                )
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["claim-1"], "internal_urls": [internal_url]}
                )
            ],
        }
    )
    section = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n"
            f"Battery life is 10 years [Source]({authority_url}).\n\n"
            "The price is 999 dollars.\n\n"
            "This always guarantees savings.\n\n"
            "Read [Unknown](https://unknown.example/page).\n\n"
            f"See [Project guide]({internal_url})."
            f"\n\n{QUALITY_PROSE}"
        ),
        used_claim_ids=["claim-1", "invented"],
        used_source_urls=[authority_url, "https://invented.example"],
        used_internal_urls=[internal_url, "https://other.example"],
    )

    sanitized = sanitize_sections(
        [section],
        plan,
        allowed_source_urls={authority_url},
        allowed_internal_urls={internal_url},
    )[0]
    report = deterministic_quality_check(
        plan,
        [sanitized],
        allowed_source_urls={authority_url},
        allowed_internal_urls={internal_url},
    )

    assert "10 years" in sanitized.markdown
    assert "999" in sanitized.markdown
    assert "always guarantees" in sanitized.markdown
    assert "https://unknown.example" in sanitized.markdown
    assert f"]({internal_url})" in sanitized.markdown
    assert sanitized.used_claim_ids == ["claim-1", "invented"]
    assert sanitized.used_source_urls == [
        authority_url,
        "https://unknown.example/page",
    ]
    assert sanitized.used_internal_urls == [internal_url]
    assert report.passed is True


def test_internal_links_are_assigned_by_section_with_article_wide_limits() -> None:
    topics = ["installation", "warranty", "sizing", "maintenance", "financing", "recycling"]
    sections = [
        OutlineSection(
            section_id=f"section-{index}",
            heading=f"Solar battery {topics[index - 1]}",
            objective=f"Explain solar battery {topics[index - 1]}",
            section_type="body_explanation",
        )
        for index in range(1, 7)
    ]
    pack = {
        "internal_sources": [
            {
                "url": f"https://project.example/blog/topic-{index}",
                "title": f"Solar battery {topics[index - 1]}",
                "description": f"Details for solar battery {topics[index - 1]}",
            }
            for index in range(1, 7)
        ]
    }

    assigned = generation.assign_internal_links_to_sections(sections, pack)
    urls = [url for section in assigned for url in section.internal_urls]

    assert len(urls) == 5
    assert len(set(urls)) == 5
    assert all(len(section.internal_urls) <= 1 for section in assigned)
    assert assigned[0].internal_urls == ["https://project.example/blog/topic-1"]
    assert assigned[-1].internal_urls == []


def test_internal_link_assignment_skips_unrelated_candidates() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="Solar battery payback",
        objective="Explain battery costs and savings",
        section_type="body_explanation",
    )
    pack = {
        "internal_sources": [
            {
                "url": "https://project.example/legal/team-policy",
                "title": "Employee leave policy",
                "description": "Internal human resources handbook",
            }
        ]
    }

    assigned = generation.assign_internal_links_to_sections([section], pack)

    assert assigned[0].internal_urls == []


def test_internal_link_assignment_matches_chinese_section_to_english_target() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="CRM 实施步骤",
        objective="说明如何落地 CRM",
        section_type="body_how_to",
    )
    url = "https://project.example/crm-implementation"
    pack = {
        "internal_sources": [
            {
                "url": url,
                "title": "CRM Implementation Guide",
                "description": "A practical CRM rollout process",
            }
        ]
    }

    assigned = generation.assign_internal_links_to_sections([section], pack)

    assert assigned[0].internal_urls == [url]


def test_internal_link_assignment_uses_best_article_wide_match() -> None:
    implementation_url = "https://project.example/crm-implementation"
    generic_url = "https://project.example/crm-startups"
    sections = [
        OutlineSection(
            section_id="implementation",
            heading="CRM 实施步骤",
            objective="说明 CRM 如何落地",
            section_type="body_how_to",
        ),
        OutlineSection(
            section_id="measurement",
            heading="衡量 CRM 效果",
            objective="说明上线后如何监控",
            section_type="body_explanation",
        ),
    ]
    pack = {
        "internal_sources": [
            {
                "url": generic_url,
                "title": "CRM for Startups",
                "description": "A CRM product page",
                "selection_score": 100,
            },
            {
                "url": implementation_url,
                "title": "CRM Implementation",
                "description": "Implementation steps and rollout guidance",
                "selection_score": 80,
            },
        ]
    }

    assigned = generation.assign_internal_links_to_sections(sections, pack)

    assert assigned[0].internal_urls == [implementation_url]
    assert assigned[1].internal_urls == []


def test_internal_link_assignment_ignores_template_heading_noise() -> None:
    section = OutlineSection(
        section_id="measurement",
        heading="衡量 CRM 实施效果",
        objective="说明上线后如何监控效果",
        section_type="body_explanation",
    )
    pack = {
        "internal_sources": [
            {
                "url": "https://project.example/company/crm-award",
                "title": "Company Wins CRM Award",
                "description": "An announcement about an industry award",
                "headings": ["CRM Implementation", "Monitor Your Systems"],
            }
        ]
    }

    assigned = generation.assign_internal_links_to_sections([section], pack)

    assert assigned[0].internal_urls == []


def test_finalizer_preserves_generated_internal_links() -> None:
    urls = [f"https://project.example/blog/topic-{index}" for index in range(1, 7)]
    plan = plan_with_sections(6).model_copy(
        update={
            "sections": [
                section.model_copy(update={"internal_urls": [urls[index]]})
                for index, section in enumerate(plan_with_sections(6).sections)
            ]
        }
    )
    sections = [
        SectionDraft(
            section_id=f"section-{index}",
            markdown=(
                f"## Section {index}\n\n"
                f"Use [topic {index}]({urls[index - 1]}) for more context."
                + (
                    f" Also see [the wrong section]({urls[0]})."
                    if index == 2
                    else ""
                )
            ),
            used_internal_urls=[urls[index - 1], *([urls[0]] if index == 2 else [])],
        )
        for index in range(1, 7)
    ]
    artifact = article_artifact(
        plan,
        sections,
        {
            "project": {"domain": "project.example"},
            "authority_sources": [],
            "competitors": [],
            "internal_sources": [{"url": url} for url in urls],
        },
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert finalized["markdown"].count("](") == 7
    assert finalized["markdown"].count(urls[0]) == 2
    assert urls[5] in finalized["markdown"]
    assert finalized["sections"][5]["used_internal_urls"] == [urls[5]]
    assert warnings == []


def test_article_artifact_does_not_add_a_project_cta_the_model_did_not_write() -> None:
    cta_url = "https://example.com/download"
    section_plan = OutlineSection(
        section_id="download",
        heading="Download the application",
        objective="Show the reader how to get started",
        section_type="conclusion",
        cta_type="strong",
    )
    plan = plan_with_sections(1).model_copy(update={"sections": [section_plan]})
    section = SectionDraft(
        section_id="download",
        markdown=f"## Download the application\n\n{QUALITY_PROSE}",
    )
    pack = {
        "keyword": "ExampleTV streaming application download",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "conversion_actions": ["Download for Free"],
                "key_pages": [
                    {
                        "url": cta_url,
                        "title": "Download ExampleTV",
                        "description": "Official application download",
                    }
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    artifact = article_artifact(plan, [section], pack)
    finalized, warnings = finalize_article_artifact(artifact)

    assert artifact["plan"]["sections"][0]["internal_urls"] == []
    assert cta_url not in finalized["markdown"]
    assert finalized["sections"][0]["used_internal_urls"] == []
    assert warnings == []


def test_finalize_section_plans_treats_choice_process_as_body_not_conclusion() -> None:
    section = OutlineSection(
        section_id="decision",
        heading="Choose by the required outcome, then compare the total cost",
        objective="Give the reader a practical sequence for choosing an option.",
        coverage_points=[
            "List the required outcome.",
            "Compare the complete cost and compatibility.",
            "Finish with the next action.",
        ],
        section_type="conclusion",
        cta_type="medium",
    )

    finalized = generation._finalize_section_plans([section], {})

    assert finalized[0].section_type == "body_how_to"
    assert finalized[0].cta_type == "medium"


def test_finalize_section_plans_preserves_a_real_conclusion() -> None:
    section = OutlineSection(
        section_id="conclusion",
        heading="Conclusion: choose the option that fits your situation",
        objective="Summarize the answer and the most important condition.",
        section_type="conclusion",
    )

    finalized = generation._finalize_section_plans([section], {})

    assert finalized[0].section_type == "conclusion"


def test_normalize_unified_preserves_the_model_section_heading() -> None:
    section_plan = OutlineSection(
        section_id="watch",
        heading="How to Watch Live Sports on ExampleTV",
        objective="Give the complete playback path",
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "title": "ExampleTV: Stream Live Sports",
            "sections": [section_plan],
        }
    )
    unified = UnifiedArticle(
        title=plan.title,
        meta_title=plan.meta_title,
        meta_description=plan.meta_description,
        slug=plan.slug,
        sections=[
            SectionDraft(
                section_id="watch",
                markdown=(
                    "## ExampleTV: Stream Live Sports\n\n"
                    "Open Live TV, choose Sports, select a match, and press Play."
                ),
            )
        ],
    )

    normalized = generation.normalize_unified(unified, plan, [])

    assert normalized.sections[0].markdown.startswith(
        "## ExampleTV: Stream Live Sports\n\n"
    )
    assert normalized.sections[0].markdown.count(plan.title) == 1


def test_article_artifact_deduplicates_project_facts_without_adding_a_cta() -> None:
    cta_url = "https://example.com/download"
    section_plan = OutlineSection(
        section_id="download",
        heading="Download and Install ExampleTV",
        objective="Explain installation on supported devices",
        internal_urls=[cta_url],
        cta_type="strong",
    )
    plan = plan_with_sections(1).model_copy(update={"sections": [section_plan]})
    repeated = "ExampleTV works on Android phones, smart TVs, TV boxes and TV sticks."
    narrated_repeat = (
        "The ExampleTV download guide says the service works on Android phones, "
        "smart TVs, TV boxes and TV sticks."
    )
    section = SectionDraft(
        section_id="download",
        markdown=(
            "## Download and Install ExampleTV\n\n"
            "The official application supports Android phones, smart TVs, TV boxes "
            "and TV sticks, with device-specific installation steps below.\n\n"
            f"{repeated}\n\n{narrated_repeat}"
        ),
    )
    pack = {
        "keyword": "ExampleTV live sports streaming",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "business_summary": "ExampleTV streams live sports.",
                "value_propositions": [repeated],
                "conversion_actions": ["Download for Free"],
                "key_pages": [{"url": cta_url, "title": "Download ExampleTV"}],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    artifact = article_artifact(plan, [section], pack)

    assert artifact["markdown"].count(repeated) == 1
    assert narrated_repeat in artifact["markdown"]
    assert "device-specific installation steps" in artifact["markdown"]
    assert cta_url not in artifact["markdown"]


def test_article_artifact_preserves_model_generated_project_ctas() -> None:
    cta_url = "https://example.com/download"
    plan = plan_with_sections(3).model_copy(
        update={
            "sections": [
                OutlineSection(
                    section_id="intro",
                    heading="Streaming choices",
                    objective="Introduce the choices",
                ),
                OutlineSection(
                    section_id="product",
                    heading="ExampleTV download",
                    objective="Explain the product and how to download it",
                    internal_urls=[cta_url],
                    cta_type="soft",
                ),
                OutlineSection(
                    section_id="conclusion",
                    heading="Choose a service",
                    objective="Summarize the decision",
                    cta_type="strong",
                ),
            ]
        }
    )
    sections = [
        SectionDraft(
            section_id="intro",
            markdown=f"## Streaming choices\n\n{QUALITY_PROSE}\n\nDownload for Free",
        ),
        SectionDraft(
            section_id="product",
            markdown=(
                f"## ExampleTV download\n\n{QUALITY_PROSE}\n\n"
                f"[Download for Free]({cta_url})\n\nDownload for Free"
            ),
        ),
        SectionDraft(
            section_id="conclusion",
            markdown=(
                f"## Choose a service\n\n{QUALITY_PROSE}\n\n"
                f"[Download for Free]({cta_url})"
            ),
        ),
    ]
    pack = {
        "keyword": "ExampleTV streaming application download",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "conversion_actions": ["Download for Free"],
                "key_pages": [
                    {
                        "url": cta_url,
                        "title": "Download ExampleTV",
                        "description": "Official application download",
                    }
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    artifact = article_artifact(plan, sections, pack)
    finalized, warnings = finalize_article_artifact(artifact)

    by_id = {item["section_id"]: item for item in finalized["sections"]}
    assert artifact["plan"]["sections"][0]["internal_urls"] == []
    assert artifact["plan"]["sections"][1]["internal_urls"] == [cta_url]
    assert artifact["plan"]["sections"][2]["internal_urls"] == []
    assert cta_url not in by_id["intro"]["markdown"]
    assert f"[Download for Free]({cta_url})" in by_id["product"]["markdown"]
    assert cta_url in by_id["conclusion"]["markdown"]
    assert finalized["markdown"].count(cta_url) == 2
    assert finalized["markdown"].count("Download for Free") >= 4
    assert warnings == []


def test_article_artifact_preserves_secondary_cta_and_generated_sources_appendix() -> None:
    cta_url = "https://example.com/download"
    homepage_url = "https://example.com/"
    plan = plan_with_sections(2).model_copy(
        update={
            "sections": [
                OutlineSection(
                    section_id="download",
                    heading="Official download",
                    objective="Show the official download route",
                    internal_urls=[cta_url],
                    cta_type="strong",
                ),
                OutlineSection(
                    section_id="watch",
                    heading="Start watching",
                    objective="Explain how to start playback",
                    internal_urls=[homepage_url],
                ),
            ]
        }
    )
    sections = [
        SectionDraft(
            section_id="download",
            markdown=(
                f"## Official download\n\n{QUALITY_PROSE}\n\n"
                f"[Download for Free]({cta_url})"
            ),
        ),
        SectionDraft(
            section_id="watch",
            markdown=(
                f"## Start watching\n\n{QUALITY_PROSE}\n\n"
                f"Need the app first? [Open ExampleTV]({homepage_url}) and follow "
                "its download route.\n\n"
                f"*Sources: *[*ExampleTV guide*]({homepage_url})*."
            ),
        ),
    ]
    pack = {
        "keyword": "live streaming",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "conversion_actions": ["Download for Free"],
                "key_pages": [
                    {
                        "url": cta_url,
                        "title": "Download ExampleTV",
                        "description": "Official application download",
                    },
                    {
                        "url": homepage_url,
                        "title": "ExampleTV",
                        "description": "ExampleTV homepage",
                    },
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [{"url": homepage_url}],
    }

    artifact = article_artifact(plan, sections, pack)
    finalized, warnings = finalize_article_artifact(artifact)

    assert finalized["markdown"].count(cta_url) == 1
    assert finalized["markdown"].count(f"]({homepage_url})") == 2
    assert "Need the app first?" in finalized["markdown"]
    assert "Sources:" in finalized["markdown"]
    assert warnings == []


def test_article_artifact_keeps_plain_text_ctas_as_plain_text() -> None:
    cta_url = "https://example.com/download"
    plan = plan_with_sections(2).model_copy(
        update={
            "sections": [
                OutlineSection(
                    section_id="devices",
                    heading="Supported devices and download",
                    objective="Explain supported devices and the official download path",
                    internal_urls=[cta_url],
                    cta_type="strong",
                ),
                OutlineSection(
                    section_id="watch",
                    heading="Start watching",
                    objective="Explain how to start watching",
                ),
            ]
        }
    )
    sections = [
        SectionDraft(
            section_id="devices",
            markdown=(
                f"## Supported devices and download\n\n{QUALITY_PROSE}\n\n"
                "Works on Android phones and smart TVs. (Download for Free)."
            ),
        ),
        SectionDraft(
            section_id="watch",
            markdown=(
                f"## Start watching\n\n{QUALITY_PROSE}\n\n"
                "Ready to use ExampleTV? Download for Free and install the app."
            ),
        ),
    ]
    pack = {
        "keyword": "ExampleTV streaming application download",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "conversion_actions": ["Download for Free"],
                "key_pages": [{"url": cta_url, "title": "Download ExampleTV"}],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    artifact = article_artifact(plan, sections, pack)
    artifact = article_artifact(
        ArticlePlan.model_validate(artifact["plan"]),
        [SectionDraft.model_validate(item) for item in artifact["sections"]],
        pack,
    )

    assert cta_url not in artifact["markdown"]
    assert artifact["markdown"].count("Download for Free") == 2


def test_generated_markdown_repairs_spacing_around_strong_text() -> None:
    markdown = (
        "A**free tier** is different. "
        "Open the service's**Live TV**area before kickoff."
    )

    repaired, repair_count, fragments_removed = generation._repair_generated_markdown(
        markdown
    )

    assert repaired == (
        "A **free tier** is different. "
        "Open the service's **Live TV** area before kickoff."
    )
    assert repair_count == 3
    assert fragments_removed == 0


def test_generated_markdown_preserves_a_valid_unicode_arrow() -> None:
    markdown = "Open **Profile → Register** to create an account."

    repaired, repair_count, fragments_removed = generation._repair_generated_markdown(
        markdown
    )

    assert repaired == markdown
    assert repair_count == 0
    assert fragments_removed == 0


def test_article_artifact_preserves_only_the_model_generated_trailing_cta() -> None:
    cta_url = "https://example.com/download"
    plan = plan_with_sections(2).model_copy(
        update={
            "sections": [
                OutlineSection(
                    section_id="product",
                    heading="ExampleTV download",
                    objective="Explain how to download the product",
                    internal_urls=[cta_url],
                    cta_type="soft",
                ),
                OutlineSection(
                    section_id="conclusion",
                    heading="Choose a service",
                    objective="Summarize the decision",
                    cta_type="strong",
                ),
            ]
        }
    )
    sections = [
        SectionDraft(
            section_id="product",
            markdown=f"## ExampleTV download\n\n{QUALITY_PROSE}",
        ),
        SectionDraft(
            section_id="conclusion",
            markdown=(
                f"## Choose a service\n\n{QUALITY_PROSE}\n\n"
                "If the product fits your setup, follow its official installation path:\n"
                f"[Download for Free]({cta_url})"
            ),
        ),
    ]
    pack = {
        "keyword": "ExampleTV streaming application download",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "conversion_actions": ["Download for Free"],
                "key_pages": [{"url": cta_url, "title": "Download ExampleTV"}],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    artifact = article_artifact(plan, sections, pack)

    assert artifact["markdown"].count(cta_url) == 1
    assert "follow its official installation path:" in artifact["markdown"]


def test_quality_does_not_reject_model_numbers() -> None:
    authority_url = "https://authority.example/fact"
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="Battery life is 10 years",
                    source_url=authority_url,
                    quote="Battery life is 10 years.",
                    section_id="section-1",
                )
            ]
        }
    )
    section = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n"
            f"Battery life is 999 years [Source]({authority_url}).\n\n{QUALITY_PROSE}"
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
    )

    report = deterministic_quality_check(
        plan,
        [section],
        allowed_source_urls={authority_url},
        allowed_internal_urls=set(),
    )

    assert report.passed is True
    assert report.issues == []


def test_quality_and_sanitizer_preserve_source_used_in_another_section() -> None:
    authority_url = "https://authority.example/fact"
    plan = plan_with_sections(2).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="Battery life is 10 years",
                    source_url=authority_url,
                    quote="Battery life is 10 years.",
                    section_id="section-1",
                )
            ],
            "sections": [
                plan_with_sections(2).sections[0].model_copy(
                    update={"claim_ids": ["claim-1"]}
                ),
                plan_with_sections(2).sections[1],
            ],
        }
    )
    misplaced = SectionDraft(
        section_id="section-2",
        markdown=(
            "## Section 2\n\n"
            f"Battery life is 10 years [Source]({authority_url}).\n\n{QUALITY_PROSE}"
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
    )

    report = deterministic_quality_check(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=f"## Section 1\n\n{QUALITY_PROSE}",
            ),
            misplaced,
        ],
        allowed_source_urls={authority_url},
        allowed_internal_urls=set(),
    )
    sanitized = sanitize_sections(
        [misplaced],
        plan,
        allowed_source_urls={authority_url},
        allowed_internal_urls=set(),
    )[0]

    assert report.passed is True
    assert authority_url in sanitized.markdown
    assert "10 years" in sanitized.markdown
    assert sanitized.used_claim_ids == ["claim-1"]
    assert sanitized.used_source_urls == [authority_url]


def test_quality_does_not_treat_numbers_inside_a_link_url_as_article_claims() -> None:
    source_url = "https://authority.example/reports/2026-update"
    plan = plan_with_sections(1)
    section = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n"
            f"Read the [current source]({source_url}) for context. {QUALITY_PROSE}"
        ),
    )

    report = deterministic_quality_check(
        plan,
        [section],
        allowed_source_urls={source_url},
        allowed_internal_urls=set(),
    )

    assert report.passed is True


def test_quality_detects_and_sanitizes_a_malformed_source_link() -> None:
    authority_url = (
        "https://www.irs.gov/newsroom/"
        "faqs-for-modification-of-sections-25c-25d-under-public-law-119-21"
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="The credit ends after December 31, 2025.",
                    quote="The credit will not be allowed after December 31, 2025.",
                    source_url=authority_url,
                    section_id="section-1",
                )
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["claim-1"]}
                )
            ],
        }
    )
    malformed = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n"
            "No. Under the supplied [IRS guidance](https://www. irs.\n\n"
            f"{QUALITY_PROSE}"
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
    )

    report = deterministic_quality_check(
        plan,
        [malformed],
        allowed_source_urls={authority_url},
        allowed_internal_urls=set(),
    )
    sanitized = sanitize_sections(
        [malformed],
        plan,
        allowed_source_urls={authority_url},
        allowed_internal_urls=set(),
    )[0]

    assert any(issue.code == "malformed_link" for issue in report.issues)
    assert report.checks["invalid_links"] == 1
    assert "https://www. irs." not in sanitized.markdown
    assert f"[IRS guidance]({authority_url})" in sanitized.markdown


def test_quality_recovers_a_verified_url_split_by_multiple_spaces() -> None:
    authority_url = (
        "https://www.irs.gov/credits-deductions/"
        "residential-clean-energy-credit"
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim=(
                        "The credit is not available for property placed in service "
                        "after December 31, 2025."
                    ),
                    quote=(
                        "The credit is not available for any property placed in "
                        "service after December 31, 2025."
                    ),
                    source_url=authority_url,
                    section_id="section-1",
                )
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["claim-1"]}
                )
            ],
        }
    )
    malformed = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n"
            "The credit is unavailable ([IRS guidance]"
            "(https://www. irs. gov/credits-deductions/"
            "residential-clean-energy-credit)).\n\n"
            f"{QUALITY_PROSE}"
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
    )

    sanitized = sanitize_sections(
        [malformed],
        plan,
        allowed_source_urls={authority_url},
        allowed_internal_urls=set(),
    )[0]

    assert f"[IRS guidance]({authority_url})" in sanitized.markdown
    assert "irs. gov" not in sanitized.markdown
    assert "gov/credits-deductions" not in sanitized.markdown.replace(
        authority_url, ""
    )


def test_link_sanitizer_does_not_remove_normal_sentence_endings() -> None:
    markdown = (
        "Confirm coverage. Compare current services. "
        "Consider the subscription. Complete the setup. "
        "Free service access does not make data free."
    )

    sanitized, removed = sanitize_markdown_links(markdown, set())

    assert sanitized == markdown
    assert removed == 0


def test_finalize_article_artifact_removes_unrecoverable_malformed_links() -> None:
    plan = plan_with_sections(1)
    artifact = article_artifact(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=(
                    "## Section 1\n\n"
                    "Read [the source](https://not-a-real. url before deciding.\n\n"
                    f"{QUALITY_PROSE}"
                ),
            )
        ],
        {"authority_sources": [], "competitors": [], "internal_sources": []},
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert "https://not-a-real. url" not in finalized["markdown"]
    assert "Read the source before deciding." in finalized["markdown"]
    assert finalized["sections"][0]["markdown"] in finalized["markdown"]
    assert warnings == [
        {
            "code": "malformed_links_removed",
            "message": "最终正文中的残缺链接已移除，并保留了可见文字",
        }
    ]


def test_finalize_article_artifact_removes_orphaned_url_fragments() -> None:
    plan = plan_with_sections(1)
    artifact = article_artifact(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=(
                    "## Section 1\n\n"
                    "irs. gov/credits-deductions/residential-clean-energy-credit)).\n\n"
                    "Use the verified eligibility rules before making a decision. "
                    f"{QUALITY_PROSE}"
                ),
            )
        ],
        {"authority_sources": [], "competitors": [], "internal_sources": []},
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert "irs. gov" not in finalized["markdown"]
    assert "gov/credits-deductions" not in finalized["markdown"]
    assert "))" not in finalized["markdown"]
    assert warnings == [
        {
            "code": "malformed_links_removed",
            "message": "最终正文中的残缺链接已移除，并保留了可见文字",
        }
    ]


def test_finalize_article_artifact_removes_unmatched_strong_marker() -> None:
    plan = plan_with_sections(1)
    artifact = article_artifact(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=(
                    "## Section 1\n\n"
                    "**No single platform carries every sport.\n\n"
                    f"A valid **service comparison** remains formatted. {QUALITY_PROSE}"
                ),
            )
        ],
        {"authority_sources": [], "competitors": [], "internal_sources": []},
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert "**No single platform carries every sport." not in finalized["markdown"]
    assert "No single platform carries every sport." in finalized["markdown"]
    assert "**service comparison**" in finalized["markdown"]
    assert finalized["sections"][0]["markdown"] in finalized["markdown"]
    assert warnings == [
        {
            "code": "unmatched_markdown_markers_removed",
            "message": "最终正文中未配对的 Markdown 粗体标记已移除",
        }
    ]


def test_finalize_article_artifact_keeps_title_out_of_editor_body() -> None:
    plan = plan_with_sections(1).model_copy(update={"title": "ExampleTV Live Sports"})
    artifact = article_artifact(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=f"## Section 1\n\n{QUALITY_PROSE}",
            )
        ],
        {"authority_sources": [], "competitors": [], "internal_sources": []},
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert finalized["title"] == "ExampleTV Live Sports"
    assert finalized["markdown"].startswith("## Section 1\n\n")
    assert "ExampleTV Live Sports" not in finalized["markdown"]
    assert warnings == []


def test_finalize_article_artifact_repairs_common_generated_markdown_damage() -> None:
    plan = plan_with_sections(1)
    artifact = article_artifact(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=(
                    "## Section 1\n\n"
                    "**Yes, this is the direct answer. **\n\n"
                    "ElephTV\u00e2\u0080\u0099s path is App \u00e2\u0086\u0092 Profile.\n\n"
                    "| Device | Setup |\n"
                    "|---|---|\n"
                    "| Android | Install the app | Extra cell |\n\n"
                    "For example, e. See the e. tv announcement.\n\n"
                    f"{QUALITY_PROSE}"
                ),
            )
        ],
        {"authority_sources": [], "competitors": [], "internal_sources": []},
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert "**Yes, this is the direct answer.**" in finalized["markdown"]
    assert "ElephTV's path is App -> Profile." in finalized["markdown"]
    assert "\u00e2\u0080\u0099" not in finalized["markdown"]
    assert "\u00e2\u0086\u0092" not in finalized["markdown"]
    assert "| Android | Install the app |" in finalized["markdown"]
    assert "Extra cell" not in finalized["markdown"]
    assert "For example, e." not in finalized["markdown"]
    assert "See the e. tv announcement." in finalized["markdown"]
    assert finalized["sections"][0]["markdown"] in finalized["markdown"]
    assert {item["code"] for item in warnings} >= {
        "generated_markdown_repaired",
        "broken_sentence_fragments_removed",
    }


def test_finalize_article_artifact_preserves_a_link_only_claim() -> None:
    authority_url = (
        "https://www.irs.gov/credits-deductions/"
        "residential-clean-energy-credit"
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim=(
                        "The residential clean energy credit is not available for "
                        "property placed in service after December 31, 2025."
                    ),
                    quote=(
                        "The credit is not available for any property placed in "
                        "service after December 31, 2025."
                    ),
                    source_url=authority_url,
                    section_id="section-1",
                )
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["claim-1"]}
                )
            ],
        }
    )
    artifact = article_artifact(
        plan,
        [
            SectionDraft(
                section_id="section-1",
                markdown=(
                    "## Section 1\n\n"
                    f"([IRS guidance]({authority_url}))\n\n"
                    f"{QUALITY_PROSE}"
                ),
                used_claim_ids=["claim-1"],
                used_source_urls=[authority_url],
            )
        ],
        {
            "authority_sources": [{"url": authority_url}],
            "competitors": [],
            "internal_sources": [],
        },
    )

    finalized, warnings = finalize_article_artifact(artifact)

    assert f"([IRS guidance]({authority_url}))" in finalized["markdown"]
    assert "The residential clean energy credit is not available" not in finalized["markdown"]
    assert warnings == []


def test_quality_ignores_heading_style_and_markdown_html_is_deterministic() -> None:
    plan = plan_with_sections(1)
    section = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n#### Skipped level\n\n"
            f"Useful **answer**. {QUALITY_PROSE}"
        ),
    )

    report = deterministic_quality_check(
        plan,
        [section],
        allowed_source_urls=set(),
        allowed_internal_urls=set(),
    )
    html = markdown_to_html("# Title\n\n## Section\n\nUseful **answer**.\n")

    assert report.issues == []
    assert html == "<h1>Title</h1>\n<h2>Section</h2>\n<p>Useful <strong>answer</strong>.</p>"


def test_markdown_html_renders_tables_as_tables() -> None:
    html = markdown_to_html(
        "| Option | Price |\n|:--|--:|\n| **A** | [10](https://example.com) |\n"
    )

    assert "<table>" in html
    assert '<th style="text-align:left">Option</th>' in html
    assert '<td style="text-align:right"><a href="https://example.com">10</a></td>' in html
    assert "<p>| Option | Price |" not in html


def test_quality_only_reports_missing_required_section() -> None:
    plan = plan_with_sections(2)
    copied = (
        "A solar battery payback estimate depends on electricity prices system cost "
        "available incentives household consumption export rates battery capacity and "
        "the amount of solar energy used directly inside the home"
    )
    sections = [
        SectionDraft(
            section_id="section-1",
            markdown=f"## Section 1\n\n{copied}. {QUALITY_PROSE}",
        )
    ]

    report = deterministic_quality_check(
        plan,
        sections,
        allowed_source_urls=set(),
        allowed_internal_urls=set(),
        competitor_passages=[copied],
    )

    assert {item.code for item in report.issues} == {"section_missing"}


def test_competitor_summary_is_structured_and_bounded() -> None:
    text = "# Main heading\n\nOpening sentence. Second sentence. " + " ".join(
        f"Point {index}." for index in range(30)
    )

    summary = generation._structured_summary(text)

    assert summary["headings"] == ["Main heading"]
    assert len(summary["opening"]) <= 400
    assert len(summary["key_points"]) <= 8
    assert all(len(item) <= 240 for item in summary["key_points"])
    assert len(summary["closing"]) <= 400


def test_competitor_analysis_failure_keeps_page_with_basic_structure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Reader:
        async def read_text(self, _reference: str) -> Any:
            return SimpleNamespace(
                text="# Solar guide\n\nOpening answer. Second sentence. Final sentence."
            )

    def fail_analysis(*_: Any, **__: Any) -> dict[str, Any]:
        raise RuntimeError("analysis failed")

    monkeypatch.setattr(generation, "S3TextReader", lambda _settings: Reader())
    monkeypatch.setattr(generation, "analyze_competitor", fail_analysis)
    competitors = asyncio.run(
        generation._competitor_summaries(
            Settings(app_env="test"),
            [
                source(
                    "https://competitor.example/guide",
                    content_ref="s3://pages/guide",
                    summary={
                        "content_type": "How-To Guide",
                        "word_count": 900,
                        "heading_structure": [
                            {"level": 2, "heading": "Installation steps"}
                        ],
                    },
                )
            ],
            5,
        )
    )

    assert len(competitors) == 1
    assert competitors[0]["content_type"] == "How-To Guide"
    assert competitors[0]["analysis"]["word_count"] == 900
    assert competitors[0]["analysis"]["structure"] == [
        {"heading": "Installation steps", "level": 2, "word_count": 0}
    ]
    assert competitors[0]["summary"]["opening"]


def test_competitor_summaries_prefer_serp_rank_over_storage_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Reader:
        async def read_text(self, reference: str) -> Any:
            return SimpleNamespace(text=f"Content from {reference}")

    monkeypatch.setattr(generation, "S3TextReader", lambda _settings: Reader())
    competitors = asyncio.run(
        generation._competitor_summaries(
            Settings(app_env="test"),
            [
                source(
                    "https://competitor.example/rank-7",
                    content_ref="s3://pages/rank-7",
                    summary={"serp_position": 7},
                ),
                source(
                    "https://competitor.example/rank-2",
                    content_ref="s3://pages/rank-2",
                    summary={"serp_position": 2},
                ),
                source(
                    "https://competitor.example/unknown",
                    content_ref="s3://pages/unknown",
                ),
            ],
            2,
        )
    )

    assert [item["url"] for item in competitors] == [
        "https://competitor.example/rank-2",
        "https://competitor.example/rank-7",
    ]


def test_competitor_summary_uses_stored_main_html_for_section_depth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Reader:
        async def read_text(self, reference: str) -> Any:
            if reference.endswith("page.html.gz"):
                return SimpleNamespace(
                    text=(
                        "<article><h2>Pricing</h2><p>Detailed current pricing guidance.</p>"
                        "<h2>Conclusion</h2><p>Choose based on total cost.</p></article>"
                    )
                )
            return SimpleNamespace(text="Plain text without heading markers.")

    monkeypatch.setattr(generation, "S3TextReader", lambda _settings: Reader())
    competitors = asyncio.run(
        generation._competitor_summaries(
            Settings(app_env="test"),
            [
                source(
                    "https://competitor.example/article",
                    content_ref="s3://pages/page.txt.gz",
                    summary={
                        "html_ref": "s3://pages/page.html.gz",
                        "heading_structure": [
                            {"level": 2, "heading": "Unreliable fallback heading"}
                        ],
                    },
                )
            ],
            1,
        )
    )

    assert [item["heading"] for item in competitors[0]["analysis"]["structure"]] == [
        "Pricing",
        "Conclusion",
    ]


def test_competitor_blueprint_does_not_override_model_plan() -> None:
    pack = {
        "keyword": "solar battery",
        "required_questions": [],
        "project": {"domain": "project.example"},
        "serp_analysis": {"dominant_content_type": "Comparison"},
        "content_brief": {"content_type": "Comparison"},
        "competitor_blueprint": {
            "structure_to_match": [
                {
                    "heading": "Pricing",
                    "competitor_count": 3,
                    "average_word_count": 500,
                }
            ],
            "must_fill_gaps": [
                {
                    "type": "thin_section",
                    "location": "Pricing",
                    "opportunity": "Add current pricing and decision criteria",
                    "competitor_count": 3,
                }
            ],
            "differentiation_opportunities": [],
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan_with_sections(1), pack)
    fallback = generation.fallback_plan(pack)

    assert [item.heading for item in normalized.sections] == ["Section 1"]
    assert all(item.heading != "Pricing" for item in fallback.sections)
    coverage = [point for section in fallback.sections for point in section.coverage_points]
    assert "Common competitor structure: Pricing" not in coverage


def test_competitor_gap_does_not_modify_model_sections() -> None:
    plan = ArticlePlan(
        title="Solar battery guide",
        search_intent="Compare solar battery choices",
        article_type="Comparison",
        meta_title="Solar battery guide",
        meta_description="Compare pricing and installation choices.",
        slug="solar-battery-guide",
        sections=[
            OutlineSection(
                section_id="intro",
                heading="Introduction",
                objective="Introduce the decision",
            ),
            OutlineSection(
                section_id="pricing",
                heading="Pricing and costs",
                objective="Explain prices and total cost",
            ),
            OutlineSection(
                section_id="setup",
                heading="Installation process",
                objective="Explain setup steps",
            ),
        ],
    )
    gap = "Explain hidden costs and price differences"
    pack = {
        "keyword": "solar battery",
        "project": {"domain": "project.example", "profile": {}},
        "serp_analysis": {"dominant_content_type": "Comparison"},
        "competitor_blueprint": {
            "structure_to_match": [
                {
                    "heading": "Pricing",
                    "competitor_count": 3,
                    "average_word_count": 500,
                }
            ],
            "must_fill_gaps": [
                {
                    "type": "thin_section",
                    "location": "Pricing",
                    "opportunity": gap,
                    "competitor_count": 3,
                }
            ]
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    assert normalized.sections[0].competitor_gaps == []
    pricing = next(item for item in normalized.sections if item.heading == "Pricing and costs")
    assert pricing.competitor_gaps == []
    assert pricing.word_target == 300
    assert normalized.gap_to_section_mapping == {}


def test_semantic_matching_uses_whole_latin_tokens() -> None:
    use_case_terms = generation._semantic_terms("use cases")

    assert "scenario" in use_case_terms
    assert "scenario" not in generation._semantic_terms("user questions")
    assert "scenario" not in generation._semantic_terms("abuse prevention")
    assert "cost" in generation._semantic_terms("pricing options")
    assert "configure" in generation._semantic_terms("setup process")


def test_section_plan_preserves_model_evidence_requirements_and_ctas() -> None:
    plan = ArticlePlan(
        title="Solar battery guide",
        search_intent="Understand solar battery choices",
        article_type="guide",
        meta_title="Solar battery guide",
        meta_description="Understand solar battery choices and next steps.",
        slug="solar-battery-guide",
        sections=[
            OutlineSection(
                section_id="intro",
                heading="Introduction",
                objective="Introduce the topic",
                cta_type="strong",
            ),
            OutlineSection(
                section_id="pricing",
                heading="Pricing",
                objective="Explain pricing",
            ),
            OutlineSection(
                section_id="conclusion",
                heading="Conclusion",
                objective="Give next steps",
            ),
        ],
    )
    pack = {
        "keyword": "solar battery",
        "project": {"domain": "project.example", "profile": {}},
        "competitor_blueprint": {
            "data_needed": [
                {"topic": "Pricing", "reason": "Competitors make unsupported claims"}
            ],
            "outdated_to_update": [
                {"location": "Pricing", "quote": "A price estimate from 2020"}
            ],
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    without_conversions = generation.normalize_plan(plan, pack)
    pricing = next(item for item in without_conversions.sections if item.heading == "Pricing")

    assert pricing.data_requirements == []
    assert [item.cta_type for item in without_conversions.sections] == [
        "strong",
        None,
        None,
    ]

    pack["project"]["profile"]["conversion_actions"] = ["Start a free assessment"]
    with_conversions = generation.normalize_plan(plan, pack)
    assert [item.cta_type for item in with_conversions.sections] == [
        "strong",
        None,
        None,
    ]


@pytest.mark.parametrize("section_count", [2, 3, 4, 5, 6])
def test_section_finalization_does_not_invent_ctas(section_count: int) -> None:
    sections = [
        OutlineSection(
            section_id=f"raw-{index}",
            heading=(
                "Introduction"
                if index == 1
                else "Conclusion"
                if index == section_count
                else f"Topic {index}"
            ),
            objective=f"Cover topic {index}",
        )
        for index in range(1, section_count + 1)
    ]
    pack = {
        "project": {"profile": {"conversion_actions": ["Start now"]}},
        "competitor_blueprint": {},
    }

    finalized = generation._finalize_section_plans(sections, pack)

    assert [item.cta_type for item in finalized] == [None] * section_count


def test_section_classification_and_snippet_targets_match_seomachine() -> None:
    sections = [
        OutlineSection(
            section_id="intro",
            heading="Introduction",
            objective="Introduce the topic",
        ),
        OutlineSection(
            section_id="definition",
            heading="What the service does",
            objective="Explain the service",
        ),
        OutlineSection(
            section_id="question",
            heading="A common user question",
            objective="Answer the question",
        ),
    ]
    pack = {"project": {"profile": {}}, "competitor_blueprint": {}}

    finalized = generation._finalize_section_plans(sections, pack)

    assert finalized[1].section_type == "body_explanation"
    assert finalized[1].featured_snippet_target is True
    assert finalized[2].section_type == "faq"
    assert finalized[2].featured_snippet_target is True


def test_first_section_question_overrides_intro_like_seomachine() -> None:
    sections = [
        OutlineSection(
            section_id="question",
            heading="Frequently asked question",
            objective="Answer the question",
        )
    ]
    pack = {"project": {"profile": {}}, "competitor_blueprint": {}}

    finalized = generation._finalize_section_plans(sections, pack)

    assert finalized[0].section_type == "faq"
    assert finalized[0].featured_snippet_target is True

    assert generation._classify_section_type("Most asked topics", 1) == "faq"


@pytest.mark.parametrize(
    ("heading", "expected"),
    [
        ("Summary steps", "body_how_to"),
        ("Why these tips matter", "body_explanation"),
        ("Best methods", "body_comparison"),
        ("Top", "body_list"),
        ("Asked questions", "faq"),
        ("Final summary", "conclusion"),
    ],
)
def test_mixed_heading_classification_uses_seomachine_priority(
    heading: str, expected: str
) -> None:
    assert generation._classify_section_type(heading, 1) == expected


def test_first_answer_heading_is_not_forced_to_be_an_intro() -> None:
    assert (
        generation._classify_section_type("Best for small teams: Example One", 0)
        == "body_comparison"
    )


def test_faq_uses_four_to_six_real_serp_questions_without_inventing() -> None:
    section = OutlineSection(
        section_id="faq",
        heading="Frequently asked questions",
        objective="Answer real questions",
        required_questions=["Question 2?", "Invented question?"],
    )
    pack = {
        "project": {"profile": {}},
        "competitor_blueprint": {},
        "required_questions": [f"Question {index}?" for index in range(1, 9)],
    }

    finalized = generation._finalize_section_plans([section], pack)[0]

    assert finalized.required_questions == [
        "Question 2?",
        "Question 1?",
        "Question 3?",
        "Question 4?",
    ]
    assert "Invented question?" not in finalized.required_questions


def test_faq_uses_every_real_question_when_fewer_than_four_are_available() -> None:
    section = OutlineSection(
        section_id="faq",
        heading="FAQ",
        objective="Answer real questions",
    )
    pack = {
        "project": {"profile": {}},
        "competitor_blueprint": {},
        "required_questions": ["First question?", "Second question?"],
    }

    finalized = generation._finalize_section_plans([section], pack)[0]

    assert finalized.required_questions == ["First question?", "Second question?"]


def test_section_plans_deduplicate_the_same_question_without_topic_rules() -> None:
    sections = [
        OutlineSection(
            section_id="choices",
            heading="Compare the choices",
            objective="Help the reader choose",
            required_questions=["Which option fits a small team?"],
            coverage_points=["Compare the options by team size."],
        ),
        OutlineSection(
            section_id="setup",
            heading="Set up the service",
            objective="Get ready to start",
            required_questions=["Which option fits a small team?"],
            coverage_points=["Compare the options by implementation time."],
        ),
        OutlineSection(
            section_id="faq",
            heading="Frequently asked questions",
            objective="Answer remaining questions",
            required_questions=["Which option fits a small team?"],
        ),
    ]
    pack = {
        "project": {"profile": {}},
        "competitor_blueprint": {},
        "required_questions": ["Which option fits a small team?"],
    }

    finalized = generation._finalize_section_plans(sections, pack)

    assert sum(
        "Which option fits a small team?" in section.required_questions
        for section in finalized
    ) == 1


def test_faq_keeps_only_questions_not_already_covered_by_the_body() -> None:
    sections = [
        OutlineSection(
            section_id="watch",
            heading="Where to watch live sports",
            objective="Name the available live sports options.",
            required_questions=["Where can I watch live sports?"],
        ),
        OutlineSection(
            section_id="faq",
            heading="Frequently asked questions",
            objective="Answer remaining questions",
            required_questions=[
                "Where can I watch live sports?",
                "Which devices support the application?",
            ],
        ),
    ]
    pack = {
        "project": {"profile": {}},
        "competitor_blueprint": {},
        "required_questions": [
            "Where can I watch live sports?",
            "Which devices support the application?",
        ],
    }

    finalized = generation._finalize_section_plans(sections, pack)
    faq = next(section for section in finalized if section.section_type == "faq")

    assert faq.required_questions == ["Which devices support the application?"]


def test_redundant_faq_section_is_removed_when_it_has_no_new_question() -> None:
    sections = [
        OutlineSection(
            section_id="watch",
            heading="Where to watch live sports",
            objective="Name the available live sports options.",
            required_questions=["Where can I watch live sports?"],
        ),
        OutlineSection(
            section_id="faq",
            heading="Frequently asked questions",
            objective="Answer remaining questions",
            required_questions=["Where can I watch live sports?"],
        ),
    ]
    pack = {
        "project": {"profile": {}},
        "competitor_blueprint": {},
        "required_questions": ["Where can I watch live sports?"],
    }

    finalized = generation._finalize_section_plans(sections, pack)

    assert all(section.section_type != "faq" for section in finalized)


def test_critical_research_uses_the_complete_query_without_fixed_topics() -> None:
    plan = plan_with_sections(1).model_copy(
        update={
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information="Current platform account access requirements",
                    why_it_blocks_core_answer="The reader cannot complete account access without it.",
                    research_query=(
                        "Research current platform account access requirements "
                        "as one complete task"
                    ),
                )
            ]
        }
    )
    queries = generation._critical_research_tasks(plan)

    assert queries == [
        "Research current platform account access requirements as one complete task"
    ]


def test_quality_does_not_enforce_section_length_or_type_templates() -> None:
    plans = [
        OutlineSection(
            section_id="how-to",
            heading="How to start",
            objective="Give steps",
            section_type="body_how_to",
            word_target=100,
        ),
        OutlineSection(
            section_id="list",
            heading="Top options",
            objective="List options",
            section_type="body_list",
            word_target=100,
        ),
        OutlineSection(
            section_id="faq",
            heading="FAQ",
            objective="Answer questions",
            section_type="faq",
            word_target=100,
            required_questions=[
                "Question one?",
                "Question two?",
                "Question three?",
                "Question four?",
            ],
        ),
        OutlineSection(
            section_id="conclusion",
            heading="Conclusion",
            objective="Give next steps",
            section_type="conclusion",
            word_target=100,
        ),
    ]
    plan = plan_with_sections(1).model_copy(update={"sections": plans})
    sections = [
        SectionDraft(section_id=item.section_id, markdown=f"## {item.heading}\n\nToo brief.")
        for item in plans
    ]

    report = deterministic_quality_check(
        plan,
        sections,
        allowed_source_urls=set(),
        allowed_internal_urls=set(),
    )

    assert report.issues == []


def test_numbered_how_to_steps_are_not_treated_as_unsupported_facts() -> None:
    section_plan = OutlineSection(
        section_id="how-to",
        heading="How to start",
        objective="Give steps",
        section_type="body_how_to",
        word_target=100,
    )
    plan = plan_with_sections(1).model_copy(update={"sections": [section_plan]})
    filler = "Use the available project information to complete this action safely and clearly. " * 6
    section = SectionDraft(
        section_id="how-to",
        markdown=(
            "## How to start\n\n"
            f"1. Review the inputs. {filler}\n\n"
            f"2. Complete the action. {filler}"
        ),
    )

    report = deterministic_quality_check(
        plan,
        [section],
        allowed_source_urls=set(),
        allowed_internal_urls=set(),
    )

    assert report.passed is True


def test_section_payload_omits_unrelated_project_cta() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="Compare options",
        objective="Help the reader decide",
        section_type="body_comparison",
        word_target=400,
        cta_type="medium",
    )
    plan = plan_with_sections(1).model_copy(update={"sections": [section]})
    pack = {
        "keyword": "solar battery",
        "language": "en",
        "project": {
            "domain": "project.example",
            "profile": {
                "conversion_actions": ["Start a free assessment"],
                "key_pages": [
                    {
                        "url": "https://project.example/assessment",
                        "title": "Start a free assessment",
                        "description": "Assessment form",
                    }
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert "writing_requirements" not in payload
    assert payload["official_product"]["conversion_actions"] == []
    assert payload["official_product"]["cta_targets"] == []


def test_section_payload_always_includes_project_answer_context_and_real_cta_url() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="Download the application",
        objective="Show the reader where and how to download it",
        section_type="body_how_to",
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "title": "ExampleTV download",
            "search_intent": "Download and install ExampleTV",
            "sections": [section],
        }
    )
    pack = {
        "keyword": "ExampleTV download",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "business_summary": "A streaming application for supported devices.",
                "products_services": ["Streaming application"],
                "value_propositions": ["Simple installation"],
                "conversion_actions": ["Download ExampleTV"],
                "key_pages": [
                    {
                        "url": "https://example.com/download",
                        "title": "Download ExampleTV",
                        "description": "Official download page",
                    }
                ],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Live sports streaming",
                        "source_url": "https://example.com/",
                        "quote": "Watch live sports on supported devices.",
                    }
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert payload["official_product"]["business_name"] == "ExampleTV"
    assert payload["official_product"]["products_services"] == [
        "Streaming application"
    ]
    assert payload["official_product"]["product_evidence"] == [
        {
            "field": "products_services",
            "value": "Live sports streaming",
            "quote": "Watch live sports on supported devices.",
            "source_url": "https://example.com/",
        }
    ]
    assert payload["official_product"]["cta_targets"] == [
        {
            "label": "Download ExampleTV",
            "url": "https://example.com/download",
            "title": "Download ExampleTV",
            "description": "Official download page",
        }
    ]


def test_planning_payload_includes_structured_project_product_evidence() -> None:
    pack = {
        "keyword": "live tv streaming sports",
        "country": "ZA",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "products_services": ["Live sports streaming"],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Live sports streaming",
                        "source_url": "https://example.com/",
                        "quote": "Watch live sports on supported devices.",
                    },
                    {
                        "field": "conversion_actions",
                        "value": "Download for Free",
                        "source_url": "https://example.com/",
                        "quote": "Download for Free",
                    },
                ],
            },
        },
        "authority_sources": [],
        "internal_sources": [],
    }

    payload = generation._planning_research_pack(pack)

    assert payload["project"]["profile"]["product_evidence"] == [
        {
            "field": "products_services",
            "value": "Live sports streaming",
            "quote": "Watch live sports on supported devices.",
            "source_url": "https://example.com/",
        },
        {
            "field": "conversion_actions",
            "value": "Download for Free",
            "quote": "Download for Free",
            "source_url": "https://example.com/",
        },
    ]


def test_generation_payloads_keep_full_planning_data_but_scope_section_sources() -> None:
    authority_sources = [
        {
            "url": f"https://source{index}.example/report",
            "title": f"Source {index}",
            "excerpt": f"Full excerpt {index}",
            "research_claim": f"Research claim {index}",
            "verification_claims": [
                {
                    "claim": f"Claim {index}-{claim_index}",
                    "evidence": f"Evidence {index}-{claim_index}",
                    "status": "unreviewed",
                }
                for claim_index in range(1, 4)
            ],
        }
        for index in range(1, 26)
    ]
    serp_results = [
        {
            "url": f"https://serp{index}.example/article",
            "title": f"SERP {index}",
            "description": f"Description {index}",
        }
        for index in range(1, 12)
    ]
    profile = {
        "business_name": "ExampleTV",
        "products_services": ["Streaming application"],
        "custom_product_detail": {"platforms": ["Android", "TV"]},
    }
    pack = {
        "keyword": "ExampleTV sports",
        "country": "ZA",
        "language": "en",
        "project": {"domain": "example.com", "profile": profile},
        "authority_sources": authority_sources,
        "serp": {"organic_results": serp_results},
        "internal_sources": [],
    }
    section = OutlineSection(
        section_id="answer",
        heading="How to watch",
        objective="Answer the reader",
    )
    plan = plan_with_sections(1).model_copy(update={"sections": [section]})

    planning = generation._planning_research_pack(pack, compact=False)
    writing = generation.section_payload(plan, section, pack, [], compact=False)

    assert len(planning["research_sources"]) <= 20
    assert all(len(item["verification_claims"]) <= 3 for item in planning["research_sources"])
    assert len(planning["serp_results"]) <= 10
    assert planning["project"]["profile"]["custom_product_detail"] == {
        "platforms": ["Android", "TV"]
    }
    assert len(writing["sources"]) <= 3
    assert not any(item["url"] == authority_sources[24]["url"] for item in writing["sources"])
    assert all(
        "status" not in claim
        for source in writing["sources"]
        for claim in source.get("verification_claims", [])
    )
    assert len(writing["serp_results"]) == 10
    assert writing["official_product"]["profile"] == profile

    compact = generation._planning_research_pack(pack, compact=True)
    assert len(compact["research_sources"]) == 10
    assert len(compact["research_sources"][0]["verification_claims"]) == 1
    assert len(compact["serp_results"]) == 10


def test_plan_normalization_caps_imported_research_claims() -> None:
    pack = {
        "keyword": "warehouse automation",
        "project": {},
        "authority_sources": [
            {
                "url": f"https://source{source_index}.example/report",
                "title": f"Report {source_index}",
                "excerpt": f"Evidence {source_index}",
                "verification_claims": [
                    {
                        "claim": f"Finding {source_index}-{claim_index}",
                        "evidence": f"Evidence {source_index}-{claim_index}",
                    }
                    for claim_index in range(5)
                ],
            }
            for source_index in range(30)
        ],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan_with_sections(6), pack)

    assert len(normalized.claims) <= 48
    assert all(len(section.claim_ids) <= 8 for section in normalized.sections)


def test_supplemental_research_stops_at_its_total_time_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    pack = {
        "keyword": "heat pump rebates",
        "country": "US",
        "language": "en",
        "project": {},
        "required_questions": [],
        "competitors": [],
        "competitor_blueprint": {},
        "authority_sources": [],
        "internal_sources": [],
        "serp": {},
        "serp_analysis": {},
    }
    planned = plan_with_sections(1).model_copy(
        update={
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"data_requirements": ["current federal rebate amounts"]}
                )
            ],
            "critical_research_gaps": [
                CriticalResearchGap(
                    missing_information="Current federal rebate amounts",
                    why_it_blocks_core_answer="The reader cannot calculate the rebate without it.",
                    research_query="Research current US federal heat pump rebate amounts",
                )
            ],
        }
    )
    research_calls = 0

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        return deepcopy(pack)

    async def generate(*_: Any, **__: Any) -> Any:
        return SimpleNamespace(value=planned, usage={})

    async def collect_research(*_: Any, **__: Any) -> tuple[None, int]:
        nonlocal research_calls
        research_calls += 1
        await asyncio.sleep(1)
        return None, 1

    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "cached_generate", generate)
    monkeypatch.setattr(generation, "_collect_research", collect_research)
    monkeypatch.setattr(generation, "MAX_SUPPLEMENTAL_RESEARCH_SECONDS", 0.02)
    context = {
        **base_context(),
        "hard_deadline_at": datetime.now(UTC) + timedelta(minutes=10),
    }

    result = asyncio.run(
        plan_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )

    assert research_calls == 1
    assert store.objects[result["output_ref"]]["plan"]["sections"]
    assert [item["code"] for item in result["warnings"]] == [
        "supplemental_research_degraded"
    ]


def test_section_payload_recovers_conversion_action_from_profile_evidence() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="Download the application",
        objective="Show the reader where and how to download it",
        section_type="body_how_to",
    )
    plan = plan_with_sections(1).model_copy(update={"sections": [section]})
    pack = {
        "keyword": "ExampleTV download",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "conversion_actions": None,
                "key_pages": [
                    {
                        "url": "https://example.com/",
                        "title": "ExampleTV",
                        "description": "Official website",
                    }
                ],
                "evidence": [
                    {
                        "field": "conversion_actions",
                        "value": "Download",
                        "source_url": "https://example.com/",
                    },
                    {
                        "field": "conversion_actions",
                        "value": "Download for Free",
                        "source_url": "https://example.com/",
                        "quote": "Download the application from the official website.",
                    },
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert payload["official_product"]["conversion_actions"] == ["Download for Free"]
    assert payload["official_product"]["cta_targets"] == [
        {
            "label": "Download for Free",
            "url": "https://example.com/",
            "title": "ExampleTV",
            "description": "Official website",
        }
    ]


def test_cta_uses_the_project_configured_target_without_url_keyword_guessing() -> None:
    pack = {
        "keyword": "live tv streaming sports",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "key_pages": [
                    {
                        "url": "https://example.com/",
                        "title": "ExampleTV",
                        "description": "Official website",
                    }
                ],
                "evidence": [
                    {
                        "field": "conversion_actions",
                        "value": "Download for Free",
                        "source_url": "https://example.com/",
                    }
                ],
            },
        },
        "authority_sources": [
            {
                "url": "https://example.com/download-exampletv/",
                "title": "Download ExampleTV",
                "excerpt": "Works on supported phones and televisions.",
                "research_claim": "Works on supported phones and televisions.",
                "verification_claims": [],
            }
        ],
    }

    context = generation._project_answer_context(None, pack)

    assert context["cta_targets"][0] == {
        "label": "Download for Free",
        "url": "https://example.com/",
        "title": "ExampleTV",
        "description": "Official website",
    }


def test_section_payload_does_not_send_explicit_editing_checklists() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="Compare options",
        objective="Help the reader decide",
        section_type="body_comparison",
        claim_ids=["claim-1"],
    )
    claim = EvidenceClaim(
        claim_id="claim-1",
        claim="A supported comparison fact",
        source_url="https://authority.example/fact",
        quote="A supported comparison fact",
        section_id="section-1",
    )
    plan = plan_with_sections(1).model_copy(
        update={"sections": [section], "claims": [claim]}
    )
    pack = {
        "keyword": "solar battery",
        "language": "en",
        "project": {"domain": "project.example", "profile": {"tone": "plain"}},
        "authority_sources": [
            {
                "url": claim.source_url,
                "title": "Supported comparison source",
                "excerpt": claim.quote,
            }
        ],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert "writing_requirements" not in payload
    assert "universal_editing_checks" not in payload
    assert "section_specific_checks" not in payload
    assert "ai_phrases_to_remove" not in payload
    assert "vague_words_to_replace" not in payload
    assert "project_writing_rules" not in payload
    assert payload["facts"] == [claim.model_dump(mode="json")]


def test_section_source_mapping_matches_alwrity_granularity_and_is_stable() -> None:
    section = OutlineSection(
        section_id="section-1",
        heading="Federal solar battery tax credit requirements",
        objective="Explain federal solar battery tax credit eligibility and requirements",
        coverage_points=["eligibility requirements", "tax credit application"],
        data_requirements=["current federal tax credit rules"],
        claim_ids=["claim-direct", "claim-unmapped"],
    )
    direct_url = "https://irs.gov/direct-credit"
    relevant_sources = [
        {
            "url": direct_url,
            "title": "Direct IRS credit source",
            "excerpt": "Federal solar battery tax credit eligibility requirements.",
        },
        {
            "url": "https://energy.gov/credit-eligibility",
            "title": "Federal solar battery tax credit eligibility requirements",
            "excerpt": "Official eligibility and tax credit application requirements.",
        },
        {
            "url": "https://treasury.gov/battery-credit",
            "title": "Solar battery credit requirements",
            "excerpt": "Federal tax credit eligibility rules for solar battery systems.",
        },
        {
            "url": "https://congress.gov/solar-credit",
            "title": "Federal solar credit law",
            "excerpt": "Current solar battery tax credit requirements and eligibility.",
        },
    ]
    irrelevant = {
        "url": "https://weather.example/marine-forecast",
        "title": "Marine weather forecast",
        "excerpt": "Wind, waves, and offshore visibility for fishing boats.",
    }
    claims = [
        EvidenceClaim(
            claim_id="claim-direct",
            claim="The credit has federal eligibility requirements.",
            source_url=direct_url,
            section_id="section-1",
        ),
        EvidenceClaim(
            claim_id="claim-unmapped",
            claim="A marine forecast is available.",
            source_url="https://missing.example/marine-forecast",
            section_id="section-1",
        ),
    ]
    plan = plan_with_sections(1).model_copy(
        update={
            "search_intent": "informational",
            "sections": [section],
            "claims": claims,
        }
    )
    pack = {
        "keyword": "solar battery tax credit",
        "language": "en",
        "project": {"domain": "project.example", "profile": {}},
        "content_brief": {
            "secondary_keywords": ["federal credit eligibility"],
            "semantic_keywords": ["tax requirements"],
            "content_angles": ["explain current eligibility requirements"],
        },
        "authority_sources": [*relevant_sources, irrelevant],
        "internal_sources": [],
    }

    first = generation.map_authority_sources_to_section(plan, section, pack)
    second = generation.map_authority_sources_to_section(plan, section, pack)
    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert first == second
    assert len(first) == 3
    assert first[0]["url"] == direct_url
    assert irrelevant["url"] not in {item["url"] for item in first}
    assert payload["sources"] == first
    assert [item["claim_id"] for item in payload["facts"]] == [
        "claim-direct",
        "claim-unmapped",
    ]


def test_complete_article_is_written_in_one_call_with_plan_and_materials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(5)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    pack_ref = asyncio.run(store.write_json("editing-pack.json.gz", pack))
    plan_ref = asyncio.run(
        store.write_json(
            "editing-plan.json.gz",
            {
                "research_pack_ref": pack_ref,
                "plan": plan.model_dump(mode="json"),
            },
        )
    )
    calls: list[tuple[str, dict[str, Any]]] = []

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            calls.append((call, deepcopy(payload)))
            return SimpleNamespace(
                value=unified_for_plan(plan),
                usage={"input_tokens": 4, "output_tokens": 4},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {"planning": {"output_ref": plan_ref}}

    result = asyncio.run(
        write_article_sections(
            FakeRepository(),
            Settings(app_env="test", s3_bucket="test-bucket"),
            context,
            POLICY,
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert len(calls) == 1
    call, payload = calls[0]
    assert call == "unify_article"
    assert [item["section_id"] for item in payload["article_plan"]["sections"]] == [
        f"section-{index}" for index in range(1, 6)
    ]
    assert "relevant_research" in payload
    assert "project_information" in payload
    assert all("Complete article prose" in item["markdown"] for item in artifact["sections"])


def test_legacy_section_cache_is_not_reused_by_full_article_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    pack_ref = asyncio.run(store.write_json("restart-pack.json.gz", pack))
    plan_ref = asyncio.run(
        store.write_json(
            "restart-plan.json.gz",
            {
                "research_pack_ref": pack_ref,
                "plan": plan.model_dump(mode="json"),
            },
        )
    )
    edited = SectionDraft(
        section_id="section-1",
        markdown="## Section 1\n\nPreviously edited complete prose.",
        summary="previously edited summary",
    )
    asyncio.run(
        store.write_json(
            "article-runs/run-1/writing/section-1.json.gz",
            {
                "kind": "article_section",
                "section": edited.model_dump(mode="json"),
                "usage": {"input_tokens": 8},
                "write_and_edit_completed": True,
            },
        )
    )

    calls: list[str] = []

    class Gateway:
        async def generate(self, call: str, *_: Any, **__: Any) -> Any:
            calls.append(call)
            return SimpleNamespace(
                value=unified_for_plan(plan, "Fresh complete article"),
                usage={"input_tokens": 8, "output_tokens": 12},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {"planning": {"output_ref": plan_ref}}

    result = asyncio.run(
        write_article_sections(
            FakeRepository(),
            Settings(app_env="test", s3_bucket="test-bucket"),
            context,
            POLICY,
        )
    )

    markdown = store.objects[result["output_ref"]]["markdown"]
    assert calls == ["unify_article"]
    assert "Fresh complete article" in markdown
    assert "Previously edited complete prose" not in markdown


def test_single_full_article_call_persists_complete_draft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    pack_ref = asyncio.run(store.write_json("edit-failure-pack.json.gz", pack))
    plan_ref = asyncio.run(
        store.write_json(
            "edit-failure-plan.json.gz",
            {
                "research_pack_ref": pack_ref,
                "plan": plan.model_dump(mode="json"),
            },
        )
    )
    original_markdown = (
        "## Section 1\n\n"
        "The original section gives the reader a complete practical answer."
    )

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            assert call == "unify_article"
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[
                        SectionDraft(
                            section_id="section-1",
                            markdown=original_markdown,
                            summary="complete original summary",
                        )
                    ],
                ),
                usage={"input_tokens": 4, "output_tokens": 4},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {"planning": {"output_ref": plan_ref}}

    result = asyncio.run(
        write_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert artifact["sections"][0]["markdown"] == original_markdown
    assert result["summary"]["section_count"] == 1
    assert result["summary"]["complete"] is True
    assert result["warnings"] == []
    assert result["summary"]["model_failures"] == []


def test_writing_recovery_regenerates_the_complete_article(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    pack_ref = asyncio.run(store.write_json("recovery-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "recovery-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    draft = SectionDraft(
        section_id="section-1",
        markdown="## Section 1\n\nComplete but unedited section prose.",
    )
    asyncio.run(
        store.write_json(
            "article-runs/run-1/writing/section-1.json.gz",
            {
                "section": draft.model_dump(mode="json"),
                "usage": {"input_tokens": 3},
                "write_and_edit_completed": False,
            },
        )
    )
    calls: list[str] = []

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            calls.append(call)
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[
                        SectionDraft(
                            section_id="section-1",
                            markdown="## Section 1\n\nEdited recovery article prose.",
                        )
                    ],
                ),
                usage={"input_tokens": 4, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {"planning": {"output_ref": planning_ref}}

    result = asyncio.run(
        generation.recover_generation_stage(
            FakeRepository(),
            Settings(app_env="test", s3_bucket="test-bucket"),
            context,
            POLICY,
            "writing",
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert calls == ["unify_article"]
    assert "Edited recovery article prose" in artifact["markdown"]
    assert result["usage"] == {"input_tokens": 4, "output_tokens": 5}


def test_content_scorer_matches_seomachine_dimensions_and_penalties() -> None:
    scorer = ContentScorer()
    assert scorer.WEIGHTS == {
        "humanity": 0.30,
        "specificity": 0.25,
        "structure_balance": 0.20,
        "seo": 0.15,
        "readability": 0.10,
    }
    assert sum(scorer.WEIGHTS.values()) == pytest.approx(1.0)
    assert scorer.PASS_THRESHOLD == 70

    natural = "You're looking at a concrete choice. Here's the useful question: what works?"
    ai_heavy = " ".join(["When it comes to this robust landscape, furthermore, utilize it."] * 20)
    specific = "In 2026, 73% of 2,000 users selected the $40 option."
    vague = "Many important things are often very good for various users."
    long_paragraph = " ".join([f"Sentence {index} explains the practical point." for index in range(6)])

    assert scorer._score_humanity(ai_heavy)["score"] < scorer._score_humanity(natural)[
        "score"
    ]
    assert scorer._score_specificity(vague)["score"] < scorer._score_specificity(
        specific
    )["score"]
    assert scorer._score_readability(long_paragraph)["details"]["long_paragraphs"] == 1
    assert scorer._score_structure_balance("## Heading\n\n" + "Prose text. " * 20)[
        "prose_ratio"
    ] > 0.75


def test_readability_textstat_failure_matches_seomachine_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(_content: str) -> float:
        raise RuntimeError("textstat unavailable")

    monkeypatch.setattr(
        "app.modules.content.quality.textstat.flesch_reading_ease", fail
    )

    result = ContentScorer()._score_readability("A short readable sentence.")

    assert result["flesch"] == 0
    assert result["score"] == 70


def test_content_scorer_matches_seomachine_composite_rounding_order() -> None:
    scorer = ContentScorer()
    scores = iter([85, 100, 88, 85, 98])

    def dimension_score(*args: object, **kwargs: object) -> dict[str, object]:
        del args, kwargs
        return {"score": next(scores), "issues": [], "details": {}}

    scorer._score_humanity = dimension_score  # type: ignore[method-assign]
    scorer._score_specificity = dimension_score  # type: ignore[method-assign]
    scorer._score_structure_balance = dimension_score  # type: ignore[method-assign]
    scorer._score_seo = dimension_score  # type: ignore[method-assign]
    scorer._score_readability = dimension_score  # type: ignore[method-assign]

    assert scorer.score("content")["composite_score"] == 94.4


def test_content_score_is_recorded_without_sending_quality_fixes_to_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1",
        markdown="## Section 1\n\nA complete original article section.",
    )
    pack_ref = asyncio.run(store.write_json("score-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "score-plan.json.gz",
            {
                "research_pack_ref": pack_ref,
                "plan": plan.model_dump(mode="json"),
            },
        )
    )
    writing_ref = asyncio.run(
        store.write_json(
            "score-draft.json.gz", generation.article_artifact(plan, [section], pack)
        )
    )
    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            return {
                "composite_score": 60.0,
                "passed": False,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [
                    {"issue": f"issue-{index}", "fix": f"fix-{index}"}
                    for index in range(1, 7)
                ],
            }

    calls: list[tuple[str, dict[str, Any]]] = []

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            calls.append((call, deepcopy(payload)))
            assert call == "unify_article"
            assert not {
                "priority_fixes",
                "issues",
                "article_contract",
                "section_contracts",
                "locked_requirements",
            }.intersection(payload)
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[
                        section.model_copy(
                            update={
                                    "markdown": section.markdown
                            }
                        )
                    ],
                ),
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "ContentScorer", Scorer)
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "writing": {"output_ref": writing_ref},
    }

    result = asyncio.run(
        unify_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    artifact = store.objects[result["output_ref"]]
    assert [call for call, _payload in calls] == ["unify_article"]
    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        60.0
    ]
    assert result["summary"]["content_score_iterations"] == 0
    assert result["summary"]["complete"] is True
    assert result["warnings"] == []


def test_low_content_score_does_not_trigger_a_second_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1", markdown="## Section 1\n\nComplete original prose."
    )
    pack_ref = asyncio.run(store.write_json("pass-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "pass-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    writing_ref = asyncio.run(
        store.write_json(
            "pass-draft.json.gz", generation.article_artifact(plan, [section], pack)
        )
    )
    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            return {
                "composite_score": 60.0,
                "passed": False,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [{"issue": "issue", "fix": "fix"}] * 3,
            }

    calls: list[str] = []

    class Gateway:
        async def generate(
            self, call: str, _payload: dict[str, Any], _output: Any
        ) -> Any:
            calls.append(call)
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[section],
                ),
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "ContentScorer", Scorer)
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "writing": {"output_ref": writing_ref},
    }

    result = asyncio.run(
        unify_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )

    assert calls == ["unify_article"]
    assert result["summary"]["content_score"] == 60.0
    assert result["summary"]["content_score_iterations"] == 0
    assert result["warnings"] == []


def test_editing_recovery_scores_once_without_model_quality_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = SectionDraft(
        section_id="section-1", markdown="## Section 1\n\nComplete article prose."
    )
    pack_ref = asyncio.run(store.write_json("recovered-score-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "recovered-score-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    writing_ref = asyncio.run(
        store.write_json(
            "recovered-score-draft.json.gz",
            generation.article_artifact(plan, [section], pack),
        )
    )
    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            return {
                "composite_score": 60.0,
                "passed": False,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [{"issue": "issue", "fix": "fix"}] * 5,
            }

    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("editing recovery must not run model quality revision")

    monkeypatch.setattr(generation, "ContentScorer", Scorer)
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["step_key"] = "editing"
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "writing": {"output_ref": writing_ref},
    }

    result = asyncio.run(
        generation.recover_generation_stage(
            FakeRepository(), Settings(app_env="test"), context, POLICY, "editing"
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        60.0
    ]
    assert result["summary"]["content_score_passed"] is False
    assert result["summary"]["content_score_iterations"] == 0
    assert result["warnings"] == []


def test_checking_recovery_keeps_fallback_sections_repairable_and_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "questions": [],
        "required_questions": [],
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    section = generation.fallback_section(plan.sections[0], "en", pack, plan)
    pack_ref = asyncio.run(store.write_json("recovered-check-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "recovered-check-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    editing_ref = asyncio.run(
        store.write_json(
            "recovered-check-article.json.gz",
            generation.article_artifact(
                plan,
                [section],
                pack,
                degraded_section_ids=["section-1"],
            ),
        )
    )
    context = base_context()
    context["step_key"] = "checking_1"
    context["input_step_key"] = "editing"
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    result = asyncio.run(
        generation.recover_generation_stage(
            FakeRepository(), Settings(app_env="test"), context, POLICY, "checking"
        )
    )

    assert result["summary"]["repairable"] is True
    assert result["summary"]["repair_scope"] == ["section-1"]
    assert result["summary"]["blocking_issue_codes"] == ["fallback_section"]


def test_low_quality_score_keeps_article_history_and_bindings_without_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    authority_url = "https://authority.example/battery-life"
    internal_url = "https://project.example/battery-guide"
    section_plan = plan_with_sections(1).sections[0].model_copy(
        update={
            "claim_ids": ["claim-1"],
            "internal_urls": [internal_url],
        }
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="Battery guidance is supported",
                    source_url=authority_url,
                    quote="Battery guidance is supported",
                    section_id="section-1",
                )
            ],
            "sections": [section_plan],
        }
    )
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "project": {"domain": "project.example"},
        "authority_sources": [{"url": authority_url}],
        "competitors": [],
        "internal_sources": [{"url": internal_url}],
    }
    section = SectionDraft(
        section_id="section-1",
        markdown=(
            "## Section 1\n\n"
            f"Use the supported battery guidance [Source]({authority_url}).\n\n"
            f"Read the [battery guide]({internal_url}) before deciding."
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
        used_internal_urls=[internal_url],
    )
    pack_ref = asyncio.run(store.write_json("quality-failure-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "quality-failure-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    writing_ref = asyncio.run(
        store.write_json(
            "quality-failure-draft.json.gz",
            generation.article_artifact(plan, [section], pack),
        )
    )

    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            return {
                "composite_score": 61.0,
                "passed": False,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [
                    {"issue": "Improve humanity", "fix": "Remove AI phrases"},
                    {"issue": "Improve specificity", "fix": "Use supported facts"},
                    {"issue": "Improve structure", "fix": "Balance prose and lists"},
                ],
            }

    class Gateway:
        async def generate(
            self, call: str, _payload: dict[str, Any], _output: Any
        ) -> Any:
            assert call == "unify_article"
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[
                        section.model_copy(
                            update={
                                "used_claim_ids": [],
                                "used_source_urls": [],
                                "used_internal_urls": [],
                            }
                        )
                    ],
                ),
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "ContentScorer", Scorer)
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "writing": {"output_ref": writing_ref},
    }

    result = asyncio.run(
        unify_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )
    artifact = store.objects[result["output_ref"]]
    final_section = artifact["sections"][0]

    assert artifact["markdown"] == generation.article_markdown(plan.title, [section])
    assert artifact["content_score"]["composite_score"] == 61.0
    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        61.0
    ]
    assert final_section["used_claim_ids"] == ["claim-1"]
    assert final_section["used_source_urls"] == [authority_url]
    assert final_section["used_internal_urls"] == [internal_url]
    assert result["warnings"] == []
    assert result["summary"]["model_failures"] == []
    assert result["summary"]["content_score_iterations"] == 0


@pytest.mark.parametrize(
    "missing_type", ["competitor", "authority", "internal"]
)
def test_missing_optional_source_group_still_builds_a_complete_fallback_plan(
    monkeypatch: pytest.MonkeyPatch, missing_type: str
) -> None:
    store = patch_store(monkeypatch)
    sources = {
        "serp": [source("serp://google/run-1", summary={})],
        "competitor": [],
        "authority": [],
        "research": [],
        "internal": [],
    }
    sources.pop(missing_type)
    repo = FakeRepository(sources)

    class FailingGateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise RuntimeError("model unavailable")

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: FailingGateway())
    result = asyncio.run(
        plan_article(repo, Settings(app_env="test"), base_context(), POLICY)
    )
    artifact = store.objects[result["output_ref"]]

    assert len(artifact["plan"]["sections"]) == 4
    assert all(item["objective"] for item in artifact["plan"]["sections"])
    assert "planning_degraded" in {
        warning["code"] for warning in result["warnings"]
    }


def test_planning_failure_uses_fallback_without_a_second_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    pack = {
        "keyword": "live video streaming",
        "secondary_keywords": [],
        "planned_title": {},
        "writing_direction": {},
        "requested_article_type": {},
        "country": "ZA",
        "language": "en",
        "project": {"domain": "example.com", "profile": {}},
        "serp": {"organic_results": [{"title": "Result", "description": "x" * 5000}]},
        "serp_analysis": {},
        "content_brief": {},
        "questions": [],
        "required_questions": [],
        "competitors": [{"analysis": {"opening": "x" * 5000}}],
        "competitor_blueprint": {},
        "authority_sources": [],
        "internal_sources": [],
    }
    payloads: list[dict[str, Any]] = []

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        return deepcopy(pack)

    async def generate(
        _gateway: Any,
        _settings: Settings,
        _context: dict[str, Any],
        call: str,
        payload: dict[str, Any],
        _output: Any,
    ) -> Any:
        assert call == "plan_article"
        payloads.append(deepcopy(payload))
        raise WritingRequestError(
            "writing_provider_timeout", retryable=True, attempts=1
        )

    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(FakeRepository(), Settings(app_env="test"), base_context(), POLICY)
    )

    assert len(payloads) == 1
    assert "serp" not in payloads[0]["research_pack"]
    assert "competitors" not in payloads[0]["research_pack"]
    assert any(item["code"] == "planning_degraded" for item in result["warnings"])
    assert "Live Video Streaming" in store.objects[result["output_ref"]]["plan"]["title"]


def test_generic_planning_omits_project_profile_from_the_first_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    pack = {
        "keyword": "live video streaming",
        "secondary_keywords": [],
        "planned_title": {},
        "writing_direction": {},
        "requested_article_type": {},
        "country": "ZA",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "business_summary": "ExampleTV provides live video streaming.",
            },
        },
        "serp": {
            "organic_results": [
                {
                    "url": "https://publisher.example/live-video",
                    "title": "Live video options",
                    "description": "A comparison of available options.",
                }
            ]
        },
        "serp_analysis": {},
        "content_brief": {},
        "questions": [],
        "required_questions": [],
        "competitors": [],
        "competitor_blueprint": {},
        "authority_sources": [
            {
                "url": "https://publisher.example/live-video",
                "title": "Live video options",
                "excerpt": "Readers can compare live video services by availability and device support.",
            }
        ],
        "internal_sources": [],
    }
    neutral = plan_with_sections(1).model_copy(
        update={
            "title": "How to choose a live video streaming service",
            "search_intent": "Compare live video streaming options",
        }
    )
    payloads: list[dict[str, Any]] = []

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        return deepcopy(pack)

    async def generate(
        _gateway: Any,
        _settings: Settings,
        _context: dict[str, Any],
        call: str,
        payload: dict[str, Any],
        _output: Any,
    ) -> Any:
        assert call == "plan_article"
        payloads.append(deepcopy(payload))
        return SimpleNamespace(
            value=neutral,
            usage={"input_tokens": 8, "output_tokens": 4},
        )

    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "cached_generate", generate)

    result = asyncio.run(
        plan_article(FakeRepository(), Settings(app_env="test"), base_context(), POLICY)
    )
    artifact = store.objects[result["output_ref"]]

    assert len(payloads) == 1
    assert payloads[0]["research_pack"]["project"] == {}
    assert artifact["plan"]["title"] == neutral.title
    assert "ExampleTV" not in artifact["plan"]["title"]
    assert result["usage"]["input_tokens"] == 8
    assert result["usage"]["output_tokens"] == 4


def test_explicit_brand_planning_keeps_project_profile_in_first_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_store(monkeypatch)
    pack = {
        "keyword": "ExampleCRM pricing",
        "country": "US",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleCRM",
                "products_services": ["Customer relationship management software"],
            },
        },
        "serp": {},
        "serp_analysis": {},
        "required_questions": [],
        "competitors": [],
        "competitor_blueprint": {},
        "authority_sources": [],
        "internal_sources": [],
    }
    payloads: list[dict[str, Any]] = []

    async def build_pack(*_: Any, **__: Any) -> dict[str, Any]:
        return deepcopy(pack)

    async def generate(
        _gateway: Any,
        _settings: Settings,
        _context: dict[str, Any],
        _call: str,
        payload: dict[str, Any],
        _output: Any,
    ) -> Any:
        payloads.append(deepcopy(payload))
        return SimpleNamespace(value=plan_with_sections(1), usage={})

    monkeypatch.setattr(generation, "build_research_pack", build_pack)
    monkeypatch.setattr(generation, "cached_generate", generate)

    asyncio.run(plan_article(FakeRepository(), Settings(app_env="test"), base_context(), POLICY))

    assert payloads[0]["research_pack"]["project"]["profile"]["business_name"] == "ExampleCRM"


def test_explicit_brand_keyword_does_not_trigger_neutral_replanning() -> None:
    plan = plan_with_sections(1).model_copy(
        update={
            "title": "ExampleTV download guide",
            "search_intent": "Download ExampleTV",
        }
    )
    pack = {
        "keyword": "ExampleTV download",
        "project": {
            "domain": "example.com",
            "profile": {"business_name": "ExampleTV"},
        },
    }

    assert generation._plan_has_unrequested_project_focus(plan, pack) is False


def test_fallback_plan_keeps_sources_without_making_project_the_answer() -> None:
    authority_url = "https://authority.example/live-video"
    project_url = "https://example.com/download"
    pack = {
        "keyword": "live video streaming",
        "required_questions": ["Where can I start?"],
        "content_brief": {"content_type": "Guide"},
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "business_summary": "ExampleTV provides live video streaming.",
                "products_services": ["Live video streaming"],
                "value_propositions": ["Supports phones and televisions"],
                "conversion_actions": ["Download ExampleTV"],
                "key_pages": [
                    {
                        "url": project_url,
                        "title": "Download ExampleTV",
                        "description": "Official download page",
                    }
                ],
            },
        },
        "authority_sources": [
            {
                "url": authority_url,
                "title": "Official live video information",
                "excerpt": "The service provides live video streaming on supported devices.",
                "research_claim": "The service provides live video streaming on supported devices.",
                "verification_claims": [
                    {
                        "claim": "The service provides live video streaming on supported devices.",
                        "evidence": "The service provides live video streaming on supported devices.",
                        "status": "verified",
                    }
                ],
            },
            {
                "url": "https://example.com/product",
                "title": "ExampleTV product page",
                "excerpt": "ExampleTV product details.",
                "verification_claims": [
                    {
                        "claim": "ExampleTV product claim.",
                        "evidence": "ExampleTV product details.",
                    }
                ],
            },
        ],
        "competitors": [],
        "competitor_blueprint": {},
        "internal_sources": [],
    }

    plan = generation.fallback_plan(pack)

    assert plan.title != pack["keyword"]
    assert "ExampleTV" not in plan.title
    assert all("ExampleTV" not in section.heading for section in plan.sections)
    assert {claim.source_url for claim in plan.claims} == {authority_url}
    assert any(plan.claims[0].claim_id in section.claim_ids for section in plan.sections)
    assert all(project_url not in section.internal_urls for section in plan.sections)


def test_research_pack_has_stable_fields_when_all_optional_sources_are_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(generation, "_source_summaries", no_summaries)
    pack = asyncio.run(
        build_research_pack(
            FakeRepository(), Settings(app_env="test"), base_context()
        )
    )

    assert pack["competitors"] == []
    assert pack["authority_sources"] == []
    assert pack["internal_sources"] == []
    assert pack["questions"] == []
    assert pack["required_questions"] == []
    assert "evidence_capabilities" not in pack


def test_research_pack_carries_serp_analysis_and_content_brief(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    serp_analysis = {
        "dominant_content_type": "Comparison",
        "content_type_distribution": {"Comparison": 6, "Review": 4},
        "content_brief": {
            "content_type": "Comparison",
            "must_have_elements": ["Comprehensive coverage"],
            "structure_recommendations": ["Introduction", "Main sections (3-5)"],
        },
    }
    repo = FakeRepository(
        {
            "serp": [
                source(
                    "serp://google/run-1",
                    summary={"serp_analysis": serp_analysis},
                )
            ]
        }
    )
    monkeypatch.setattr(generation, "_source_summaries", no_summaries)

    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )

    assert pack["serp_analysis"] == serp_analysis
    assert pack["content_brief"] == serp_analysis["content_brief"]


def test_research_pack_backfills_analysis_from_legacy_serp_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def no_summaries(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return []

    repo = FakeRepository(
        {
            "serp": [
                source(
                    "serp://google/run-1",
                    summary={
                        "keyword": "solar battery",
                        "organic_results": [
                            {
                                "position": 1,
                                "url": "https://example.net/tutorial",
                                "title": "Solar Battery Tutorial",
                            }
                        ],
                    },
                )
            ]
        }
    )
    monkeypatch.setattr(generation, "_source_summaries", no_summaries)

    pack = asyncio.run(
        build_research_pack(repo, Settings(app_env="test"), base_context())
    )

    assert pack["serp_analysis"]["dominant_content_type"] == "How-To Guide"
    assert pack["content_brief"]["content_type"] == "How-To Guide"


def test_plan_normalization_preserves_model_article_type() -> None:
    plan = plan_with_sections(1).model_copy(update={"article_type": "Review"})
    pack = {
        "keyword": "solar battery",
        "project": {"domain": "project.example"},
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    assert normalized.article_type == "Review"


def test_plan_normalization_canonicalizes_a_best_options_listicle_type() -> None:
    plan = plan_with_sections(1).model_copy(
        update={"article_type": "listicle / best options comparison"}
    )
    pack = {
        "keyword": "best remote team tools",
        "project": {"domain": "project.example"},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    assert normalized.article_type == "Listicle / Best X"


def test_generic_plan_is_not_rewritten_as_a_project_product_article() -> None:
    cta_url = "https://example.com/download"
    home_url = "https://example.com/"
    plan = ArticlePlan(
        title="Live TV streaming for sports",
        search_intent="Find a practical way to stream live sports",
        article_type="Guide",
        meta_title="Live TV streaming for sports",
        meta_description="Compare ways to stream live sports.",
        slug="live-tv-streaming-sports",
        sections=[
            OutlineSection(
                section_id="intro",
                heading="Live sports streaming options",
                objective="Introduce the available options",
                internal_urls=[home_url],
                required_questions=[
                    "Where can I stream free live sports in South Africa?",
                    "Which streaming service is best for live sports?",
                ],
                competitor_gaps=["Compare the leading paid services"],
                data_requirements=["Include a broadcaster channel lineup"],
            ),
            OutlineSection(
                section_id="comparison",
                heading="Compare broadcasters",
                objective="Compare public and paid broadcasters",
            ),
            OutlineSection(
                section_id="conclusion",
                heading="Choose a service",
                objective="Help the reader choose",
            ),
            OutlineSection(
                section_id="setup",
                heading="Device setup",
                objective="Explain installation and device setup",
            ),
            OutlineSection(
                section_id="data",
                heading="Data and reliability",
                objective="Explain data use and playback reliability",
            ),
            OutlineSection(
                section_id="examples",
                heading="Viewer examples",
                objective="Repeat the same choices through examples",
            ),
            OutlineSection(
                section_id="faq",
                heading="Frequently asked questions",
                objective="Repeat questions already answered above",
                required_questions=["Where can I watch live sports online?"],
            ),
            OutlineSection(
                section_id="reminder",
                heading="Before the match",
                objective="Check the fixture and verify availability before kickoff",
                coverage_points=[
                    "Confirm the schedule before the match",
                    "Recheck rights and availability before the event",
                ],
            ),
        ],
    )
    pack = {
        "keyword": "live tv streaming sports",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "business_summary": (
                    "ExampleTV provides streaming entertainment with live sports."
                ),
                "products_services": [
                    "Live sports streaming",
                    "APK and application download access",
                ],
                "value_propositions": [
                    "Supports Android phones, TV boxes, smart TVs, and Windows PC"
                ],
                "conversion_actions": [],
                "key_pages": [
                    {"url": home_url, "title": "ExampleTV"},
                    {"url": cta_url, "title": "Download ExampleTV"},
                ],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Live sports streaming",
                        "quote": "Live sports streaming",
                        "source_url": home_url,
                    },
                    {
                        "field": "value_propositions",
                        "value": (
                            "Supports Android phones, TV boxes, smart TVs, and Windows PC"
                        ),
                        "quote": (
                            "Supports Android phones, TV boxes, smart TVs, and Windows PC"
                        ),
                        "source_url": home_url,
                    },
                    {
                        "field": "conversion_actions",
                        "value": "Download for Free",
                        "source_url": home_url,
                    },
                    {
                        "field": "languages",
                        "value": "en-US",
                        "source_url": home_url,
                    },
                    {
                        "field": "target_audiences",
                        "value": "Resellers",
                        "quote": "Reseller",
                        "source_url": cta_url,
                    },
                ],
            },
        },
        "serp_analysis": {"dominant_content_type": "Guide"},
        "content_brief": {},
        "competitor_blueprint": {},
        "authority_sources": [
            {
                "url": "https://example.com/sports",
                "title": "Sports on ExampleTV",
                "excerpt": "Watch rugby, football and cricket. Open Live TV and filter by Sports.",
                "verification_claims": [
                    {
                        "claim": "ExampleTV carries rugby, football and cricket.",
                        "evidence": "Watch rugby, football and cricket.",
                        "status": "verified",
                    },
                    {
                        "claim": "Open Live TV and filter by Sports.",
                        "evidence": "Open Live TV and filter by Sports.",
                        "status": "verified",
                    },
                ],
            },
            {
                "url": "https://example.com/account",
                "title": "Register for ExampleTV",
                "excerpt": "Open Profile, choose Register, enter an email or phone number, then enter the verification code.",
                "verification_claims": [
                    {
                        "claim": "Register from Profile with an email or phone number and verification code.",
                        "evidence": "Open Profile, choose Register, enter an email or phone number, then enter the verification code.",
                        "status": "paraphrase",
                    }
                ],
            },
            {
                "url": "https://competitor.example/sports",
                "title": "Competitor sports package",
                "excerpt": "CompetitorTV requires a premium sports package.",
                "verification_claims": [
                    {
                        "claim": "CompetitorTV requires a premium sports package.",
                        "evidence": "CompetitorTV requires a premium sports package.",
                        "status": "verified",
                    }
                ],
            },
        ],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    answer = normalized.sections[0]
    answer_text = " ".join(
        [
            answer.heading,
            answer.objective,
            *answer.coverage_points,
        ]
    )
    assert [section.heading for section in normalized.sections] == [
        section.heading for section in plan.sections
    ]
    assert normalized.title == plan.title
    assert normalized.meta_title == plan.meta_title
    assert normalized.meta_description == plan.meta_description
    assert normalized.search_intent == plan.search_intent
    assert "exampletv" not in answer_text.casefold()
    assert cta_url not in answer.internal_urls
    assert answer.cta_type is None
    assert len(normalized.sections) == len(plan.sections)
    assert normalized.total_word_target == sum(
        section.word_target for section in normalized.sections
    )
    product_claims = [
        claim
        for claim in normalized.claims
        if claim.source_url.startswith("https://example.com/")
    ]
    assert [claim.claim for claim in product_claims] == ["Live sports streaming"]
    assert all("exampletv" not in claim.claim.casefold() for claim in product_claims)
    assert len({claim.claim_id for claim in normalized.claims}) == len(normalized.claims)
    assert any(
        claim.source_url == "https://competitor.example/sports"
        for claim in normalized.claims
    )


def test_generic_planning_pack_excludes_project_owned_material() -> None:
    pack = {
        "keyword": "solar battery payback",
        "project": {
            "domain": "project.example",
            "profile": {
                "business_name": "ExampleEnergy",
                "business_summary": "ExampleEnergy sells home energy products.",
            },
        },
        "serp": {
            "organic_results": [
                {"url": "https://project.example/solar", "title": "ExampleEnergy"},
                {"url": "https://authority.example/solar", "title": "Solar guide"},
            ]
        },
        "authority_sources": [
            {
                "url": "https://project.example/solar",
                "title": "ExampleEnergy solar products",
                "excerpt": "Project product information.",
            },
            {
                "url": "https://authority.example/solar",
                "title": "Independent solar guide",
                "excerpt": "Independent research.",
            },
        ],
        "competitors": [
            {"url": "https://project.example/solar", "title": "ExampleEnergy"},
            {"url": "https://competitor.example/solar", "title": "Market guide"},
        ],
        "internal_sources": [
            {"url": "https://project.example/contact", "title": "Contact"}
        ],
    }

    payload = generation._planning_research_pack(
        pack, include_project_profile=False
    )

    assert payload["project"] == {}
    assert payload["internal_sources"] == []
    assert [item["url"] for item in payload["serp_results"]] == [
        "https://authority.example/solar"
    ]
    assert [item["url"] for item in payload["research_sources"]] == [
        "https://authority.example/solar"
    ]
    assert [item["url"] for item in payload["competitor_articles"]] == [
        "https://competitor.example/solar"
    ]


def test_generic_article_rejects_unrelated_explicit_or_prompted_cta() -> None:
    cta_url = "https://project.example/payroll-trial"
    sections = [
        OutlineSection(
            section_id="maintenance",
            heading="Solar battery maintenance",
            objective="Explain routine battery maintenance",
            internal_urls=[cta_url],
            cta_type="strong",
        )
    ]
    pack = {
        "keyword": "solar battery maintenance",
        "project": {
            "domain": "project.example",
            "profile": {
                "business_name": "ExamplePayroll",
                "business_summary": "Payroll software for small businesses.",
                "products_services": ["Payroll and employee scheduling"],
                "conversion_actions": ["Start a payroll trial"],
                "key_pages": [
                    {
                        "url": cta_url,
                        "title": "Start a payroll trial",
                        "description": "Payroll software trial",
                    }
                ],
            },
        },
    }

    assert generation._select_cta_assignment(sections, pack) is None


def test_generic_article_uses_same_category_project_as_a_conversion_option() -> None:
    project_url = "https://project.example/"
    plan = ArticlePlan(
        title="Live sports streaming options",
        search_intent="Compare live sports streaming options",
        article_type="comparison",
        meta_title="Live sports streaming options",
        meta_description="Compare live sports streaming options.",
        slug="live-sports-streaming-options",
        sections=[
            OutlineSection(
                section_id="comparison",
                heading="Compare live sports streaming services",
                objective="Compare coverage, devices and cost",
                internal_urls=[project_url],
                cta_type="strong",
            )
        ],
    )
    pack = {
        "keyword": "live sports streaming",
        "project": {
            "domain": "project.example",
            "profile": {
                "business_name": "ExampleTV",
                "business_summary": "ExampleTV provides live sports streaming.",
                "products_services": ["Live sports streaming"],
                "conversion_actions": ["Download ExampleTV"],
                "key_pages": [
                    {
                        "url": project_url,
                        "title": "Download ExampleTV",
                        "description": "Live sports streaming app",
                    }
                ],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Live sports streaming",
                        "quote": "Live sports streaming",
                        "source_url": project_url,
                    },
                    {
                        "field": "conversion_actions",
                        "value": "Download ExampleTV",
                        "source_url": project_url,
                    },
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
        "required_questions": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    assert generation._project_article_role(pack) == "conversion"
    assert generation._select_cta_assignment(normalized.sections, pack) == (
        "section-1",
        project_url,
    )
    assert any(
        claim.source_url.startswith("https://project.example")
        for claim in normalized.claims
    )


def test_article_writing_brief_uses_the_matching_type_template_without_stale_dimensions() -> None:
    pack = {
        "keyword": "remote team collaboration tools",
        "country": "GB",
        "required_questions": [
            "Which collaboration tool is best for a remote team?",
        ],
        "competitor_blueprint": {
            "comparison_dimensions": [
                "subscription price",
                "cleaning performance",
                "size and capacity",
            ]
        },
        "authority_sources": [
            {
                "url": "https://authority.example/tools",
                "title": "Collaboration tool subscription prices",
                "excerpt": "Compare subscription price and team access.",
            }
        ],
        "project": {"domain": "project.example", "profile": {}},
    }

    brief = generation._article_writing_brief(pack)

    assert brief["recommended_article_type"] == "Listicle / Best X"
    assert "H2: Best for [scenario]: [item]" in brief["article_type_structure"]
    assert "Direct answer" in brief["article_type_structure"]
    assert "not a visible H2" in brief["heading_rule"]
    assert brief["comparison_dimensions"] == ["subscription price"]


def test_project_article_role_distinguishes_core_conversion_and_unrelated() -> None:
    conversion_pack = {
        "keyword": "remote team collaboration tools",
        "project": {
            "domain": "project.example",
            "profile": {
                "business_name": "ExampleWork",
                "products_services": ["Remote team collaboration software"],
                "conversion_actions": ["Start a trial"],
                "key_pages": [
                    {
                        "url": "https://project.example/trial",
                        "title": "Start an ExampleWork trial",
                    }
                ],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Remote team collaboration software",
                        "quote": "Remote team collaboration software",
                        "source_url": "https://project.example/",
                    },
                    {
                        "field": "conversion_actions",
                        "value": "Start a trial",
                        "source_url": "https://project.example/trial",
                    },
                ],
            },
        },
    }
    core_pack = {
        **conversion_pack,
        "keyword": "ExampleWork review",
    }
    unrelated_pack = {
        **conversion_pack,
        "keyword": "solar battery maintenance",
    }

    assert generation._project_article_role(core_pack) == "core"
    assert generation._project_article_role(conversion_pack) == "conversion"
    assert generation._project_article_role(unrelated_pack) == "unrelated"


def test_conversion_planning_pack_contains_only_verified_project_context() -> None:
    cta_url = "https://project.example/trial"
    pack = {
        "keyword": "remote team collaboration tools",
        "project": {
            "domain": "project.example",
            "profile": {
                "business_name": "ExampleWork",
                "business_summary": "ExampleWork is used for remote collaboration.",
                "products_services": [
                    "Remote team collaboration software",
                    "Unverified adjacent service",
                ],
                "conversion_actions": ["Start a trial"],
                "key_pages": [
                    {"url": cta_url, "title": "Start an ExampleWork trial"},
                    {
                        "url": "https://project.example/other",
                        "title": "Unrelated page",
                    },
                ],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Remote team collaboration software",
                        "quote": "Remote team collaboration software",
                        "source_url": "https://project.example/",
                    },
                    {
                        "field": "conversion_actions",
                        "value": "Start a trial",
                        "source_url": cta_url,
                    },
                ],
            },
        },
        "serp": {"organic_results": []},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [
            {"url": cta_url, "title": "Start an ExampleWork trial"},
            {"url": "https://project.example/other", "title": "Unrelated page"},
        ],
    }

    payload = generation._planning_research_pack(pack)
    profile = payload["project"]["profile"]

    assert payload["project"]["role"] == "conversion"
    assert profile["business_name"] == "ExampleWork"
    assert profile["products_services"] == ["Remote team collaboration software"]
    assert "Unverified adjacent service" not in str(profile)
    assert [item["url"] for item in profile["cta_targets"]] == [cta_url]
    assert [item["url"] for item in payload["internal_sources"]] == [cta_url]


def test_plan_claim_ids_remain_unique_when_model_claims_are_preserved() -> None:
    source_url = "https://example.com/verified"
    plan = plan_with_sections(1).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="model-invalid",
                    claim="Unsupported claim",
                    source_url="https://unverified.example/fact",
                    quote="Unsupported claim",
                ),
                EvidenceClaim(
                    claim_id="model-valid",
                    claim="Verified model claim",
                    source_url=source_url,
                    quote="Verified model claim",
                ),
            ],
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={"claim_ids": ["model-valid"]}
                )
            ],
        }
    )
    pack = {
        "keyword": "Example streaming app",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "Example",
                "products_services": ["Project streaming app claim"],
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "Project streaming app claim",
                        "quote": "Project streaming app claim",
                        "source_url": source_url,
                    }
                ],
            },
        },
        "serp_analysis": {"dominant_content_type": "Guide"},
        "content_brief": {},
        "competitor_blueprint": {},
        "authority_sources": [
            {
                "url": source_url,
                "title": "Verified source",
                "excerpt": "Verified model claim. Project streaming app claim.",
            }
        ],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)

    assert {claim.claim for claim in normalized.claims} == {
        "Unsupported claim",
        "Verified model claim",
        "Project streaming app claim",
    }
    assert len({claim.claim_id for claim in normalized.claims}) == 3
    assigned_claim_ids = {
        claim_id for section in normalized.sections for claim_id in section.claim_ids
    }
    assert "claim-2" in assigned_claim_ids


def test_project_evidence_is_available_to_the_product_answer_section() -> None:
    source_url = "https://example.com/live-sports"
    section = OutlineSection(
        section_id="answer",
        heading="ExampleTV for live sports",
        objective="Explain the product answer",
        claim_ids=["claim-1"],
    )
    claim = EvidenceClaim(
        claim_id="claim-1",
        claim="ExampleTV provides live sports streaming.",
        quote="ExampleTV provides live sports streaming.",
        source_url=source_url,
        section_id="answer",
    )
    plan = plan_with_sections(1).model_copy(
        update={"sections": [section], "claims": [claim]}
    )
    pack = {
        "keyword": "live tv streaming sports",
        "language": "en",
        "project": {
            "domain": "example.com",
            "profile": {
                "business_name": "ExampleTV",
                "evidence": [
                    {
                        "field": "products_services",
                        "value": "ExampleTV provides live sports streaming.",
                        "quote": "ExampleTV provides live sports streaming.",
                        "source_url": source_url,
                    }
                ],
            },
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert payload["facts"] == [claim.model_dump(mode="json")]
    assert payload["sources"] == [
        {
            "url": source_url,
            "title": "ExampleTV",
            "excerpt": "ExampleTV provides live sports streaming.",
            "research_claim": "ExampleTV provides live sports streaming.",
            "verification_claims": [
                {
                    "claim": "ExampleTV provides live sports streaming.",
                    "evidence": "ExampleTV provides live sports streaming.",
                }
            ],
        }
    ]


def test_commercial_plan_without_product_evidence_preserves_the_requested_question() -> None:
    plan = ArticlePlan(
        title="10 Best Car Interior Cleaners: Tested Winners and Current Prices",
        search_intent="Choose a car interior cleaner",
        article_type="Listicle",
        meta_title="10 Best Car Interior Cleaners Ranked",
        meta_description="Our experts tested and ranked 10 products with current prices.",
        slug="best-car-interior-cleaners",
        sections=[
            OutlineSection(
                section_id="products",
                heading="10 Best Products Ranked",
                objective="Name the winner and compare current prices",
                coverage_points=["Hands-on test results", "Professional recommendation"],
            )
        ],
    )
    pack = {
        "keyword": "car interior cleaner",
        "project": {"domain": "project.example", "profile": {}},
        "serp_analysis": {"dominant_content_type": "Listicle"},
        "content_brief": {
            "content_type": "Listicle",
            "structure_recommendations": ["10 best products ranked with current prices"],
        },
        "competitor_blueprint": {},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)
    searchable = " ".join(
        [normalized.title, normalized.meta_title, normalized.meta_description]
        + [
            " ".join(
                [
                    section.heading,
                    section.objective,
                    *section.coverage_points,
                    *section.data_requirements,
                ]
            )
            for section in normalized.sections
        ]
    ).casefold()

    assert normalized.article_type == "Listicle"
    assert normalized.title == plan.title
    assert normalized.sections[0].heading == plan.sections[0].heading
    assert "selection guide" not in searchable


def test_quality_issue_classification_does_not_block_writing_for_data_gaps() -> None:
    data_gap = generation._classify_quality_issue(
        SectionIssue(
            section_id="section-1",
            code="missing_product_evidence",
            message="No named products were collected",
        )
    )
    prose_issue = generation._classify_quality_issue(
        SectionIssue(
            section_id="section-2",
            code="required_question_unanswered",
            message="Answer the required question",
        )
    )

    assert data_gap.category == "prose"
    assert data_gap.repairable is True
    assert prose_issue.category == "prose"
    assert prose_issue.repairable is True


def test_shorter_revision_is_accepted_when_it_preserves_contract_and_evidence() -> None:
    authority_url = "https://authority.example/streaming-guide"
    section_plan = OutlineSection(
        section_id="answer",
        heading="How to start streaming",
        objective="Answer the reader directly",
        section_type="body_explanation",
        word_target=500,
        claim_ids=["claim-1"],
    )
    claim = EvidenceClaim(
        claim_id="claim-1",
        claim="The service supports live streaming.",
        source_url=authority_url,
        quote="The service supports live streaming.",
        section_id="answer",
    )
    plan = plan_with_sections(1).model_copy(
        update={"sections": [section_plan], "claims": [claim]}
    )
    baseline = SectionDraft(
        section_id="answer",
        markdown=(
            "## How to start streaming\n\n"
            + "The same vague sentence is repeated without helping the reader. " * 12
            + f"The service supports live streaming [Source]({authority_url})."
        ),
        used_claim_ids=[],
        used_source_urls=[],
    )
    candidate = SectionDraft(
        section_id="answer",
        markdown=(
            "## How to start streaming\n\n"
            "Open the official service, choose the live channel you need, and confirm "
            "that it is available in your region before playback. "
            f"The service supports live streaming [Source]({authority_url})."
        ),
        used_claim_ids=[],
        used_source_urls=[],
    )

    accepted, reasons = generation._candidate_improves_article(
        plan,
        [baseline],
        {"composite_score": 70},
        plan,
        [candidate],
        {"composite_score": 70},
        {authority_url},
        set(),
        [],
        require_measurable_improvement=False,
    )

    assert accepted is True
    assert reasons == []


def test_unified_edit_is_accepted_without_inline_source_links_or_score_gain() -> None:
    authority_url = "https://authority.example/streaming-guide"
    section_plan = OutlineSection(
        section_id="answer",
        heading="How to watch live sports",
        objective="Give the complete playback path",
        claim_ids=["claim-1"],
    )
    claim = EvidenceClaim(
        claim_id="claim-1",
        claim="Open Live TV and choose Sports.",
        source_url=authority_url,
        quote="Open Live TV and choose Sports.",
        section_id="answer",
    )
    plan = plan_with_sections(1).model_copy(
        update={"sections": [section_plan], "claims": [claim]}
    )
    baseline = SectionDraft(
        section_id="answer",
        markdown=(
            "## How to watch live sports\n\n"
            f"According to the source, open Live TV and choose Sports "
            f"[source]({authority_url})."
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
    )
    candidate = SectionDraft(
        section_id="answer",
        markdown=(
            "## How to watch live sports\n\n"
            "Open Live TV, choose Sports, then select the channel or event you want."
        ),
        used_claim_ids=["claim-1"],
        used_source_urls=[authority_url],
    )

    accepted, reasons = generation._candidate_improves_article(
        plan,
        [baseline],
        {"composite_score": 70},
        plan,
        [candidate],
        {"composite_score": 70},
        {authority_url},
        set(),
        [],
        require_inline_citations=False,
        require_claim_bindings=False,
        require_measurable_improvement=False,
    )

    assert accepted is True
    assert reasons == []


def test_revision_sends_only_repairable_affected_sections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(2)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "required_questions": [],
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    sections = [
        SectionDraft(
            section_id=f"section-{index}",
            markdown=f"## Section {index}\n\nOriginal section {index}. {QUALITY_PROSE}",
        )
        for index in (1, 2)
    ]
    pack_ref = asyncio.run(store.write_json("target-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "target-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    checked = generation.article_artifact(plan, sections, pack)
    checked["quality"] = {
        "passed": False,
        "repairable": True,
        "repair_scope": ["section-2"],
        "issues": [
            {
                "section_id": "section-1",
                "code": "missing_product_evidence",
                "message": "No product evidence",
                "category": "evidence",
                "repairable": False,
            },
            {
                "section_id": "section-2",
                "code": "required_question_unanswered",
                "message": "Answer the question",
                "category": "prose",
                "repairable": True,
            },
        ],
    }
    checked_ref = asyncio.run(store.write_json("target-checked.json.gz", checked))
    received: dict[str, Any] = {}

    class Gateway:
        async def generate(
            self, _call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            received.update(payload)
            return SimpleNamespace(
                value=generation.RevisedSections(
                    sections=[
                        SectionDraft(
                            section_id="section-2",
                            markdown=f"## Section 2\n\nRevised answer. {QUALITY_PROSE}",
                        )
                    ]
                ),
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "checking": {"output_ref": checked_ref},
    }

    result = asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert [item["section_id"] for item in received["sections"]] == ["section-2"]
    assert [item["section_id"] for item in received["section_goals"]] == [
        "section-2"
    ]
    assert "official_product" not in received
    assert received["section_goals"][0]["official_product"] == {
        "conversion_actions": [],
        "cta_targets": [],
    }
    assert "issues" not in received
    assert "Original section 1" in artifact["sections"][0]["markdown"]
    assert "Revised answer" in artifact["sections"][1]["markdown"]


def test_revision_accepts_sections_without_requiring_inline_citations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    source_url = "https://authority.example/fact"
    plan = plan_with_sections(2).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-2",
                    claim="The documented fact is available.",
                    quote="The documented fact is available.",
                    source_url=source_url,
                    section_id="section-2",
                )
            ],
            "sections": [
                plan_with_sections(2).sections[0],
                plan_with_sections(2).sections[1].model_copy(
                    update={"claim_ids": ["claim-2"]}
                ),
            ],
        }
    )
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "required_questions": [],
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [{"url": source_url}],
        "competitors": [],
        "internal_sources": [],
    }
    sections = [
        SectionDraft(
            section_id="section-1",
            markdown=f"## Section 1\n\nBroken | table | row. {QUALITY_PROSE}",
        ),
        SectionDraft(
            section_id="section-2",
            markdown=(
                "## Section 2\n\n"
                f"[The documented fact is available.]({source_url}) {QUALITY_PROSE}"
            ),
        ),
    ]
    pack_ref = asyncio.run(store.write_json("partial-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "partial-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    checked = generation.article_artifact(plan, sections, pack)
    checked["quality"] = {
        "passed": False,
        "repairable": True,
        "repair_scope": ["section-1", "section-2"],
        "issues": [
            {
                "section_id": "section-1",
                "code": "malformed_markdown",
                "message": "Repair the table",
                "category": "prose",
                "repairable": True,
            },
            {
                "section_id": "section-2",
                "code": "unclear_prose",
                "message": "Clarify the prose",
                "category": "prose",
                "repairable": True,
            },
        ],
    }
    checked_ref = asyncio.run(store.write_json("partial-checked.json.gz", checked))

    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            return SimpleNamespace(
                value=generation.RevisedSections(
                    sections=[
                        SectionDraft(
                            section_id="section-1",
                            markdown=f"## Section 1\n\nRepaired table explanation. {QUALITY_PROSE}",
                        ),
                        SectionDraft(
                            section_id="section-2",
                            markdown=f"## Section 2\n\nClarified but uncited. {QUALITY_PROSE}",
                        ),
                    ]
                ),
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "checking": {"output_ref": checked_ref},
    }

    result = asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert result["summary"]["revised_sections"] == 2
    assert "Repaired table explanation" in artifact["sections"][0]["markdown"]
    assert source_url not in artifact["sections"][1]["markdown"]
    assert "Clarified but uncited" in artifact["sections"][1]["markdown"]
    assert result["warnings"] == []


def test_section_revision_rescores_without_duplicate_full_article_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "required_questions": [],
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    original = SectionDraft(
        section_id="section-1",
        markdown=f"## Section 1\n\nOriginal checked prose. {QUALITY_PROSE}",
    )
    pack_ref = asyncio.run(store.write_json("final-score-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "final-score-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    previous_score = {
        "composite_score": 75.0,
        "passed": True,
        "threshold": 70,
        "dimensions": {},
        "priority_fixes": [],
    }
    checked = generation.article_artifact(plan, [original], pack)
    checked["content_score"] = previous_score
    checked["content_score_history"] = [previous_score]
    checked["quality"] = {
        "passed": False,
        "repairable": True,
        "repair_scope": ["section-1"],
        "issues": [
            {
                "section_id": "section-1",
                "code": "required_question_unanswered",
                "message": "Answer the required question",
                "category": "prose",
                "repairable": True,
            }
        ],
    }
    checked_ref = asyncio.run(store.write_json("final-score-checked.json.gz", checked))
    scores = iter([65.0, 72.0])

    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            value = next(scores)
            return {
                "composite_score": value,
                "passed": value >= 70,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [{"issue": "Improve prose", "fix": "Revise it"}],
            }

    calls: list[str] = []

    class Gateway:
        async def generate(
            self, call: str, _payload: dict[str, Any], _output: Any
        ) -> Any:
            calls.append(call)
            section = SectionDraft(
                section_id="section-1",
                markdown=f"## Section 1\n\n{call} result. {QUALITY_PROSE}",
            )
            value: Any
            if call == "revise_sections":
                value = generation.RevisedSections(sections=[section])
            else:
                assert call == "revise_quality"
                value = UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[section],
                )
            return SimpleNamespace(
                value=value,
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "ContentScorer", Scorer)
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "checking": {"output_ref": checked_ref},
    }

    result = asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert calls == ["revise_sections"]
    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        75.0,
        72.0,
    ]
    assert artifact["content_score"]["composite_score"] == 72.0
    assert artifact["content_score_revision_count"] == 0
    assert result["summary"]["content_score_passed"] is True
    assert result["summary"]["content_score_iterations"] == 0
    assert all(
        item["code"] != "content_quality_below_threshold"
        for item in result["warnings"]
    )


def test_low_score_section_revision_returns_complete_article_without_duplicate_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = patch_store(monkeypatch)
    plan = plan_with_sections(1)
    pack = {
        "keyword": "solar battery payback",
        "language": "en",
        "required_questions": [],
        "project": {"domain": "project.example", "profile": {}},
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }
    original = SectionDraft(
        section_id="section-1",
        markdown=f"## Section 1\n\nOriginal checked prose. {QUALITY_PROSE}",
    )
    pack_ref = asyncio.run(store.write_json("low-final-score-pack.json.gz", pack))
    planning_ref = asyncio.run(
        store.write_json(
            "low-final-score-plan.json.gz",
            {"research_pack_ref": pack_ref, "plan": plan.model_dump(mode="json")},
        )
    )
    checked = generation.article_artifact(plan, [original], pack)
    checked["quality"] = {
        "passed": False,
        "repairable": True,
        "repair_scope": ["section-1"],
        "issues": [
            {
                "section_id": "section-1",
                "code": "required_question_unanswered",
                "message": "Answer the required question",
                "category": "prose",
                "repairable": True,
            }
        ],
    }
    checked_ref = asyncio.run(
        store.write_json("low-final-score-checked.json.gz", checked)
    )
    scores = iter([65.0, 66.0, 68.0])

    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            value = next(scores)
            return {
                "composite_score": value,
                "passed": False,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [{"issue": "Improve prose", "fix": "Revise it"}],
            }

    calls: list[str] = []

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            calls.append(call)
            revision_label = (
                "final quality revision"
                if call == "revise_quality" and payload.get("iteration") == 2
                else call
            )
            section = SectionDraft(
                section_id="section-1",
                markdown=(
                    f"## Section 1\n\nThe {revision_label} preserves useful prose. "
                    f"{QUALITY_PROSE}"
                ),
            )
            value: Any
            if call == "revise_sections":
                value = generation.RevisedSections(sections=[section])
            else:
                assert call == "revise_quality"
                value = UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[section],
                )
            return SimpleNamespace(
                value=value,
                usage={"input_tokens": 5, "output_tokens": 5},
            )

    monkeypatch.setattr(generation, "ContentScorer", Scorer)
    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "checking": {"output_ref": checked_ref},
    }

    result = asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert calls == ["revise_sections"]
    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        66.0,
    ]
    assert artifact["content_score"]["composite_score"] == 66.0
    assert artifact["content_score_revision_count"] == 0
    assert result["summary"]["content_score_passed"] is False
    assert result["summary"]["content_score_iterations"] == 0
    assert "The revise_sections preserves useful prose" in artifact["markdown"]
    assert result["warnings"] == []


def test_plan_normalization_does_not_force_content_brief_into_outline() -> None:
    plan = plan_with_sections(1).model_copy(update={"article_type": "guide"})
    structure = [
        "Introduction (what you'll learn)",
        "Prerequisites/Requirements",
        "Step-by-step instructions",
        "Common mistakes to avoid",
        "FAQs",
        "Conclusion/Next steps",
    ]
    must_have = [
        "Step-by-step instructions",
        "Visual aids (screenshots, diagrams)",
        "Prerequisites section",
        "Time estimate",
        "Troubleshooting tips",
    ]
    feature_targets = [
        "Featured Snippet - Add concise definition/answer in first 100 words",
        "People Also Ask - Add FAQ section answering related questions",
        "Video - Consider embedding relevant video or creating one",
        "Images - Include high-quality images with alt text",
    ]
    pack = {
        "keyword": "solar battery",
        "language": "en",
        "project": {"domain": "project.example"},
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "content_brief": {
            "content_type": "How-To Guide",
            "structure_recommendations": structure,
            "must_have_elements": must_have,
            "serp_features_to_target": feature_targets,
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)
    coverage = {
        point for section in normalized.sections for point in section.coverage_points
    }

    assert len(normalized.sections) == 1
    assert not {f"SERP structure: {item}" for item in structure}.intersection(coverage)
    assert not {f"Required element: {item}" for item in must_have}.intersection(coverage)
    assert not {f"SERP feature target: {item}" for item in feature_targets}.intersection(
        coverage
    )

    writing_payloads = [
        generation.section_payload(normalized, section, pack, [], compact=False)
        for section in normalized.sections
    ]
    writing_coverage = {
        point
        for payload in writing_payloads
        for point in payload["section"]["coverage_points"]
    }
    assert writing_coverage == coverage


def test_fallback_plan_does_not_use_serp_content_brief_structure() -> None:
    pack = {
        "keyword": "solar battery",
        "required_questions": ["How long does installation take?"],
        "content_brief": {
            "content_type": "How-To Guide",
            "structure_recommendations": [
                "Introduction (what you'll learn)",
                "Prerequisites/Requirements",
                "Step-by-step instructions",
                "Common mistakes to avoid",
                "FAQs",
                "Conclusion/Next steps",
            ],
        },
    }

    plan = generation.fallback_plan(pack)

    assert plan.article_type == "guide"
    assert [item.heading for item in plan.sections] == [
        "Understanding solar battery",
        "Key considerations",
        "A practical process",
    ]
    assert not set(item.heading for item in plan.sections).intersection(
        pack["content_brief"]["structure_recommendations"]
    )


def test_serp_requirements_do_not_modify_full_model_coverage() -> None:
    plan = plan_with_sections(1)
    plan.sections[0].coverage_points = [f"Model point {index}" for index in range(12)]
    pack = {
        "keyword": "solar battery",
        "project": {"domain": "project.example"},
        "serp_analysis": {"dominant_content_type": "How-To Guide"},
        "content_brief": {
            "content_type": "How-To Guide",
            "structure_recommendations": ["Introduction (what you'll learn)"],
            "must_have_elements": ["Step-by-step instructions"],
            "serp_features_to_target": [
                "Featured Snippet - Add concise definition/answer in first 100 words"
            ],
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    normalized = generation.normalize_plan(plan, pack)
    coverage = normalized.sections[0].coverage_points

    assert len(coverage) == 12
    assert coverage == [f"Model point {index}" for index in range(12)]
