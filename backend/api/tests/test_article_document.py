import pytest

from app.modules.content.document import (
    AssetRenderReference,
    ArticleDocumentError,
    CURRENT_SCHEMA_VERSION,
    canonical_document_json,
    document_capabilities,
    document_content_hash,
    document_to_html,
    document_to_markdown,
    extract_asset_manifest,
    markdown_to_document,
    normalize_document,
)


def _complete_media_document() -> dict:
    return normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "node_id": "image-1",
                        "asset_id": "asset-image",
                        "alt": "Product <screen>",
                        "display": "wide",
                        "caption": "Dashboard & report",
                        "link": "/reports/latest",
                        "width": 1600,
                        "height": 900,
                    },
                },
                {
                    "type": "file",
                    "attrs": {
                        "node_id": "file-1",
                        "asset_id": "asset-file",
                        "display_name": "Evidence bundle",
                        "description": "Reviewed source files",
                    },
                },
                {
                    "type": "audio",
                    "attrs": {
                        "node_id": "audio-1",
                        "asset_id": "asset-audio",
                        "title": "Founder interview",
                        "caption": "Edited recording",
                        "duration_ms": 65_000,
                    },
                },
                {
                    "type": "video",
                    "attrs": {
                        "node_id": "video-1",
                        "asset_id": "asset-video",
                        "poster_asset_id": "asset-custom-poster",
                        "title": "Product launch",
                        "caption": "Final cut",
                        "duration_ms": 125_000,
                    },
                },
            ],
        }
    )


def test_document_normalization_and_rendering_preserve_supported_content() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "Safety & setup"}],
                },
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Official guide",
                                            "marks": [
                                                {
                                                    "type": "link",
                                                    "attrs": {
                                                        "href": "https://example.com/guide",
                                                        "target": "_blank",
                                                    },
                                                }
                                            ],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                },
            ],
        }
    )

    assert document_to_markdown(document) == (
        "## Safety & setup\n\n- [Official guide](https://example.com/guide)\n"
    )
    assert document_to_html(document) == (
        "<h2>Safety &amp; setup</h2><ul><li><p>"
        '<a href="https://example.com/guide" target="_blank" rel="noopener noreferrer">'
        "Official guide</a></p></li></ul>"
    )
    assert document["content"][1]["content"][0]["content"][0]["content"][0]["marks"] == [
        {
            "type": "link",
            "attrs": {
                "href": "https://example.com/guide",
                "target": "_blank",
                "rel": "noopener noreferrer",
            },
        }
    ]
    assert document["schema_version"] == CURRENT_SCHEMA_VERSION
    assert all("node_id" in node["attrs"] for node in document["content"])


def test_v1_migration_is_deterministic_and_normalizes_legacy_tiptap_fields() -> None:
    legacy = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 1},
                "content": [{"type": "text", "text": "Legacy heading"}],
            },
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Body",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {
                                    "href": "https://example.com/body",
                                    "target": "_blank",
                                    "rel": "noopener noreferrer",
                                    "class": None,
                                },
                            }
                        ],
                    }
                ],
            },
        ],
    }

    first = normalize_document(legacy)
    second = normalize_document(legacy)

    assert first == second
    assert first["schema_version"] == 2
    assert first["content"][0]["attrs"]["level"] == 2
    assert first["content"][0]["attrs"]["node_id"]
    assert first["content"][1]["attrs"]["node_id"]
    assert first["content"][1]["content"][0]["marks"] == [
        {
            "type": "link",
            "attrs": {
                "href": "https://example.com/body",
                "target": "_blank",
                "rel": "noopener noreferrer",
            },
        }
    ]


def test_v2_rejects_h1_missing_node_id_and_future_schema() -> None:
    with pytest.raises(ArticleDocumentError, match="heading_level_invalid"):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"node_id": "block-1", "level": 1},
                        "content": [{"type": "text", "text": "No H1"}],
                    }
                ],
            }
        )
    with pytest.raises(ArticleDocumentError, match="node_id_invalid"):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Body"}]}],
            }
        )
    with pytest.raises(ArticleDocumentError, match="schema_unsupported_read_only"):
        normalize_document({"type": "doc", "schema_version": 3, "content": []})


