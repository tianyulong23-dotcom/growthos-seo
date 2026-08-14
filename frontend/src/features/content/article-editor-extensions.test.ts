import { Editor, type JSONContent } from "@tiptap/core"
import { Slice } from "@tiptap/pm/model"
import { describe, expect, it, vi } from "vitest"

import type { ArticleDocument } from "@/api/articles"
import { ARTICLE_PASTE_FIXTURES } from "@/features/content/__fixtures__/article-editor-paste-fixtures"
import {
  articleDocumentToEditorJson,
  canonicalizeArticleDocument,
  editorJsonToArticleDocument,
} from "@/features/content/article-document"
import {
  articleEditorExtensions,
  createArticleEditorExtensions,
} from "@/features/content/article-editor-extensions"
import {
  ARTICLE_HIGHLIGHT_COLORS,
  sanitizeArticlePasteHtml,
} from "@/features/content/article-editor-paste"

const document = {
  type: "doc",
  schema_version: 2,
  content: [
    {
      type: "image",
      attrs: {
        node_id: "image-1",
        asset_id: "asset-image",
        alt: "Screenshot",
        display: "wide",
        caption: "Result",
        width: 1200,
        height: 800,
      },
    },
    {
      type: "gallery",
      attrs: {
        node_id: "gallery-1",
        display: "regular",
        items: [
          { item_id: "item-1", asset_id: "asset-a", alt: "A" },
          { item_id: "item-2", asset_id: "asset-b", alt: "B" },
        ],
      },
    },
    {
      type: "table",
      attrs: { node_id: "table-1" },
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: {
                colspan: 2,
                colwidth: [120, 180],
                textAlign: "center",
                verticalAlign: "middle",
              },
              content: [
                {
                  type: "paragraph",
                  attrs: { node_id: "cell-p-1" },
                  content: [{ type: "text", text: "Name" }],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { node_id: "cell-p-2" },
                  content: [{ type: "text", text: "Value" }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "file",
      attrs: {
        node_id: "file-1",
        asset_id: "asset-file",
        display_name: "brief.pdf",
        description: "Brief",
      },
    },
    {
      type: "audio",
      attrs: {
        node_id: "audio-1",
        asset_id: "asset-audio",
        title: "Interview",
        duration_ms: 1000,
      },
    },
    {
      type: "video",
      attrs: {
        node_id: "video-1",
        asset_id: "asset-video",
        poster_asset_id: "asset-poster",
        duration_ms: 2000,
      },
    },
    {
      type: "bookmark",
      attrs: {
        node_id: "bookmark-1",
        url: "https://example.com/source",
        title: "Source",
        thumbnail_asset_id: "asset-thumb",
      },
    },
    {
      type: "callout",
      attrs: { node_id: "callout-1", tone: "warning", icon: "info" },
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "callout-p-1" },
          content: [{ type: "text", text: "Attention" }],
        },
      ],
    },
    {
      type: "details",
      attrs: {
        node_id: "details-1",
        summary: "More",
        open_by_default: true,
      },
      content: [
        {
          type: "detailsContent",
          content: [
            {
              type: "paragraph",
              attrs: { node_id: "details-p-1" },
              content: [{ type: "text", text: "Details" }],
            },
          ],
        },
      ],
    },
    {
      type: "button",
      attrs: {
        node_id: "button-1",
        label: "Read",
        href: "/guides/read",
        style: "primary",
      },
    },
    {
      type: "embed",
      attrs: {
        node_id: "embed-1",
        provider: "youtube",
        source_url: "https://www.youtube.com/watch?v=abc",
        embed_id: "abc",
      },
    },
  ],
} satisfies ArticleDocument

