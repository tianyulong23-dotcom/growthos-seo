from __future__ import annotations

import json
from difflib import SequenceMatcher
from typing import Any, Literal


ARTICLE_DIFF_ALGORITHM_VERSION = "article-typed-diff.v1"
MEDIA_NODE_TYPES = {"image", "gallery", "file", "audio", "video"}
TABLE_NODE_TYPES = {"table", "tableRow", "tableCell", "tableHeader"}
METADATA_FIELDS = (
    "title",
    "slug",
    "meta_title",
    "meta_description",
    "focus_keyword",
    "secondary_keywords",
    "canonical_url",
    "indexing",
    "field_states",
    "publication_status",
)


def build_article_diff(
    before_document: dict[str, Any],
    after_document: dict[str, Any],
    before_metadata: dict[str, Any],
    after_metadata: dict[str, Any],
) -> dict[str, Any]:
    before_blocks = _indexed_blocks(before_document)
    after_blocks = _indexed_blocks(after_document)
    before_by_id = {block["node_id"]: block for block in before_blocks}
    after_by_id = {block["node_id"]: block for block in after_blocks}
    block_changes: list[dict[str, Any]] = []
    inline_changes: list[dict[str, Any]] = []
    media_changes: list[dict[str, Any]] = []
    table_changes: list[dict[str, Any]] = []

    for block in before_blocks:
        node_id = block["node_id"]
        if node_id not in after_by_id:
            block_changes.append(_block_change("removed", block, None))
    for block in after_blocks:
        node_id = block["node_id"]
        if node_id not in before_by_id:
            block_changes.append(_block_change("added", None, block))

    for node_id in sorted(set(before_by_id) & set(after_by_id)):
        before = before_by_id[node_id]
        after = after_by_id[node_id]
        if before["index"] != after["index"]:
            block_changes.append(_block_change("moved", before, after))
        if before["node"] != after["node"]:
            attribute_changes = _value_changes(
                before["node"].get("attrs", {}),
                after["node"].get("attrs", {}),
                "attrs",
            )
            block_changes.append(
                {
                    **_block_change("updated", before, after),
                    "attribute_changes": attribute_changes,
                }
            )
            inline_changes.extend(
                _inline_changes(node_id, before["node"], after["node"])
            )
            node_type = str(after["node"].get("type") or before["node"].get("type"))
            if node_type in MEDIA_NODE_TYPES:
                media_changes.extend(
                    _media_changes(node_id, node_type, before["node"], after["node"])
                )
            if node_type == "table":
                table_changes.extend(
                    _table_changes(node_id, before["node"], after["node"])
                )

    metadata_changes = [
        {
            "field": field,
            "before": before_metadata.get(field),
            "after": after_metadata.get(field),
        }
        for field in METADATA_FIELDS
        if before_metadata.get(field) != after_metadata.get(field)
    ]
    return {
        "algorithm_version": ARTICLE_DIFF_ALGORITHM_VERSION,
        "summary": {
            "blocks_added": sum(item["kind"] == "added" for item in block_changes),
            "blocks_removed": sum(item["kind"] == "removed" for item in block_changes),
            "blocks_moved": sum(item["kind"] == "moved" for item in block_changes),
            "blocks_updated": sum(item["kind"] == "updated" for item in block_changes),
            "inline_changes": len(inline_changes),
            "media_changes": len(media_changes),
            "table_changes": len(table_changes),
            "metadata_changes": len(metadata_changes),
        },
        "block_changes": block_changes,
        "inline_changes": inline_changes,
        "media_changes": media_changes,
        "table_changes": table_changes,
        "metadata_changes": metadata_changes,
    }