def test_v2_rejects_legacy_tiptap_link_class() -> None:
    with pytest.raises(ArticleDocumentError, match="link_attributes_unsupported_fields"):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "paragraph",
                        "attrs": {"node_id": "paragraph-1"},
                        "content": [
                            {
                                "type": "text",
                                "text": "Link",
                                "marks": [
                                    {
                                        "type": "link",
                                        "attrs": {
                                            "href": "https://example.com",
                                            "class": None,
                                        },
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        )


def test_empty_v2_document_is_valid() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [{"type": "paragraph", "attrs": {"node_id": "empty-1"}}],
        }
    )
    assert document["content"] == [{"type": "paragraph", "attrs": {"node_id": "empty-1"}}]


@pytest.mark.parametrize(
    "node",
    [
        {"type": "horizontalRule", "attrs": {"node_id": "hr-1"}},
        {
            "type": "codeBlock",
            "attrs": {"node_id": "code-1", "language": "python"},
            "content": [{"type": "text", "text": "print('ok')"}],
        },
        {
            "type": "image",
            "attrs": {
                "node_id": "image-1",
                "asset_id": "asset-image",
                "alt": "Screenshot",
                "decorative": False,
                "display": "wide",
                "caption": "Result",
                "width": 1200,
                "height": 800,
            },
        },
        {
            "type": "gallery",
            "attrs": {
                "node_id": "gallery-1",
                "display": "regular",
                "items": [
                    {
                        "item_id": "item-1",
                        "asset_id": "asset-a",
                        "alt": "A",
                        "width": 1200,
                        "height": 800,
                    },
                    {
                        "item_id": "item-2",
                        "asset_id": "asset-b",
                        "alt": "B",
                        "width": 800,
                        "height": 1200,
                    },
                ],
            },
        },
        {
            "type": "table",
            "attrs": {"node_id": "table-1"},
            "content": [
                {
                    "type": "tableRow",
                    "content": [
                        {
                            "type": "tableHeader",
                            "attrs": {"colspan": 2, "rowspan": 1, "colwidth": [120, 180]},
                            "content": [
                                {
                                    "type": "paragraph",
                                    "attrs": {"node_id": "cell-p-1"},
                                    "content": [{"type": "text", "text": "Name"}],
                                }
                            ],
                        },
                        {
                            "type": "tableCell",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "attrs": {"node_id": "cell-p-2"},
                                    "content": [{"type": "text", "text": "Value"}],
                                }
                            ],
                        },
                    ],
                }
            ],
        },
        {
            "type": "file",
            "attrs": {
                "node_id": "file-1",
                "asset_id": "asset-file",
                "display_name": "brief.pdf",
                "description": "Brief",
            },
        },
        {
            "type": "audio",
            "attrs": {
                "node_id": "audio-1",
                "asset_id": "asset-audio",
                "title": "Interview",
                "duration_ms": 1000,
            },
        },
        {
            "type": "video",
            "attrs": {
                "node_id": "video-1",
                "asset_id": "asset-video",
                "poster_asset_id": "asset-poster",
                "duration_ms": 2000,
            },
        },
        {
            "type": "bookmark",
            "attrs": {
                "node_id": "bookmark-1",
                "url": "https://example.com/source",
                "title": "Source",
                "thumbnail_asset_id": "asset-thumb",
            },
        },
        {
            "type": "callout",
            "attrs": {"node_id": "callout-1", "tone": "warning", "icon": "info"},
            "content": [
                {
                    "type": "paragraph",
                    "attrs": {"node_id": "callout-p-1"},
                    "content": [{"type": "text", "text": "Attention"}],
                }
            ],
        },
        {
            "type": "details",
            "attrs": {
                "node_id": "details-1",
                "summary": "More",
                "open_by_default": True,
            },
            "content": [
                {
                    "type": "detailsContent",
                    "content": [
                        {
                            "type": "paragraph",
                            "attrs": {"node_id": "details-p-1"},
                            "content": [{"type": "text", "text": "Details"}],
                        }
                    ],
                }
            ],
        },
        {
            "type": "button",
            "attrs": {
                "node_id": "button-1",
                "label": "Read",
                "href": "/guides/read",
                "style": "primary",
            },
        },
        {
            "type": "embed",
            "attrs": {
                "node_id": "embed-1",
                "provider": "youtube",
                "source_url": "https://www.youtube.com/watch?v=abc",
                "embed_id": "abc",
            },
        },
    ],
)
def test_v2_supported_block_fixtures_round_trip_and_render(node: dict) -> None:
    document = normalize_document({"type": "doc", "schema_version": 2, "content": [node]})
    assert normalize_document(document) == document
    assert isinstance(document_to_html(document), str)
    assert isinstance(document_to_markdown(document), str)


def test_media_markdown_extension_round_trip_preserves_complete_document_facts() -> None:
    document = _complete_media_document()

    markdown = document_to_markdown(document)
    restored = markdown_to_document(markdown)

    assert restored == document
    assert ":::article-image" in markdown
    assert ":::article-file" in markdown
    assert ":::article-audio" in markdown
    assert ":::article-video" in markdown
    assert "asset:" not in markdown
    assert "blob:" not in markdown
    assert "data:" not in markdown


def test_markdown_preserves_text_around_media_directives() -> None:
    markdown = (
        "Before upload.\n\n"
        ':::article-image {"alt":"Dashboard","asset_id":"asset-image",'
        '"display":"wide","node_id":"image-1"}\n'
        ":::\n\n"
        "After upload.\n"
    )

    restored = markdown_to_document(markdown)

    assert [node["type"] for node in restored["content"]] == [
        "paragraph",
        "image",
        "paragraph",
    ]
    assert restored["content"][0]["content"][0]["text"] == "Before upload."
    assert restored["content"][1]["attrs"] == {
        "node_id": "image-1",
        "asset_id": "asset-image",
        "alt": "Dashboard",
        "display": "wide",
    }
    assert restored["content"][2]["content"][0]["text"] == "After upload."