describe("article editor v2 extensions", () => {
  it("loads and exports every v2 structural and media node without data loss", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: articleDocumentToEditorJson(document),
    })

    expect(editorJsonToArticleDocument(editor.getJSON())).toEqual(
      canonicalizeArticleDocument(document)
    )
    expect(editor.getHTML()).toContain('data-article-node="image"')
    expect(editor.getHTML()).toContain('data-article-node="table"')
    expect(editor.getHTML()).toContain('data-article-node="details"')
    editor.destroy()
  })

  it("never persists temporary media URLs or storage implementation fields", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              node_id: "image-temporary-fields",
              asset_id: "asset-image",
              alt: "Screenshot",
              display: "regular",
              preview_url: "blob:https://editor.local/image-preview",
              src: "data:image/png;base64,temporary",
              storage_key: "private/article/image.png",
            },
          },
          {
            type: "video",
            attrs: {
              node_id: "video-temporary-fields",
              asset_id: "asset-video",
              preview_url: "blob:https://editor.local/video-preview",
              storage_key: "private/article/video.mp4",
            },
          },
        ],
      },
    })

    const exported = editorJsonToArticleDocument(editor.getJSON())
    expect(exported.content).toEqual([
      {
        type: "image",
        attrs: {
          node_id: "image-temporary-fields",
          asset_id: "asset-image",
          alt: "Screenshot",
          display: "regular",
        },
      },
      {
        type: "video",
        attrs: {
          node_id: "video-temporary-fields",
          asset_id: "asset-video",
        },
      },
    ])
    expect(JSON.stringify(exported)).not.toContain("blob:")
    expect(JSON.stringify(exported)).not.toContain("data:image")
    expect(JSON.stringify(exported)).not.toContain("storage_key")
    editor.destroy()
  })

  it("persists a generated block ID in the editor transaction and keeps it stable", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    })

    editor.commands.insertContentAt(1, "First")
    const first = editor.getJSON()
    const firstId = first.content?.[0].attrs?.node_id
    expect(firstId).toMatch(/^blk_[a-f0-9]+$/)

    editor.commands.insertContentAt(6, " second")
    expect(editor.getJSON().content?.[0].attrs?.node_id).toBe(firstId)
    editor.destroy()
  })

  it("preserves heading levels after an edit and export", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: articleDocumentToEditorJson({
        type: "doc",
        schema_version: 2,
        content: [
          {
            type: "heading",
            attrs: { level: 2, node_id: "heading-1" },
            content: [{ type: "text", text: "Heading" }],
          },
        ],
      }),
    })

    editor.commands.insertContentAt(1, "Updated ")

    expect(editorJsonToArticleDocument(editor.getJSON()).content[0]).toEqual({
      type: "heading",
      attrs: { level: 2, node_id: "heading-1" },
      content: [{ type: "text", text: "Updated Heading" }],
    })
    editor.destroy()
  })

  it("allows media and enhanced card nodes to be edited", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: articleDocumentToEditorJson({
        type: "doc",
        schema_version: 2,
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "paragraph-1" },
            content: [{ type: "text", text: "Editable" }],
          },
          document.content[0],
          document.content[6],
          document.content[9],
          document.content[10],
        ],
      }),
    })

    editor.commands.setNodeSelection(10)
    expect(editor.commands.updateAttributes("image", { alt: "Updated" })).toBe(
      true
    )
    expect(
      editorJsonToArticleDocument(editor.getJSON()).content[1].attrs
    ).toMatchObject({ alt: "Updated" })

    editor.commands.setNodeSelection(11)
    expect(
      editor.commands.updateAttributes("bookmark", { title: "Changed" })
    ).toBe(true)
    expect(
      editorJsonToArticleDocument(editor.getJSON()).content[2].attrs
    ).toMatchObject({ node_id: "bookmark-1", title: "Changed" })

    editor.commands.setNodeSelection(12)
    expect(
      editor.commands.updateAttributes("button", { label: "Updated CTA" })
    ).toBe(true)
    expect(
      editorJsonToArticleDocument(editor.getJSON()).content[3].attrs
    ).toMatchObject({ node_id: "button-1", label: "Updated CTA" })

    editor.commands.setNodeSelection(13)
    expect(
      editor.commands.updateAttributes("embed", { caption: "Updated video" })
    ).toBe(true)
    expect(
      editorJsonToArticleDocument(editor.getJSON()).content[4].attrs
    ).toMatchObject({ node_id: "embed-1", caption: "Updated video" })
    expect(editor.commands.insertContentAt(1, "Still ")).toBe(true)
    expect(editor.getText()).toContain("Still Editable")
    editor.destroy()
  })

  it("round-trips every enhanced card attribute without data loss", () => {
    const enhancedDocument = {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "bookmark",
          attrs: {
            node_id: "bookmark-complete",
            url: "https://example.com/source",
            title: "Primary source",
            description: "A complete source description.",
            thumbnail_asset_id: "asset-thumbnail",
            publisher: "Example Research",
            icon_url: "https://example.com/favicon.ico",
            image_url: "https://example.com/cover.jpg",
            fetched_at: "2026-08-09T12:00:00Z",
          },
        },
        {
          type: "button",
          attrs: {
            node_id: "button-complete",
            label: "Read the guide",
            href: "https://example.com/guide",
            style: "secondary",
            target: "_blank",
            rel: "nofollow sponsored noopener noreferrer",
          },
        },
        {
          type: "embed",
          attrs: {
            node_id: "embed-complete",
            provider: "spotify",
            source_url: "https://open.spotify.com/episode/episode123",
            embed_id: "episode/episode123",
            caption: "Full interview",
          },
        },
      ],
    } satisfies ArticleDocument
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: articleDocumentToEditorJson(enhancedDocument),
    })

    expect(editorJsonToArticleDocument(editor.getJSON())).toEqual(
      canonicalizeArticleDocument(enhancedDocument)
    )
    editor.destroy()
  })

  it("round-trips official table spans, widths, and controlled alignment", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: articleDocumentToEditorJson({
        type: "doc",
        schema_version: 2,
        content: [document.content[2]],
      }),
    })

    const exported = editorJsonToArticleDocument(editor.getJSON())
    expect(exported.content[0]).toEqual(
      canonicalizeArticleDocument({
        type: "doc",
        schema_version: 2,
        content: [document.content[2]],
      }).content[0]
    )
    expect(editor.getHTML()).toContain('colspan="2"')
    expect(editor.getHTML()).toContain('colwidth="120,180"')
    expect(editor.getHTML()).toContain("text-align: center")
    expect(editor.getHTML()).toContain("vertical-align: middle")
    editor.destroy()
  })

  it("limits table cells and headers to paragraphs with inline marks", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: sanitizeArticlePasteHtml(
        "<table><tbody><tr><td><h2>Cell heading</h2><p><strong>Body</strong></p><img src='https://example.com/x.png'></td></tr></tbody></table>"
      ),
    })
    const cell = (editor.getJSON() as JSONContent).content?.[0].content?.[0]
      .content?.[0]

    expect(editor.schema.nodes.tableCell.spec.content).toBe("paragraph+")
    expect(editor.schema.nodes.tableHeader.spec.content).toBe("paragraph+")
    expect(cell?.content?.every((node) => node.type === "paragraph")).toBe(true)
    expect(JSON.stringify(cell)).not.toContain('"type":"heading"')
    expect(JSON.stringify(cell)).not.toContain('"type":"image"')
    expect(JSON.stringify(cell)).toContain("Cell heading")
    expect(JSON.stringify(cell)).toContain('"type":"bold"')
    editor.destroy()
  })

  it("sanitizes pasted HTML before the schema parses it", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p>Start</p>",
    })
    let transformed = '<h1 class="MsoTitle">Title</h1><script>bad()</script>'
    editor.view.someProp("transformPastedHTML", (transform) => {
      transformed = transform(transformed, editor.view)
      return false
    })

    expect(transformed).toBe("<h2>Title</h2>")
    editor.destroy()
  })

  it("repairs duplicate node IDs introduced by structural editor commands", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "duplicate-id" },
            content: [{ type: "text", text: "First" }],
          },
        ],
      },
    })

    editor.commands.insertContent({
      type: "paragraph",
      attrs: { node_id: "duplicate-id" },
      content: [{ type: "text", text: "Second" }],
    })

    const nodeIds = (editor.getJSON().content ?? []).map(
      (node) => node.attrs?.node_id
    )
    expect(nodeIds[0]).toBe("duplicate-id")
    expect(nodeIds[1]).toMatch(/^blk_/)
    expect(new Set(nodeIds).size).toBe(nodeIds.length)
    editor.destroy()
  })

  it("opens paste review with the original selection for governed HTML", () => {
    const onPasteReview = vi.fn()
    const editor = new Editor({
      extensions: createArticleEditorExtensions({ onPasteReview }),
      content: "<p>Replace this text</p>",
    })
    editor.commands.setTextSelection({ from: 1, to: 8 })
    const event = {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<p>Before<img src="https://cdn.example.com/a.png">After</p>'
            : "",
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ClipboardEvent
    let handled = false

    editor.view.someProp("handlePaste", (handler) => {
      if (!handler(editor.view, event, Slice.empty)) return false
      handled = true
      return true
    })

    expect(handled).toBe(true)
    expect(onPasteReview).toHaveBeenCalledWith(
      expect.objectContaining({ from: 1, to: 8, requiresConfirmation: true })
    )
    expect(editor.getText()).toBe("Replace this text")
    editor.destroy()
  })

  it("opens paste review for an oversized table but not ordinary safe HTML", () => {
    const onPasteReview = vi.fn()
    const editor = new Editor({
      extensions: createArticleEditorExtensions({ onPasteReview }),
      content: "<p>Start</p>",
    })
    const invoke = (html: string) => {
      let handled = false
      const event = {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === "text/html" ? html : ""),
        },
      } as unknown as ClipboardEvent
      editor.view.someProp("handlePaste", (handler) => {
        if (!handler(editor.view, event, Slice.empty)) return false
        handled = true
        return true
      })
      return handled
    }

    expect(invoke(ARTICLE_PASTE_FIXTURES.oversizedTable)).toBe(true)
    expect(onPasteReview).toHaveBeenCalledOnce()
    expect(invoke("<p><strong>Safe</strong> content</p>")).toBe(false)
    expect(onPasteReview).toHaveBeenCalledOnce()
    editor.destroy()
  })

  it("lets FileHandler consume file and HTML paste before paste review", () => {
    const onPasteFiles = vi.fn()
    const onPasteReview = vi.fn()
    const editor = new Editor({
      extensions: createArticleEditorExtensions({
        onPasteFiles,
        onPasteReview,
      }),
      content: "<p>Start</p>",
    })
    const file = new File(["image"], "clipboard.png", { type: "image/png" })
    const event = {
      clipboardData: {
        files: [file],
        getData: (type: string) =>
          type === "text/html"
            ? '<p>Clipboard<img src="https://cdn.example.com/a.png"></p>'
            : "",
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ClipboardEvent
    let handled = false

    editor.view.someProp("handlePaste", (handler) => {
      if (!handler(editor.view, event, Slice.empty)) return false
      handled = true
      return true
    })

    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(onPasteFiles).toHaveBeenCalledWith([file])
    expect(onPasteReview).not.toHaveBeenCalled()
    editor.destroy()
  })

  it("passes pasted WAV files to the upload workflow", () => {
    const onPasteFiles = vi.fn()
    const editor = new Editor({
      extensions: createArticleEditorExtensions({ onPasteFiles }),
      content: "<p>Start</p>",
    })
    const file = new File(["audio"], "clipboard.wav", { type: "audio/wav" })
    const event = {
      clipboardData: {
        files: [file],
        getData: () => "",
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ClipboardEvent
    let handled = false

    editor.view.someProp("handlePaste", (handler) => {
      if (!handler(editor.view, event, Slice.empty)) return false
      handled = true
      return true
    })

    expect(handled).toBe(true)
    expect(onPasteFiles).toHaveBeenCalledWith([file])
    editor.destroy()
  })

  it("opens the link workflow from Mod-K", () => {
    const onOpenLink = vi.fn()
    const editor = new Editor({
      extensions: createArticleEditorExtensions({ onOpenLink }),
      content: "<p>Linked text</p>",
    })

    expect(editor.commands.keyboardShortcut("Mod-k")).toBe(true)
    expect(onOpenLink).toHaveBeenCalledOnce()
    editor.destroy()
  })

  it("round-trips complete governed link attributes", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p>Reference</p>",
    })
    editor.commands.setTextSelection({ from: 1, to: 10 })
    editor.commands.setLink({
      href: "https://example.com/reference",
      target: "_blank",
      rel: "nofollow sponsored noopener noreferrer",
      title: "Source",
      link_kind: "external",
    } as Parameters<typeof editor.commands.setLink>[0])

    expect(editorJsonToArticleDocument(editor.getJSON())).toMatchObject({
      content: [
        {
          content: [
            {
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com/reference",
                    target: "_blank",
                    rel: "nofollow sponsored noopener noreferrer",
                    title: "Source",
                    link_kind: "external",
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    editor.destroy()
  })

  it("does not add link target or rel while loading persisted content", () => {
    const persistedDocument = {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "paragraph-link" },
          content: [
            {
              type: "text",
              text: "Reference",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com/reference" },
                },
              ],
            },
          ],
        },
      ],
    } satisfies ArticleDocument
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: articleDocumentToEditorJson(persistedDocument),
    })

    expect(editorJsonToArticleDocument(editor.getJSON())).toEqual(
      canonicalizeArticleDocument(persistedDocument)
    )
    editor.destroy()
  })

  it("round-trips every controlled highlight color", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "highlights" },
            content: ARTICLE_HIGHLIGHT_COLORS.map((color, index) => ({
              type: "text",
              text: `Color ${index + 1}${index === 4 ? "" : " "}`,
              marks: [{ type: "highlight", attrs: { color } }],
            })),
          },
        ],
      },
    })

    const exported = editorJsonToArticleDocument(editor.getJSON())
    const paragraph = exported.content[0] as JSONContent
    expect(
      paragraph.content?.map((node) => node.marks?.[0]?.attrs?.color)
    ).toEqual(ARTICLE_HIGHLIGHT_COLORS)
    editor.destroy()
  })

  it("stores text alignment only on configured paragraph and heading nodes", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<ul><li><p>List item</p></li></ul>",
    })
    editor.commands.setTextSelection(3)
    expect(editor.commands.setTextAlign("center")).toBe(true)
    const list = (editor.getJSON() as JSONContent).content?.[0]
    expect(list?.attrs?.textAlign).toBeUndefined()
    expect(list?.content?.[0].attrs?.textAlign).toBeUndefined()
    expect(list?.content?.[0].content?.[0].attrs?.textAlign).toBe("center")
    editor.destroy()
  })
})
