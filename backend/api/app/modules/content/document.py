from __future__ import annotations

import base64
import binascii
import hashlib
import html
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from markdown_it import MarkdownIt


CURRENT_SCHEMA_VERSION = 2
MAX_CHARACTERS = 200_000
MAX_NODES = 50_000
MAX_DEPTH = 16
MAX_LINK_LENGTH = 2_048
NODE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?$")

BLOCK_TYPES = {
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "image",
    "gallery",
    "table",
    "tableRow",
    "tableCell",
    "tableHeader",
    "file",
    "audio",
    "video",
    "bookmark",
    "callout",
    "details",
    "detailsContent",
    "button",
    "embed",
}
INLINE_TYPES = {"text", "hardBreak"}
MARK_TYPES = {"bold", "italic", "strike", "code", "underline", "highlight", "link"}
NODE_ID_TYPES = BLOCK_TYPES - {
    "listItem",
    "tableRow",
    "tableCell",
    "tableHeader",
    "detailsContent",
}
ASSET_NODE_TYPES = {"image", "gallery", "file", "audio", "video"}
CALLOUT_TONES = {"note", "tip", "warning", "conclusion"}
CALLOUT_ICONS = {"info", "lightbulb", "triangle-alert", "circle-check"}
LEGACY_CALLOUT_TONES = {
    "info": "note",
    "neutral": "note",
    "success": "conclusion",
    "danger": "warning",
}
LEGACY_CALLOUT_ICONS = {
    "alert": "triangle-alert",
    "check": "circle-check",
    "idea": "lightbulb",
    "warning": "triangle-alert",
}
CALLOUT_MARKER_RE = re.compile(
    r"^\[!CALLOUT tone=(note|tip|warning|conclusion)(?: icon=(info|lightbulb|triangle-alert|circle-check))?\]$"
)
DETAILS_MARKER_RE = re.compile(r"^\[!DETAILS ([A-Za-z0-9_-]+)\]$")
DETAILS_EMPTY_PARAGRAPH_MARKER = "[!ARTICLE-EMPTY-PARAGRAPH]"
ARTICLE_DIRECTIVE_RE = re.compile(
    r"^:::article-(image|gallery|file|audio|video|bookmark|button|embed) (\{.*\})\r?\n:::$",
    re.MULTILINE,
)


class ArticleDocumentError(ValueError):
    pass


@dataclass(frozen=True)
class AssetRenderReference:
    url: str
    mime_type: str | None = None
    filename: str | None = None
    byte_size: int | None = None
    width: int | None = None
    height: int | None = None


AssetRenderReferences = Mapping[tuple[str, str], AssetRenderReference]


@dataclass
class _Inspection:
    characters: int = 0
    nodes: int = 1
    node_ids: set[str] | None = None

    def __post_init__(self) -> None:
        if self.node_ids is None:
            self.node_ids = set()


def empty_document() -> dict[str, Any]:
    return {
        "type": "doc",
        "schema_version": CURRENT_SCHEMA_VERSION,
        "content": [{"type": "paragraph", "attrs": {"node_id": "empty-root"}}],
    }


def document_capabilities(*, media_upload_enabled: bool = False) -> dict[str, Any]:
    return {
        "schema_version": CURRENT_SCHEMA_VERSION,
        "writable": True,
        "nodes": sorted(BLOCK_TYPES | INLINE_TYPES),
        "marks": sorted(MARK_TYPES),
        "heading_levels": [2, 3, 4, 5, 6],
        "asset_types": ["image", "video", "audio", "file"],
        "media_upload_enabled": media_upload_enabled,
        "limits": {
            "characters": MAX_CHARACTERS,
            "nodes": MAX_NODES,
            "depth": MAX_DEPTH,
            "url_length": MAX_LINK_LENGTH,
        },
    }


def normalize_document(value: object) -> dict[str, Any]:
    root = _record(value, "document")
    _keys(root, {"type", "schema_version", "content"}, "document")
    if root.get("type") != "doc":
        raise ArticleDocumentError("article_document_root_invalid")
    raw_schema = root.get("schema_version", 1)
    if not isinstance(raw_schema, int) or raw_schema < 1:
        raise ArticleDocumentError("article_document_schema_invalid")
    if raw_schema > CURRENT_SCHEMA_VERSION:
        raise ArticleDocumentError("article_document_schema_unsupported_read_only")
    if raw_schema < CURRENT_SCHEMA_VERSION:
        root = _migrate_v1_to_v2(root)
    content = _array(root.get("content"), "document content")
    if not content or len(content) > 10_000:
        raise ArticleDocumentError("article_document_content_invalid")
    state = _Inspection()
    normalized = [
        _normalize_block(item, state, 2, parent="doc", path=(index,))
        for index, item in enumerate(content)
    ]
    if state.nodes > MAX_NODES:
        raise ArticleDocumentError("article_document_too_many_nodes")
    if state.characters > MAX_CHARACTERS:
        raise ArticleDocumentError("article_document_too_large")
    return {"type": "doc", "schema_version": CURRENT_SCHEMA_VERSION, "content": normalized}


def canonical_document_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def document_content_hash(document: dict[str, Any], metadata: dict[str, Any] | None = None) -> str:
    normalized = normalize_document(document)
    payload = {"document": normalized, "metadata": metadata or {}}
    return hashlib.sha256(canonical_document_json(payload).encode("utf-8")).hexdigest()


def extract_asset_manifest(document: dict[str, Any]) -> list[dict[str, Any]]:
    normalized = normalize_document(document)
    result: list[dict[str, Any]] = []

    def add(asset_id: str, role: str, node_id: str, item_id: str | None = None) -> None:
        result.append(
            {
                "asset_id": asset_id,
                "binding_role": role,
                "node_id": node_id,
                "item_id": item_id,
            }
        )

    def visit(node: dict[str, Any]) -> None:
        node_type = node["type"]
        attrs = node.get("attrs", {})
        node_id = attrs.get("node_id")
        if node_type in {"image", "file", "audio", "video"}:
            add(attrs["asset_id"], node_type, node_id)
        if node_type == "gallery":
            for item in attrs["items"]:
                add(item["asset_id"], "gallery_item", node_id, item["item_id"])
        for field, role in (
            ("poster_asset_id", "poster"),
            ("thumbnail_asset_id", "thumbnail"),
        ):
            if attrs.get(field):
                add(attrs[field], role, node_id)
        for child in node.get("content", []):
            if child.get("type") != "text":
                visit(child)

    for block in normalized["content"]:
        visit(block)
    return result


def document_to_markdown(document: dict[str, Any]) -> str:
    normalized = normalize_document(document)
    body = "\n\n".join(
        part for node in normalized["content"] if (part := _block_markdown(node, 0))
    ).strip()
    return f"{body}\n" if body else ""


def document_to_html(
    document: dict[str, Any],
    *,
    asset_references: AssetRenderReferences | None = None,
) -> str:
    normalized = normalize_document(document)
    return "".join(_block_html(node, asset_references) for node in normalized["content"])


