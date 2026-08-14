import asyncio

import pytest

from app.modules.content import activities
from app.modules.content.document import extract_asset_manifest
from app.modules.content.visual_assembly import (
    _prefix_node_ids,
    assemble_visual_document,
    validate_article_visuals,
)
from app.modules.content.visual_generation import ResolvedVisual
from app.modules.content.writing_gateway import (
    ArticlePlan,
    OutlineSection,
    SectionDraft,
    VisualPlanItem,
)


def plan() -> ArticlePlan:
    sections = [
        OutlineSection(
            section_id="section-1",
            heading="What to check",
            objective="Explain the first check.",
        ),
        OutlineSection(
            section_id="section-2",
            heading="What to check",
            objective="Explain the second check.",
        ),
    ]
    return ArticlePlan(
        title="Solar battery checks",
        search_intent="Learn what to check before buying.",
        article_type="guide",
        meta_title="Solar battery checks",
        meta_description="A practical solar battery checklist.",
        slug="solar-battery-checks",
        sections=sections,
        visuals=[
            VisualPlanItem(
                visual_id="visual-1",
                section_id="section-2",
                reader_job="demonstrate",
                source_strategy="project_asset",
                title="Battery connection example",
                alt_instruction="A labeled battery connection example",
            )
        ],
    )


def article_artifact() -> dict:
    article_plan = plan()
    return {
        "plan": article_plan.model_dump(mode="json"),
        "sections": [
            SectionDraft(
                section_id="section-1",
                markdown="## What to check\n\nFirst section paragraph.",
            ).model_dump(mode="json"),
            SectionDraft(
                section_id="section-2",
                markdown="## What to check\n\nSecond section paragraph.",
            ).model_dump(mode="json"),
        ],
    }


def visual_artifact(*, status: str = "ready") -> dict:
    return {
        "kind": "resolved_visuals",
        "visuals": [
            ResolvedVisual(
                visual_id="visual-1",
                section_id="section-2",
                asset_id="asset-1" if status == "ready" else None,
                status=status,
                required=False,
                alt_text="A labeled battery connection example" if status == "ready" else "",
                alt_source="default_alt_text" if status == "ready" else None,
                caption="Connection points to inspect",
                provider="project_asset",
                width=1600,
                height=900,
            ).model_dump(mode="json")
        ],
    }


def test_assembly_uses_section_id_when_two_headings_are_identical() -> None:
    assembled = assemble_visual_document(article_artifact(), visual_artifact())
    nodes = assembled["document"]["content"]
    image_index = next(index for index, node in enumerate(nodes) if node["type"] == "image")
    second_heading_index = next(
        index
        for index, node in enumerate(nodes)
        if node["type"] == "heading" and node["attrs"]["node_id"].startswith("section-2:")
    )

    assert image_index > second_heading_index
    assert nodes[image_index]["attrs"] == {
        "node_id": "visual:visual-1",
        "asset_id": "asset-1",
        "alt": "A labeled battery connection example",
        "display": "wide",
        "caption": "Connection points to inspect",
        "width": 1600,
        "height": 900,
    }
    assert extract_asset_manifest(assembled["document"]) == [
        {
            "asset_id": "asset-1",
            "binding_role": "image",
            "node_id": "visual:visual-1",
            "item_id": None,
        }
    ]
    assert validate_article_visuals(assembled)["passed"] is True


def test_assembly_is_repeatable_and_optional_missing_image_is_omitted() -> None:
    assembled = assemble_visual_document(article_artifact(), visual_artifact())
    repeated = assemble_visual_document(assembled, visual_artifact())
    omitted = assemble_visual_document(article_artifact(), visual_artifact(status="omitted"))

    assert repeated["document"] == assembled["document"]
    assert repeated["markdown"].count(":::article-image") == 1
    assert all(node["type"] != "image" for node in omitted["document"]["content"])
    assert omitted["asset_manifest"] == []


def test_long_prefixed_node_ids_remain_unique_and_within_schema_limit() -> None:
    shared = "x" * 140
    nodes = [
        {"type": "paragraph", "attrs": {"node_id": f"{shared}a"}},
        {"type": "paragraph", "attrs": {"node_id": f"{shared}b"}},
    ]

    prefixed = _prefix_node_ids(nodes, "section-with-a-very-long-stable-identifier")
    ids = [node["attrs"]["node_id"] for node in prefixed]

    assert len(set(ids)) == 2
    assert all(len(node_id) <= 128 for node_id in ids)


def test_required_visual_missing_from_resolved_artifact_is_blocking() -> None:
    artifact = article_artifact()
    artifact["plan"]["visuals"][0]["required"] = True
    assembled = assemble_visual_document(
        artifact,
        {"kind": "resolved_visuals", "visuals": []},
    )

    result = validate_article_visuals(assembled)

    assert result["passed"] is False
    assert result["required_missing_count"] == 1
    assert result["issues"] == [
        {"visual_id": "visual-1", "code": "required_visual_missing"}
    ]


