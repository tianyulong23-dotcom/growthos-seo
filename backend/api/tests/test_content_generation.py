import asyncio
import json
from copy import deepcopy
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
    sanitize_sections,
)
from app.modules.content.writing_gateway import (
    ArticlePlan,
    EvidenceClaim,
    LockedRequirementCheck,
    OutlineSection,
    SectionDraft,
    SectionIssue,
    SemanticQualityResult,
    UnifiedArticle,
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
    assert pack["article_type"] == "How-To Guide"
    assert pack["authority_sources"][0]["url"] == authority_url
    assert pack["authority_sources"][0]["excerpt"] == "Verified fact"
    assert pack["authority_sources"][0] == {
        "url": authority_url,
            "title": "Source",
            "excerpt": "Verified fact",
            "research_answer": "",
            "citation_excerpt": "",
            "research_claim": "The model proposed this fact.",
        "verification_status": "verified",
        "verification_method": "page_text_match_v1",
        "source_tier": "tier_1_official_public_or_standards",
        "provider": "responses",
        "model": "research-model",
        "queries": ["official facts"],
        "failed_queries": ["current prices"],
        "cached": True,
        "verified_url": authority_url,
        "echo_cluster_id": "source-1",
        "independent_source": True,
            "verification_claims": [
            {
                "claim": "The model proposed this fact.",
                "status": "verified",
                "evidence": "Verified fact",
                }
            ],
            "crawler": {},
        }
    assert pack["internal_sources"][0]["url"] == internal_url
    assert repo.bound_plan is not None
    assert repo.bound_plan["claims"][0]["claim_id"] == "claim-1"
    assert repo.bound_plan["claims"][0]["section_id"] == "section-1"
    assert repo.bound_plan["sections"][0]["claim_ids"] == ["claim-1"]
    assert repo.bound_plan["sections"][0]["internal_urls"] == [internal_url]


def test_supplemental_research_only_queries_unsupported_load_bearing_requirements() -> None:
    plan = plan_with_sections(1).model_copy(
        update={
            "sections": [
                plan_with_sections(1).sections[0].model_copy(
                    update={
                        "data_requirements": [
                            "Explain the installation steps clearly",
                            "current federal tax credit rules",
                            "2026 average installation cost",
                            "current product availability by region",
                            "comparison ranking methodology",
                            "latest warranty statistics",
                        ]
                    }
                )
            ]
        }
    )
    pack = {
        "keyword": "solar battery",
        "country": "US",
        "questions": ["How long is solar battery payback?"],
        "required_questions": ["Are solar batteries worth it?"],
        "authority_sources": [],
        "content_brief": {},
    }

    queries = generation._supplemental_research_queries(plan, pack)

    assert len(queries) == 4
    assert all("installation steps clearly" not in query for query in queries)
    assert "How long is solar battery payback?" not in queries
    assert "Are solar batteries worth it?" not in queries
    assert any("current federal tax credit rules" in query for query in queries)


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
    assert pack["content_brief"]["secondary_keywords"] == [
        "editorial calendar",
        "content workflow",
    ]
    assert artifact["plan"]["title"] == "Locked Content Plan Title"
    assert generation.fallback_plan(pack).title == "Locked Content Plan Title"


def test_existing_section_evidence_suppresses_supplemental_research() -> None:
    authority_url = "https://irs.gov/solar-credit"
    section = plan_with_sections(1).sections[0].model_copy(
        update={
            "heading": "Federal solar battery tax credit requirements",
            "objective": "Explain current federal solar battery tax credit eligibility",
            "data_requirements": ["current federal tax credit rules"],
            "claim_ids": ["claim-existing"],
        }
    )
    plan = plan_with_sections(1).model_copy(
        update={
            "sections": [section],
            "claims": [
                EvidenceClaim(
                    claim_id="claim-existing",
                    claim="Federal eligibility rules apply.",
                    source_url=authority_url,
                    quote="Federal eligibility rules apply.",
                    section_id=section.section_id,
                )
            ],
        }
    )
    pack = {
        "keyword": "solar battery tax credit",
        "country": "US",
        "project": {},
        "content_brief": {},
        "authority_sources": [
            {
                "url": authority_url,
                "title": "Federal solar battery tax credit eligibility requirements",
                "excerpt": "Federal eligibility rules apply.",
            }
        ],
    }

    assert generation._supplemental_research_queries(plan, pack) == []


def test_successful_supplemental_research_rebuilds_pack_before_normalization(
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
        }
    )
    packs = iter([initial_pack, supplemented_pack])
    pack_calls = 0
    research_queries: list[str] = []

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
    ) -> tuple[None, int]:
        research_queries.extend(exact_questions)
        return None, 1

    async def generate(*_: Any, **__: Any) -> Any:
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
    assert len(research_queries) == 1
    assert "current federal tax credit rules" in research_queries[0]
    assert "What is a solar battery?" not in research_queries
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
            ]
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


