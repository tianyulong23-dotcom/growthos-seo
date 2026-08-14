import { afterEach, describe, expect, it, vi } from "vitest"

import {
  authorizeAssetDownload,
  createAssetUpload,
  getAssetUsage,
  updateAssetMetadata,
  uploadAssetPart,
} from "@/api/assets"

describe("asset API", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the stable idempotency key when an upload is initialized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          asset_id: "asset-1",
          upload_id: "upload-1",
          status: "initiated",
          part_size: 5,
          maximum_bytes: 10,
          expires_at: "2026-08-09T13:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    await createAssetUpload(
      "project-1",
      {
        filename: "proof.png",
        byte_size: 5,
        declared_mime_type: "image/png",
        asset_type: "image",
        source_type: "paste",
      },
      "article-upload:article-1:upload-1"
    )

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(request.headers).get("Idempotency-Key")).toBe(
      "article-upload:article-1:upload-1"
    )
  })

  it("reports actual uploaded bytes from XMLHttpRequest", async () => {
    class MockXhr {
      static latest: MockXhr
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
        onprogress: null,
      }
      responseType = ""
      response: unknown = null
      status = 0
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      onload: (() => void) | null = null
      constructor() {
        MockXhr.latest = this
      }
      open() {}
      setRequestHeader() {}
      abort() {
        this.onabort?.()
      }
      send() {
        this.upload.onprogress?.({
          loaded: 3,
          lengthComputable: true,
        } as ProgressEvent)
        this.status = 200
        this.response = {
          asset_id: "asset-1",
          upload_id: "upload-1",
          part_number: 2,
          etag: "etag",
          byte_size: 5,
          uploaded_bytes: 10,
          status: "uploading",
        }
        this.onload?.()
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXhr)
    const progress = vi.fn()

    await uploadAssetPart("project-1", "asset-1", 2, new Blob(["12345"]), {
      contentSha256: "a".repeat(64),
      completedBytes: 5,
      totalBytes: 10,
      onProgress: progress,
    })

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        partUploadedBytes: 3,
        completedBytes: 5,
        totalUploadedBytes: 8,
        totalBytes: 10,
      })
    )
  })

  it("does not send a part when the upload was already aborted", async () => {
    class MockXhr {
      static latest: MockXhr
      upload = { onprogress: null }
      responseType = ""
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      onload: (() => void) | null = null
      send = vi.fn()
      constructor() {
        MockXhr.latest = this
      }
      open() {}
      setRequestHeader() {}
      abort() {
        this.onabort?.()
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXhr)
    const controller = new AbortController()
    controller.abort()

    await expect(
      uploadAssetPart(
        "project-1",
        "asset-1",
        1,
        new Blob(["12345"]),
        {
          contentSha256: "a".repeat(64),
          completedBytes: 0,
          totalBytes: 5,
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(MockXhr.latest.send).not.toHaveBeenCalled()
  })

  it("authorizes a signed download with bearer and request identity headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://objects.example/signed-image",
          expires_at: "2026-08-09T13:05:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    await authorizeAssetDownload("project-1", "asset-1", "inline", {
      accessToken: "secret-access-token",
      requestId: "request-download-1",
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/v1/projects/project-1/assets/asset-1/download-authorizations"
    )
    const request = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(request.headers)
    expect(request.method).toBe("POST")
    expect(headers.get("Authorization")).toBe("Bearer secret-access-token")
    expect(headers.get("X-Request-ID")).toBe("request-download-1")
    expect(JSON.parse(String(request.body))).toEqual({ disposition: "inline" })
  })

  it("requests a specific processed asset variant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://objects.example/signed-poster",
          expires_at: "2026-08-09T13:05:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    await authorizeAssetDownload(
      "project-1",
      "asset-video",
      "inline",
      undefined,
      "poster"
    )

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      disposition: "inline",
      variant_type: "poster",
    })
  })

  it("updates project asset defaults without changing article node fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ asset_id: "asset-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    await updateAssetMetadata("project-1", "asset-1", {
      title: "Campaign image",
      default_alt_text: "Product on a desk",
      caption: null,
    })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(request.method).toBe("PATCH")
    expect(JSON.parse(String(request.body))).toEqual({
      title: "Campaign image",
      default_alt_text: "Product on a desk",
      caption: null,
    })
  })

  it("loads the article usage that protects an asset from deletion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          asset_id: "asset-1",
          active_reference_count: 2,
          article_count: 1,
          items: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    await getAssetUsage("project-1", "asset-1")

    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/v1/projects/project-1/assets/asset-1/usage"
    )
  })
})
