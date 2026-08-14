from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from app.modules.content.document import canonical_document_json, normalize_document


AI_EDIT_COMMANDS = {
    "rewrite",
    "polish",
    "shorten",
    "expand",
    "proofread",
    "translate",
    "continue",
    "title",
    "meta_title",
    "meta_description",
    "faq",
    "cta",
}
TEXT_COMMANDS = {"rewrite", "polish", "shorten", "expand", "proofread", "translate", "continue"}
METADATA_COMMANDS = {"title", "meta_title", "meta_description"}
SLICE_COMMANDS = {"faq", "cta"}
SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_ -]?key|secret|token|password)\s*[:=]\s*[^\s,;]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/-]{12,}"),
)


class AIEditValidationError(ValueError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_hash(value: Any) -> str:
    return sha256_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def redact_sensitive_text(value: str, *, maximum: int = 12_000) -> str:
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted[:maximum]


def node_plain_text(node: dict[str, Any]) -> str:
    if node.get("type") == "text":
        return str(node.get("text") or "")
    return "".join(
        "\n" if child.get("type") == "hardBreak" else node_plain_text(child)
        for child in node.get("content", [])
        if isinstance(child, dict)
    )


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def utf16_offset_to_index(value: str, offset: int) -> int:
    if offset < 0:
        raise AIEditValidationError("ai_edit_selection_out_of_range")
    units = 0
    for index, character in enumerate(value):
        if units == offset:
            return index
        units += 2 if ord(character) > 0xFFFF else 1
        if units > offset:
            raise AIEditValidationError("ai_edit_selection_offset_invalid")
    if units == offset:
        return len(value)
    raise AIEditValidationError("ai_edit_selection_out_of_range")


def find_node(document: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    def visit(node: dict[str, Any]) -> dict[str, Any] | None:
        attrs = node.get("attrs")
        if isinstance(attrs, dict) and attrs.get("node_id") == node_id:
            return node
        for child in node.get("content", []):
            if isinstance(child, dict) and (found := visit(child)) is not None:
                return found
        return None

    return visit(document)


def selected_text(document: dict[str, Any], node_id: str, start: int, end: int) -> str:
    normalized = normalize_document(document)
    node = find_node(normalized, node_id)
    if node is None:
        raise AIEditValidationError("ai_edit_anchor_node_missing")
    text = node_plain_text(node)
    if start < 0 or end < start or end > utf16_length(text):
        raise AIEditValidationError("ai_edit_selection_out_of_range")
    return text[utf16_offset_to_index(text, start) : utf16_offset_to_index(text, end)]


def validate_selection(
    document: dict[str, Any], node_id: str, start: int, end: int, expected_hash: str
) -> str:
    value = selected_text(document, node_id, start, end)
    if sha256_text(value) != expected_hash.removeprefix("sha256:"):
        raise AIEditValidationError("ai_edit_selection_stale")
    return value


def candidate_kind(command: str) -> str:
    if command in TEXT_COMMANDS:
        return "text"
    if command in METADATA_COMMANDS:
        return "metadata"
    if command in SLICE_COMMANDS:
        return "slice"
    raise AIEditValidationError("ai_edit_command_invalid")


def allowed_modes(command: str) -> list[str]:
    if command in METADATA_COMMANDS:
        return ["apply_metadata"]
    if command in {"continue", "faq", "cta"}:
        return ["insert_after"]
    if command == "expand":
        return ["replace", "insert_after"]
    return ["replace"]


def safe_input_payload(*, command: str, selected: str, context: dict[str, Any]) -> dict[str, Any]:
    heading_path = [
        redact_sensitive_text(str(item), maximum=300)
        for item in context.get("heading_path", [])[:8]
    ]
    brand_terms = [
        redact_sensitive_text(str(item), maximum=100)
        for item in context.get("brand_terms", [])[:30]
    ]
    return {
        "command": command,
        "selected_text": redact_sensitive_text(selected),
        "context": {
            "heading_path": heading_path,
            "focus_keyword": redact_sensitive_text(
                str(context.get("focus_keyword") or ""), maximum=300
            ),
            "locale": str(context.get("locale") or "zh-CN")[:32],
            "target_locale": str(context.get("target_locale") or "")[:32] or None,
            "brand_terms": brand_terms,
        },
    }


def validate_candidate(
    command: str, raw: str
) -> tuple[str | None, dict[str, Any] | None, dict[str, Any] | None]:
    kind = candidate_kind(command)
    if kind == "text":
        text = raw.strip()
        if not text or len(text) > 100_000:
            raise AIEditValidationError("ai_edit_candidate_text_invalid")
        return text, None, None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AIEditValidationError("ai_edit_candidate_json_invalid") from exc
    if kind == "metadata":
        field = command
        candidates = value.get("candidates") if isinstance(value, dict) else None
        if (
            not isinstance(candidates, list)
            or not 1 <= len(candidates) <= 10
            or any(
                not isinstance(item, str) or not item.strip() or len(item) > 500
                for item in candidates
            )
        ):
            raise AIEditValidationError("ai_edit_candidate_metadata_invalid")
        return None, {"field": field, "candidates": [item.strip() for item in candidates]}, None
    content = value.get("content") if isinstance(value, dict) else None
    if not isinstance(content, list) or not content:
        raise AIEditValidationError("ai_edit_candidate_slice_invalid")
    normalized = normalize_document({"type": "doc", "schema_version": 2, "content": content})
    types = {str(item.get("type")) for item in normalized["content"]}
    if command == "faq" and not ({"heading", "details"} & types):
        raise AIEditValidationError("ai_edit_candidate_faq_invalid")
    if command == "cta" and "button" not in types:
        raise AIEditValidationError("ai_edit_candidate_cta_invalid")
    return None, None, {"type": "slice", "content": normalized["content"]}


def rekey_candidate_slice(candidate_slice: dict[str, Any], operation_id: str) -> dict[str, Any]:
    """Give generated nodes stable IDs scoped to one immutable operation."""
    value = json.loads(json.dumps(candidate_slice, ensure_ascii=False))

    def visit(node: dict[str, Any], path: tuple[int, ...]) -> None:
        attrs = node.get("attrs")
        if isinstance(attrs, dict) and isinstance(attrs.get("node_id"), str):
            source_id = attrs["node_id"]
            location = ".".join(str(item) for item in path)
            attrs["node_id"] = str(
                uuid5(NAMESPACE_URL, f"article-ai-edit:{operation_id}:{location}:{source_id}")
            )
        for index, child in enumerate(node.get("content", [])):
            if isinstance(child, dict):
                visit(child, (*path, index))

    for index, node in enumerate(value.get("content", [])):
        if isinstance(node, dict):
            visit(node, (index,))
    return value


def prompt_for(command: str, payload: dict[str, Any]) -> tuple[str, str]:
    rules = {
        "rewrite": "Rewrite the selected text while preserving facts, links, product names and numbers.",
        "polish": "Polish clarity and flow without changing meaning or facts.",
        "shorten": "Shorten without removing required evidence, numbers or key steps.",
        "expand": "Expand usefully. Mark unsupported new facts as needing verification.",
        "proofread": "Only fix grammar and typos. Do not change meaning.",
        "translate": "Translate to target_locale and preserve brand terminology.",
        "continue": "Continue coherently after the cursor using only supplied context.",
        "title": 'Return JSON {"candidates":[...]} with 3-5 article title candidates.',
        "meta_title": 'Return JSON {"candidates":[...]} with 3-5 concise SEO title candidates.',
        "meta_description": 'Return JSON {"candidates":[...]} with 3-5 meta description candidates.',
        "faq": 'Return JSON {"content":[...]} containing canonical heading/details nodes with unique node_id attributes.',
        "cta": 'Return JSON {"content":[...]} containing a canonical button node with a unique node_id and safe https href.',
    }[command]
    system = (
        "You are a controlled article editor. Follow the requested transformation only. "
        "Never claim publication, approval, review, or saving. Return only the candidate, without commentary."
    )
    user = rules + "\nInput:\n" + canonical_document_json(payload)
    return system, user
