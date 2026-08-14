from __future__ import annotations

import argparse
import asyncio
import io
import json
import re
from decimal import Decimal
from typing import Any

from PIL import Image

from app.core.config import get_settings
from app.db.session import session_factory
from app.modules.content import visual_generation
from app.modules.content.asset_repository import AssetRepository
from app.modules.content.asset_service import build_asset_service
from app.modules.content.image_gateway import image_provider_for
from app.modules.content.object_storage import S3ArtifactStore
from app.modules.content.visual_assembly import (
    assemble_visual_document,
    validate_article_visuals,
)
from app.modules.content.visual_generation import resolve_visuals
from app.modules.content.writing_gateway import (
    ArticlePlan,
    ChartDataPoint,
    EvidenceClaim,
    VisualPlanItem,
)
from real_content_visual_reuse_probe import ledger_snapshot, verify_binding_rollback


PROJECT_ID = "b69d5efb-edf6-4cb4-882a-8083c2bdacf8"
SOURCE_RUN_ID = "b4f562f7-6bc2-4ce6-90b6-9ce4dd39ddab"
PROBE_RUN_ID = "probe-hd-streaming-chart-v2"
VISUAL_ID = "visual-hd-frame-rate-chart"
SOURCE_URL = "https://www.creativebroadcast.ae/glossary/live-hd-streaming/"
FRAME_RATE_PATTERN = re.compile(r"29\.97\s+or\s+59\.94\s*fps", re.IGNORECASE)


def _source_evidence(research_pack: dict[str, Any]) -> tuple[str, str, Decimal, Decimal]:
    candidates = [
        item
        for item in research_pack.get("competitors") or []
        if isinstance(item, dict) and str(item.get("url") or "") == SOURCE_URL
    ]
    if not candidates:
        candidates = [
            item
            for item in research_pack.get("serp", {}).get("organic_results") or []
            if isinstance(item, dict) and str(item.get("url") or "") == SOURCE_URL
        ]
    if not candidates:
        raise AssertionError("saved SERP source was not found in the reused research pack")
    source = candidates[0]
    text = str(source.get("content") or source.get("description") or "")
    match = FRAME_RATE_PATTERN.search(text)
    if match is None:
        raise AssertionError("saved SERP source does not contain the expected frame-rate evidence")
    title = str(source.get("title") or "Creative Broadcast Agency: Live HD Streaming")
    quote = match.group(0)
    values = re.findall(r"\d+(?:\.\d+)?", quote)
    if len(values) != 2:
        raise AssertionError(f"could not parse both saved frame rates from: {quote}")
    return title, quote, Decimal(values[0]), Decimal(values[1])


def _claims_and_visual(
    *,
    section_id: str,
    source_title: str,
    quote: str,
    first_rate: Decimal,
    second_rate: Decimal,
) -> tuple[list[EvidenceClaim], VisualPlanItem]:
    claims = [
        EvidenceClaim(
            claim_id="claim-hd-2997-fps",
            claim=f"The saved source lists {first_rate} fps as an HD streaming frame rate.",
            source_url=SOURCE_URL,
            source_title=source_title,
            quote=quote,
            section_id=section_id,
        ),
        EvidenceClaim(
            claim_id="claim-hd-5994-fps",
            claim=f"The saved source lists {second_rate} fps as an HD streaming frame rate.",
            source_url=SOURCE_URL,
            source_title=source_title,
            quote=quote,
            section_id=section_id,
        ),
    ]
    visual = VisualPlanItem(
        visual_id=VISUAL_ID,
        section_id=section_id,
        reader_job="compare",
        source_strategy="chart",
        title="高清直播常见帧率",
        alt_instruction="比较已保存来源中列出的两种高清直播帧率",
        caption=f"来源：{source_title}",
        aspect_ratio="16:9",
        data_claim_ids=[item.claim_id for item in claims],
        chart_data=[
            ChartDataPoint(
                label="帧率选项 1",
                value=first_rate,
                unit=" fps",
                claim_id=claims[0].claim_id,
            ),
            ChartDataPoint(
                label="帧率选项 2",
                value=second_rate,
                unit=" fps",
                claim_id=claims[1].claim_id,
            ),
        ],
    )
    return claims, visual


async def _build_probe_artifacts() -> tuple[dict[str, Any], dict[str, Any], str, dict[str, Any]]:
    settings = get_settings()
    store = S3ArtifactStore(settings)
    source_prefix = f"article-runs/{SOURCE_RUN_ID}"
    planning = await store.read_json(
        f"s3://{settings.s3_bucket}/{source_prefix}/planning/plan.json.gz"
    )
    research_pack = await store.read_json(str(planning["research_pack_ref"]))
    article = await store.read_json(
        f"s3://{settings.s3_bucket}/{source_prefix}/checking_1/article.json.gz"
    )
    plan = ArticlePlan.model_validate(planning["plan"])
    section = next(
        (item for item in plan.sections if item.section_id == "section-2"),
        plan.sections[0],
    )
    source_title, quote, first_rate, second_rate = _source_evidence(research_pack)
    claims, visual = _claims_and_visual(
        section_id=section.section_id,
        source_title=source_title,
        quote=quote,
        first_rate=first_rate,
        second_rate=second_rate,
    )
    probe_plan = plan.model_copy(update={"claims": claims, "visuals": [visual]})
    planning_ref = await store.write_json(
        f"article-runs/{PROBE_RUN_ID}/planning/plan.json.gz",
        {
            **planning,
            "plan": probe_plan.model_dump(mode="json"),
            "probe_source_run_id": SOURCE_RUN_ID,
        },
    )
    article["plan"] = probe_plan.model_dump(mode="json")
    evidence = {
        "source_url": SOURCE_URL,
        "source_title": source_title,
        "saved_quote": quote,
        "values": [str(first_rate), str(second_rate)],
    }
    return article, probe_plan.model_dump(mode="json"), planning_ref, evidence


