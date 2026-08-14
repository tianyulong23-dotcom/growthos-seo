import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ContentAsset } from "@/api/assets"
import type {
  ArticleDocument,
  ArticleDocumentCapabilities,
} from "@/api/articles"
import { ArticleEditor } from "@/features/content/article-editor"
import { executeArticleFileUpload } from "@/features/content/article-upload-executor"

const mediaHarness = vi.hoisted(() => ({
  assets: [] as unknown[],
  mediaProps: null as Record<string, unknown> | null,
  imageProps: null as Record<string, unknown> | null,
}))

vi.mock("@/features/content/article-editor-operation-layer", () => ({
  ArticleEditorOperationLayer: () => null,
}))

vi.mock("@/features/content/article-upload-executor", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/content/article-upload-executor")
    >()
  return {
    ...actual,
    executeArticleFileUpload: vi.fn(() => new Promise(() => undefined)),
  }
})

vi.mock("@/features/content/article-media-dialog", () => ({
  ArticleMediaDialog: (props: Record<string, unknown>) => {
    mediaHarness.mediaProps = props
    return (
      <div role="dialog" aria-label="测试媒体工作台">
        <button
          type="button"
          onClick={() =>
            (props.onChooseAssets as (assets: unknown[]) => void)(
              mediaHarness.assets
            )
          }
        >
          选择测试资产
        </button>
        <button
          type="button"
          onClick={() =>
            (props.onChooseFiles as (files: File[]) => void)([
              new File(["image"], "queued-image.png", {
                type: "image/png",
              }),
            ])
          }
        >
          选择测试文件
        </button>
      </div>
    )
  },
  ArticleImagePropertiesDialog: (props: Record<string, unknown>) => {
    mediaHarness.imageProps = props
    const assetId = (props.asset as ContentAsset).asset_id
    return (
      <div
        role="dialog"
        aria-label="测试图片属性"
        data-testid={`image-properties-${assetId}`}
      >
        <span>{String(props.initialAlt ?? "")}</span>
        <span>{String(props.initialCaption ?? "")}</span>
        <button
          type="button"
          onClick={() =>
            (
              props.onSubmit as (value: {
                alt: string
                decorative: boolean
                caption?: string
                display: "regular"
              }) => void
            )({
              alt: String(props.initialAlt ?? "Confirmed alt"),
              decorative: false,
              caption: String(props.initialCaption ?? "") || undefined,
              display: "regular",
            })
          }
        >
          确认测试图片
        </button>
      </div>
    )
  },
}))

const emptyRect = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
}

Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => emptyRect
HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList

const capabilities: ArticleDocumentCapabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "media-integration-test",
  nodes: [
    "doc",
    "paragraph",
    "text",
    "image",
    "gallery",
    "file",
    "audio",
    "video",
  ],
  marks: ["link"],
  heading_levels: [2, 3, 4, 5, 6],
  asset_types: ["image", "video", "audio", "file"],
  media_upload_enabled: true,
  can_manage_seo_advanced: false,
  limits: {},
}

function asset(
  assetId: string,
  values: Partial<ContentAsset> = {}
): ContentAsset {
  return {
    asset_id: assetId,
    canonical_asset_id: null,
    asset_type: "image",
    status: "ready",
    original_filename: `${assetId}.png`,
    title: null,
    default_alt_text: null,
    caption: null,
    description: null,
    mime_type: "image/png",
    detected_mime_type: "image/png",
    byte_size: 128,
    content_hash: `hash-${assetId}`,
    width: 1200,
    height: 800,
    duration_ms: null,
    source_type: "upload",
    source_url: null,
    final_source_url: null,
    failure_code: null,
    failure_detail: null,
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
    ready_at: "2026-08-12T00:00:00.000Z",
    active_reference_count: 0,
    variants: [],
    actions: ["download", "delete", "insert", "edit_metadata"],
    ...values,
  }
}

function paragraphDocument(): ArticleDocument {
  return {
    type: "doc",
    schema_version: 2,
    content: [
      {
        type: "paragraph",
        attrs: { node_id: "paragraph-1" },
        content: [{ type: "text", text: "Article body" }],
      },
    ],
  }
}

