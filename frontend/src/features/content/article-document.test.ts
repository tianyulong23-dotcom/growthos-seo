import type { JSONContent } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import type { ArticleDocument, ArticleMetadataSnapshot } from "@/api/articles"
import {
  articleDocumentAssetReferences,
  articleDocumentHash,
  articleDocumentToEditorJson,
  articleMetadata,
  articleMetadataHash,
  articleSnapshotHash,
  documentCompatibility,
  editorJsonToArticleDocument,
} from "@/features/content/article-document"

const metadata = {
  title: "Title",
  slug: "title",
  meta_title: null,
  meta_description: "Description",
  publication_status: "complete_draft",
} as ArticleMetadataSnapshot

describe("article document", () => {
  it("expands sparse SEO field states before hashing and saving", () => {
    const article = {
      title: "Title",
      slug: "title",
      meta_title: "Meta title",
      meta_description: "Description",
      focus_keyword: "keyword",
      secondary_keywords: [],
      canonical_url: null,
      indexing: "index/follow",
      field_states: { title: "confirmed" },
      publication_status: "complete_draft",
    } satisfies Parameters<typeof articleMetadata>[0]

    expect(articleMetadata(article).field_states).toEqual({
      title: "confirmed",
      slug: "generated",
      focus_keyword: "generated",
      secondary_keywords: "generated",
      meta_title: "generated",
      meta_description: "generated",
      canonical_url: "generated",
      indexing: "generated",
    })
  })

  it("matches the backend canonical SHA-256 fixture", async () => {
    const document = {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "block-1" },
          content: [
            {
              type: "text",
              text: "中文 body",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    } satisfies ArticleDocument

    await expect(articleSnapshotHash(document, metadata)).resolves.toBe(
      "b969db51b0656d1d1360515c8bb57206447cd93f006bc666f1006cfb9d546466"
    )
  })

  it("matches the backend document and metadata hashes used by analysis", async () => {
    const document = {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "block-1" },
          content: [
            {
              type: "text",
              text: "中文 body",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    } satisfies ArticleDocument
    const analysisMetadata = {
      title: "中文标题",
      slug: "zhong-wen",
      meta_title: "中文 SEO 标题",
      meta_description: "中文描述",
      focus_keyword: "中文关键词",
      secondary_keywords: ["次关键词", "SEO"],
      canonical_url: "https://example.com/zhong-wen",
      indexing: "index/follow",
      field_states: {
        title: "confirmed",
        meta_title: "modified",
      },
      publication_status: "complete_draft",
    } satisfies ArticleMetadataSnapshot

    await expect(articleDocumentHash(document)).resolves.toBe(
      "92f4a86349462421548d15854240c89e4cbcdf963b3d2673d5bff4f9fb865373"
    )
    await expect(articleMetadataHash(analysisMetadata)).resolves.toBe(
      "d84c26b10a8bf15f1d0f7bc1e85a7d700ffd4c966766d3a1dc03a37ab1dcd56b"
    )
  })

  it("preserves existing node IDs and assigns missing IDs once", () => {
    const first = editorJsonToArticleDocument({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, node_id: "existing-heading" },
          content: [{ type: "text", text: "Heading" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      ],
    })
    const second = editorJsonToArticleDocument(
      articleDocumentToEditorJson(first)
    )

    expect(first.content[0].attrs).toMatchObject({
      level: 2,
      node_id: "existing-heading",
    })
    expect(first.content[1].attrs).toMatchObject({
      node_id: expect.stringMatching(/^blk_[a-f0-9]+$/),
    })
    expect(second).toEqual(first)
  })

  it("normalizes TipTap table cell align attributes to the server contract", () => {
    const document = editorJsonToArticleDocument({
      type: "doc",
      content: [
        {
          type: "table",
          attrs: { node_id: "table-1" },
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: {
                    colspan: 2,
                    rowspan: 1,
                    colwidth: null,
                    align: "center",
                    textAlign: null,
                    verticalAlign: null,
                  },
                  content: [
                    {
                      type: "paragraph",
                      attrs: { node_id: "cell-paragraph-1" },
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    colwidth: null,
                    textAlign: null,
                    verticalAlign: null,
                  },
                  content: [
                    {
                      type: "paragraph",
                      attrs: { node_id: "cell-paragraph-2" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const table = (document as unknown as JSONContent).content?.[0]
    expect(table?.content?.[0].content?.[0].attrs).toEqual({
      colspan: 2,
      textAlign: "center",
    })
    expect(table?.content?.[0].content?.[1].attrs).toEqual({})
  })

  it("forces future schema and unknown nodes or marks into read-only mode", () => {
    expect(
      documentCompatibility({ type: "doc", schema_version: 3, content: [] })
        .writable
    ).toBe(false)

    const compatibility = documentCompatibility({
      type: "doc",
      schema_version: 2,
      content: [
        { type: "futureCard", attrs: { node_id: "future-1" } },
        {
          type: "paragraph",
          attrs: { node_id: "p-1" },
          content: [
            {
              type: "text",
              text: "Body",
              marks: [{ type: "futureMark" }],
            },
          ],
        },
      ],
    })

    expect(compatibility).toEqual({
      writable: false,
      unsupportedNodes: ["futureCard"],
      unsupportedMarks: ["futureMark"],
    })
  })

  it("treats a legacy document without an embedded schema version as v1", () => {
    const compatibility = documentCompatibility({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Legacy body" }],
        },
      ],
    } as unknown as ArticleDocument)

    expect(compatibility).toEqual({
      writable: true,
      unsupportedNodes: [],
      unsupportedMarks: [],
    })
  })

  it("extracts only real asset references with their binding roles", () => {
    const references = articleDocumentAssetReferences({
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "gallery",
          attrs: {
            node_id: "gallery-1",
            items: [
              { item_id: "item-1", asset_id: "asset-a", alt: "A" },
              { item_id: "item-2", asset_id: "asset-b", alt: "B" },
            ],
          },
        },
        {
          type: "video",
          attrs: {
            node_id: "video-1",
            asset_id: "asset-video",
            poster_asset_id: "asset-poster",
          },
        },
        {
          type: "bookmark",
          attrs: {
            node_id: "bookmark-1",
            url: "https://example.com",
            thumbnail_asset_id: "asset-thumbnail",
          },
        },
      ],
    })

    expect(references).toEqual([
      {
        assetId: "asset-a",
        role: "gallery_item",
        nodeId: "gallery-1",
        itemId: "item-1",
      },
      {
        assetId: "asset-b",
        role: "gallery_item",
        nodeId: "gallery-1",
        itemId: "item-2",
      },
      { assetId: "asset-video", role: "video", nodeId: "video-1" },
      { assetId: "asset-poster", role: "poster", nodeId: "video-1" },
      {
        assetId: "asset-thumbnail",
        role: "thumbnail",
        nodeId: "bookmark-1",
      },
    ])
  })
})