def test_planning_rejects_quote_taken_from_another_source() -> None:
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

    assert [claim.claim for claim in normalized.claims] == ["Cycle limits vary"]
    assert normalized.sections[0].claim_ids == ["claim-2"]


def test_planning_rejects_claim_that_contradicts_its_quote() -> None:
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

    assert normalized.claims == []
    assert normalized.sections[0].claim_ids == []


def test_planning_drops_claim_not_assigned_to_any_section() -> None:
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

    assert normalized.claims == []


def test_explicit_non_independent_source_never_enters_research_pack(
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

    assert pack["authority_sources"] == []


def test_legacy_authority_and_research_sources_never_enter_research_pack(
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

    assert pack["authority_sources"] == []


def test_unreachable_research_source_never_enters_research_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeRepository(
        {
            "authority": [
                source(
                    "https://authority.example/unreachable",
                    status="failed",
                    summary={
                        "citation_excerpt": "A model-returned exact quote.",
                        "research_claim": "A model-returned claim.",
                    },
                    metadata={
                        "source": "web_research",
                        "verification_status": "unreachable",
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

    assert pack["authority_sources"] == []


def test_research_pack_exposes_only_verified_claims_and_page_evidence(
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
    assert authority["research_claim"] == verified_claim
    assert authority["research_answer"] == ""
    assert authority["citation_excerpt"] == ""
    assert authority["verification_claims"] == [
        {
            "claim": verified_claim,
            "status": "verified",
            "evidence": page_evidence,
        }
    ]
    assert rejected_claim not in json.dumps(authority)


def test_echo_duplicate_never_enters_research_pack_or_plan_claims(
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

    assert [item["url"] for item in pack["authority_sources"]] == [verified_url]
    assert [claim.source_url for claim in normalized.claims] == [verified_url]
    assert normalized.sections[0].claim_ids == ["claim-1"]


def test_section_failure_retries_once_then_uses_complete_short_section(
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
    attempts: dict[str, int] = {}
    payloads: dict[str, list[dict[str, Any]]] = {}

    class Gateway:
        async def generate(self, call: str, payload: dict[str, Any], _output: Any) -> Any:
            section_id = str(payload["section"]["section_id"])
            if call == "edit_section":
                return SimpleNamespace(
                    value=SectionDraft.model_validate(payload["draft"]),
                    usage={"input_tokens": 5, "output_tokens": 10},
                )
            attempts[section_id] = attempts.get(section_id, 0) + 1
            payloads.setdefault(section_id, []).append(deepcopy(payload))
            if section_id == "section-1" and attempts[section_id] == 1:
                raise RuntimeError("first attempt failed")
            if section_id == "section-2":
                raise RuntimeError("both attempts failed")
            return SimpleNamespace(
                value=SectionDraft(
                    section_id=section_id,
                    markdown="Useful answer after retry.",
                    summary="Useful answer",
                ),
                usage={"input_tokens": 5, "output_tokens": 10},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    result = asyncio.run(
        write_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )
    artifact = store.objects[result["output_ref"]]

    assert attempts == {"section-1": 2, "section-2": 2}
    assert result["summary"]["section_count"] == 2
    assert result["summary"]["complete"] is True
    assert result["summary"]["model_failures"] == [
        {
            "section_id": "section-1",
            "mode": "full",
            "code": "writing_unexpected_error",
            "attempts": 0,
            "format_attempts": 0,
        },
        {
            "section_id": "section-2",
            "mode": "full",
            "code": "writing_unexpected_error",
            "attempts": 0,
            "format_attempts": 0,
        },
        {
            "section_id": "section-2",
            "mode": "compact",
            "code": "writing_unexpected_error",
            "attempts": 0,
            "format_attempts": 0,
        },
    ]
    assert [item["section_id"] for item in artifact["sections"]] == [
        "section-1",
        "section-2",
    ]
    assert artifact["sections"][0]["markdown"].startswith("## Section 1")
    assert "Explain topic 2" in artifact["sections"][1]["markdown"]
    assert payloads["section-2"][0]["previous_section_summaries"] == [
        "Useful answer"
    ]
    assert [item["code"] for item in result["warnings"]] == ["writing_degraded"]


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
    assert [item["code"] for item in checked["warnings"]] == ["checking_degraded"]
    assert "A complete useful answer." in store.objects[checked["output_ref"]]["markdown"]
    assert checked["summary"] == {
        "issue_count": 0,
        "passed": False,
        "check_status": "unavailable",
        "repairable": False,
        "repair_scope": [],
        "issue_fingerprint": [],
        "repairable_issue_fingerprint": [],
        "repairable_issue_count": 0,
        "evidence_issue_count": 0,
        "content_score": 77.5,
        "content_score_passed": True,
        "model_failure": {
            "code": "writing_unexpected_error",
            "attempts": 0,
            "format_attempts": 0,
        },
    }
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


def test_semantic_check_receives_only_required_questions(
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
    received_questions: list[str] = []

    class Gateway:
        async def generate(
            self, _call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            received_questions.extend(payload["required_questions"])
            return SimpleNamespace(
                value=SemanticQualityResult(passed=True),
                usage={"input_tokens": 5, "output_tokens": 1},
            )

    monkeypatch.setattr(generation, "writing_gateway", lambda _context: Gateway())
    context = base_context()
    context["completed_steps"] = {
        "planning": {"output_ref": planning_ref},
        "editing": {"output_ref": editing_ref},
    }

    result = asyncio.run(
        check_article(FakeRepository(), Settings(app_env="test"), context, POLICY)
    )

    assert received_questions == ["Required question"]
    assert result["summary"]["passed"] is True


def test_semantic_check_records_failed_locked_writing_direction(
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
    received_requirements: list[dict[str, str]] = []

    class Gateway:
        async def generate(
            self, _call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            received_requirements.extend(payload["locked_requirements"])
            return SimpleNamespace(
                value=SemanticQualityResult(
                    passed=True,
                    locked_requirement_checks=[
                        LockedRequirementCheck(
                            field="writing_direction",
                            requirement=requirement,
                            passed=False,
                            evidence="The article has no worked example.",
                        )
                    ],
                ),
                usage={"input_tokens": 5, "output_tokens": 1},
            )

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

    assert received_requirements == [
        {"field": "writing_direction", "requirement": requirement}
    ]
    assert artifact["quality"]["locked_requirement_checks"] == [
        {
            "field": "writing_direction",
            "requirement": requirement,
            "passed": False,
            "evidence": "The article has no worked example.",
        }
    ]
    assert "locked_requirement_failed" in {
        issue["code"] for issue in artifact["quality"]["issues"]
    }
    assert result["summary"]["passed"] is False


def test_check_and_revision_receive_matching_section_requirements(
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
            payloads[call] = payload
            if call == "check_article":
                return SimpleNamespace(
                    value=SemanticQualityResult(
                        passed=False,
                        issues=[
                            SectionIssue(
                                section_id="section-1",
                                code="comparison_criteria_missing",
                                message="Add decision criteria",
                            )
                        ],
                    ),
                    usage={"input_tokens": 5, "output_tokens": 1},
                )
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
    context["completed_steps"]["checking"] = {"output_ref": checked["output_ref"]}
    asyncio.run(
        revise_article_sections(
            FakeRepository(), Settings(app_env="test"), context, POLICY
        )
    )

    comparison_rule = "State the decision criteria before comparing options"
    assert comparison_rule in payloads["check_article"]["section_requirements"][
        "section-1"
    ]["must"]
    assert payloads["check_article"]["conversion_actions"] == [
        "Start a free assessment"
    ]
    assert set(payloads["check_article"]["section_requirements"]) == {
        "section-1",
        "section-2",
    }
    assert [item["section_id"] for item in payloads["revise_sections"]["section_plans"]] == [
        "section-1"
    ]
    assert comparison_rule in payloads["revise_sections"]["section_requirements"][
        "section-1"
    ]["must"]
    assert payloads["revise_sections"]["conversion_actions"] == [
        "Start a free assessment"
    ]
    assert [item["claim_id"] for item in payloads["revise_sections"]["claims"]] == [
        "claim-1"
    ]
    assert "section-2" not in payloads["revise_sections"]["section_requirements"]


def test_semantic_check_preserves_unanswered_required_question_issue(
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
            return SimpleNamespace(
                value=SemanticQualityResult(
                    passed=False,
                    issues=[
                        SectionIssue(
                            section_id="section-1",
                            code="required_question_unanswered",
                            message="Required question is not answered",
                        )
                    ],
                ),
                usage={"input_tokens": 5, "output_tokens": 1},
            )

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

    assert result["summary"] == {
        "issue_count": 1,
        "passed": False,
        "check_status": "completed",
        "repairable": True,
        "repair_scope": ["section-1"],
        "issue_fingerprint": ["prose:section-1:required_question_unanswered"],
        "repairable_issue_fingerprint": [
            "prose:section-1:required_question_unanswered"
        ],
        "repairable_issue_count": 1,
        "evidence_issue_count": 0,
        "model_failure": None,
    }
    assert artifact["quality"]["issues"][0]["code"] == (
        "required_question_unanswered"
    )
    assert artifact["quality"]["required_questions"] == {"total": 1, "covered": []}


def test_sanitizer_removes_unverified_claims_and_unknown_links() -> None:
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
    assert "999" not in sanitized.markdown
    assert "always guarantees" not in sanitized.markdown
    assert "https://unknown.example" not in sanitized.markdown
    assert f"]({internal_url})" in sanitized.markdown
    assert sanitized.used_claim_ids == ["claim-1"]
    assert sanitized.used_source_urls == [authority_url]
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


def test_finalizer_removes_cross_section_duplicate_and_sixth_internal_links() -> None:
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

    assert finalized["markdown"].count("](") == 5
    assert finalized["markdown"].count(urls[0]) == 1
    assert urls[5] not in finalized["markdown"]
    assert finalized["sections"][5]["used_internal_urls"] == []
    assert warnings == [
        {
            "code": "invalid_internal_links_removed",
            "message": "未按章节分配、重复或超量的内链已移除，并保留了锚文本",
        }
    ]


def test_quality_rejects_wrong_number_even_with_an_allowed_source_link() -> None:
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

    assert report.passed is False
    assert any(issue.code == "unsupported_number" for issue in report.issues)


def test_quality_and_sanitizer_reject_source_assigned_to_another_section() -> None:
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

    assert any(
        issue.code == "source_not_assigned_to_section" for issue in report.issues
    )
    assert authority_url not in sanitized.markdown
    assert "10 years" not in sanitized.markdown
    assert sanitized.used_claim_ids == []
    assert sanitized.used_source_urls == []


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

    assert report.checks["unsupported_numbers"] == 0


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


def test_finalize_article_artifact_restores_a_verified_link_only_claim() -> None:
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

    assert (
        "The residential clean energy credit is not available for property placed "
        "in service after December 31, 2025. ([IRS guidance]"
        f"({authority_url}))."
    ) in finalized["markdown"]
    assert warnings == []


def test_quality_reports_heading_hierarchy_and_markdown_html_is_deterministic() -> None:
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

    assert [item.code for item in report.issues] == ["invalid_heading_hierarchy"]
    assert html == "<h1>Title</h1>\n<h2>Section</h2>\n<p>Useful <strong>answer</strong>.</p>"


def test_quality_reports_competitor_copy_and_missing_required_section() -> None:
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

    assert {item.code for item in report.issues} == {
        "competitor_copy",
        "section_missing",
    }
    assert report.checks["copied_competitor_sections"] == 1


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


def test_competitor_blueprint_is_applied_to_model_and_fallback_plans() -> None:
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

    assert any(item.heading == "Pricing" for item in normalized.sections)
    assert any(item.heading == "Pricing" for item in fallback.sections)
    for plan in (normalized, fallback):
        coverage = [point for section in plan.sections for point in section.coverage_points]
        assert "Common competitor structure: Pricing" in coverage
        assert "Competitor opportunity: Add current pricing and decision criteria" in coverage
        pricing = next(item for item in plan.sections if item.heading == "Pricing")
        assert pricing.competitor_gaps == ["Add current pricing and decision criteria"]
        assert pricing.word_target == 550
        assert plan.gap_to_section_mapping == {
            "Add current pricing and decision criteria": pricing.section_id
        }


def test_competitor_gap_maps_to_semantically_relevant_section() -> None:
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
    assert pricing.competitor_gaps == [gap]
    assert pricing.word_target == 550
    assert normalized.gap_to_section_mapping[gap] == pricing.section_id


def test_semantic_matching_uses_whole_latin_tokens() -> None:
    use_case_terms = generation._semantic_terms("use cases")

    assert "scenario" in use_case_terms
    assert "scenario" not in generation._semantic_terms("user questions")
    assert "scenario" not in generation._semantic_terms("abuse prevention")
    assert "cost" in generation._semantic_terms("pricing options")
    assert "configure" in generation._semantic_terms("setup process")


def test_section_plan_consumes_evidence_requirements_and_controls_ctas() -> None:
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

    assert len(pricing.data_requirements) == 2
    assert all(item.cta_type is None for item in without_conversions.sections)

    pack["project"]["profile"]["conversion_actions"] = ["Start a free assessment"]
    with_conversions = generation.normalize_plan(plan, pack)
    assert with_conversions.sections[1].cta_type == "soft"
    assert with_conversions.sections[-1].cta_type == "strong"


@pytest.mark.parametrize(
    ("section_count", "expected"),
    [
        (2, [None, "soft"]),
        (3, [None, "soft", "strong"]),
        (4, [None, "soft", "medium", "strong"]),
        (5, [None, "soft", "medium", None, "strong"]),
        (6, [None, "soft", None, "medium", None, "strong"]),
    ],
)
def test_cta_distribution_matches_seomachine_collision_order(
    section_count: int, expected: list[str | None]
) -> None:
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

    assert [item.cta_type for item in finalized] == expected


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


def test_first_section_asked_without_question_remains_intro_like_seomachine() -> None:
    assert generation._classify_section_type("Most asked topics", 0) == "intro"


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


def test_quality_checks_section_targets_and_type_specific_structure() -> None:
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

    codes = {item.code for item in report.issues}
    assert "section_too_short" in codes
    assert "how_to_steps_missing" in codes
    assert "list_structure_missing" in codes
    assert "faq_qa_structure_missing" in codes
    assert "conclusion_actions_missing" in codes
    assert report.checks["short_sections"] == 4
    assert report.checks["invalid_section_structures"] == 4


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


def test_section_payload_contains_type_specific_rules_and_supported_cta() -> None:
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
            "profile": {"conversion_actions": ["Start a free assessment"]},
        },
        "authority_sources": [],
        "competitors": [],
        "internal_sources": [],
    }

    payload = generation.section_payload(plan, section, pack, [], compact=False)

    assert "State the decision criteria before comparing options" in payload[
        "writing_requirements"
    ]["must"]
    assert payload["conversion_actions"] == ["Start a free assessment"]
    assert all(
        "story" not in rule.casefold()
        for rules in payload["writing_requirements"].values()
        for rule in rules
    )


def test_section_payload_matches_seomachine_editing_checklists_and_word_lists() -> None:
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

    assert payload["universal_editing_checks"] == generation.SECTION_EDITING_CHECKS
    assert payload["section_specific_checks"] == [
        "Comparison is fair",
        "Specific data points present",
        "'Best for' recommendations included",
        "Not overly promotional",
    ]
    assert payload["ai_phrases_to_remove"] == generation.AI_PHRASES_TO_REMOVE[:8]
    assert payload["vague_words_to_replace"] == dict(
        list(generation.VAGUE_WORD_REPLACEMENTS.items())[:6]
    )
    assert payload["supported_claims"] == [claim.model_dump(mode="json")]


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
    assert payload["authority_sources"] == first
    assert [item["claim_id"] for item in payload["supported_claims"]] == [
        "claim-direct"
    ]


def test_body_sections_are_written_in_bounded_batches_with_previous_summaries(
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
    calls: list[tuple[str, str]] = []
    section_contexts: dict[str, list[str]] = {}

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            section_id = str(payload["section"]["section_id"])
            calls.append((call, section_id))
            section_contexts[section_id] = list(payload["previous_section_summaries"])
            assert call == "write_and_edit_section"
            return SimpleNamespace(
                value=SectionDraft(
                    section_id=section_id,
                    markdown=(
                        f"## {payload['section']['heading']}\n\n"
                        "Edited prose explains the practical choice without unsupported facts."
                    ),
                    summary=f"edited summary {section_id}",
                ),
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

    assert sorted(calls) == [
        ("write_and_edit_section", f"section-{index}") for index in range(1, 6)
    ]
    assert section_contexts == {
        "section-1": [],
        "section-2": ["edited summary section-1"],
        "section-3": ["edited summary section-1"],
        "section-4": ["edited summary section-1"],
        "section-5": [
            "edited summary section-3",
            "edited summary section-4",
        ],
    }
    assert all("Edited" in item["markdown"] for item in artifact["sections"])


def test_completed_section_edit_is_reused_after_restart(
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

    class Gateway:
        async def generate(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("completed write/edit must not run again")

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

    assert "Previously edited complete prose" in store.objects[result["output_ref"]][
        "markdown"
    ]


def test_single_write_and_edit_call_persists_complete_section(
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
            assert call == "write_and_edit_section"
            return SimpleNamespace(
                value=SectionDraft(
                    section_id=str(payload["section"]["section_id"]),
                    markdown=original_markdown,
                    summary="complete original summary",
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
    stored_section = store.objects[
        "s3://test-bucket/article-runs/run-1/writing/section-1.json.gz"
    ]

    assert artifact["sections"][0]["markdown"] == original_markdown
    assert stored_section["write_and_edit_completed"] is True
    assert stored_section["section"]["markdown"] == original_markdown
    assert result["warnings"] == []
    assert result["summary"]["model_failures"] == []


def test_writing_recovery_regenerates_incomplete_cached_section(
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
                value=SectionDraft(
                    section_id=str(payload["section"]["section_id"]),
                    markdown="## Section 1\n\nEdited recovery section prose.",
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
    stored = store.objects[
        "s3://test-bucket/article-runs/run-1/writing/section-1.json.gz"
    ]

    assert calls == ["write_and_edit_section"]
    assert "Edited recovery section prose" in artifact["markdown"]
    assert stored["write_and_edit_completed"] is True
    assert stored["usage"]["input_tokens"] == 4
    assert stored["usage"]["output_tokens"] == 5


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


def test_content_score_revision_applies_top_five_and_stops_after_two_rounds(
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
    scores = iter([60.0, 65.0, 68.0])

    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            value = next(scores)
            return {
                "composite_score": value,
                "passed": value >= 70,
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
            iteration = int(payload.get("iteration") or 0)
            markdown = (
                section.markdown
                if call == "unify_article"
                else f"## Section 1\n\nComplete revision {iteration}."
            )
            return SimpleNamespace(
                value=UnifiedArticle(
                    title=plan.title,
                    meta_title=plan.meta_title,
                    meta_description=plan.meta_description,
                    slug=plan.slug,
                    sections=[
                        section.model_copy(
                            update={
                                "markdown": markdown
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
    revision_calls = [payload for call, payload in calls if call == "revise_quality"]

    assert [call for call, _payload in calls] == [
        "unify_article",
        "revise_quality",
        "revise_quality",
    ]
    assert [item["iteration"] for item in revision_calls] == [1, 2]
    assert all(len(item["priority_fixes"]) == 5 for item in revision_calls)
    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        60.0,
        65.0,
        68.0,
    ]
    assert result["summary"]["content_score_iterations"] == 2
    assert result["summary"]["complete"] is True
    assert result["warnings"][-1]["code"] == "content_quality_below_threshold"


def test_content_score_revision_stops_as_soon_as_first_revision_passes(
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
    scores = iter([60.0, 72.0])

    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            value = next(scores)
            return {
                "composite_score": value,
                "passed": value >= 70,
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

    assert calls == ["unify_article", "revise_quality"]
    assert result["summary"]["content_score"] == 72.0
    assert result["summary"]["content_score_iterations"] == 1
    assert all(
        item["code"] != "content_quality_below_threshold"
        for item in result["warnings"]
    )


def test_editing_recovery_runs_two_quality_revisions_and_rescores(
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
    scores = iter([60.0, 65.0, 72.0])

    class Scorer:
        def score(self, *_: Any, **__: Any) -> dict[str, Any]:
            value = next(scores)
            return {
                "composite_score": value,
                "passed": value >= 70,
                "threshold": 70,
                "dimensions": {},
                "priority_fixes": [{"issue": "issue", "fix": "fix"}] * 5,
            }

    calls: list[int] = []

    class Gateway:
        async def generate(
            self, call: str, payload: dict[str, Any], _output: Any
        ) -> Any:
            assert call == "revise_quality"
            calls.append(int(payload["iteration"]))
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

    assert calls == [1, 2]
    assert [item["composite_score"] for item in artifact["content_score_history"]] == [
        60.0,
        65.0,
        72.0,
    ]
    assert result["summary"]["content_score_passed"] is True
    assert result["summary"]["content_score_iterations"] == 2
    assert all(
        item["code"] != "content_quality_below_threshold"
        for item in result["warnings"]
    )


def test_quality_revision_failure_keeps_article_score_history_and_bindings(
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
            if call == "revise_quality":
                raise RuntimeError("quality revision unavailable")
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
    assert [item["code"] for item in result["warnings"]] == [
        "content_quality_revision_degraded",
        "content_quality_below_threshold",
    ]
    assert result["summary"]["model_failures"][-1]["mode"] == "quality_revision"


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
    assert result["warnings"][0]["code"] == "planning_degraded"


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
    assert pack["evidence_capabilities"] == {
        "verified_claim_count": 0,
        "verified_source_count": 0,
        "competitor_count": 0,
        "internal_source_count": 0,
        "named_entities": [],
        "named_product_count": 0,
        "price_evidence_available": False,
        "professional_source_available": False,
        "official_source_available": False,
        "supported_comparison_dimensions": [],
        "unsupported_promises": [
            "fixed product count",
            "ranking",
            "winner",
            "current prices",
            "professional recommendation",
            "hands-on test",
            "award",
        ],
    }


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


def test_plan_normalization_forces_dominant_serp_type() -> None:
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

    assert normalized.article_type == "How-To Guide"


def test_commercial_plan_without_product_evidence_becomes_truthful_selection_guide() -> None:
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
        "evidence_capabilities": {
            "named_product_count": 0,
            "price_evidence_available": False,
            "professional_source_available": False,
            "unsupported_promises": [
                "fixed product count",
                "ranking",
                "winner",
                "current prices",
                "professional recommendation",
                "hands-on test",
            ],
        },
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

    assert normalized.article_type == "Selection Guide"
    assert all(
        promise not in searchable
        for promise in (
            "10 best",
            "10 products",
            "winner",
            "ranked",
            "current prices",
            "hands-on test",
            "professional recommendation",
        )
    )
    assert "selection guide" in searchable or "selection criteria" in searchable


def test_quality_issue_classification_separates_data_gaps_from_rewrites() -> None:
    evidence_gap = generation._classify_quality_issue(
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

    assert evidence_gap.category == "evidence"
    assert evidence_gap.repairable is False
    assert prose_issue.category == "prose"
    assert prose_issue.repairable is True


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
    assert [item["code"] for item in received["issues"]] == [
        "required_question_unanswered"
    ]
    assert "Original section 1" in artifact["sections"][0]["markdown"]
    assert "Revised answer" in artifact["sections"][1]["markdown"]


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


def test_plan_normalization_puts_every_content_brief_requirement_in_outline() -> None:
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

    assert len(normalized.sections) == 6
    assert {f"SERP structure: {item}" for item in structure} <= coverage
    assert {f"Required element: {item}" for item in must_have} <= coverage
    assert {f"SERP feature target: {item}" for item in feature_targets} <= coverage

    writing_payloads = [
        generation.section_payload(normalized, section, pack, [], compact=False)
        for section in normalized.sections
    ]
    writing_coverage = {
        point
        for payload in writing_payloads
        for point in payload["section"]["coverage_points"]
    }
    assert {f"SERP structure: {item}" for item in structure} <= writing_coverage
    assert {f"Required element: {item}" for item in must_have} <= writing_coverage
    assert {
        f"SERP feature target: {item}" for item in feature_targets
    } <= writing_coverage


def test_fallback_plan_uses_serp_content_brief_structure() -> None:
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

    assert plan.article_type == "How-To Guide"
    assert [item.heading for item in plan.sections] == pack["content_brief"][
        "structure_recommendations"
    ]


def test_serp_requirements_are_not_truncated_by_full_model_coverage() -> None:
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
    assert "SERP structure: Introduction (what you'll learn)" in coverage
    assert "Required element: Step-by-step instructions" in coverage
    assert (
        "SERP feature target: Featured Snippet - Add concise definition/answer "
        "in first 100 words"
    ) in coverage
