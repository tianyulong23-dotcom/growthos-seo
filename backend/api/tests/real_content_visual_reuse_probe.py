from __future__ import annotations

import argparse
import asyncio
import json
import time
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select, text

from app.core.config import get_settings
from app.db.session import session_factory
from app.modules.content import visual_generation
from app.modules.content.asset_repository import AssetRepository
from app.modules.content.asset_schemas import AssetUpdateRequest
from app.modules.content.asset_service import build_asset_dispatcher, build_asset_service
from app.modules.content.image_gateway import image_provider_for
from app.modules.content.models import ArticleAssetBinding
from app.modules.content.object_storage import S3ArtifactStore
from app.modules.content.visual_assembly import (
    assemble_visual_document,
    validate_article_visuals,
)
from app.modules.content.visual_generation import resolve_visuals
from app.modules.content.writing_gateway import ArticlePlan, VisualPlanItem


PROJECT_ID = "b69d5efb-edf6-4cb4-882a-8083c2bdacf8"
ARTICLE_ID = "8a12cc74-9a35-466e-bdfd-bf2f38b3305a"
SOURCE_RUN_ID = "b4f562f7-6bc2-4ce6-90b6-9ce4dd39ddab"
PROBE_RUN_ID = "probe-hd-streaming-visual-v1"
VISUAL_ID = "visual-elephtv-device"
INGEST_IDEMPOTENCY_KEY = "real-probe:elephtv-home-product:v1"


async def ledger_snapshot() -> dict[str, dict[str, str | int]]:
    statements = {
        "content_plan": """
            SELECT COUNT(*), COALESCE(SUM(cost_usd), 0)
            FROM content_plan_external_requests
            WHERE provider = 'dataforseo'
        """,
        "keywords": """
            SELECT COUNT(*), COALESCE(SUM(cost_usd), 0)
            FROM keyword_external_requests
            WHERE provider = 'dataforseo'
        """,
    }
    result: dict[str, dict[str, str | int]] = {}
    async with session_factory() as session:
        for name, statement in statements.items():
            count, cost = (await session.execute(text(statement))).one()
            result[name] = {
                "count": int(count),
                "cost_usd": str(Decimal(cost).quantize(Decimal("0.000001"))),
            }
    return result


async def ensure_product_asset(image_path: Path) -> Any:
    settings = get_settings()
    service = build_asset_service(settings)
    response = await service.ingest_bytes(
        project_id=PROJECT_ID,
        user_id="system",
        idempotency_key=INGEST_IDEMPOTENCY_KEY,
        filename="elephtv-home-product.png",
        mime_type="image/png",
        content=image_path.read_bytes(),
        source_type="project_asset",
    )
    deadline = time.monotonic() + 90
    dispatcher = build_asset_dispatcher(settings)
    while response.status != "ready":
        if response.status in {"failed", "quarantined", "pending_delete", "deleted"}:
            raise AssertionError(
                f"asset processing failed: {response.status}/{response.failure_code}"
            )
        if time.monotonic() >= deadline:
            raise AssertionError("asset processing did not finish within 90 seconds")
        await dispatcher.run_once(limit=4)
        await asyncio.sleep(0.1)
        response = await service.get_asset(PROJECT_ID, response.asset_id)
    response = await service.update_metadata(
        project_id=PROJECT_ID,
        asset_id=response.asset_id,
        user_id="system",
        request=AssetUpdateRequest(
            title="ElephTV HD streaming device",
            default_alt_text=(
                "ElephTV streaming device and remote shown beside a television interface"
            ),
            caption="ElephTV streaming device and viewing interface.",
        ),
    )
    if (response.width, response.height) != (1201, 953):
        raise AssertionError(
            f"unexpected processed dimensions: {response.width}x{response.height}"
        )
    return response


async def build_probe_artifacts() -> tuple[dict[str, Any], dict[str, Any], str]:
    settings = get_settings()
    store = S3ArtifactStore(settings)
    source_prefix = f"article-runs/{SOURCE_RUN_ID}"
    planning = await store.read_json(
        f"s3://{settings.s3_bucket}/{source_prefix}/planning/plan.json.gz"
    )
    article = await store.read_json(
        f"s3://{settings.s3_bucket}/{source_prefix}/checking_1/article.json.gz"
    )
    plan = ArticlePlan.model_validate(planning["plan"])
    section = next(
        (item for item in plan.sections if item.section_id == "section-1"),
        plan.sections[0],
    )
    visual = VisualPlanItem(
        visual_id=VISUAL_ID,
        section_id=section.section_id,
        reader_job="demonstrate",
        source_strategy="project_asset",
        title="ElephTV HD streaming device",
        alt_instruction=(
            "Show the real ElephTV streaming device and viewing interface clearly"
        ),
        caption="ElephTV streaming device and viewing interface.",
        aspect_ratio="4:3",
    )
    probe_plan = plan.model_copy(update={"visuals": [visual]})
    planning_ref = await store.write_json(
        f"article-runs/{PROBE_RUN_ID}/planning/plan.json.gz",
        {
            **planning,
            "plan": probe_plan.model_dump(mode="json"),
            "probe_source_run_id": SOURCE_RUN_ID,
        },
    )
    article["plan"] = probe_plan.model_dump(mode="json")
    return article, probe_plan.model_dump(mode="json"), planning_ref


