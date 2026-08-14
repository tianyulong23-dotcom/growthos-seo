import { Editor, type JSONContent } from "@tiptap/core"
import { EditorContent } from "@tiptap/react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AssetStatus, ContentAsset } from "@/api/assets"
import { ArticleAssetAccessStore } from "@/features/content/article-asset-access"
import { createArticleEditorExtensions } from "@/features/content/article-editor-extensions"
import type { ArticleMediaRuntimeStorage } from "@/features/content/article-media-nodeviews"

function asset(
  assetId: string,
  assetType: ContentAsset["asset_type"],
  status: AssetStatus = "ready",
  values: Partial<ContentAsset> = {}
): ContentAsset {
  const filename = {
    file: "research.pdf",
    audio: "interview.mp3",
    video: "launch.mp4",
    image: "poster.jpg",
  }[assetType]
  return {
    asset_id: assetId,
    canonical_asset_id: null,
    asset_type: assetType,
    status,
    original_filename: filename,
    title: null,
    default_alt_text: null,
    caption: null,
    description: null,
    mime_type: {
      file: "application/pdf",
      audio: "audio/mpeg",
      video: "video/mp4",
      image: "image/jpeg",
    }[assetType],
    detected_mime_type: null,
    byte_size: 2048,
    content_hash: "a".repeat(64),
    width: assetType === "video" || assetType === "image" ? 1280 : null,
    height: assetType === "video" || assetType === "image" ? 720 : null,
    duration_ms: assetType === "audio" || assetType === "video" ? 65_000 : null,
    source_type: "upload",
    source_url: null,
    final_source_url: null,
    failure_code: null,
    failure_detail: null,
    created_at: "2026-08-09T11:00:00.000Z",
    updated_at: "2026-08-09T12:00:00.000Z",
    ready_at: status === "ready" ? "2026-08-09T12:00:00.000Z" : null,
    active_reference_count: 0,
    variants: [],
    actions:
      status === "ready"
        ? ["download", "delete", "insert"]
        : ["retry", "cancel"],
    ...values,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function authorization(url: string) {
  return jsonResponse({
    url,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })
}

type FetchRouter = (
  url: string,
  init: RequestInit | undefined
) => Response | Promise<Response>

function renderMediaNode(
  node: JSONContent,
  fetchRouter: FetchRouter,
  options: { readOnly?: boolean } = {}
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    fetchRouter(String(input), init)
  )
  vi.stubGlobal("fetch", fetchMock)
  const store = new ArticleAssetAccessStore("project-1")
  const replace = vi.fn()
  const replacePoster = vi.fn()
  const runtime: ArticleMediaRuntimeStorage = {
    projectId: "project-1",
    readOnly: Boolean(options.readOnly),
    assetAccess: store,
    replace,
    addGalleryItems: vi.fn(),
    replacePoster,
  }
  const editor = new Editor({
    extensions: createArticleEditorExtensions({ mediaRuntime: runtime }),
    editable: !options.readOnly,
    content: { type: "doc", content: [node] },
  })
  if (!options.readOnly) editor.commands.setNodeSelection(0)
  const rendered = render(<EditorContent editor={editor} />)
  return {
    ...rendered,
    editor,
    fetchMock,
    replace,
    replacePoster,
    store,
    destroy() {
      rendered.unmount()
      editor.destroy()
      store.dispose()
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("article file, audio and video node views", () => {
  it("shows file facts and download authorization and edits semantic fields", async () => {
    const fileAsset = asset("asset-file", "file", "ready", {
      detected_mime_type: "application/pdf",
      byte_size: 1536,
    })
    const view = renderMediaNode(
      {
        type: "file",
        attrs: {
          node_id: "file-1",
          asset_id: "asset-file",
          display_name: "Research pack",
          description: "Source material for the article.",
        },
      },
      (url, init) => {
        if (init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            disposition: "attachment",
          })
          return authorization("https://objects.example/research-download")
        }
        expect(url).toContain("/assets/asset-file")
        return jsonResponse(fileAsset)
      }
    )

    expect(await screen.findByText("Research pack")).not.toBeNull()
    expect(
      screen.getAllByText("Source material for the article.")
    ).toHaveLength(2)
    expect(
      screen.getByText(/research\.pdf · application\/pdf · 1\.5 KB/)
    ).not.toBeNull()
    const download = await screen.findByRole("link", {
      name: "下载 research.pdf",
    })
    expect(download.getAttribute("href")).toBe(
      "https://objects.example/research-download"
    )
    expect(download.getAttribute("download")).toBe("research.pdf")

    fireEvent.change(screen.getByLabelText("显示名称"), {
      target: { value: "Evidence bundle" },
    })
    fireEvent.change(screen.getByLabelText("文件说明"), {
      target: { value: "Reviewed sources" },
    })
    await waitFor(() =>
      expect(view.editor.getJSON().content?.[0].attrs).toMatchObject({
        node_id: "file-1",
        asset_id: "asset-file",
        display_name: "Evidence bundle",
        description: "Reviewed sources",
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "替换" }))
    expect(view.replace).toHaveBeenCalledWith({
      nodeId: "file-1",
      nodeType: "file",
      assetType: "file",
    })
    view.destroy()
  })

  it("renders the audio player and renews an expired signed URL", async () => {
    const audioAsset = asset("asset-audio", "audio", "ready")
    let authorizations = 0
    const view = renderMediaNode(
      {
        type: "audio",
        attrs: {
          node_id: "audio-1",
          asset_id: "asset-audio",
          title: "Founder interview",
          caption: "Edited recording",
          duration_ms: 65_000,
        },
      },
      (_url, init) => {
        if (init?.method === "POST") {
          authorizations += 1
          return authorization(
            `https://objects.example/audio-${authorizations}`
          )
        }
        return jsonResponse(audioAsset)
      }
    )

    const player = await waitFor(() => {
      const audio = view.container.querySelector("audio")
      expect(audio?.getAttribute("src")).toBe("https://objects.example/audio-1")
      return audio as HTMLAudioElement
    })
    expect(
      screen.getByText(/interview\.mp3 · audio\/mpeg · 2\.0 KB · 1:05/)
    ).not.toBeNull()

    fireEvent.error(player)
    await waitFor(() => {
      expect(authorizations).toBe(2)
      expect(player.getAttribute("src")).toBe("https://objects.example/audio-2")
    })
    view.destroy()
  })

  it("uses a custom poster first, then restores and refreshes the automatic poster", async () => {
    const videoAsset = asset("asset-video", "video", "ready", {
      variants: [
        {
          variant_type: "poster",
          format: "jpeg",
          width: 1280,
          height: 720,
          byte_size: 512,
          status: "ready",
        },
      ],
    })
    const authorizationBodies: Array<Record<string, string>> = []
    let automaticPosterVersion = 0
    const view = renderMediaNode(
      {
        type: "video",
        attrs: {
          node_id: "video-1",
          asset_id: "asset-video",
          poster_asset_id: "asset-custom-poster",
          title: "Product launch",
          caption: "Final cut",
          duration_ms: 65_000,
        },
      },
      (url, init) => {
        if (init?.method !== "POST") return jsonResponse(videoAsset)
        const body = JSON.parse(String(init.body)) as Record<string, string>
        authorizationBodies.push(body)
        if (url.includes("asset-custom-poster")) {
          return authorization("https://objects.example/custom-poster")
        }
        if (body.variant_type === "poster") {
          automaticPosterVersion += 1
          return authorization(
            `https://objects.example/automatic-poster-${automaticPosterVersion}`
          )
        }
        return authorization("https://objects.example/video")
      }
    )

    const player = await waitFor(() => {
      const video = view.container.querySelector("video")
      expect(video?.getAttribute("poster")).toBe(
        "https://objects.example/custom-poster"
      )
      return video as HTMLVideoElement
    })
    expect(
      authorizationBodies.some((body) => body.variant_type === "poster")
    ).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "使用自动封面" }))
    await waitFor(() =>
      expect(player.getAttribute("poster")).toBe(
        "https://objects.example/automatic-poster-1"
      )
    )
    expect(view.editor.getJSON().content?.[0].attrs).toMatchObject({
      node_id: "video-1",
      asset_id: "asset-video",
      poster_asset_id: null,
      title: "Product launch",
      caption: "Final cut",
    })

    const posterProbe = view.container.querySelector(
      'img[aria-hidden="true"]'
    ) as HTMLImageElement
    fireEvent.error(posterProbe)
    await waitFor(() =>
      expect(player.getAttribute("poster")).toBe(
        "https://objects.example/automatic-poster-2"
      )
    )
    view.destroy()
  })

  it("shows real processing failure and applies retry and cancel responses", async () => {
    const failed = asset("asset-video", "video", "failed", {
      failure_code: "video_processing_failed",
      failure_detail: "Automatic poster extraction failed.",
    })
    const processing = asset("asset-video", "video", "processing")
    const cancelled = asset("asset-video", "video", "failed", {
      failure_code: "asset_processing_cancelled",
      failure_detail: "Processing was cancelled.",
      actions: [],
    })
    const view = renderMediaNode(
      {
        type: "video",
        attrs: {
          node_id: "video-1",
          asset_id: "asset-video",
          title: "Launch",
        },
      },
      (url, init) => {
        if (init?.method !== "POST") return jsonResponse(failed)
        if (url.endsWith("/retry")) return jsonResponse(processing)
        if (url.endsWith("/cancel")) return jsonResponse(cancelled)
        throw new Error(`Unexpected request: ${url}`)
      }
    )

    expect(
      await screen.findByText("Automatic poster extraction failed.")
    ).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "重试处理" }))
    expect(await screen.findByText("正在优化")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "取消处理" }))
    expect(await screen.findByText("Processing was cancelled.")).not.toBeNull()
    expect(screen.queryByRole("button", { name: "重试处理" })).toBeNull()
    view.destroy()
  })

  it("keeps media semantics visible but removes editing controls when read-only", async () => {
    const view = renderMediaNode(
      {
        type: "file",
        attrs: {
          node_id: "file-1",
          asset_id: "asset-file",
          display_name: "Public research",
          description: "Read-only description",
        },
      },
      (_url, init) =>
        init?.method === "POST"
          ? authorization("https://objects.example/file")
          : jsonResponse(asset("asset-file", "file")),
      { readOnly: true }
    )

    expect(await screen.findByText("Public research")).not.toBeNull()
    expect(screen.getByText("Read-only description")).not.toBeNull()
    expect(screen.queryByRole("button", { name: "替换" })).toBeNull()
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull()
    expect(screen.queryByLabelText("显示名称")).toBeNull()
    view.destroy()
  })
})
