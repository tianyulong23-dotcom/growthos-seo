import asyncio

import pytest

from app.modules.content.ai_edit import (
    AIEditValidationError,
    rekey_candidate_slice,
    safe_input_payload,
    selected_text,
    validate_candidate,
)
from app.modules.content.ai_edit_provider import DeterministicAIEditProvider


def document(text: str = "A😀B") -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-1"},
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


def test_selection_offsets_follow_prosemirror_utf16_semantics() -> None:
    assert selected_text(document(), "paragraph-1", 1, 3) == "😀"
    assert selected_text(document(), "paragraph-1", 3, 4) == "B"

    with pytest.raises(AIEditValidationError, match="ai_edit_selection_offset_invalid"):
        selected_text(document(), "paragraph-1", 1, 2)


def test_safe_input_payload_redacts_secrets_and_enforces_context_limits() -> None:
    payload = safe_input_payload(
        command="rewrite",
        selected="password=hunter2 sk-abcdefghijklmnop " + "x" * 13_000,
        context={
            "heading_path": ["token=heading-secret"] * 12,
            "focus_keyword": "api_key=keyword-secret",
            "locale": "zh-CN",
            "brand_terms": ["Bearer abcdefghijklmnop"] * 35,
        },
    )

    serialized = str(payload)
    assert "hunter2" not in serialized
    assert "sk-abcdefghijklmnop" not in serialized
    assert "heading-secret" not in serialized
    assert "keyword-secret" not in serialized
    assert "abcdefghijklmnop" not in serialized
    assert len(payload["selected_text"]) == 12_000
    assert len(payload["context"]["heading_path"]) == 8
    assert len(payload["context"]["brand_terms"]) == 30


def test_deterministic_provider_outputs_every_candidate_kind() -> None:
    async def collect(command: str) -> str:
        provider = DeterministicAIEditProvider(
            command=command,
            payload={"selected_text": "原始文本"},
        )
        chunks = [chunk.text async for chunk in provider.stream("system", "user")]
        return "".join(chunks)

    text, metadata, slice_value = validate_candidate("rewrite", asyncio.run(collect("rewrite")))
    assert text == "原始文本（AI 候选）"
    assert metadata is None and slice_value is None

    text, metadata, slice_value = validate_candidate(
        "meta_title", asyncio.run(collect("meta_title"))
    )
    assert text is None and slice_value is None
    assert metadata and metadata["field"] == "meta_title"
    assert len(metadata["candidates"]) == 3

    for command in ("faq", "cta"):
        text, metadata, slice_value = validate_candidate(command, asyncio.run(collect(command)))
        assert text is None and metadata is None
        assert slice_value and slice_value["type"] == "slice"


def test_candidate_slice_node_ids_are_stable_and_operation_scoped() -> None:
    raw = (
        '{"content":[{"type":"button","attrs":'
        '{"node_id":"provider-id","label":"CTA","href":"https://example.com",'
        '"target":"_self","rel":null,"style":"primary"}}]}'
    )
    _, _, candidate = validate_candidate("cta", raw)
    assert candidate is not None

    first = rekey_candidate_slice(candidate, "operation-1")
    repeated = rekey_candidate_slice(candidate, "operation-1")
    other = rekey_candidate_slice(candidate, "operation-2")
    first_id = first["content"][0]["attrs"]["node_id"]

    assert first == repeated
    assert first_id != "provider-id"
    assert first_id != other["content"][0]["attrs"]["node_id"]


@pytest.mark.parametrize(
    ("command", "raw", "code"),
    [
        (
            "faq",
            '{"content":[{"type":"paragraph","attrs":{"node_id":"p"}}]}',
            "ai_edit_candidate_faq_invalid",
        ),
        (
            "cta",
            '{"content":[{"type":"paragraph","attrs":{"node_id":"p"}}]}',
            "ai_edit_candidate_cta_invalid",
        ),
        ("meta_title", '{"candidates":[]}', "ai_edit_candidate_metadata_invalid"),
    ],
)
def test_structured_candidates_reject_invalid_schema(command: str, raw: str, code: str) -> None:
    with pytest.raises(AIEditValidationError, match=code):
        validate_candidate(command, raw)
