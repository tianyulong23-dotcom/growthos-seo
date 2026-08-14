from __future__ import annotations

import hashlib
import re
from copy import deepcopy
from typing import Any

from app.modules.content.document import (
    document_to_markdown,
    extract_asset_manifest,
    markdown_to_document,
    normalize_document,
)
from app.modules.content.visual_generation import ResolvedVisual
from app.modules.content.writing_gateway import ArticlePlan, SectionDraft


def assemble_visual_document(
    article_artifact: dict[str, Any],
    visual_artifact: dict[str, Any],
) -> dict[str, Any]:
    output = deepcopy(article_artifact)
    raw_resolved = [
        ResolvedVisual.model_validate(item)
        for item in visual_artifact.get("visuals") or []
    ]
    if isinstance(visual_artifact.get("plan"), dict):
        output["plan"] = ArticlePlan.model_validate(
            visual_artifact["plan"]
        ).model_dump(mode="json")
    plan = ArticlePlan.model_validate(output["plan"])
    resolved, preassembly_issues = _filter_unsafe_visuals(plan, raw_resolved)
    output["visual_preassembly_issues"] = preassembly_issues
    ready = {
        item.section_id: item
        for item in resolved
        if item.status == "ready" and item.asset_id and item.alt_text.strip()
    }
    output["visuals"] = [item.model_dump(mode="json") for item in resolved]
    existing = output.get("document")
    if isinstance(existing, dict):
        normalized_existing = normalize_document(existing)
        existing_ids = _node_ids(normalized_existing)
        expected_ids = {f"visual:{item.visual_id}" for item in ready.values()}
        existing_visual_ids = {
            node_id for node_id in existing_ids if node_id.startswith("visual:")
        }
        if expected_ids == existing_visual_ids:
            output["document"] = normalized_existing
            output["markdown"] = document_to_markdown(normalized_existing)
            output["asset_manifest"] = extract_asset_manifest(normalized_existing)
            return output

    sections = [SectionDraft.model_validate(item) for item in output.get("sections") or []]
    content: list[dict[str, Any]] = []
    for section in sections:
        section_document = markdown_to_document(section.markdown)
        section_nodes = _prefix_node_ids(
            section_document["content"],
            section.section_id,
        )
        visual = ready.get(section.section_id)
        if visual is not None:
            image_node: dict[str, Any] = {
                "type": "image",
                "attrs": {
                    "node_id": f"visual:{visual.visual_id}",
                    "asset_id": visual.asset_id,
                    "alt": visual.alt_text.strip(),
                    "display": "wide",
                },
            }
            if visual.caption:
                image_node["attrs"]["caption"] = visual.caption
            if visual.width and visual.height:
                image_node["attrs"]["width"] = visual.width
                image_node["attrs"]["height"] = visual.height
            insertion_index = next(
                (
                    index + 1
                    for index, node in enumerate(section_nodes)
                    if node.get("type") == "paragraph"
                ),
                len(section_nodes),
            )
            section_nodes.insert(insertion_index, image_node)
        content.extend(section_nodes)
    document = normalize_document(
        {"type": "doc", "schema_version": 2, "content": content}
    )
    output["document"] = document
    output["markdown"] = document_to_markdown(document)
    output["asset_manifest"] = extract_asset_manifest(document)
    return output


def validate_article_visuals(artifact: dict[str, Any]) -> dict[str, Any]:
    document = normalize_document(artifact["document"])
    plan = ArticlePlan.model_validate(artifact["plan"])
    planned = {item.visual_id: item for item in plan.visuals}
    resolved = [ResolvedVisual.model_validate(item) for item in artifact.get("visuals") or []]
    node_ids = _node_ids(document)
    issues: list[dict[str, str]] = [
        {"visual_id": str(item.get("visual_id") or ""), "code": str(item["code"])}
        for item in artifact.get("visual_preassembly_issues") or []
        if isinstance(item, dict) and item.get("code")
    ]
    resolved_by_id = {item.visual_id: item for item in resolved}
    for visual_id, planned_item in planned.items():
        if planned_item.required and visual_id not in resolved_by_id:
            issues.append({"visual_id": visual_id, "code": "required_visual_missing"})
    for visual in resolved:
        node_id = f"visual:{visual.visual_id}"
        if visual.status == "ready" and node_id not in node_ids:
            issues.append({"visual_id": visual.visual_id, "code": "visual_node_missing"})
        if visual.status == "ready" and (not visual.width or not visual.height):
            issues.append({"visual_id": visual.visual_id, "code": "visual_dimensions_missing"})
        if visual.status == "ready" and (not visual.alt_text.strip() or not visual.alt_source):
            issues.append({"visual_id": visual.visual_id, "code": "visual_alt_missing"})
        if visual.required and visual.status != "ready":
            issues.append({"visual_id": visual.visual_id, "code": "required_visual_missing"})
        planned_item = planned.get(visual.visual_id)
        if planned_item is None or planned_item.section_id != visual.section_id:
            issues.append({"visual_id": visual.visual_id, "code": "visual_section_invalid"})
            continue
        issues.extend(_source_policy_issues(planned_item, visual))
    manifest = extract_asset_manifest(document)
    image_asset_ids = {
        item["asset_id"] for item in manifest if item["binding_role"] == "image"
    }
    for visual in resolved:
        if visual.status == "ready" and visual.asset_id not in image_asset_ids:
            issues.append({"visual_id": visual.visual_id, "code": "visual_asset_unbound"})
    issues = list(
        {
            (item.get("visual_id", ""), item["code"]): item
            for item in issues
        }.values()
    )
    required_ids = {item.visual_id for item in plan.visuals if item.required}
    blocking_visual_ids = {
        str(item.get("visual_id") or "")
        for item in issues
        if item["code"] == "required_visual_missing"
        or item.get("visual_id") in required_ids
    }
    return {
        "passed": not blocking_visual_ids,
        "issues": issues,
        "manifest": manifest,
        "ready_count": sum(item.status == "ready" for item in resolved),
        "required_missing_count": len(blocking_visual_ids),
    }