function renderEditor(initialDocument: ArticleDocument) {
  const onChange = vi.fn()
  function ControlledEditor() {
    const [document, setDocument] = useState(initialDocument)
    return (
      <ArticleEditor
        projectId="project-media"
        articleId="article-media"
        document={document}
        capabilities={capabilities}
        readOnly={false}
        onChange={(nextDocument, metadata) => {
          onChange(nextDocument, metadata)
          setDocument(nextDocument)
        }}
      />
    )
  }
  const result = render(<ControlledEditor />)
  return { ...result, onChange }
}

function latestChangeContext(onChange: ReturnType<typeof vi.fn>) {
  return onChange.mock.calls.at(-1)?.[1] as
    | { source: "initialization" | "editor" }
    | undefined
}

function latestDocument(onChange: ReturnType<typeof vi.fn>) {
  return onChange.mock.calls.at(-1)?.[0] as ArticleDocument | undefined
}

function nodeByType(document: ArticleDocument | undefined, type: string) {
  return document?.content.find((node) => node.type === type)
}

function galleryItems(document: ArticleDocument | undefined) {
  const attrs = nodeByType(document, "gallery")?.attrs as
    | { items?: unknown }
    | undefined
  return Array.isArray(attrs?.items) ? attrs.items : undefined
}

async function openInsertMenu(item: string) {
  await screen.findByLabelText("文章正文编辑器")
  fireEvent.click(screen.getByRole("button", { name: "插入内容" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: item }))
  await screen.findByRole("dialog", { name: "测试媒体工作台" })
}

async function selectNode(nodeId: string) {
  const node = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"]`
    )
    expect(element).not.toBeNull()
    return element!
  })
  vi.mocked(document.elementFromPoint).mockReturnValue(node)
  fireEvent.mouseDown(node)
  fireEvent.click(node)
}

function chooseAssets(...assets: ContentAsset[]) {
  mediaHarness.assets = assets
  fireEvent.click(screen.getByRole("button", { name: "选择测试资产" }))
}

async function confirmImageProperties(...assetIds: string[]) {
  for (const assetId of assetIds) {
    await screen.findByTestId(`image-properties-${assetId}`)
    fireEvent.click(
      await screen.findByRole("button", { name: "确认测试图片" })
    )
    await waitFor(() =>
      expect(
        screen.queryByTestId(`image-properties-${assetId}`)
      ).toBeNull()
    )
  }
}