def test_optional_duplicate_asset_is_omitted_before_document_assembly() -> None:
    artifact = article_artifact()
    artifact["plan"]["visuals"].append(
        VisualPlanItem(
            visual_id="visual-2",
            section_id="section-1",
            reader_job="demonstrate",
            source_strategy="project_asset",
            title="Another battery view",
            alt_instruction="Another battery view",
        ).model_dump(mode="json")
    )
    resolved = visual_artifact()["visuals"]
    resolved.append(
        ResolvedVisual(
            visual_id="visual-2",
            section_id="section-1",
            asset_id="asset-1",
            status="ready",
            alt_text="Another view",
            alt_source="title",
            provider="project_asset",
            source_strategy="project_asset",
            width=1600,
            height=900,
        ).model_dump(mode="json")
    )

    assembled = assemble_visual_document(artifact, {"visuals": resolved})
    result = validate_article_visuals(assembled)

    assert len(assembled["asset_manifest"]) == 1
    assert {item["code"] for item in result["issues"]} == {"visual_asset_duplicate"}
    assert result["passed"] is True


def test_stock_image_without_attribution_is_omitted() -> None:
    artifact = article_artifact()
    artifact["plan"]["visuals"][0]["source_strategy"] = "stock"
    resolved = visual_artifact()["visuals"]
    resolved[0]["provider"] = "stock"
    resolved[0]["source_strategy"] = "stock"

    assembled = assemble_visual_document(artifact, {"visuals": resolved})
    result = validate_article_visuals(assembled)

    assert assembled["asset_manifest"] == []
    assert {item["code"] for item in result["issues"]} == {
        "stock_attribution_missing"
    }
    assert result["passed"] is True


def test_visual_stage_recovery_keeps_text_document_when_images_fail(monkeypatch) -> None:
    stored = article_artifact()
    stored["markdown"] = "## What to check\n\nComplete article text.\n"
    writes = []

    class Store:
        def __init__(self, _settings) -> None:
            pass

        async def read_json(self, ref: str):
            assert ref == "checking-ref"
            return stored

        async def write_json(self, key: str, value: dict):
            writes.append((key, value))
            return "assembled-ref"

    monkeypatch.setattr(activities, "S3ArtifactStore", Store)
    result = asyncio.run(
        activities._recover_visual_assembly_stage(
            object(),
            {
                "run_id": "run-1",
                "input_step_key": "checking_1",
                "completed_steps": {"checking_1": {"output_ref": "checking-ref"}},
            },
        )
    )

    assert result["warning"]["code"] == "visual_assembling_degraded"
    assert result["summary"] == {"image_count": 0, "complete": True, "degraded": True}
    assert writes[0][1]["document"]["type"] == "doc"
    assert "First section paragraph" in writes[0][1]["markdown"]
    assert "Second section paragraph" in writes[0][1]["markdown"]


def test_visual_stage_dispatch_uses_normal_and_recovery_handlers(monkeypatch) -> None:
    calls = []

    async def normal(_settings, _context):
        calls.append("normal")
        return {"output_ref": "normal-ref"}

    async def recovered(_settings, _context):
        calls.append("recovered")
        return {"output_ref": "recovered-ref"}

    monkeypatch.setattr(activities, "repository", lambda: object())
    monkeypatch.setattr(activities, "get_settings", lambda: object())
    monkeypatch.setattr(activities, "_assemble_visual_stage", normal)
    monkeypatch.setattr(activities, "_recover_visual_assembly_stage", recovered)
    context = {"run_id": "run-1", "stage_kind": "visual_assembling"}

    normal_result = asyncio.run(
        activities.execute_stage_work("visual_assembling", context, {})
    )
    recovery_result = asyncio.run(
        activities.recover_stage_work("visual_assembling", context, {})
    )

    assert calls == ["normal", "recovered"]
    assert normal_result["output_ref"] == "normal-ref"
    assert recovery_result["output_ref"] == "recovered-ref"


def test_visual_check_recovery_blocks_required_item_missing_from_results(monkeypatch) -> None:
    artifact = article_artifact()
    artifact["plan"]["visuals"][0]["required"] = True

    class Store:
        def __init__(self, _settings) -> None:
            pass

        async def read_json(self, ref: str):
            assert ref == "assembled-ref"
            return {**artifact, "visuals": []}

    monkeypatch.setattr(activities, "S3ArtifactStore", Store)

    with pytest.raises(ValueError, match="required_visual_missing"):
        asyncio.run(
            activities._recover_visual_check_stage(
                object(),
                {
                    "run_id": "run-1",
                    "input_step_key": "visual_assembling",
                    "completed_steps": {
                        "visual_assembling": {"output_ref": "assembled-ref"}
                    },
                },
            )
        )