def markdown_to_document(markdown: str) -> dict[str, Any]:
    content = _markdown_blocks_with_directives(markdown)
    content = _restore_markdown_structures(content)
    candidate = {"type": "doc", "content": content or [{"type": "paragraph"}]}
    try:
        return normalize_document(candidate)
    except ArticleDocumentError:
        text = re.sub(r"\s+", " ", markdown).strip()
        if not text:
            return empty_document()
        return normalize_document(
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": text[:MAX_CHARACTERS]}],
                    }
                ],
            }
        )


def _migrate_v1_to_v2(root: dict[str, Any]) -> dict[str, Any]:
    migrated = json.loads(json.dumps(root, ensure_ascii=False))

    def visit(node: dict[str, Any], path: tuple[int, ...]) -> None:
        node_type = node.get("type")
        if node_type == "text":
            for mark in node.get("marks", []):
                if not isinstance(mark, dict) or mark.get("type") != "link":
                    continue
                attrs = mark.get("attrs")
                if isinstance(attrs, dict):
                    attrs.pop("class", None)
            return
        if node_type in NODE_ID_TYPES:
            attrs = node.setdefault("attrs", {})
            if node_type == "heading" and attrs.get("level") == 1:
                attrs["level"] = 2
            if not attrs.get("node_id"):
                snapshot = {key: val for key, val in node.items() if key != "attrs"}
                digest = hashlib.sha256(
                    f"{path}:{canonical_document_json(snapshot)}".encode("utf-8")
                ).hexdigest()[:24]
                attrs["node_id"] = f"blk_{digest}"
        for index, child in enumerate(node.get("content", [])):
            if isinstance(child, dict):
                visit(child, (*path, index))

    for index, block in enumerate(migrated.get("content", [])):
        if isinstance(block, dict):
            visit(block, (index,))
    migrated["schema_version"] = CURRENT_SCHEMA_VERSION
    return migrated