beforeEach(() => {
  mediaHarness.assets = []
  mediaHarness.mediaProps = null
  mediaHarness.imageProps = null
  vi.mocked(executeArticleFileUpload).mockClear()
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(),
  })
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const assetId = decodeURIComponent(
      url.match(/\/assets\/([^/?]+)/)?.[1] ?? "unknown"
    )
    const body =
      init?.method === "POST"
        ? {
            url: `https://objects.example/${assetId}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }
        : asset(assetId, {
            asset_type: assetId.includes("video") ? "video" : "image",
            duration_ms: assetId.includes("video") ? 10_000 : null,
          })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  }))
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:queued-image"),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("article editor media entry integration", () => {
  it("shows selected image controls after changing from read-only to writable", async () => {
    const document = {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "image",
          attrs: {
            node_id: "image-unlocked",
            asset_id: "asset-unlocked",
            alt: "Unlocked image",
          },
        },
      ],
    } satisfies ArticleDocument
    const onChange = vi.fn()
    const view = render(
      <ArticleEditor
        projectId="project-media"
        articleId="article-media"
        document={document}
        capabilities={capabilities}
        readOnly
        onChange={onChange}
      />
    )
    await screen.findByLabelText("文章正文编辑器")

    view.rerender(
      <ArticleEditor
        projectId="project-media"
        articleId="article-media"
        document={document}
        capabilities={capabilities}
        readOnly={false}
        onChange={onChange}
      />
    )
    await selectNode("image-unlocked")

    expect(await screen.findByRole("button", { name: "正文" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "加宽" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "全宽" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "替换" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy()
  })

  it("prefills library defaults and inserts the confirmed image instance", async () => {
    const { onChange } = renderEditor(paragraphDocument())
    await openInsertMenu("从资产库选择")
    chooseAssets(
      asset("asset-library", {
        default_alt_text: "Default library alt",
        caption: "Default library caption",
      })
    )

    expect(await screen.findByText("Default library alt")).toBeTruthy()
    expect(screen.getByText("Default library caption")).toBeTruthy()
    await confirmImageProperties("asset-library")

    await waitFor(() =>
      expect(nodeByType(latestDocument(onChange), "image")?.attrs).toMatchObject({
        asset_id: "asset-library",
        alt: "Default library alt",
        caption: "Default library caption",
      })
    )
  })

  it("replaces a selected image through the shared library dialog", async () => {
    const { onChange } = renderEditor({
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "image",
          attrs: {
            node_id: "image-1",
            asset_id: "asset-old",
            alt: "Old image",
          },
        },
      ],
    })
    await screen.findByLabelText("文章正文编辑器")
    await selectNode("image-1")
    fireEvent.click(await screen.findByRole("button", { name: "替换" }))
    chooseAssets(asset("asset-new"))

    await waitFor(() =>
      expect(nodeByType(latestDocument(onChange), "image")?.attrs).toMatchObject({
        node_id: "image-1",
        asset_id: "asset-new",
        alt: "Old image",
      })
    )
  })

  it("replaces only the selected gallery item", async () => {
    const { onChange } = renderEditor({
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "gallery",
          attrs: {
            node_id: "gallery-1",
            items: [
              { item_id: "item-1", asset_id: "asset-1", alt: "One" },
              { item_id: "item-2", asset_id: "asset-2", alt: "Two" },
            ],
          },
        },
      ],
    })
    await screen.findByLabelText("文章正文编辑器")
    await selectNode("gallery-1")
    const replaceButtons = await screen.findAllByRole("button", {
      name: "替换图片",
    })
    fireEvent.click(replaceButtons[1])
    chooseAssets(asset("asset-replacement"))

    await waitFor(() =>
      expect(galleryItems(latestDocument(onChange))).toEqual([
        expect.objectContaining({ item_id: "item-1", asset_id: "asset-1" }),
        expect.objectContaining({
          item_id: "item-2",
          asset_id: "asset-replacement",
          alt: "Two",
        }),
      ])
    )
  })

  it("appends a selected batch to the same gallery in selection order", async () => {
    const { onChange } = renderEditor({
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "gallery",
          attrs: {
            node_id: "gallery-add",
            items: [
              { item_id: "old-1", asset_id: "old-asset-1", alt: "Old one" },
              { item_id: "old-2", asset_id: "old-asset-2", alt: "Old two" },
            ],
          },
        },
      ],
    })
    await screen.findByLabelText("文章正文编辑器")
    await selectNode("gallery-add")
    fireEvent.click(await screen.findByRole("button", { name: "添加图片" }))
    chooseAssets(
      asset("asset-added-1", { default_alt_text: "Added one" }),
      asset("asset-added-2", { default_alt_text: "Added two" })
    )
    await confirmImageProperties("asset-added-1", "asset-added-2")

    await waitFor(() =>
      expect(galleryItems(latestDocument(onChange))).toEqual([
        expect.objectContaining({ asset_id: "old-asset-1" }),
        expect.objectContaining({ asset_id: "old-asset-2" }),
        expect.objectContaining({ asset_id: "asset-added-1", alt: "Added one" }),
        expect.objectContaining({ asset_id: "asset-added-2", alt: "Added two" }),
      ])
    )
  })

  it("creates one ordered gallery from a multi-asset selection", async () => {
    const { onChange } = renderEditor(paragraphDocument())
    await openInsertMenu("图库（2-20 张）")
    expect(mediaHarness.mediaProps).toMatchObject({
      multiple: true,
      minimumSelection: 2,
      maximumSelection: 20,
    })
    chooseAssets(
      asset("gallery-asset-1", { default_alt_text: "Gallery one" }),
      asset("gallery-asset-2", { default_alt_text: "Gallery two" })
    )
    await confirmImageProperties("gallery-asset-1", "gallery-asset-2")

    await waitFor(() => {
      expect(galleryItems(latestDocument(onChange))).toEqual([
        expect.objectContaining({
          asset_id: "gallery-asset-1",
          alt: "Gallery one",
        }),
        expect.objectContaining({
          asset_id: "gallery-asset-2",
          alt: "Gallery two",
        }),
      ])
      expect(
        latestDocument(onChange)?.content.filter((node) => node.type === "image")
      ).toHaveLength(0)
    })
  })

  it("updates a selected video's custom poster asset", async () => {
    const { onChange } = renderEditor({
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "video",
          attrs: {
            node_id: "video-1",
            asset_id: "asset-video",
            poster_asset_id: null,
            title: "Launch video",
          },
        },
      ],
    })
    await screen.findByLabelText("文章正文编辑器")
    await selectNode("video-1")
    fireEvent.click(
      await screen.findByRole("button", { name: "上传自定义封面" })
    )
    chooseAssets(asset("asset-poster"))

    await waitFor(() =>
      expect(nodeByType(latestDocument(onChange), "video")?.attrs).toMatchObject({
        node_id: "video-1",
        asset_id: "asset-video",
        poster_asset_id: "asset-poster",
      })
    )
  })

  it("sends upload-tab files through the existing queue and renders its placeholder", async () => {
    renderEditor(paragraphDocument())
    await openInsertMenu("图片")
    fireEvent.click(screen.getByRole("button", { name: "选择测试文件" }))

    await waitFor(() => {
      expect(executeArticleFileUpload).toHaveBeenCalledTimes(1)
      expect(
        document.querySelector('[data-upload-id][role="status"]')?.textContent
      ).toContain("queued-image.png")
    })
  })

  it("commits a completed upload with confirmed image properties as an editor change", async () => {
    const uploaded = asset("asset-upload-confirmed")
    vi.mocked(executeArticleFileUpload).mockResolvedValueOnce(uploaded)
    const { onChange } = renderEditor(paragraphDocument())

    await openInsertMenu("图片")
    fireEvent.click(screen.getByRole("button", { name: "选择测试文件" }))
    await confirmImageProperties(uploaded.asset_id)

    await waitFor(() => {
      expect(nodeByType(latestDocument(onChange), "image")?.attrs).toMatchObject({
        asset_id: uploaded.asset_id,
        alt: "Confirmed alt",
      })
      expect(latestChangeContext(onChange)).toEqual({ source: "editor" })
    })
  })

  it("commits a dropped image after confirming its properties", async () => {
    const uploaded = asset("asset-drop-confirmed")
    vi.mocked(executeArticleFileUpload).mockResolvedValueOnce(uploaded)
    const { onChange } = renderEditor(paragraphDocument())
    const editorContent = await screen.findByLabelText("文章正文编辑器")
    const editor = editorContent.querySelector<HTMLElement>(".ProseMirror")
    expect(editor).not.toBeNull()
    const file = new File(["image"], "dropped-image.png", {
      type: "image/png",
    })

    const drop = new Event("drop", { bubbles: true, cancelable: true })
    Object.defineProperties(drop, {
      clientX: { value: 0 },
      clientY: { value: 0 },
      dataTransfer: {
        value: {
          files: [file],
          items: [],
          types: ["Files"],
          getData: () => "",
          setData: () => undefined,
          clearData: () => undefined,
        },
      },
    })
    fireEvent(editor!, drop)

    await waitFor(() => {
      expect(executeArticleFileUpload).toHaveBeenCalledTimes(1)
      expect(
        document.querySelector('[data-upload-id][role="status"]')?.textContent
      ).toContain(file.name)
    })
    await confirmImageProperties(uploaded.asset_id)

    await waitFor(() => {
      expect(nodeByType(latestDocument(onChange), "image")?.attrs).toMatchObject({
        asset_id: uploaded.asset_id,
        alt: "Confirmed alt",
      })
      expect(latestChangeContext(onChange)).toEqual({ source: "editor" })
    })
  })
})
