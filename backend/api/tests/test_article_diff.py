from app.modules.content.article_diff import ARTICLE_DIFF_ALGORITHM_VERSION, build_article_diff


def paragraph(node_id: str, text: str, marks: list[dict] | None = None) -> dict:
    inline = {"type": "text", "text": text}
    if marks:
        inline["marks"] = marks
    return {
        "type": "paragraph",
        "attrs": {"node_id": node_id},
        "content": [inline],
    }


def document(*nodes: dict) -> dict:
    return {"type": "doc", "schema_version": 2, "content": list(nodes)}


def test_typed_diff_detects_block_move_text_marks_and_link_attributes() -> None:
    before = document(
        paragraph("a", "Alpha"),
        paragraph(
            "b",
            "Linked",
            [{"type": "link", "attrs": {"href": "https://old.example", "rel": "nofollow"}}],
        ),
    )
    after = document(
        paragraph(
            "b",
            "Linked",
            [{"type": "link", "attrs": {"href": "https://new.example", "target": "_blank"}}],
        ),
        paragraph("a", "Alpha revised", [{"type": "bold"}]),
    )

    result = build_article_diff(before, after, {}, {})

    assert result["algorithm_version"] == ARTICLE_DIFF_ALGORITHM_VERSION
    assert result["summary"]["blocks_moved"] == 2
    assert result["summary"]["blocks_updated"] == 2
    assert any(item["kind"] == "marks_changed" for item in result["inline_changes"])
    link_change = next(
        item
        for item in result["inline_changes"]
        if item["node_id"] == "b" and item["kind"] == "marks_changed"
    )
    assert link_change["before_marks"][0]["attrs"]["href"] == "https://old.example"
    assert link_change["after_marks"][0]["attrs"]["href"] == "https://new.example"


def test_typed_diff_detects_image_gallery_and_table_changes() -> None:
    before = document(
        {"type": "image", "attrs": {"node_id": "image", "asset_id": "asset-1", "alt": "Before"}},
        {
            "type": "gallery",
            "attrs": {
                "node_id": "gallery",
                "items": [
                    {"item_id": "one", "asset_id": "asset-1", "alt": "One"},
                    {"item_id": "two", "asset_id": "asset-2", "alt": "Two"},
                ],
            },
        },
        {
            "type": "table",
            "attrs": {"node_id": "table"},
            "content": [{"type": "tableRow", "content": [{"type": "tableCell", "content": [paragraph("cell-a", "Old")]}]}],
        },
    )
    after = document(
        {"type": "image", "attrs": {"node_id": "image", "asset_id": "asset-2", "alt": "After"}},
        {
            "type": "gallery",
            "attrs": {
                "node_id": "gallery",
                "items": [
                    {"item_id": "two", "asset_id": "asset-3", "alt": "Two"},
                    {"item_id": "one", "asset_id": "asset-1", "alt": "One"},
                ],
            },
        },
        {
            "type": "table",
            "attrs": {"node_id": "table"},
            "content": [{"type": "tableRow", "content": [{"type": "tableCell", "content": [paragraph("cell-a", "New")]}]}],
        },
    )

    result = build_article_diff(before, after, {}, {})

    assert any(item["kind"] == "asset_replaced" for item in result["media_changes"])
    assert any(item["kind"] == "reordered" for item in result["media_changes"])
    assert any(item["kind"] == "item_changed" and item["after"]["asset_id"] == "asset-3" for item in result["media_changes"])
    assert result["table_changes"][0]["before"]["text"] == "Old"
    assert result["table_changes"][0]["after"]["text"] == "New"


def test_typed_diff_preserves_structured_seo_metadata_values() -> None:
    result = build_article_diff(
        document(paragraph("a", "Same")),
        document(paragraph("a", "Same")),
        {"canonical_url": None, "indexing": "index/follow", "field_states": {"title": "generated"}},
        {"canonical_url": "https://example.com/article", "indexing": "noindex/follow", "field_states": {"title": "confirmed"}},
    )

    changes = {item["field"]: item for item in result["metadata_changes"]}
    assert changes["canonical_url"]["after"] == "https://example.com/article"
    assert changes["indexing"] == {"field": "indexing", "before": "index/follow", "after": "noindex/follow"}
    assert changes["field_states"]["after"] == {"title": "confirmed"}