def test_invalid_media_directive_json_remains_visible_instead_of_swallowing_content() -> None:
    markdown = (
        "Before invalid block.\n\n"
        ":::article-image {not-json}\n"
        ":::\n\n"
        "After invalid block.\n"
    )

    restored = markdown_to_document(markdown)
    visible_text = " ".join(
        inline.get("text", "")
        for block in restored["content"]
        for inline in block.get("content", [])
        if inline.get("type") == "text"
    )

    assert not any(node["type"] == "image" for node in restored["content"])
    assert "Before invalid block." in visible_text
    assert ":::article-image {not-json}" in visible_text
    assert "After invalid block." in visible_text


def test_governed_leaf_directives_round_trip_without_losing_attributes() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "bookmark",
                    "attrs": {
                        "node_id": "bookmark-1",
                        "url": "https://example.com/source",
                        "title": "Primary source",
                        "description": "Source summary",
                        "thumbnail_asset_id": "asset-thumbnail",
                        "publisher": "Example",
                    },
                },
                {
                    "type": "button",
                    "attrs": {
                        "node_id": "button-1",
                        "label": "Read source",
                        "href": "/source",
                        "style": "outline",
                        "target": "_blank",
                        "rel": "noopener nofollow",
                    },
                },
                {
                    "type": "embed",
                    "attrs": {
                        "node_id": "embed-1",
                        "provider": "youtube",
                        "source_url": "https://www.youtube.com/watch?v=abc",
                        "embed_id": "abc",
                        "caption": "Product walkthrough",
                    },
                },
            ],
        }
    )

    markdown = document_to_markdown(document)

    assert markdown_to_document(markdown) == document
    assert ":::article-bookmark" in markdown
    assert ":::article-button" in markdown
    assert ":::article-embed" in markdown


def test_gallery_directive_round_trip_preserves_order_and_complete_item_attributes() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "gallery",
                    "attrs": {
                        "node_id": "gallery-1",
                        "display": "full",
                        "items": [
                            {
                                "item_id": "item-b",
                                "asset_id": "asset-b",
                                "alt": "Second image",
                                "caption": "Second caption",
                                "link": "/second",
                                "width": 900,
                                "height": 1200,
                            },
                            {
                                "item_id": "item-a",
                                "asset_id": "asset-a",
                                "alt": "First image",
                                "caption": "First caption",
                                "link": "https://example.com/first",
                                "width": 1600,
                                "height": 900,
                            },
                        ],
                    },
                }
            ],
        }
    )

    assert markdown_to_document(document_to_markdown(document)) == document


def test_gallery_requires_individual_alt_or_explicit_decorative_choice() -> None:
    base = {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "gallery",
                "attrs": {
                    "node_id": "gallery-accessibility",
                    "items": [
                        {"item_id": "item-a", "asset_id": "asset-a", "alt": "A"},
                        {"item_id": "item-b", "asset_id": "asset-b", "alt": ""},
                    ],
                },
            }
        ],
    }

    with pytest.raises(ArticleDocumentError, match="article_document_alt_required"):
        normalize_document(base)

    base["content"][0]["attrs"]["items"][1]["decorative"] = True
    normalized = normalize_document(base)
    assert normalized["content"][0]["attrs"]["items"][1] == {
        "item_id": "item-b",
        "asset_id": "asset-b",
        "alt": "",
        "decorative": True,
    }


def test_media_html_renderer_has_native_semantics_without_temporary_urls() -> None:
    rendered = document_to_html(_complete_media_document())

    assert '<figure class="article-image article-image-wide"' in rendered
    assert 'src="asset:asset-image"' in rendered
    assert 'alt="Product &lt;screen&gt;"' in rendered
    assert 'width="1600" height="900"' in rendered
    assert '<a href="asset:asset-file" download="Evidence bundle"' in rendered
    assert '<audio src="asset:asset-audio" controls preload="metadata">' in rendered
    assert (
        '<video src="asset:asset-video" poster="asset:asset-custom-poster" '
        'controls playsinline preload="metadata"' in rendered
    )
    assert "autoplay" not in rendered
    assert "blob:" not in rendered
    assert "data:" not in rendered
    assert "storage_key" not in rendered