async def verify_binding_rollback(manifest: list[dict[str, Any]]) -> dict[str, int]:
    if len(manifest) != 1:
        raise AssertionError(f"expected one manifest item, got {len(manifest)}")
    marker = f"probe-binding-{uuid4().hex}"
    item = manifest[0]
    async with session_factory() as session:
        baseline = int(
            await session.scalar(
                select(func.count(ArticleAssetBinding.id)).where(
                    ArticleAssetBinding.article_id == ARTICLE_ID,
                    ArticleAssetBinding.removed_at.is_(None),
                )
            )
            or 0
        )
        transaction = await session.begin_nested()
        session.add(
            ArticleAssetBinding(
                id=marker,
                article_id=ARTICLE_ID,
                version_number=None,
                node_id=str(item["node_id"]),
                item_id=item.get("item_id"),
                asset_id=str(item["asset_id"]),
                binding_role=str(item["binding_role"]),
            )
        )
        await session.flush()
        inserted = int(
            await session.scalar(
                select(func.count(ArticleAssetBinding.id)).where(
                    ArticleAssetBinding.id == marker
                )
            )
            or 0
        )
        await transaction.rollback()
        await session.rollback()
    async with session_factory() as session:
        remaining = int(
            await session.scalar(
                select(func.count(ArticleAssetBinding.id)).where(
                    ArticleAssetBinding.id == marker
                )
            )
            or 0
        )
        final_count = int(
            await session.scalar(
                select(func.count(ArticleAssetBinding.id)).where(
                    ArticleAssetBinding.article_id == ARTICLE_ID,
                    ArticleAssetBinding.removed_at.is_(None),
                )
            )
            or 0
        )
    if inserted != 1 or remaining != 0 or final_count != baseline:
        raise AssertionError("article asset binding rollback verification failed")
    return {"baseline": baseline, "inserted": inserted, "after_rollback": final_count}


async def run_probe(image_path: Path) -> dict[str, Any]:
    if not image_path.is_file():
        raise FileNotFoundError(image_path)
    ledgers_before = await ledger_snapshot()
    asset = await ensure_product_asset(image_path)
    article_artifact, probe_plan, planning_ref = await build_probe_artifacts()
    settings = get_settings()
    context = {
        "run_id": PROBE_RUN_ID,
        "project_id": PROJECT_ID,
        "completed_steps": {"planning": {"output_ref": planning_ref}},
    }
    provider_calls: list[str] = []
    original_factory = visual_generation.image_provider_for

    def counting_factory(strategy: str, **kwargs: Any) -> Any:
        provider = image_provider_for(strategy, **kwargs)

        class CountingProvider:
            name = provider.name

            async def acquire(self, request: Any) -> Any:
                provider_calls.append(strategy)
                return await provider.acquire(request)

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
    checked_ref = await store.write_json(
        f"article-runs/{PROBE_RUN_ID}/visuals/checked.json.gz",
        {**assembled, "visual_quality": quality},
    )
    resolved = visual_artifact["visuals"]
    if first["summary"]["ready_count"] != 1:
        raise AssertionError(f"first resolution failed: {first['summary']}")
    if first_calls not in ([], ["project_asset"]):
        raise AssertionError(f"unexpected first provider calls: {first_calls}")
    if second_calls:
        raise AssertionError(f"cached resolution called providers: {second_calls}")
    if len(resolved) != 1 or resolved[0].get("reused") is not True:
        raise AssertionError("second resolution did not reuse the successful artifact")
    if resolved[0].get("asset_id") != asset.asset_id:
        raise AssertionError("resolved visual did not use the ElephTV project asset")
    if resolved[0].get("source_strategy") != "project_asset":
        raise AssertionError("backend source strategy was not project_asset")
    if not quality["passed"] or quality["issues"]:
        raise AssertionError(f"visual quality check failed: {quality}")
    manifest = assembled["asset_manifest"]
    binding = await verify_binding_rollback(manifest)
    ledgers_after = await ledger_snapshot()
    if ledgers_after != ledgers_before:
        raise AssertionError(
            f"DataForSEO ledgers changed: {ledgers_before} -> {ledgers_after}"
        )
    image_nodes = [
        node for node in assembled["document"]["content"] if node.get("type") == "image"
    ]
    if len(image_nodes) != 1:
        raise AssertionError(f"expected one image node, got {len(image_nodes)}")
    attrs = image_nodes[0]["attrs"]
    return {
        "status": "passed",
        "source_run_id": SOURCE_RUN_ID,
        "probe_run_id": PROBE_RUN_ID,
        "project_id": PROJECT_ID,
        "article_id": ARTICLE_ID,
        "asset": {
            "asset_id": asset.asset_id,
            "status": asset.status,
            "width": asset.width,
            "height": asset.height,
            "alt": asset.default_alt_text,
        },
        "plan": probe_plan["visuals"],
        "first_resolution": first["summary"],
        "first_provider_calls": first_calls,
        "second_resolution": second["summary"],
        "second_provider_calls": second_calls,
        "second_reused": resolved[0]["reused"],
        "image_node": attrs,
        "visual_quality": quality,
        "binding_transaction": binding,
        "dataforseo_before": ledgers_before,
        "dataforseo_after": ledgers_after,
        "checked_artifact_ref": checked_ref,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--image",
        type=Path,
        default=Path("/tmp/elephtv-home-product.png"),
    )
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run_probe(args.image)), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