def _filter_unsafe_visuals(
    plan: ArticlePlan,
    resolved: list[ResolvedVisual],
) -> tuple[list[ResolvedVisual], list[dict[str, str]]]:
    planned = {item.visual_id: item for item in plan.visuals}
    seen_asset_ids: set[str] = set()
    filtered: list[ResolvedVisual] = []
    issues: list[dict[str, str]] = []
    for visual in resolved:
        planned_item = planned.get(visual.visual_id)
        codes: list[str] = []
        if visual.status == "ready":
            if not visual.asset_id:
                codes.append("visual_asset_missing")
            if not visual.alt_text.strip() or not visual.alt_source:
                codes.append("visual_alt_missing")
            if not visual.width or not visual.height:
                codes.append("visual_dimensions_missing")
            if visual.asset_id and visual.asset_id in seen_asset_ids:
                codes.append("visual_asset_duplicate")
            if planned_item is None or planned_item.section_id != visual.section_id:
                codes.append("visual_section_invalid")
            elif planned_item is not None:
                codes.extend(
                    item["code"] for item in _source_policy_issues(planned_item, visual)
                )
        issues.extend({"visual_id": visual.visual_id, "code": code} for code in codes)
        if codes:
            filtered.append(
                visual.model_copy(
                    update={
                        "asset_id": None,
                        "status": "failed" if visual.required else "omitted",
                        "failure_code": codes[0],
                    }
                )
            )
            continue
        if visual.status == "ready" and visual.asset_id:
            seen_asset_ids.add(visual.asset_id)
        filtered.append(visual)
    return filtered, issues


def _source_policy_issues(
    planned: Any,
    visual: ResolvedVisual,
) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    strategy = visual.source_strategy or planned.source_strategy
    if strategy != planned.source_strategy:
        issues.append({"visual_id": visual.visual_id, "code": "visual_source_strategy_mismatch"})
    if planned.source_strategy == "project_asset" and visual.provider != "project_asset":
        issues.append({"visual_id": visual.visual_id, "code": "visual_provider_mismatch"})
    if planned.source_strategy == "screenshot" and (
        visual.provider == "ai" or not visual.source_url
    ):
        issues.append({"visual_id": visual.visual_id, "code": "screenshot_source_invalid"})
    if planned.source_strategy == "chart" and not planned.data_claim_ids:
        issues.append({"visual_id": visual.visual_id, "code": "chart_claim_source_missing"})
    if planned.source_strategy == "stock" and (
        not visual.license_name
        or not visual.creator_name
        or not visual.attribution_url
    ):
        issues.append({"visual_id": visual.visual_id, "code": "stock_attribution_missing"})
    if planned.source_strategy in {"chart", "stock", "screenshot"} and not visual.caption:
        issues.append({"visual_id": visual.visual_id, "code": "visual_caption_missing"})
    if visual.provider == "ai" and planned.reader_job == "prove":
        issues.append({"visual_id": visual.visual_id, "code": "ai_visual_cannot_prove"})
    return issues


def _prefix_node_ids(nodes: list[dict[str, Any]], section_id: str) -> list[dict[str, Any]]:
    copied = deepcopy(nodes)
    safe_prefix = re.sub(r"[^A-Za-z0-9._:-]", "-", section_id)[:40] or "section"

    def visit(node: dict[str, Any], path: tuple[int, ...]) -> None:
        attrs = node.get("attrs")
        if isinstance(attrs, dict) and isinstance(attrs.get("node_id"), str):
            suffix = attrs["node_id"]
            candidate = f"{safe_prefix}:{suffix}"
            if len(candidate) <= 128:
                attrs["node_id"] = candidate
            else:
                digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:16]
                attrs["node_id"] = f"{candidate[:111]}:{digest}"
        for index, child in enumerate(node.get("content") or []):
            if isinstance(child, dict) and child.get("type") != "text":
                visit(child, (*path, index))

    for index, node in enumerate(copied):
        visit(node, (index,))
    return copied


def _node_ids(document: dict[str, Any]) -> set[str]:
    result: set[str] = set()

    def visit(node: dict[str, Any]) -> None:
        attrs = node.get("attrs")
        if isinstance(attrs, dict) and isinstance(attrs.get("node_id"), str):
            result.add(attrs["node_id"])
        for child in node.get("content") or []:
            if isinstance(child, dict) and child.get("type") != "text":
                visit(child)

    for block in document["content"]:
        visit(block)
    return result