def test_media_html_renderer_uses_final_asset_mapping_and_true_metadata() -> None:
    references = {
        ("asset-image", "original"): AssetRenderReference(
            url="https://cdn.example.com/image.webp",
            mime_type="image/webp",
            filename="product.webp",
            byte_size=123_456,
            width=1600,
            height=900,
        ),
        ("asset-file", "download"): AssetRenderReference(
            url="https://cdn.example.com/evidence.pdf",
            mime_type="application/pdf",
            filename="evidence.pdf",
            byte_size=654_321,
        ),
        ("asset-audio", "original"): AssetRenderReference(
            url="https://cdn.example.com/interview.mp3",
            mime_type="audio/mpeg",
            filename="interview.mp3",
            byte_size=7_000_000,
        ),
        ("asset-video", "original"): AssetRenderReference(
            url="https://cdn.example.com/launch.mp4",
            mime_type="video/mp4",
            filename="launch.mp4",
            byte_size=42_000_000,
            width=1920,
            height=1080,
        ),
        ("asset-video", "poster"): AssetRenderReference(
            url="https://cdn.example.com/automatic-poster.jpg",
            mime_type="image/jpeg",
        ),
        ("asset-custom-poster", "original"): AssetRenderReference(
            url="https://cdn.example.com/custom-poster.jpg",
            mime_type="image/jpeg",
            filename="poster.jpg",
            byte_size=120_000,
            width=1920,
            height=1080,
        ),
    }

    rendered = document_to_html(_complete_media_document(), asset_references=references)

    assert 'src="https://cdn.example.com/image.webp"' in rendered
    assert 'href="https://cdn.example.com/evidence.pdf"' in rendered
    assert 'download="evidence.pdf"' in rendered
    assert 'data-mime-type="application/pdf"' in rendered
    assert 'data-byte-size="654321"' in rendered
    assert 'type="audio/mpeg"' in rendered
    assert 'src="https://cdn.example.com/launch.mp4"' in rendered
    assert 'poster="https://cdn.example.com/custom-poster.jpg"' in rendered
    assert "automatic-poster.jpg" not in rendered
    assert 'width="1920" height="1080"' in rendered


def test_video_html_renderer_uses_automatic_poster_when_no_custom_poster_is_selected() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "video",
                    "attrs": {
                        "node_id": "video-automatic-poster",
                        "asset_id": "asset-video",
                    },
                }
            ],
        }
    )

    rendered = document_to_html(
        document,
        asset_references={
            ("asset-video", "original"): AssetRenderReference(
                url="https://cdn.example.com/video.mp4",
                mime_type="video/mp4",
            ),
            ("asset-video", "poster"): AssetRenderReference(
                url="https://cdn.example.com/video-poster.jpg",
                mime_type="image/jpeg",
            ),
        },
    )

    assert 'src="https://cdn.example.com/video.mp4"' in rendered
    assert 'poster="https://cdn.example.com/video-poster.jpg"' in rendered


def test_gallery_html_renderer_preserves_order_identity_metadata_and_links() -> None:
    document = markdown_to_document(
        ':::article-gallery {"display":"wide","items":['
        '{"alt":"B <alt>","asset_id":"asset-b","caption":"B & caption",'
        '"height":1200,"item_id":"item-b","link":"/b","width":900},'
        '{"alt":"A","asset_id":"asset-a","caption":"A caption",'
        '"height":900,"item_id":"item-a","link":"https://example.com/a",'
        '"width":1600}],"node_id":"gallery-1"}\n:::\n'
    )

    rendered = document_to_html(
        document,
        asset_references={
            ("asset-b", "original"): AssetRenderReference(
                url="https://cdn.example.com/b.webp", mime_type="image/webp"
            ),
            ("asset-a", "original"): AssetRenderReference(
                url="https://cdn.example.com/a.webp", mime_type="image/webp"
            ),
        },
    )

    assert rendered.index('data-gallery-item-id="item-b"') < rendered.index(
        'data-gallery-item-id="item-a"'
    )
    assert 'class="article-gallery article-gallery-wide"' in rendered
    assert 'alt="B &lt;alt&gt;" width="900" height="1200"' in rendered
    assert '<a href="/b"><img src="https://cdn.example.com/b.webp"' in rendered
    assert "B &amp; caption" in rendered


def test_file_html_renderer_escapes_filename_mime_size_and_description() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "file",
                    "attrs": {
                        "node_id": "file-escaped",
                        "asset_id": "asset-file",
                        "display_name": 'Bundle <2026> & "notes"',
                        "description": "Reviewed <source> & evidence",
                    },
                }
            ],
        }
    )

    rendered = document_to_html(
        document,
        asset_references={
            ("asset-file", "download"): AssetRenderReference(
                url="https://cdn.example.com/evidence.zip",
                filename='evidence <final> & "notes".zip',
                mime_type="application/x-example+xml",
                byte_size=12_345,
            )
        },
    )

    assert 'download="evidence &lt;final&gt; &amp; &quot;notes&quot;.zip"' in rendered
    assert 'data-mime-type="application/x-example+xml"' in rendered
    assert 'data-byte-size="12345"' in rendered
    assert "Bundle &lt;2026&gt; &amp; &quot;notes&quot;" in rendered
    assert "Reviewed &lt;source&gt; &amp; evidence" in rendered


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "data:text/html,bad",
        "asset:other-asset",
        "//cdn.example.com/image.webp",
        "https://cdn.example.com/image name.webp",
        "https://cdn.example.com\\image.webp",
        "https:///missing-host.webp",
    ],
)
def test_media_html_renderer_rejects_unsafe_mapped_asset_url(url: str) -> None:
    with pytest.raises(ArticleDocumentError, match="asset_url_invalid"):
        document_to_html(
            _complete_media_document(),
            asset_references={
                ("asset-image", "original"): AssetRenderReference(url=url)
            },
        )