def _inspect_png(content: bytes) -> dict[str, int | str]:
    with Image.open(io.BytesIO(content)) as image:
        image.load()
        rgb = image.convert("RGB")
        colors = rgb.getcolors(maxcolors=rgb.width * rgb.height)
        if not colors or len(colors) < 20:
            raise AssertionError("rendered chart appears blank or has too little visual content")
        non_white_pixels = sum(count for count, color in colors if color != (255, 255, 255))
        if non_white_pixels < rgb.width * rgb.height // 100:
            raise AssertionError("rendered chart contains less than one percent non-white pixels")
        return {
            "format": str(image.format),
            "width": rgb.width,
            "height": rgb.height,
            "color_count": len(colors),
            "non_white_pixels": non_white_pixels,
        }


async def run_probe() -> dict[str, Any]:
    ledgers_before = await ledger_snapshot()
    article_artifact, probe_plan, planning_ref, evidence = await _build_probe_artifacts()
    settings = get_settings()
    context = {
        "run_id": PROBE_RUN_ID,
        "project_id": PROJECT_ID,
        "completed_steps": {"planning": {"output_ref": planning_ref}},
    }
    provider_calls: list[str] = []
    rendered_png: dict[str, int | str] | None = None
    original_factory = visual_generation.image_provider_for

    def counting_factory(strategy: str, **kwargs: Any) -> Any:
        provider = image_provider_for(strategy, **kwargs)

        class CountingProvider:
            name = provider.name

            async def acquire(self, request: Any) -> Any:
                nonlocal rendered_png
                provider_calls.append(strategy)
                result = await provider.acquire(request)
                if strategy == "chart" and result.content is not None:
                    rendered_png = _inspect_png(result.content)
                return result

        return CountingProvider()

    visual_generation.image_provider_for = counting_factory
    try:
        first = await resolve_visuals(
            settings=settings,
            context=context,
            asset_repository=AssetRepository(session_factory),
            asset_service=build_asset_service(settings),
        )
        first_calls = list(provider_calls)
        provider_calls.clear()
        second = await resolve_visuals(
            settings=settings,
            context=context,
            asset_repository=AssetRepository(session_factory),
            asset_service=build_asset_service(settings),
        )
        second_calls = list(provider_calls)
    finally:
        visual_generation.image_provider_for = original_factory

    store = S3ArtifactStore(settings)
    visual_artifact = await store.read_json(str(second["output_ref"]))
    assembled = assemble_visual_document(article_artifact, visual_artifact)
    quality = validate_article_visuals(assembled)
    resolved = visual_artifact["visuals"]
    if first["summary"]["ready_count"] != 1:
        raise AssertionError(f"first chart resolution failed: {first['summary']}")
    if first_calls not in ([], ["chart"]):
        raise AssertionError(f"unexpected first provider calls: {first_calls}")
    if first_calls == ["chart"] and rendered_png is None:
        raise AssertionError("chart provider returned no inspectable PNG")
    if second_calls:
        raise AssertionError(f"cached chart resolution called providers: {second_calls}")
    if len(resolved) != 1 or resolved[0].get("reused") is not True:
        raise AssertionError("second chart resolution did not reuse the successful artifact")
    if resolved[0].get("source_strategy") != "chart":
        raise AssertionError("resolved visual source strategy was not chart")
    if not quality["passed"] or quality["issues"]:
        raise AssertionError(f"chart visual quality check failed: {quality}")

    asset_id = str(resolved[0]["asset_id"])
    asset = await build_asset_service(settings).get_asset(PROJECT_ID, asset_id)
    metadata = dict(asset.provider_metadata or {})
    if metadata.get("provider") != "chart" or metadata.get("source_strategy") != "chart":
        raise AssertionError(f"chart provenance metadata is incomplete: {metadata}")
    if metadata.get("data_claim_ids") != probe_plan["visuals"][0]["data_claim_ids"]:
        raise AssertionError("chart claim provenance was not preserved")
    if metadata.get("chart_data") != probe_plan["visuals"][0]["chart_data"]:
        raise AssertionError("chart data provenance was not preserved")

    image_nodes = [
        node for node in assembled["document"]["content"] if node.get("type") == "image"
    ]
    if len(image_nodes) != 1:
        raise AssertionError(f"expected one chart image node, got {len(image_nodes)}")
    binding = await verify_binding_rollback(assembled["asset_manifest"])
    ledgers_after = await ledger_snapshot()
    if ledgers_after != ledgers_before:
        raise AssertionError(
            f"DataForSEO ledgers changed: {ledgers_before} -> {ledgers_after}"
        )
    return {
        "status": "passed",
        "source_run_id": SOURCE_RUN_ID,
        "probe_run_id": PROBE_RUN_ID,
        "reused_saved_evidence": evidence,
        "asset": {
            "asset_id": asset.asset_id,
            "status": asset.status,
            "width": asset.width,
            "height": asset.height,
            "provider_metadata": metadata,
        },
        "rendered_png": rendered_png or "reused_existing_processed_asset",
        "first_provider_calls": first_calls,
        "second_provider_calls": second_calls,
        "second_reused": resolved[0]["reused"],
        "image_node": image_nodes[0]["attrs"],
        "visual_quality": quality,
        "binding_transaction": binding,
        "dataforseo_before": ledgers_before,
        "dataforseo_after": ledgers_after,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    print(json.dumps(asyncio.run(run_probe()), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
