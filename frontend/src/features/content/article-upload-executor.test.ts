import { afterEach, describe, expect, it, vi } from "vitest"

import { getAsset, type ContentAsset } from "@/api/assets"
import { waitForReadyAsset } from "@/features/content/article-upload-executor"

vi.mock("@/api/assets", () => ({
  completeAssetUpload: vi.fn(),
  createAssetUpload: vi.fn(),
  getAsset: vi.fn(),
  importAsset: vi.fn(),
  retryAsset: vi.fn(),
  uploadAssetPart: vi.fn(),
}))

const asset = (status: ContentAsset["status"]): ContentAsset => ({
  asset_id: "asset-1",
  canonical_asset_id: null,
  asset_type: "image",
  status,
  original_filename: "proof.png",
  title: null,
  default_alt_text: null,
  caption: null,
  description: null,
  mime_type: "image/png",
  detected_mime_type: status === "ready" ? "image/png" : null,
  byte_size: 5,
  content_hash: status === "ready" ? "hash-ready" : null,
  width: status === "ready" ? 1200 : null,
  height: status === "ready" ? 800 : null,
  duration_ms: null,
  source_type: "upload",
  source_url: null,
  final_source_url: null,
  failure_code: null,
  failure_detail: null,
  created_at: "2026-08-09T12:00:00.000Z",
  updated_at: "2026-08-09T12:00:01.000Z",
  ready_at: status === "ready" ? "2026-08-09T12:00:01.000Z" : null,
  active_reference_count: 0,
  variants: [],
  actions: [],
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("article upload executor", () => {
  it("removes each abort listener after a successful polling delay", async () => {
    vi.useFakeTimers()
    vi.mocked(getAsset)
      .mockResolvedValueOnce(asset("processing"))
      .mockResolvedValueOnce(asset("ready"))
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")

    const result = waitForReadyAsset(
      "project-1",
      "asset-1",
      { signal: controller.signal },
      100
    )
    await vi.advanceTimersByTimeAsync(100)

    await expect(result).resolves.toMatchObject({ status: "ready" })
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})