def test_marks_alignment_and_relative_links_are_preserved() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "paragraph",
                    "attrs": {"node_id": "p-1", "textAlign": "center"},
                    "content": [
                        {
                            "type": "text",
                            "text": "Guide",
                            "marks": [
                                {"type": "underline"},
                                {"type": "highlight", "attrs": {"color": "#ffff00"}},
                                {
                                    "type": "link",
                                    "attrs": {
                                        "href": "/guide",
                                        "target": "_self",
                                        "rel": "noopener",
                                        "title": "Guide",
                                        "link_kind": "internal",
                                    },
                                },
                            ],
                        }
                    ],
                }
            ],
        }
    )
    attrs = document["content"][0]["content"][0]["marks"][2]["attrs"]
    assert attrs["href"] == "/guide"
    assert attrs["link_kind"] == "internal"
    assert 'href="/guide"' in document_to_html(document)


def test_canonical_hash_is_order_independent_and_asset_manifest_is_stable() -> None:
    document = normalize_document(
        {
            "schema_version": 2,
            "content": [
                {
                    "attrs": {
                        "display": "regular",
                        "alt": "A",
                        "asset_id": "asset-1",
                        "node_id": "image-1",
                    },
                    "type": "image",
                }
            ],
            "type": "doc",
        }
    )
    metadata = {"title": "Article", "slug": "article"}

    assert canonical_document_json(document) == canonical_document_json(
        {"content": document["content"], "type": "doc", "schema_version": 2}
    )
    assert document_content_hash(document, metadata) == document_content_hash(
        document, {"slug": "article", "title": "Article"}
    )
    assert extract_asset_manifest(document) == [
        {
            "asset_id": "asset-1",
            "binding_role": "image",
            "node_id": "image-1",
            "item_id": None,
        }
    ]


def test_capabilities_expose_exact_writable_schema() -> None:
    capabilities = document_capabilities()
    assert capabilities["schema_version"] == 2
    assert capabilities["writable"] is True
    assert "gallery" in capabilities["nodes"]
    assert "highlight" in capabilities["marks"]
    assert capabilities["heading_levels"] == [2, 3, 4, 5, 6]
    assert capabilities["media_upload_enabled"] is False
    assert document_capabilities(media_upload_enabled=True)["media_upload_enabled"] is True


def test_decorative_image_requires_explicit_empty_alt() -> None:
    decorative = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "node_id": "image-decorative",
                        "asset_id": "asset-image",
                        "alt": "",
                        "decorative": True,
                        "display": "regular",
                    },
                }
            ],
        }
    )
    assert decorative["content"][0]["attrs"]["decorative"] is True

    with pytest.raises(ArticleDocumentError, match="article_document_alt_required"):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "image",
                        "attrs": {
                            "node_id": "image-missing-alt",
                            "asset_id": "asset-image",
                            "alt": "",
                            "display": "regular",
                        },
                    }
                ],
            }
        )


def test_table_spans_alignment_and_semantic_renderer_are_preserved() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "table",
                    "attrs": {"node_id": "table-semantic"},
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableHeader",
                                    "attrs": {
                                        "colspan": 2,
                                        "rowspan": 1,
                                        "colwidth": [120, 180],
                                        "textAlign": "center",
                                        "verticalAlign": "middle",
                                    },
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "attrs": {"node_id": "table-heading"},
                                            "content": [{"type": "text", "text": "Heading"}],
                                        }
                                    ],
                                }
                            ],
                        },
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableCell",
                                    "attrs": {"rowspan": 2},
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "attrs": {"node_id": "table-value"},
                                            "content": [{"type": "text", "text": "Value"}],
                                        }
                                    ],
                                },
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "attrs": {"node_id": "table-value-detail"},
                                            "content": [{"type": "text", "text": "Detail"}],
                                        }
                                    ],
                                },
                            ],
                        },
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "attrs": {"node_id": "table-value-final"},
                                            "content": [{"type": "text", "text": "Final"}],
                                        }
                                    ],
                                }
                            ],
                        },
                    ],
                }
            ],
        }
    )

    header_attrs = document["content"][0]["content"][0]["content"][0]["attrs"]
    assert header_attrs == {
        "colspan": 2,
        "colwidth": [120, 180],
        "textAlign": "center",
        "verticalAlign": "middle",
    }
    rendered = document_to_html(document)
    assert '<div class="article-table-wrapper"><table><thead>' in rendered
    assert (
        '<th colspan="2" scope="col" style="text-align:center;vertical-align:middle">' in rendered
    )
    assert '<td rowspan="2">' in rendered


def _table_document(rows: list[dict]) -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "table",
                "attrs": {"node_id": "table-validation"},
                "content": rows,
            }
        ],
    }