def _record(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ArticleDocumentError(f"{label.replace(' ', '_')}_invalid")
    return value


def _array(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ArticleDocumentError(f"{label.replace(' ', '_')}_invalid")
    return value


def _keys(value: dict[str, Any], allowed: set[str], label: str) -> None:
    if set(value) - allowed:
        raise ArticleDocumentError(f"{label.replace(' ', '_')}_unsupported_fields")


def _string(value: object, code: str, *, required: bool = True, maximum: int = 2_048) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value) or len(value) > maximum:
        raise ArticleDocumentError(code)
    return value


def _details_summary(value: object) -> str:
    if not isinstance(value, str):
        raise ArticleDocumentError("article_document_details_summary_invalid")
    summary = value.strip()
    if (
        not summary
        or len(summary) > 300
        or any(ord(character) < 32 or ord(character) == 127 for character in summary)
    ):
        raise ArticleDocumentError("article_document_details_summary_invalid")
    return summary


def _node_attrs(
    node: dict[str, Any],
    node_type: str,
    state: _Inspection,
    allowed: set[str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    _keys(node, {"type", "attrs", "content"}, "block")
    if node.get("attrs") is None:
        raise ArticleDocumentError("article_document_node_id_invalid")
    attrs = _record(node.get("attrs"), f"{node_type} attributes")
    _keys(attrs, allowed | {"node_id"}, f"{node_type} attributes")
    node_id = attrs.get("node_id")
    if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
        raise ArticleDocumentError("article_document_node_id_invalid")
    assert state.node_ids is not None
    if node_id in state.node_ids:
        raise ArticleDocumentError("article_document_node_id_duplicate")
    state.node_ids.add(node_id)
    return attrs, {"node_id": node_id}


def _normalize_block(
    value: object,
    state: _Inspection,
    depth: int,
    *,
    parent: str,
    path: tuple[int, ...],
) -> dict[str, Any]:
    if depth > MAX_DEPTH:
        raise ArticleDocumentError("article_document_too_deep")
    state.nodes += 1
    node = _record(value, "block")
    node_type = node.get("type")
    if node_type not in BLOCK_TYPES:
        raise ArticleDocumentError("article_document_block_unsupported")
    if node_type == "listItem" and parent not in {"bulletList", "orderedList"}:
        raise ArticleDocumentError("article_document_list_item_parent_invalid")
    if node_type == "detailsContent" and parent != "details":
        raise ArticleDocumentError("article_document_details_content_parent_invalid")

    if node_type in {"paragraph", "heading"}:
        allowed = {"textAlign"} | ({"level"} if node_type == "heading" else set())
        attrs, output_attrs = _node_attrs(node, node_type, state, allowed)
        alignment = attrs.get("textAlign")
        if alignment is not None:
            if alignment not in {"left", "center", "right", "justify"}:
                raise ArticleDocumentError("article_document_text_align_invalid")
            output_attrs["textAlign"] = alignment
        if node_type == "heading":
            level = attrs.get("level")
            if not isinstance(level, int) or not 2 <= level <= 6:
                raise ArticleDocumentError("article_document_heading_level_invalid")
            output_attrs["level"] = level
        content = [
            _normalize_inline(item, state)
            for item in _array(node.get("content", []), "inline content")
        ]
        result: dict[str, Any] = {"type": node_type, "attrs": output_attrs}
        if content:
            result["content"] = content
        return result

    if node_type == "horizontalRule":
        _, attrs = _node_attrs(node, node_type, state, set())
        if node.get("content") is not None:
            raise ArticleDocumentError("article_document_leaf_content_invalid")
        return {"type": node_type, "attrs": attrs}

    if node_type == "codeBlock":
        raw, attrs = _node_attrs(node, node_type, state, {"language"})
        language = _string(
            raw.get("language"),
            "article_document_code_language_invalid",
            required=False,
            maximum=64,
        )
        if language is not None:
            attrs["language"] = language
        content = [
            _normalize_inline(item, state, allow_marks=False)
            for item in _array(node.get("content", []), "code content")
        ]
        if any(item["type"] != "text" for item in content):
            raise ArticleDocumentError("article_document_code_content_invalid")
        result = {"type": node_type, "attrs": attrs}
        if content:
            result["content"] = content
        return result

    if node_type in {"image", "gallery", "file", "audio", "video", "bookmark", "button", "embed"}:
        return _normalize_leaf_block(node, node_type, state)

    container_result_attrs: dict[str, Any] | None
    if node_type in {"tableRow", "listItem", "detailsContent"}:
        _keys(node, {"type", "content", "attrs"}, "block")
        if node.get("attrs") is not None:
            container_attrs = _record(node["attrs"], f"{node_type} attributes")
            _keys(container_attrs, set(), f"{node_type} attributes")
        container_result_attrs = None
    elif node_type in {"tableCell", "tableHeader"}:
        _keys(node, {"type", "content", "attrs"}, "block")
        raw_cell_attrs = _record(node.get("attrs", {}), f"{node_type} attributes")
        _keys(
            raw_cell_attrs,
            {"colspan", "rowspan", "colwidth", "textAlign", "verticalAlign"},
            f"{node_type} attributes",
        )
        container_result_attrs = {}
        for field in ("colspan", "rowspan"):
            value = raw_cell_attrs.get(field, 1)
            if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 100:
                raise ArticleDocumentError(f"article_document_table_{field}_invalid")
            if value != 1:
                container_result_attrs[field] = value
        colwidth = raw_cell_attrs.get("colwidth")
        if colwidth is not None:
            if (
                not isinstance(colwidth, list)
                or not colwidth
                or len(colwidth) != raw_cell_attrs.get("colspan", 1)
                or any(
                    not isinstance(width, int)
                    or isinstance(width, bool)
                    or not 25 <= width <= 10_000
                    for width in colwidth
                )
            ):
                raise ArticleDocumentError("article_document_table_colwidth_invalid")
            container_result_attrs["colwidth"] = colwidth
        text_align = raw_cell_attrs.get("textAlign")
        if text_align is not None:
            if text_align not in {"left", "center", "right"}:
                raise ArticleDocumentError("article_document_table_text_align_invalid")
            container_result_attrs["textAlign"] = text_align
        vertical_align = raw_cell_attrs.get("verticalAlign")
        if vertical_align is not None:
            if vertical_align not in {"top", "middle", "bottom"}:
                raise ArticleDocumentError("article_document_table_vertical_align_invalid")
            container_result_attrs["verticalAlign"] = vertical_align
    else:
        allowed = {"start"} if node_type == "orderedList" else set()
        if node_type == "callout":
            allowed = {"tone", "icon"}
        elif node_type == "details":
            allowed = {"summary", "open_by_default"}
        _, container_result_attrs = _node_attrs(node, node_type, state, allowed)
        raw = _record(node["attrs"], f"{node_type} attributes")
        if node_type == "orderedList":
            start = raw.get("start", 1)
            if not isinstance(start, int) or not 1 <= start <= 1_000_000:
                raise ArticleDocumentError("article_document_list_start_invalid")
            container_result_attrs["start"] = start
        elif node_type == "callout":
            raw_tone = raw.get("tone")
            tone = LEGACY_CALLOUT_TONES.get(raw_tone, raw_tone)
            if tone not in CALLOUT_TONES:
                raise ArticleDocumentError("article_document_callout_tone_invalid")
            container_result_attrs["tone"] = tone
            icon = _string(
                raw.get("icon"), "article_document_callout_icon_invalid", required=False, maximum=64
            )
            if icon is not None:
                icon = LEGACY_CALLOUT_ICONS.get(icon, icon)
                if icon not in CALLOUT_ICONS:
                    raise ArticleDocumentError("article_document_callout_icon_invalid")
                container_result_attrs["icon"] = icon
        elif node_type == "details":
            container_result_attrs["summary"] = _details_summary(raw.get("summary"))
            opened = raw.get("open_by_default", False)
            if not isinstance(opened, bool):
                raise ArticleDocumentError("article_document_details_open_invalid")
            container_result_attrs["open_by_default"] = opened

    children = _array(node.get("content"), "block content")
    if not children or len(children) > 5_000:
        raise ArticleDocumentError("article_document_block_content_invalid")
    normalized = [
        _normalize_block(item, state, depth + 1, parent=node_type, path=(*path, index))
        for index, item in enumerate(children)
    ]
    expected = {
        "bulletList": {"listItem"},
        "orderedList": {"listItem"},
        "table": {"tableRow"},
        "tableRow": {"tableCell", "tableHeader"},
        "callout": {"paragraph", "bulletList", "orderedList"},
        "details": {"detailsContent"},
        "detailsContent": {"paragraph", "bulletList", "orderedList"},
    }.get(node_type)
    if expected and any(item["type"] not in expected for item in normalized):
        raise ArticleDocumentError("article_document_block_content_invalid")
    if node_type == "listItem" and normalized[0]["type"] not in {
        "paragraph",
        "heading",
    }:
        raise ArticleDocumentError("article_document_block_content_invalid")
    if node_type in {"tableCell", "tableHeader"} and any(
        item["type"] != "paragraph" for item in normalized
    ):
        raise ArticleDocumentError("article_document_table_cell_content_invalid")
    if node_type == "table":
        _validate_table_rectangular(normalized)
    result = {"type": node_type, "content": normalized}
    if container_result_attrs is not None:
        result["attrs"] = container_result_attrs
    return result


def _validate_table_rectangular(rows: list[dict[str, Any]]) -> None:
    occupied: list[set[int]] = [set() for _ in rows]
    expected_width: int | None = None

    for row_index, row in enumerate(rows):
        column = 0
        for cell in row["content"]:
            while column in occupied[row_index]:
                column += 1
            attrs = cell.get("attrs", {})
            colspan = attrs.get("colspan", 1)
            rowspan = attrs.get("rowspan", 1)
            if row_index + rowspan > len(rows):
                raise ArticleDocumentError("article_document_table_rectangular_invalid")
            for target_row in range(row_index, row_index + rowspan):
                for target_column in range(column, column + colspan):
                    if target_column in occupied[target_row]:
                        raise ArticleDocumentError(
                            "article_document_table_rectangular_invalid"
                        )
                    occupied[target_row].add(target_column)
            column += colspan

        row_width = max(occupied[row_index], default=-1) + 1
        if row_width == 0 or occupied[row_index] != set(range(row_width)):
            raise ArticleDocumentError("article_document_table_rectangular_invalid")
        if expected_width is None:
            expected_width = row_width
        elif row_width != expected_width:
            raise ArticleDocumentError("article_document_table_rectangular_invalid")


def _normalize_leaf_block(
    node: dict[str, Any], node_type: str, state: _Inspection
) -> dict[str, Any]:
    allowed_by_type = {
        "image": {
            "asset_id",
            "alt",
            "decorative",
            "display",
            "caption",
            "link",
            "width",
            "height",
        },
        "gallery": {"items", "display"},
        "file": {"asset_id", "display_name", "description"},
        "audio": {"asset_id", "title", "caption", "duration_ms"},
        "video": {"asset_id", "title", "caption", "poster_asset_id", "duration_ms"},
        "bookmark": {
            "url",
            "title",
            "description",
            "thumbnail_asset_id",
            "publisher",
            "icon_url",
            "image_url",
            "fetched_at",
        },
        "button": {"label", "href", "style", "target", "rel"},
        "embed": {"provider", "source_url", "embed_id", "caption"},
    }
    raw, attrs = _node_attrs(node, node_type, state, allowed_by_type[node_type])
    if node.get("content") is not None:
        raise ArticleDocumentError("article_document_leaf_content_invalid")

    def copy_text(field: str, *, required: bool = False, maximum: int = 2_048) -> None:
        value = _string(
            raw.get(field), f"article_document_{field}_invalid", required=required, maximum=maximum
        )
        if value is not None:
            attrs[field] = value

    if node_type in ASSET_NODE_TYPES - {"gallery"}:
        copy_text("asset_id", required=True, maximum=200)
    if node_type == "image":
        alt = raw.get("alt")
        if not isinstance(alt, str) or len(alt) > 2_000:
            raise ArticleDocumentError("article_document_alt_invalid")
        decorative = raw.get("decorative", False)
        if not isinstance(decorative, bool):
            raise ArticleDocumentError("article_document_decorative_invalid")
        if decorative and alt:
            raise ArticleDocumentError("article_document_decorative_alt_invalid")
        if not decorative and not alt:
            raise ArticleDocumentError("article_document_alt_required")
        attrs["alt"] = alt
        if "decorative" in raw:
            attrs["decorative"] = decorative
        display = raw.get("display")
        if display not in {"regular", "wide", "full"}:
            raise ArticleDocumentError("article_document_display_invalid")
        attrs["display"] = display
        copy_text("caption", maximum=5_000)
        if raw.get("link") is not None:
            attrs["link"] = _safe_url(raw["link"])
        for field in ("width", "height"):
            if raw.get(field) is not None:
                value = raw[field]
                if not isinstance(value, int) or value < 1 or value > 100_000:
                    raise ArticleDocumentError(f"article_document_{field}_invalid")
                attrs[field] = value
    elif node_type == "gallery":
        items = _array(raw.get("items"), "gallery items")
        if not 2 <= len(items) <= 20:
            raise ArticleDocumentError("article_document_gallery_items_invalid")
        normalized_items = []
        seen = set()
        for item_value in items:
            item = _record(item_value, "gallery item")
            _keys(
                item,
                {
                    "item_id",
                    "asset_id",
                    "alt",
                    "decorative",
                    "caption",
                    "link",
                    "width",
                    "height",
                },
                "gallery item",
            )
            item_id = _string(
                item.get("item_id"), "article_document_gallery_item_id_invalid", maximum=128
            )
            if item_id in seen:
                raise ArticleDocumentError("article_document_gallery_item_id_duplicate")
            seen.add(item_id)
            alt_value = item.get("alt")
            if not isinstance(alt_value, str) or len(alt_value) > 2_000:
                raise ArticleDocumentError("article_document_alt_invalid")
            alt = alt_value
            decorative = item.get("decorative", False)
            if not isinstance(decorative, bool):
                raise ArticleDocumentError("article_document_decorative_invalid")
            if decorative and alt:
                raise ArticleDocumentError("article_document_decorative_alt_invalid")
            if not decorative and not alt:
                raise ArticleDocumentError("article_document_alt_required")
            normalized_item = {
                "item_id": item_id,
                "asset_id": _string(
                    item.get("asset_id"), "article_document_asset_id_invalid", maximum=200
                ),
                "alt": alt,
            }
            if "decorative" in item:
                normalized_item["decorative"] = decorative
            for field in ("caption",):
                if item.get(field) is not None:
                    normalized_item[field] = _string(
                        item[field], f"article_document_{field}_invalid", maximum=5_000
                    )
            if item.get("link") is not None:
                normalized_item["link"] = _safe_url(item["link"])
            for field in ("width", "height"):
                if item.get(field) is not None:
                    value = item[field]
                    if (
                        not isinstance(value, int)
                        or isinstance(value, bool)
                        or value < 1
                        or value > 100_000
                    ):
                        raise ArticleDocumentError(f"article_document_{field}_invalid")
                    normalized_item[field] = value
            normalized_items.append(normalized_item)
        attrs["items"] = normalized_items
        display = raw.get("display", "regular")
        if display not in {"regular", "wide", "full"}:
            raise ArticleDocumentError("article_document_display_invalid")
        attrs["display"] = display
    elif node_type == "file":
        copy_text("display_name", required=True, maximum=500)
        copy_text("description", maximum=5_000)
    elif node_type in {"audio", "video"}:
        copy_text("title", maximum=500)
        copy_text("caption", maximum=5_000)
        if node_type == "video":
            copy_text("poster_asset_id", maximum=200)
        if raw.get("duration_ms") is not None:
            duration = raw["duration_ms"]
            if not isinstance(duration, int) or duration < 0 or duration > 86_400_000:
                raise ArticleDocumentError("article_document_duration_invalid")
            attrs["duration_ms"] = duration
    elif node_type == "bookmark":
        attrs["url"] = _safe_url(raw.get("url"), absolute=True)
        for field, limit in (
            ("title", 500),
            ("description", 5_000),
            ("thumbnail_asset_id", 200),
            ("publisher", 500),
            ("fetched_at", 100),
        ):
            copy_text(field, maximum=limit)
        for field in ("icon_url", "image_url"):
            if raw.get(field) is not None:
                attrs[field] = _safe_url(raw[field], absolute=True)
    elif node_type == "button":
        copy_text("label", required=True, maximum=200)
        attrs["href"] = _safe_url(raw.get("href"))
        style = raw.get("style", "primary")
        if style not in {"primary", "secondary", "outline", "link"}:
            raise ArticleDocumentError("article_document_button_style_invalid")
        attrs["style"] = style
        _copy_link_behavior(raw, attrs)
    elif node_type == "embed":
        provider = raw.get("provider")
        domains = {
            "youtube": {
                "youtube.com",
                "www.youtube.com",
                "m.youtube.com",
                "youtu.be",
            },
            "vimeo": {"vimeo.com", "www.vimeo.com", "player.vimeo.com"},
            "spotify": {"open.spotify.com"},
        }
        if provider not in domains:
            raise ArticleDocumentError("article_document_embed_provider_invalid")
        source_url = _safe_url(raw.get("source_url"), absolute=True)
        hostname = (urlsplit(source_url).hostname or "").lower()
        if hostname not in domains[provider]:
            raise ArticleDocumentError("article_document_embed_domain_invalid")
        attrs.update({"provider": provider, "source_url": source_url})
        copy_text("embed_id", required=True, maximum=500)
        copy_text("caption", maximum=5_000)
    return {"type": node_type, "attrs": attrs}


def _normalize_inline(
    value: object, state: _Inspection, *, allow_marks: bool = True
) -> dict[str, Any]:
    state.nodes += 1
    node = _record(value, "inline node")
    node_type = node.get("type")
    if node_type not in INLINE_TYPES:
        raise ArticleDocumentError("article_document_inline_unsupported")
    if node_type == "hardBreak":
        _keys(node, {"type"}, "hard break")
        return {"type": "hardBreak"}
    _keys(node, {"type", "text", "marks"}, "text")
    text_value = node.get("text")
    if not isinstance(text_value, str) or not text_value:
        raise ArticleDocumentError("article_document_text_invalid")
    state.characters += len(text_value)
    result: dict[str, Any] = {"type": "text", "text": text_value}
    marks = [_normalize_mark(item) for item in _array(node.get("marks", []), "marks")]
    if not allow_marks and marks:
        raise ArticleDocumentError("article_document_code_marks_invalid")
    if len(marks) > 7 or len({item["type"] for item in marks}) != len(marks):
        raise ArticleDocumentError("article_document_marks_invalid")
    if marks:
        result["marks"] = marks
    return result


def _normalize_mark(value: object) -> dict[str, Any]:
    mark = _record(value, "mark")
    mark_type = mark.get("type")
    if mark_type not in MARK_TYPES:
        raise ArticleDocumentError("article_document_mark_unsupported")
    if mark_type in {"bold", "italic", "strike", "code", "underline"}:
        _keys(mark, {"type"}, "mark")
        return {"type": mark_type}
    if mark_type == "highlight":
        _keys(mark, {"type", "attrs"}, "highlight mark")
        highlight_attrs = _record(mark.get("attrs", {}), "highlight attributes")
        _keys(highlight_attrs, {"color"}, "highlight attributes")
        result: dict[str, Any] = {"type": "highlight"}
        color = highlight_attrs.get("color")
        if color is not None:
            if not isinstance(color, str) or not COLOR_RE.fullmatch(color):
                raise ArticleDocumentError("article_document_highlight_color_invalid")
            result["attrs"] = {"color": color.lower()}
        return result
    _keys(mark, {"type", "attrs"}, "link mark")
    raw = _record(mark.get("attrs"), "link attributes")
    _keys(raw, {"href", "target", "rel", "title", "link_kind"}, "link attributes")
    link_attrs: dict[str, Any] = {"href": _safe_url(raw.get("href"))}
    _copy_link_behavior(raw, link_attrs)
    title = _string(
        raw.get("title"), "article_document_link_title_invalid", required=False, maximum=500
    )
    if title is not None:
        link_attrs["title"] = title
    link_kind = raw.get("link_kind")
    if link_kind is not None:
        if link_kind not in {"internal", "external", "download", "affiliate"}:
            raise ArticleDocumentError("article_document_link_kind_invalid")
        link_attrs["link_kind"] = link_kind
    return {"type": "link", "attrs": link_attrs}


def _safe_url(value: object, *, absolute: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_LINK_LENGTH:
        raise ArticleDocumentError("article_document_link_invalid")
    if any(char.isspace() for char in value) or "\\" in value:
        raise ArticleDocumentError("article_document_link_invalid")
    parsed = urlsplit(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return value
    if not absolute and value.startswith("/") and not value.startswith("//"):
        return value
    raise ArticleDocumentError("article_document_link_invalid")


def _copy_link_behavior(raw: dict[str, Any], attrs: dict[str, Any]) -> None:
    target = raw.get("target")
    if target is not None:
        if target not in {"_self", "_blank"}:
            raise ArticleDocumentError("article_document_link_target_invalid")
        attrs["target"] = target
    rel = raw.get("rel")
    rel_tokens: list[str] = []
    if rel is not None:
        if (
            not isinstance(rel, str)
            or len(rel) > 200
            or any(
                token not in {"noopener", "noreferrer", "nofollow", "sponsored", "ugc"}
                for token in rel.split()
            )
        ):
            raise ArticleDocumentError("article_document_link_rel_invalid")
        rel_tokens = list(dict.fromkeys(rel.split()))
    if target == "_blank":
        for token in ("noopener", "noreferrer"):
            if token not in rel_tokens:
                rel_tokens.append(token)
    if rel_tokens:
        attrs["rel"] = " ".join(rel_tokens)


def _inline_markdown(content: list[dict[str, Any]]) -> str:
    output: list[str] = []
    wrappers = {"bold": "**", "italic": "*", "strike": "~~", "code": "`", "underline": "<u>"}
    for node in content:
        if node["type"] == "hardBreak":
            output.append("  \n")
            continue
        text_value = node["text"]
        marks = node.get("marks", [])
        link = next((item for item in marks if item["type"] == "link"), None)
        for mark in (item for item in marks if item["type"] in wrappers):
            wrapper = wrappers[mark["type"]]
            text_value = f"{wrapper}{text_value}{'</u>' if wrapper == '<u>' else wrapper}"
        if link:
            text_value = f"[{text_value}]({link['attrs']['href']})"
        output.append(text_value)
    return "".join(output)


def _block_markdown(node: dict[str, Any], depth: int) -> str:
    node_type = node["type"]
    attrs = node.get("attrs", {})
    if node_type == "paragraph":
        return _inline_markdown(node.get("content", []))
    if node_type == "heading":
        return f"{'#' * attrs['level']} {_inline_markdown(node.get('content', []))}"
    if node_type == "horizontalRule":
        return "---"
    if node_type == "codeBlock":
        return f"```{attrs.get('language', '')}\n{_inline_markdown(node.get('content', []))}\n```"
    if node_type == "blockquote":
        return "\n".join(
            f"> {line}"
            for child in node["content"]
            for line in _block_markdown(child, depth + 1).splitlines()
        )
    if node_type == "listItem":
        return "\n\n".join(_block_markdown(child, depth + 1) for child in node["content"])
    if node_type in {"bulletList", "orderedList"}:
        start = int(attrs.get("start", 1))
        return "\n".join(
            ("- " if node_type == "bulletList" else f"{start + index}. ")
            + _block_markdown(child, depth + 1).replace("\n", "\n  ")
            for index, child in enumerate(node["content"])
        )
    if node_type == "callout":
        marker = f"[!CALLOUT tone={attrs['tone']}"
        if attrs.get("icon"):
            marker += f" icon={attrs['icon']}"
        marker += "]"
        body = "\n\n".join(_block_markdown(child, depth + 1) for child in node.get("content", []))
        quoted_body = "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
        return f"> {marker}\n>\n{quoted_body}"
    if node_type == "details":
        payload = canonical_document_json(
            {
                "open_by_default": attrs.get("open_by_default", False),
                "summary": attrs["summary"],
            }
        ).encode("utf-8")
        encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
        details_content = node.get("content", [])
        body_nodes = details_content[0].get("content", []) if details_content else []
        body_parts = [
            DETAILS_EMPTY_PARAGRAPH_MARKER
            if child["type"] == "paragraph" and not child.get("content")
            else _block_markdown(child, depth + 1)
            for child in body_nodes
        ]
        body = "\n\n".join(body_parts)
        quoted_body = "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
        return f"> [!DETAILS {encoded}]\n>\n{quoted_body}"
    if node_type in {"table", "tableRow", "tableCell", "tableHeader", "detailsContent"}:
        return "\n".join(_block_markdown(child, depth + 1) for child in node.get("content", []))
    if node_type in {
        "image",
        "gallery",
        "file",
        "audio",
        "video",
        "bookmark",
        "button",
        "embed",
    }:
        return f":::article-{node_type} {canonical_document_json(attrs)}\n:::"
    return f":::article-{node_type} {canonical_document_json(attrs)}\n:::"


def _markdown_blocks(markdown: str) -> list[dict[str, Any]]:
    if not markdown.strip():
        return []
    tokens = MarkdownIt(
        "commonmark", {"html": False, "linkify": False}
    ).enable("table").parse(markdown)
    content, _ = _tokens_to_blocks(tokens, 0)
    return content


def _markdown_blocks_with_directives(markdown: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    cursor = 0
    for match in ARTICLE_DIRECTIVE_RE.finditer(markdown):
        try:
            attrs = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
        if not isinstance(attrs, dict):
            continue
        output.extend(_markdown_blocks(markdown[cursor : match.start()]))
        output.append({"type": match.group(1), "attrs": attrs})
        cursor = match.end()
    output.extend(_markdown_blocks(markdown[cursor:]))
    return output


def _inline_html(content: list[dict[str, Any]]) -> str:
    output: list[str] = []
    tags = {"bold": "strong", "italic": "em", "strike": "s", "code": "code", "underline": "u"}
    for node in content:
        if node["type"] == "hardBreak":
            output.append("<br>")
            continue
        value = html.escape(node["text"])
        for mark in node.get("marks", []):
            if mark["type"] in tags:
                tag = tags[mark["type"]]
                value = f"<{tag}>{value}</{tag}>"
            elif mark["type"] == "highlight":
                color = mark.get("attrs", {}).get("color")
                style = (
                    f' style="background-color:{html.escape(color, quote=True)}"' if color else ""
                )
                value = f"<mark{style}>{value}</mark>"
            elif mark["type"] == "link":
                attrs = mark["attrs"]
                href = html.escape(attrs["href"], quote=True)
                target = f' target="{attrs["target"]}"' if attrs.get("target") else ""
                rel = attrs.get("rel") or (
                    "noopener noreferrer" if attrs.get("target") == "_blank" else None
                )
                rel_attr = f' rel="{html.escape(rel, quote=True)}"' if rel else ""
                value = f'<a href="{href}"{target}{rel_attr}>{value}</a>'
        output.append(value)
    return "".join(output)


def _asset_render_reference(
    asset_id: str,
    role: str,
    references: AssetRenderReferences | None,
) -> AssetRenderReference:
    reference = references.get((asset_id, role)) if references is not None else None
    if reference is None and references is not None and role != "original":
        reference = references.get((asset_id, "original"))
    if reference is None:
        suffix = "#poster" if role == "poster" else ""
        return AssetRenderReference(url=f"asset:{asset_id}{suffix}")
    parsed = urlsplit(reference.url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ArticleDocumentError("article_document_asset_url_invalid")
    if any(character.isspace() for character in reference.url) or "\\" in reference.url:
        raise ArticleDocumentError("article_document_asset_url_invalid")
    return reference


def _asset_url(reference: AssetRenderReference) -> str:
    return html.escape(reference.url, quote=True)


def _asset_data_attributes(reference: AssetRenderReference) -> str:
    attributes = []
    if reference.mime_type:
        attributes.append(f' data-mime-type="{html.escape(reference.mime_type, quote=True)}"')
    if reference.byte_size is not None:
        attributes.append(f' data-byte-size="{reference.byte_size}"')
    return "".join(attributes)


def _media_caption(title: str | None, caption: str | None) -> str:
    parts = []
    if title:
        parts.append(f'<strong class="article-media-title">{html.escape(title)}</strong>')
    if caption:
        parts.append(f'<span class="article-media-caption">{html.escape(caption)}</span>')
    return f"<figcaption>{''.join(parts)}</figcaption>" if parts else ""


def _block_html(node: dict[str, Any], references: AssetRenderReferences | None = None) -> str:
    node_type = node["type"]
    attrs = node.get("attrs", {})
    align = f' style="text-align:{attrs["textAlign"]}"' if attrs.get("textAlign") else ""
    if node_type == "paragraph":
        return f"<p{align}>{_inline_html(node.get('content', []))}</p>"
    if node_type == "heading":
        level = attrs["level"]
        return f"<h{level}{align}>{_inline_html(node.get('content', []))}</h{level}>"
    if node_type == "horizontalRule":
        return "<hr>"
    if node_type == "codeBlock":
        value = "".join(item.get("text", "") for item in node.get("content", []))
        language = html.escape(attrs.get("language", ""), quote=True)
        class_name = f' class="language-{language}"' if language else ""
        return f"<pre><code{class_name}>{html.escape(value)}</code></pre>"
    if node_type == "blockquote":
        return f"<blockquote>{''.join(_block_html(item, references) for item in node['content'])}</blockquote>"
    if node_type == "listItem":
        return f"<li>{''.join(_block_html(item, references) for item in node['content'])}</li>"
    if node_type in {"bulletList", "orderedList"}:
        tag = "ul" if node_type == "bulletList" else "ol"
        start = attrs.get("start")
        start_attr = f' start="{start}"' if tag == "ol" and start not in {None, 1} else ""
        return f"<{tag}{start_attr}>{''.join(_block_html(item, references) for item in node['content'])}</{tag}>"
    if node_type == "table":
        rows = node["content"]
        header_rows = []
        body_rows = rows
        if rows and all(cell["type"] == "tableHeader" for cell in rows[0]["content"]):
            header_rows = [rows[0]]
            body_rows = rows[1:]
        thead = (
            f"<thead>{''.join(_block_html(item, references) for item in header_rows)}</thead>"
            if header_rows
            else ""
        )
        tbody = f"<tbody>{''.join(_block_html(item, references) for item in body_rows)}</tbody>"
        return f'<div class="article-table-wrapper"><table>{thead}{tbody}</table></div>'
    if node_type == "tableRow":
        return f"<tr>{''.join(_block_html(item, references) for item in node['content'])}</tr>"
    if node_type in {"tableCell", "tableHeader"}:
        tag = "td" if node_type == "tableCell" else "th"
        cell_attrs = []
        if attrs.get("colspan", 1) != 1:
            cell_attrs.append(f' colspan="{attrs["colspan"]}"')
        if attrs.get("rowspan", 1) != 1:
            cell_attrs.append(f' rowspan="{attrs["rowspan"]}"')
        if tag == "th":
            cell_attrs.append(' scope="col"')
        styles = []
        if attrs.get("textAlign"):
            styles.append(f"text-align:{attrs['textAlign']}")
        if attrs.get("verticalAlign"):
            styles.append(f"vertical-align:{attrs['verticalAlign']}")
        if styles:
            cell_attrs.append(f' style="{html.escape(";".join(styles), quote=True)}"')
        return f"<{tag}{''.join(cell_attrs)}>{''.join(_block_html(item, references) for item in node['content'])}</{tag}>"
    if node_type == "image":
        reference = _asset_render_reference(attrs["asset_id"], "original", references)
        source = _asset_url(reference)
        alt = html.escape(attrs["alt"], quote=True)
        dimensions = ""
        width = attrs.get("width") or reference.width
        height = attrs.get("height") or reference.height
        if width and height:
            dimensions = f' width="{width}" height="{height}"'
        image = (
            f'<img src="{source}" alt="{alt}"{dimensions} loading="lazy" '
            f'decoding="async"{_asset_data_attributes(reference)}>'
        )
        if attrs.get("link"):
            link = html.escape(attrs["link"], quote=True)
            image = f'<a href="{link}">{image}</a>'
        caption = (
            f"<figcaption>{html.escape(attrs['caption'])}</figcaption>"
            if attrs.get("caption")
            else ""
        )
        display = html.escape(attrs["display"], quote=True)
        return (
            f'<figure class="article-image article-image-{display}" '
            f'data-asset-id="{html.escape(attrs["asset_id"], quote=True)}">'
            f"{image}{caption}</figure>"
        )
    if node_type == "gallery":
        items = []
        for item in attrs["items"]:
            reference = _asset_render_reference(item["asset_id"], "original", references)
            width = item.get("width") or reference.width
            height = item.get("height") or reference.height
            dimensions = f' width="{width}" height="{height}"' if width and height else ""
            image = (
                f'<img src="{_asset_url(reference)}" '
                f'alt="{html.escape(item["alt"], quote=True)}"{dimensions} '
                f'loading="lazy" decoding="async"{_asset_data_attributes(reference)}>'
            )
            if item.get("link"):
                image = f'<a href="{html.escape(item["link"], quote=True)}">{image}</a>'
            caption = (
                f"<figcaption>{html.escape(item['caption'])}</figcaption>"
                if item.get("caption")
                else ""
            )
            items.append(
                f'<figure class="article-gallery-item" '
                f'data-gallery-item-id="{html.escape(item["item_id"], quote=True)}" '
                f'data-asset-id="{html.escape(item["asset_id"], quote=True)}">'
                f"{image}{caption}</figure>"
            )
        display = html.escape(attrs["display"], quote=True)
        return (
            f'<div class="article-gallery article-gallery-{display}" '
            f'data-article-node="gallery">{"".join(items)}</div>'
        )
    if node_type == "file":
        reference = _asset_render_reference(attrs["asset_id"], "download", references)
        filename = reference.filename or attrs["display_name"]
        description = (
            f'<span class="article-file-description">{html.escape(attrs["description"])}</span>'
            if attrs.get("description")
            else ""
        )
        metadata = ""
        if reference.filename or reference.mime_type or reference.byte_size is not None:
            metadata_parts = [
                value
                for value in (
                    reference.filename,
                    reference.mime_type,
                    str(reference.byte_size) if reference.byte_size is not None else None,
                )
                if value
            ]
            metadata = (
                f'<span class="article-file-metadata">'
                f"{html.escape(' · '.join(metadata_parts))}</span>"
            )
        return (
            f'<div class="article-file" data-article-node="file" '
            f'data-asset-id="{html.escape(attrs["asset_id"], quote=True)}">'
            f'<a href="{_asset_url(reference)}" '
            f'download="{html.escape(filename, quote=True)}"'
            f"{_asset_data_attributes(reference)}>"
            f'<span class="article-file-title">{html.escape(attrs["display_name"])}</span>'
            f"{description}{metadata}</a></div>"
        )
    if node_type == "audio":
        reference = _asset_render_reference(attrs["asset_id"], "original", references)
        mime_type = (
            f'<source src="{_asset_url(reference)}" '
            f'type="{html.escape(reference.mime_type, quote=True)}">'
            if reference.mime_type
            else ""
        )
        return (
            f'<figure class="article-audio" data-article-node="audio" '
            f'data-asset-id="{html.escape(attrs["asset_id"], quote=True)}" '
            f'data-duration-ms="{attrs.get("duration_ms", "")}"'
            f"{_asset_data_attributes(reference)}>"
            f'<audio src="{_asset_url(reference)}" controls preload="metadata">'
            f"{mime_type}</audio>{_media_caption(attrs.get('title'), attrs.get('caption'))}"
            f"</figure>"
        )
    if node_type == "video":
        reference = _asset_render_reference(attrs["asset_id"], "original", references)
        poster_asset_id = attrs.get("poster_asset_id")
        poster = _asset_render_reference(
            poster_asset_id or attrs["asset_id"],
            "original" if poster_asset_id else "poster",
            references,
        )
        dimensions = ""
        if reference.width and reference.height:
            dimensions = f' width="{reference.width}" height="{reference.height}"'
        mime_type = (
            f'<source src="{_asset_url(reference)}" '
            f'type="{html.escape(reference.mime_type, quote=True)}">'
            if reference.mime_type
            else ""
        )
        return (
            f'<figure class="article-video" data-article-node="video" '
            f'data-asset-id="{html.escape(attrs["asset_id"], quote=True)}" '
            f'data-duration-ms="{attrs.get("duration_ms", "")}"'
            f"{_asset_data_attributes(reference)}>"
            f'<video src="{_asset_url(reference)}" poster="{_asset_url(poster)}" '
            f'controls playsinline preload="metadata"{dimensions}>'
            f"{mime_type}</video>{_media_caption(attrs.get('title'), attrs.get('caption'))}"
            f"</figure>"
        )
    if node_type == "bookmark":
        url = html.escape(attrs["url"], quote=True)
        title = html.escape(attrs.get("title") or attrs["url"])
        description = (
            f'<span class="article-bookmark-description">'
            f'{html.escape(attrs["description"])}</span>'
            if attrs.get("description")
            else ""
        )
        publisher = (
            f'<span class="article-bookmark-publisher">'
            f'{html.escape(attrs["publisher"])}</span>'
            if attrs.get("publisher")
            else ""
        )
        icon = (
            f'<img class="article-bookmark-icon" src="{html.escape(attrs["icon_url"], quote=True)}" alt="">'
            if attrs.get("icon_url")
            else ""
        )
        image = (
            f'<img class="article-bookmark-image" src="{html.escape(attrs["image_url"], quote=True)}" alt="">'
            if attrs.get("image_url")
            else ""
        )
        return (
            f'<aside class="article-bookmark" data-article-node="bookmark">'
            f'<a href="{url}" target="_blank" rel="noopener noreferrer">'
            f'<span class="article-bookmark-content"><strong>{title}</strong>'
            f'{description}<span class="article-bookmark-meta">{icon}{publisher}</span>'
            f'</span>{image}</a></aside>'
        )
    if node_type == "button":
        target = f' target="{html.escape(attrs["target"], quote=True)}"' if attrs.get("target") else ""
        rel = f' rel="{html.escape(attrs["rel"], quote=True)}"' if attrs.get("rel") else ""
        return (
            f'<p class="article-button-wrap" data-article-node="button">'
            f'<a class="article-button article-button-{html.escape(attrs["style"], quote=True)}" '
            f'href="{html.escape(attrs["href"], quote=True)}"{target}{rel}>'
            f'{html.escape(attrs["label"])}</a></p>'
        )
    if node_type == "embed":
        provider = attrs["provider"]
        embed_id = html.escape(attrs["embed_id"], quote=True)
        embed_urls = {
            "youtube": f"https://www.youtube-nocookie.com/embed/{embed_id}",
            "vimeo": f"https://player.vimeo.com/video/{embed_id}",
            "spotify": f"https://open.spotify.com/embed/{embed_id}",
        }
        caption = (
            f'<figcaption>{html.escape(attrs["caption"])}</figcaption>'
            if attrs.get("caption")
            else ""
        )
        return (
            f'<figure class="article-embed article-embed-{provider}" data-article-node="embed">'
            f'<iframe src="{embed_urls[provider]}" loading="lazy" '
            f'allow="fullscreen; autoplay; encrypted-media; picture-in-picture" '
            f'referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>'
            f'{caption}</figure>'
        )
    if node_type in {"callout", "details", "detailsContent"}:
        body = "".join(_block_html(item, references) for item in node.get("content", []))
        if node_type == "details":
            opened = " open" if attrs.get("open_by_default") else ""
            return (
                f'<details class="article-details" data-article-node="details"{opened}>'
                f"<summary>{html.escape(attrs['summary'])}</summary>{body}</details>"
            )
        if node_type == "callout":
            tone = html.escape(attrs["tone"], quote=True)
            icon = attrs.get("icon")
            icon_attr = f' data-icon="{html.escape(icon, quote=True)}"' if icon else ""
            icon_html = (
                f'<span class="article-callout-icon" data-icon="{html.escape(icon, quote=True)}" aria-hidden="true"></span>'
                if icon
                else ""
            )
            return (
                f'<aside class="article-callout article-callout-{tone}" '
                f'data-article-node="callout" data-tone="{tone}"{icon_attr}>'
                f'{icon_html}<div class="article-callout-content">{body}</div></aside>'
            )
        tag = "aside" if node_type == "callout" else "div"
        return f'<{tag} data-article-node="{node_type}">{body}</{tag}>'
    escaped_type = html.escape(node_type, quote=True)
    escaped_attrs = html.escape(canonical_document_json(attrs), quote=True)
    return f'<div data-article-node="{escaped_type}" data-article-attrs="{escaped_attrs}"></div>'


def _tokens_to_blocks(
    tokens: list[Any], index: int, closing: str | None = None
) -> tuple[list[dict[str, Any]], int]:
    output: list[dict[str, Any]] = []
    while index < len(tokens):
        token = tokens[index]
        if closing and token.type == closing:
            return output, index + 1
        if token.type in {"paragraph_open", "heading_open"}:
            inline = tokens[index + 1] if index + 1 < len(tokens) else None
            content = _inline_tokens(getattr(inline, "children", None) or [])
            node: dict[str, Any] = {
                "type": "paragraph" if token.type == "paragraph_open" else "heading"
            }
            if node["type"] == "heading":
                node["attrs"] = {"level": int(token.tag[1])}
            if content:
                node["content"] = content
            output.append(node)
            index += 3
            continue
        containers = {
            "bullet_list_open": ("bulletList", "bullet_list_close"),
            "ordered_list_open": ("orderedList", "ordered_list_close"),
            "list_item_open": ("listItem", "list_item_close"),
            "blockquote_open": ("blockquote", "blockquote_close"),
            "table_open": ("table", "table_close"),
            "tr_open": ("tableRow", "tr_close"),
        }
        if token.type in containers:
            node_type, end = containers[token.type]
            children, index = _tokens_to_blocks(tokens, index + 1, end)
            node = {"type": node_type, "content": children}
            if node_type == "orderedList" and token.attrGet("start"):
                node["attrs"] = {"start": int(token.attrGet("start"))}
            output.append(node)
            continue
        if token.type in {"thead_open", "tbody_open"}:
            closing_token = token.type.replace("_open", "_close")
            children, index = _tokens_to_blocks(tokens, index + 1, closing_token)
            output.extend(children)
            continue
        if token.type in {"th_open", "td_open"}:
            inline = tokens[index + 1] if index + 1 < len(tokens) else None
            content = _inline_tokens(getattr(inline, "children", None) or [])
            paragraph: dict[str, Any] = {"type": "paragraph"}
            if content:
                paragraph["content"] = content
            attrs: dict[str, Any] = {}
            style = str(token.attrGet("style") or "")
            alignment = re.search(r"(?:^|;)\s*text-align\s*:\s*(left|center|right)", style)
            if alignment:
                attrs["textAlign"] = alignment.group(1)
            node = {
                "type": "tableHeader" if token.type == "th_open" else "tableCell",
                "content": [paragraph],
            }
            if attrs:
                node["attrs"] = attrs
            output.append(node)
            index += 3
            continue
        if token.type in {"fence", "code_block"}:
            node = {
                "type": "codeBlock",
                "content": [{"type": "text", "text": token.content.rstrip("\n") or " "}],
            }
            if token.info:
                node["attrs"] = {"language": token.info.strip().split()[0]}
            output.append(node)
        elif token.type == "hr":
            output.append({"type": "horizontalRule"})
        index += 1
    return output, index


def _restore_markdown_structures(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    restored: list[dict[str, Any]] = []
    for node in nodes:
        children = node.get("content")
        if isinstance(children, list):
            node = {**node, "content": _restore_markdown_structures(children)}
        if node.get("type") != "blockquote":
            restored.append(node)
            continue
        block_children = node.get("content", [])
        first = block_children[0] if block_children else None
        first_content = first.get("content", []) if isinstance(first, dict) else []
        marker_text = "".join(
            item.get("text", "") for item in first_content if item.get("type") == "text"
        )
        marker = CALLOUT_MARKER_RE.fullmatch(marker_text)
        body = block_children[1:]
        if (
            marker
            and body
            and all(
                child.get("type") in {"paragraph", "bulletList", "orderedList"} for child in body
            )
        ):
            attrs: dict[str, Any] = {"tone": marker.group(1)}
            if marker.group(2):
                attrs["icon"] = marker.group(2)
            restored.append({"type": "callout", "attrs": attrs, "content": body})
            continue

        details_marker = DETAILS_MARKER_RE.fullmatch(marker_text)
        if not details_marker or not body:
            restored.append(node)
            continue
        try:
            encoded = details_marker.group(1)
            padding = "=" * (-len(encoded) % 4)
            payload = json.loads(base64.urlsafe_b64decode(encoded + padding).decode("utf-8"))
            if not isinstance(payload, dict) or set(payload) != {
                "open_by_default",
                "summary",
            }:
                raise ValueError
            attrs = {
                "summary": _details_summary(payload.get("summary")),
                "open_by_default": payload.get("open_by_default"),
            }
            if not isinstance(attrs["open_by_default"], bool):
                raise ValueError
        except (ArticleDocumentError, binascii.Error, UnicodeDecodeError, ValueError):
            restored.append(node)
            continue
        details_body = []
        for child in body:
            child_content = child.get("content", []) if isinstance(child, dict) else []
            child_text = "".join(
                item.get("text", "") for item in child_content if item.get("type") == "text"
            )
            if child.get("type") == "paragraph" and child_text == DETAILS_EMPTY_PARAGRAPH_MARKER:
                details_body.append({"type": "paragraph"})
            else:
                details_body.append(child)
        if any(
            child.get("type") not in {"paragraph", "bulletList", "orderedList"}
            for child in details_body
        ):
            restored.append(node)
            continue
        restored.append(
            {
                "type": "details",
                "attrs": attrs,
                "content": [{"type": "detailsContent", "content": details_body}],
            }
        )
    return restored


def _inline_tokens(tokens: list[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    marks: list[dict[str, Any]] = []
    mark_map = {"strong": "bold", "em": "italic", "s": "strike"}
    for token in tokens:
        if token.type in {"strong_open", "em_open", "s_open"}:
            marks.append({"type": mark_map[token.type.removesuffix("_open")]})
        elif token.type == "link_open":
            marks.append({"type": "link", "attrs": {"href": token.attrGet("href") or ""}})
        elif token.type in {"strong_close", "em_close", "s_close", "link_close"}:
            expected = (
                "link"
                if token.type == "link_close"
                else mark_map[token.type.removesuffix("_close")]
            )
            marks = [mark for mark in marks if mark["type"] != expected]
        elif token.type in {"text", "code_inline"} and token.content:
            active = [*marks]
            if token.type == "code_inline":
                active.append({"type": "code"})
            node: dict[str, Any] = {"type": "text", "text": token.content}
            if active:
                node["marks"] = active
            output.append(node)
        elif token.type in {"softbreak", "hardbreak"}:
            output.append({"type": "hardBreak"})
    return output
