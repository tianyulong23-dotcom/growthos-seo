import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArticleAssetAccessStore } from "@/features/content/article-asset-access"
import type { AssetStatus, ContentAsset } from "@/api/assets"

const now = new Date("2026-08-09T12:00:00.000Z")

function authorization(url: string, expiresAt: string) {
  return new Response(JSON.stringify({ url, expires_at: expiresAt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function asset(
  status: AssetStatus,
  values: Partial<ContentAsset> = {}
): ContentAsset {
  return {
    asset_id: "asset-1",
    canonical_asset_id: null,
    asset_type: "video",
    status,
    original_filename: "launch.mp4",
    title: null,
    default_alt_text: null,
    caption: null,
    description: null,
    mime_type: "video/mp4",
    detected_mime_type: "video/mp4",
    byte_size: 1024,
    content_hash: "a".repeat(64),
    width: 1280,
    height: 720,
    duration_ms: 65_000,
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
        : status === "failed"
          ? ["retry", "cancel"]
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

describe("article asset access", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("deduplicates valid authorizations and refreshes before expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/inline-1",
          "2026-08-09T12:02:00.000Z"
        )
      )
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/inline-2",
          "2026-08-09T12:04:00.000Z"
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    const store = new ArticleAssetAccessStore("project-1", {
      accessToken: "access-token",
    })

    await store.load("asset-1", "inline")
    await store.load("asset-1", "inline")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.snapshot("asset-1", "inline").url).toBe(
      "https://objects.example/inline-1"
    )

    await vi.advanceTimersByTimeAsync(90_000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.snapshot("asset-1", "inline").url).toBe(
      "https://objects.example/inline-2"
    )
    store.dispose()
  })

  it("keeps inline and attachment authorizations isolated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/inline",
          "2026-08-09T12:05:00.000Z"
        )
      )
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/attachment",
          "2026-08-09T12:05:00.000Z"
        )
      )
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/inline-refreshed",
          "2026-08-09T12:06:00.000Z"
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    const store = new ArticleAssetAccessStore("project-1")

    await store.load("asset-1", "inline")
    await store.load("asset-1", "attachment")
    await store.load("asset-1", "inline", true)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(store.snapshot("asset-1", "inline").url).toBe(
      "https://objects.example/inline-refreshed"
    )
    expect(store.snapshot("asset-1", "attachment").url).toBe(
      "https://objects.example/attachment"
    )
    expect(
      fetchMock.mock.calls.map((call) =>
        JSON.parse(String((call[1] as RequestInit).body))
      )
    ).toEqual([
      { disposition: "inline" },
      { disposition: "attachment" },
      { disposition: "inline" },
    ])
    store.dispose()
  })

  it("keeps original and poster authorizations isolated and refreshes the poster", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/original",
          "2026-08-09T12:05:00.000Z"
        )
      )
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/poster-1",
          "2026-08-09T12:02:00.000Z"
        )
      )
      .mockResolvedValueOnce(
        authorization(
          "https://objects.example/poster-2",
          "2026-08-09T12:04:00.000Z"
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    const store = new ArticleAssetAccessStore("project-1")

    await store.load("asset-1", "inline")
    await store.load("asset-1", "inline", false, "poster")

    expect(store.snapshot("asset-1", "inline").url).toBe(
      "https://objects.example/original"
    )
    expect(store.snapshot("asset-1", "inline", "poster").url).toBe(
      "https://objects.example/poster-1"
    )

    await vi.advanceTimersByTimeAsync(90_000)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(store.snapshot("asset-1", "inline").url).toBe(
      "https://objects.example/original"
    )
    expect(store.snapshot("asset-1", "inline", "poster").url).toBe(
      "https://objects.example/poster-2"
    )
    expect(
      fetchMock.mock.calls.map((call) =>
        JSON.parse(String((call[1] as RequestInit).body))
      )
    ).toEqual([
      { disposition: "inline" },
      { disposition: "inline", variant_type: "poster" },
      { disposition: "inline", variant_type: "poster" },
    ])
    store.dispose()
  })

  it("deduplicates metadata requests and reports request failures", async () => {
    let resolveRequest!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve
    })
    const fetchMock = vi.fn().mockReturnValueOnce(pending)
    vi.stubGlobal("fetch", fetchMock)
    const store = new ArticleAssetAccessStore("project-1")

    const first = store.loadMetadata("asset-1")
    const repeated = store.loadMetadata("asset-1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveRequest(jsonResponse(asset("ready")))
    await Promise.all([first, repeated])
    expect(store.metadataSnapshot("asset-1").asset?.status).toBe("ready")

    fetchMock.mockRejectedValueOnce(new Error("metadata network failed"))
    await store.loadMetadata("asset-2", true)
    expect(store.metadataSnapshot("asset-2")).toEqual(
      expect.objectContaining({
        asset: null,
        loading: false,
        error: "metadata network failed",
      })
    )
    store.dispose()
  })

  it("polls processing metadata until the asset is ready", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(asset("processing")))
      .mockResolvedValueOnce(jsonResponse(asset("ready")))
    vi.stubGlobal("fetch", fetchMock)
    const store = new ArticleAssetAccessStore("project-1")

    await store.loadMetadata("asset-1")
    expect(store.metadataSnapshot("asset-1").asset?.status).toBe("processing")

    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.metadataSnapshot("asset-1").asset?.status).toBe("ready")

    await vi.advanceTimersByTimeAsync(4_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it("deduplicates retry and cancel actions and stores their returned state", async () => {
    let resolveRetry!: (response: Response) => void
    const retryPending = new Promise<Response>((resolve) => {
      resolveRetry = resolve
    })
    let resolveCancel!: (response: Response) => void
    const cancelPending = new Promise<Response>((resolve) => {
      resolveCancel = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          asset("failed", {
            failure_code: "video_processing_failed",
            failure_detail: "Poster extraction failed.",
          })
        )
      )
      .mockReturnValueOnce(retryPending)
      .mockReturnValueOnce(cancelPending)
    vi.stubGlobal("fetch", fetchMock)
    const store = new ArticleAssetAccessStore("project-1")

    await store.loadMetadata("asset-1")
    const retry = store.retry("asset-1")
    const repeatedRetry = store.retry("asset-1")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.metadataSnapshot("asset-1").action).toBe("retry")
    resolveRetry(jsonResponse(asset("processing")))
    await Promise.all([retry, repeatedRetry])
    expect(store.metadataSnapshot("asset-1")).toEqual(
      expect.objectContaining({ action: "", error: "" })
    )
    expect(store.metadataSnapshot("asset-1").asset?.status).toBe("processing")

    const cancel = store.cancel("asset-1")
    const repeatedCancel = store.cancel("asset-1")
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(store.metadataSnapshot("asset-1").action).toBe("cancel")
    resolveCancel(jsonResponse(asset("failed", { actions: [] })))
    await Promise.all([cancel, repeatedCancel])
    expect(store.metadataSnapshot("asset-1").asset?.actions).toEqual([])
    expect(
      fetchMock.mock.calls.map((call) => [
        String(call[0]).split("/").at(-1),
        (call[1] as RequestInit | undefined)?.method ?? "GET",
      ])
    ).toEqual([
      ["asset-1", "GET"],
      ["retry", "POST"],
      ["cancel", "POST"],
    ])
    store.dispose()
  })
})