def _table_cell(node_id: str, text: str, **attrs: int) -> dict:
    return {
        "type": "tableCell",
        **({"attrs": attrs} if attrs else {}),
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": node_id},
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


def test_table_rectangular_validation_accepts_colspan_and_rowspan() -> None:
    document = normalize_document(
        _table_document(
            [
                {
                    "type": "tableRow",
                    "content": [_table_cell("span-top", "Top", colspan=2)],
                },
                {
                    "type": "tableRow",
                    "content": [
                        _table_cell("span-left", "Left", rowspan=2),
                        _table_cell("span-right-1", "Right 1"),
                    ],
                },
                {
                    "type": "tableRow",
                    "content": [_table_cell("span-right-2", "Right 2")],
                },
            ]
        )
    )

    assert document["content"][0]["content"][1]["content"][0]["attrs"] == {
        "rowspan": 2
    }


@pytest.mark.parametrize(
    "rows",
    [
        [
            {
                "type": "tableRow",
                "content": [_table_cell("uneven-1", "A"), _table_cell("uneven-2", "B")],
            },
            {"type": "tableRow", "content": [_table_cell("uneven-3", "C")]},
        ],
        [
            {
                "type": "tableRow",
                "content": [_table_cell("overflow-1", "A", rowspan=2)],
            }
        ],
        [
            {
                "type": "tableRow",
                "content": [
                    _table_cell("overlap-1", "A", rowspan=2),
                    _table_cell("overlap-2", "B"),
                ],
            },
            {
                "type": "tableRow",
                "content": [_table_cell("overlap-3", "C", colspan=2)],
            },
        ],
    ],
)
def test_table_rectangular_validation_rejects_invalid_spans(rows: list[dict]) -> None:
    with pytest.raises(
        ArticleDocumentError, match="article_document_table_rectangular_invalid"
    ):
        normalize_document(_table_document(rows))


@pytest.mark.parametrize("child_type", ["heading", "image", "table"])
def test_table_cells_reject_non_paragraph_blocks(child_type: str) -> None:
    if child_type == "heading":
        child = {
            "type": "heading",
            "attrs": {"node_id": "cell-heading", "level": 2},
            "content": [{"type": "text", "text": "Heading"}],
        }
    elif child_type == "image":
        child = {
            "type": "image",
            "attrs": {
                "node_id": "cell-image",
                "asset_id": "asset-image",
                "alt": "Image",
                "display": "regular",
            },
        }
    else:
        child = {
            "type": "table",
            "attrs": {"node_id": "nested-table"},
            "content": [
                {
                    "type": "tableRow",
                    "content": [_table_cell("nested-cell", "Nested")],
                }
            ],
        }
    rows = [
        {
            "type": "tableRow",
            "content": [
                {
                    "type": "tableCell",
                    "content": [
                        _table_cell("cell-prefix", "Prefix")["content"][0],
                        child,
                    ],
                }
            ],
        }
    ]

    with pytest.raises(
        ArticleDocumentError, match="article_document_table_cell_content_invalid"
    ):
        normalize_document(_table_document(rows))


@pytest.mark.parametrize(
    "document,error",
    [
        (
            {"type": "doc", "content": [{"type": "image", "attrs": {}}]},
            "article_document_asset_id_invalid",
        ),
        (
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "unsafe",
                                "marks": [
                                    {
                                        "type": "link",
                                        "attrs": {"href": "javascript:alert(1)"},
                                    }
                                ],
                            }
                        ],
                    }
                ],
            },
            "article_document_link_invalid",
        ),
        (
            {
                "type": "doc",
                "content": [
                    {
                        "type": "listItem",
                        "content": [{"type": "paragraph", "content": []}],
                    }
                ],
            },
            "article_document_list_item_parent_invalid",
        ),
    ],
)
def test_document_rejects_unsupported_or_unsafe_nodes(document: dict, error: str) -> None:
    with pytest.raises(ArticleDocumentError, match=error):
        normalize_document(document)


def test_markdown_conversion_disables_raw_html_and_keeps_safe_links() -> None:
    document = markdown_to_document(
        "# Title\n\n<script>alert(1)</script>\n\n[Source](https://example.com/source)"
    )
    rendered = document_to_html(document)

    assert "<script>" not in rendered
    assert "https://example.com/source" in rendered


def test_markdown_table_remains_a_table_in_the_editor_document_and_html() -> None:
    document = markdown_to_document(
        "| Option | Price |\n|:--|--:|\n| **A** | [10](https://example.com) |\n"
    )
    rendered = document_to_html(document)

    table = document["content"][0]
    assert table["type"] == "table"
    assert [cell["type"] for cell in table["content"][0]["content"]] == [
        "tableHeader",
        "tableHeader",
    ]
    assert table["content"][0]["content"][0]["attrs"]["textAlign"] == "left"
    assert table["content"][1]["content"][1]["attrs"]["textAlign"] == "right"
    assert '<div class="article-table-wrapper"><table>' in rendered
    assert '<a href="https://example.com">10</a>' in rendered