def _indexed_blocks(document: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for index, node in enumerate(document.get("content") or []):
        if not isinstance(node, dict):
            continue
        node_id = (node.get("attrs") or {}).get("node_id")
        if not isinstance(node_id, str) or not node_id:
            node_id = f"legacy:{index}:{_stable_json(node)}"
        output.append({"node_id": node_id, "index": index, "node": node})
    return output


def _block_change(
    kind: Literal["added", "removed", "moved", "updated"],
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> dict[str, Any]:
    source = after or before or {}
    node = source.get("node") or {}
    return {
        "change_id": f"block:{source.get('node_id')}:{kind}",
        "kind": kind,
        "node_id": source.get("node_id"),
        "node_type": node.get("type", "unknown"),
        "before_index": before.get("index") if before else None,
        "after_index": after.get("index") if after else None,
        "before": before.get("node") if before else None,
        "after": after.get("node") if after else None,
        "attribute_changes": [],
    }


def _inline_changes(
    node_id: str, before_node: dict[str, Any], after_node: dict[str, Any]
) -> list[dict[str, Any]]:
    before_runs = _text_runs(before_node)
    after_runs = _text_runs(after_node)
    before_text = "".join(run["text"] for run in before_runs)
    after_text = "".join(run["text"] for run in after_runs)
    output: list[dict[str, Any]] = []
    matcher = SequenceMatcher(a=before_text, b=after_text, autojunk=False)
    for index, (tag, a0, a1, b0, b1) in enumerate(matcher.get_opcodes()):
        if tag == "equal":
            continue
        output.append(
            {
                "change_id": f"inline:{node_id}:text:{index}",
                "node_id": node_id,
                "kind": {"insert": "added", "delete": "removed"}.get(tag, "updated"),
                "before_text": before_text[a0:a1],
                "after_text": after_text[b0:b1],
                "before_range": [a0, a1],
                "after_range": [b0, b1],
                "before_marks": [],
                "after_marks": [],
            }
        )
    before_marks = _mark_segments(before_runs)
    after_marks = _mark_segments(after_runs)
    for index, (before, after) in enumerate(_zip_longest(before_marks, after_marks)):
        if before == after:
            continue
        output.append(
            {
                "change_id": f"inline:{node_id}:marks:{index}",
                "node_id": node_id,
                "kind": "marks_changed",
                "before_text": before.get("text", "") if before else "",
                "after_text": after.get("text", "") if after else "",
                "before_range": before.get("range") if before else None,
                "after_range": after.get("range") if after else None,
                "before_marks": before.get("marks", []) if before else [],
                "after_marks": after.get("marks", []) if after else [],
            }
        )
    return output


def _text_runs(node: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []

    def visit(value: Any) -> None:
        if not isinstance(value, dict):
            return
        if value.get("type") == "text":
            output.append(
                {
                    "text": str(value.get("text") or ""),
                    "marks": sorted(
                        [dict(mark) for mark in value.get("marks") or [] if isinstance(mark, dict)],
                        key=_stable_json,
                    ),
                }
            )
        for child in value.get("content") or []:
            visit(child)

    visit(node)
    return output


def _mark_segments(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    offset = 0
    output = []
    for run in runs:
        text = run["text"]
        if run["marks"]:
            output.append(
                {"text": text, "range": [offset, offset + len(text)], "marks": run["marks"]}
            )
        offset += len(text)
    return output


def _media_changes(
    node_id: str,
    node_type: str,
    before_node: dict[str, Any],
    after_node: dict[str, Any],
) -> list[dict[str, Any]]:
    before_attrs = dict(before_node.get("attrs") or {})
    after_attrs = dict(after_node.get("attrs") or {})
    output: list[dict[str, Any]] = []
    if node_type == "gallery":
        before_items = list(before_attrs.get("items") or [])
        after_items = list(after_attrs.get("items") or [])
        before_order = [item.get("item_id") for item in before_items]
        after_order = [item.get("item_id") for item in after_items]
        if before_order != after_order and set(before_order) == set(after_order):
            output.append(
                {
                    "change_id": f"media:{node_id}:gallery-order",
                    "node_id": node_id,
                    "node_type": node_type,
                    "kind": "reordered",
                    "path": "attrs.items",
                    "before": before_order,
                    "after": after_order,
                }
            )
        before_by_id = {item.get("item_id"): item for item in before_items}
        after_by_id = {item.get("item_id"): item for item in after_items}
        for item_id in sorted(set(before_by_id) | set(after_by_id), key=str):
            if before_by_id.get(item_id) != after_by_id.get(item_id):
                output.append(
                    {
                        "change_id": f"media:{node_id}:gallery-item:{item_id}",
                        "node_id": node_id,
                        "node_type": node_type,
                        "kind": "item_changed",
                        "path": f"attrs.items.{item_id}",
                        "before": before_by_id.get(item_id),
                        "after": after_by_id.get(item_id),
                    }
                )
    for change in _value_changes(before_attrs, after_attrs, "attrs"):
        if node_type == "gallery" and change["path"].startswith("attrs.items"):
            continue
        output.append(
            {
                "change_id": f"media:{node_id}:{change['path']}",
                "node_id": node_id,
                "node_type": node_type,
                "kind": "asset_replaced" if change["path"].endswith("asset_id") else "attributes_changed",
                **change,
            }
        )
    return output


def _table_changes(
    node_id: str, before_node: dict[str, Any], after_node: dict[str, Any]
) -> list[dict[str, Any]]:
    before_cells = _table_cells(before_node)
    after_cells = _table_cells(after_node)
    output = []
    for coordinate in sorted(set(before_cells) | set(after_cells)):
        before = before_cells.get(coordinate)
        after = after_cells.get(coordinate)
        if before == after:
            continue
        output.append(
            {
                "change_id": f"table:{node_id}:{coordinate[0]}:{coordinate[1]}",
                "node_id": node_id,
                "row": coordinate[0],
                "column": coordinate[1],
                "kind": "cell_changed",
                "before": before,
                "after": after,
            }
        )
    return output


def _table_cells(node: dict[str, Any]) -> dict[tuple[int, int], dict[str, Any]]:
    output: dict[tuple[int, int], dict[str, Any]] = {}
    for row_index, row in enumerate(node.get("content") or []):
        for column_index, cell in enumerate(row.get("content") or []):
            output[(row_index, column_index)] = {
                "type": cell.get("type"),
                "attrs": dict(cell.get("attrs") or {}),
                "text": "".join(run["text"] for run in _text_runs(cell)),
            }
    return output


def _value_changes(before: Any, after: Any, path: str) -> list[dict[str, Any]]:
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        output = []
        for key in sorted(set(before) | set(after)):
            output.extend(_value_changes(before.get(key), after.get(key), f"{path}.{key}"))
        return output
    return [{"path": path, "before": before, "after": after}]


def _zip_longest(left: list[Any], right: list[Any]) -> list[tuple[Any | None, Any | None]]:
    size = max(len(left), len(right))
    return [
        (left[index] if index < len(left) else None, right[index] if index < len(right) else None)
        for index in range(size)
    ]


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