def test_code_block_preserves_language_and_escapes_content_in_renderers() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "codeBlock",
                    "attrs": {"node_id": "code-1", "language": "typescript"},
                    "content": [
                        {
                            "type": "text",
                            "text": 'const value = "</code><script>bad()</script>";',
                        }
                    ],
                }
            ],
        }
    )

    assert document_to_markdown(document) == (
        '```typescript\nconst value = "</code><script>bad()</script>";\n```\n'
    )
    assert document_to_html(document) == (
        '<pre><code class="language-typescript">const value = &quot;&lt;/code&gt;'
        "&lt;script&gt;bad()&lt;/script&gt;&quot;;</code></pre>"
    )


def test_markdown_code_fence_restores_its_language() -> None:
    document = markdown_to_document("```python\nprint('ok')\n```\n")

    assert document["content"][0]["type"] == "codeBlock"
    assert document["content"][0]["attrs"]["language"] == "python"
    assert document_to_markdown(document) == "```python\nprint('ok')\n```\n"


@pytest.mark.parametrize("tone", ["note", "tip", "warning", "conclusion"])
def test_callout_preserves_each_controlled_tone_in_html(tone: str) -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "callout",
                    "attrs": {
                        "node_id": "callout-1",
                        "tone": tone,
                        "icon": "lightbulb",
                    },
                    "content": [
                        {
                            "type": "paragraph",
                            "attrs": {"node_id": "callout-p-1"},
                            "content": [{"type": "text", "text": "Safe <content>"}],
                        }
                    ],
                }
            ],
        }
    )

    assert document["content"][0]["attrs"] == {
        "node_id": "callout-1",
        "tone": tone,
        "icon": "lightbulb",
    }
    rendered = document_to_html(document)
    assert f'class="article-callout article-callout-{tone}"' in rendered
    assert f'data-tone="{tone}"' in rendered
    assert 'data-icon="lightbulb"' in rendered
    assert "Safe &lt;content&gt;" in rendered
    assert "<content>" not in rendered


def test_callout_markdown_round_trip_preserves_tone_icon_paragraphs_and_list() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "callout",
                    "attrs": {
                        "node_id": "callout-1",
                        "tone": "conclusion",
                        "icon": "circle-check",
                    },
                    "content": [
                        {
                            "type": "paragraph",
                            "attrs": {"node_id": "callout-p-1"},
                            "content": [{"type": "text", "text": "Summary"}],
                        },
                        {
                            "type": "orderedList",
                            "attrs": {"node_id": "callout-list-1", "start": 1},
                            "content": [
                                {
                                    "type": "listItem",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "attrs": {"node_id": "callout-p-2"},
                                            "content": [{"type": "text", "text": "Action"}],
                                        }
                                    ],
                                }
                            ],
                        },
                    ],
                }
            ],
        }
    )

    markdown = document_to_markdown(document)
    restored = markdown_to_document(markdown)
    callout = restored["content"][0]

    assert markdown == (
        "> [!CALLOUT tone=conclusion icon=circle-check]\n>\n> Summary\n>\n> 1. Action\n"
    )
    assert callout["type"] == "callout"
    assert callout["attrs"]["tone"] == "conclusion"
    assert callout["attrs"]["icon"] == "circle-check"
    assert [node["type"] for node in callout["content"]] == [
        "paragraph",
        "orderedList",
    ]


@pytest.mark.parametrize(
    ("legacy_tone", "legacy_icon", "tone", "icon"),
    [
        ("info", "idea", "note", "lightbulb"),
        ("neutral", "alert", "note", "triangle-alert"),
        ("success", "check", "conclusion", "circle-check"),
        ("danger", "warning", "warning", "triangle-alert"),
    ],
)
def test_callout_canonicalizes_known_legacy_values(
    legacy_tone: str, legacy_icon: str, tone: str, icon: str
) -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "callout",
                    "attrs": {
                        "node_id": "callout-legacy",
                        "tone": legacy_tone,
                        "icon": legacy_icon,
                    },
                    "content": [
                        {
                            "type": "paragraph",
                            "attrs": {"node_id": "callout-p-legacy"},
                        }
                    ],
                }
            ],
        }
    )

    assert document["content"][0]["attrs"]["tone"] == tone
    assert document["content"][0]["attrs"]["icon"] == icon


@pytest.mark.parametrize(
    ("attrs", "error"),
    [
        (
            {"node_id": "callout-1", "tone": "#ff0000"},
            "article_document_callout_tone_invalid",
        ),
        (
            {"node_id": "callout-1", "tone": "note", "icon": "rocket"},
            "article_document_callout_icon_invalid",
        ),
        (
            {
                "node_id": "callout-1",
                "tone": "note",
                "backgroundColor": "red",
            },
            "callout_attributes_unsupported_fields",
        ),
    ],
)
def test_callout_rejects_arbitrary_visual_attributes(attrs: dict, error: str) -> None:
    with pytest.raises(ArticleDocumentError, match=error):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "callout",
                        "attrs": attrs,
                        "content": [
                            {
                                "type": "paragraph",
                                "attrs": {"node_id": "callout-p-1"},
                            }
                        ],
                    }
                ],
            }
        )


def test_callout_rejects_unsupported_child_blocks() -> None:
    with pytest.raises(ArticleDocumentError, match="block_content_invalid"):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "callout",
                        "attrs": {"node_id": "callout-1", "tone": "note"},
                        "content": [
                            {
                                "type": "codeBlock",
                                "attrs": {"node_id": "callout-code-1"},
                                "content": [{"type": "text", "text": "code"}],
                            }
                        ],
                    }
                ],
            }
        )


def test_details_html_and_markdown_round_trip_preserve_complete_semantics() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "details",
                    "attrs": {
                        "node_id": "details-1",
                        "summary": "  Is <script> safe?  ",
                        "open_by_default": True,
                    },
                    "content": [
                        {
                            "type": "detailsContent",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "attrs": {"node_id": "details-p-1"},
                                    "content": [{"type": "text", "text": "Yes & no."}],
                                },
                                {
                                    "type": "bulletList",
                                    "attrs": {"node_id": "details-list-1"},
                                    "content": [
                                        {
                                            "type": "listItem",
                                            "content": [
                                                {
                                                    "type": "paragraph",
                                                    "attrs": {"node_id": "details-p-2"},
                                                    "content": [
                                                        {
                                                            "type": "text",
                                                            "text": "Read details",
                                                        }
                                                    ],
                                                }
                                            ],
                                        }
                                    ],
                                },
                            ],
                        }
                    ],
                }
            ],
        }
    )

    assert document["content"][0]["attrs"]["summary"] == "Is <script> safe?"
    rendered = document_to_html(document)
    assert rendered.startswith('<details class="article-details" data-article-node="details" open>')
    assert "<summary>Is &lt;script&gt; safe?</summary>" in rendered
    assert "<script>" not in rendered

    markdown = document_to_markdown(document)
    restored = markdown_to_document(markdown)
    details = restored["content"][0]
    assert markdown.startswith("> [!DETAILS ")
    assert details["type"] == "details"
    assert details["attrs"]["summary"] == "Is <script> safe?"
    assert details["attrs"]["open_by_default"] is True
    assert [item["type"] for item in details["content"][0]["content"]] == [
        "paragraph",
        "bulletList",
    ]
    assert details["content"][0]["content"][0]["content"][0]["text"] == "Yes & no."


def test_details_markdown_round_trip_preserves_empty_body_paragraph() -> None:
    document = normalize_document(
        {
            "type": "doc",
            "schema_version": 2,
            "content": [
                {
                    "type": "details",
                    "attrs": {
                        "node_id": "details-empty",
                        "summary": "Question",
                        "open_by_default": False,
                    },
                    "content": [
                        {
                            "type": "detailsContent",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "attrs": {"node_id": "details-empty-p"},
                                }
                            ],
                        }
                    ],
                }
            ],
        }
    )

    restored = markdown_to_document(document_to_markdown(document))

    assert restored["content"][0]["type"] == "details"
    assert restored["content"][0]["content"][0]["content"] == [
        {
            "type": "paragraph",
            "attrs": restored["content"][0]["content"][0]["content"][0]["attrs"],
        }
    ]


@pytest.mark.parametrize(
    ("attrs", "error"),
    [
        (
            {"node_id": "details-1", "summary": "   "},
            "article_document_details_summary_invalid",
        ),
        (
            {"node_id": "details-1", "summary": "Line\nbreak"},
            "article_document_details_summary_invalid",
        ),
        (
            {"node_id": "details-1", "summary": "x" * 301},
            "article_document_details_summary_invalid",
        ),
        (
            {
                "node_id": "details-1",
                "summary": "Question",
                "open_by_default": "yes",
            },
            "article_document_details_open_invalid",
        ),
        (
            {
                "node_id": "details-1",
                "summary": "Question",
                "backgroundColor": "red",
            },
            "details_attributes_unsupported_fields",
        ),
    ],
)
def test_details_rejects_invalid_summary_or_attributes(attrs: dict, error: str) -> None:
    with pytest.raises(ArticleDocumentError, match=error):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "details",
                        "attrs": attrs,
                        "content": [
                            {
                                "type": "detailsContent",
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "attrs": {"node_id": "details-p-1"},
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        )


def test_details_rejects_unsupported_body_blocks_and_orphan_content() -> None:
    with pytest.raises(ArticleDocumentError, match="block_content_invalid"):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "details",
                        "attrs": {
                            "node_id": "details-1",
                            "summary": "Question",
                        },
                        "content": [
                            {
                                "type": "detailsContent",
                                "content": [
                                    {
                                        "type": "codeBlock",
                                        "attrs": {"node_id": "details-code-1"},
                                        "content": [{"type": "text", "text": "code"}],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        )

    with pytest.raises(
        ArticleDocumentError, match="article_document_details_content_parent_invalid"
    ):
        normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "detailsContent",
                        "content": [
                            {
                                "type": "paragraph",
                                "attrs": {"node_id": "orphan-p-1"},
                            }
                        ],
                    }
                ],
            }
        )
