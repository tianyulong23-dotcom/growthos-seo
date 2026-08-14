import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deleteAsset,
  getAssetUsage,
  listAssets,
  updateAssetMetadata,
  type ContentAsset,
} from "@/api/assets"
import { ApiError } from "@/api/client"
import {
  ArticleImagePropertiesDialog,
  ArticleMediaDialog,
} from "@/features/content/article-media-dialog"

vi.mock("@/api/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/assets")>()
  return {
    ...actual,
    authorizeAssetDownload: vi.fn(),
    cancelAsset: vi.fn(),
    deleteAsset: vi.fn(),
    getAssetUsage: vi.fn(),
    listAssets: vi.fn(),
    retryAsset: vi.fn(),
    updateAssetMetadata: vi.fn(),
  }
})

const previewSnapshot = { url: null, expiresAt: 0, loading: false, error: null }
const assetAccess = {
  subscribe: () => () => undefined,
  snapshot: () => previewSnapshot,
  load: vi.fn().mockResolvedValue(undefined),
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
    original_filename: `${assetId}.jpg`,
    title: null,
    default_alt_text: null,
    caption: null,
    description: null,
    mime_type: "image/jpeg",
    detected_mime_type: "image/jpeg",
    byte_size: 2048,
    content_hash: "a".repeat(64),
    width: 1200,
    height: 800,
    duration_ms: null,
    source_type: "upload",
    source_url: null,
    final_source_url: null,
    failure_code: null,
    failure_detail: null,
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
    ready_at: "2026-08-12T08:01:00Z",
    active_reference_count: 0,
    variants: [],
    actions: ["download", "delete", "insert", "edit_metadata"],
    ...values,
  }
}

function usage(assetId: string, count = 0) {
  return {
    asset_id: assetId,
    active_reference_count: count,
    article_count: count ? 1 : 0,
    items: count
      ? [
          {
            article_id: "article-1",
            article_title: "引用这张图片的文章",
            article_status: "draft",
            current_reference_count: count,
            version_reference_count: 0,
            binding_roles: ["image"],
            node_ids: ["image-1"],
            version_numbers: [],
          },
        ]
      : [],
  }
}

function renderDialog(overrides: {
  mode?: "upload" | "library" | "url"
  assetType?: "image" | "video" | "audio" | "file"
  multiple?: boolean
  minimumSelection?: number
  maximumSelection?: number
} = {}) {
  const callbacks = {
    onOpenChange: vi.fn(),
    onImportUrl: vi.fn(),
    onChooseFiles: vi.fn(),
    onChooseAssets: vi.fn(),
  }
  render(
    <ArticleMediaDialog
      projectId="project-1"
      mode={overrides.mode ?? "library"}
      assetType={overrides.assetType ?? "image"}
      open
      assetAccess={assetAccess as never}
      multiple={overrides.multiple}
      minimumSelection={overrides.minimumSelection}
      maximumSelection={overrides.maximumSelection}
      {...callbacks}
    />
  )
  return callbacks
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  assetAccess.load.mockResolvedValue(undefined)
})

describe("article media dialog", () => {
  it("allows WAV files in the audio picker", () => {
    renderDialog({ mode: "upload", assetType: "audio" })

    expect(screen.getByLabelText("本地媒体文件").getAttribute("accept")).toContain(
      "audio/wav"
    )
  })

  it("prefills article image alt and caption from asset defaults", () => {
    const onSubmit = vi.fn()
    render(
      <ArticleImagePropertiesDialog
        open
        asset={asset("asset-defaults")}
        filename="defaults.jpg"
        initialAlt="A product on a desk"
        initialCaption="Campaign photography"
        assetAccess={assetAccess as never}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    expect((screen.getByLabelText("替代文本") as HTMLInputElement).value).toBe(
      "A product on a desk"
    )
    expect(
      (screen.getByLabelText("说明文字") as HTMLTextAreaElement).value
    ).toBe("Campaign photography")
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }))

    expect(onSubmit).toHaveBeenCalledWith({
      alt: "A product on a desk",
      decorative: false,
      caption: "Campaign photography",
      link: undefined,
      display: "regular",
    })
  })

  it("searches by filename and clears a selection hidden by the new filter", async () => {
    const first = asset("asset-first")
    const second = asset("asset-second")
    vi.mocked(listAssets)
      .mockResolvedValueOnce({ items: [first], next_cursor: "next-page" })
      .mockResolvedValueOnce({ items: [second], next_cursor: null })
    vi.mocked(getAssetUsage).mockResolvedValue(usage(first.asset_id))
    renderDialog()

    fireEvent.click(await screen.findByText("asset-first.jpg"))
    fireEvent.change(screen.getByLabelText("搜索资产"), {
      target: { value: "campaign" },
    })
    await waitFor(() =>
      expect(listAssets).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ query: "campaign" }),
        undefined
      )
    )
    expect(
      (screen.getByRole("button", {
        name: "使用此资产",
      }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it("appends cursor pages without losing selection", async () => {
    const first = asset("asset-first")
    const second = asset("asset-second")
    vi.mocked(listAssets)
      .mockResolvedValueOnce({ items: [first], next_cursor: "next-page" })
      .mockResolvedValueOnce({ items: [second], next_cursor: null })
    vi.mocked(getAssetUsage).mockResolvedValue(usage(first.asset_id))
    const callbacks = renderDialog()

    fireEvent.click(await screen.findByText("asset-first.jpg"))
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }))
    await screen.findByText("asset-second.jpg")
    expect(listAssets).toHaveBeenLastCalledWith(
      "project-1",
      expect.objectContaining({ cursor: "next-page" }),
      undefined
    )

    fireEvent.click(screen.getByRole("button", { name: "使用此资产" }))
    expect(callbacks.onChooseAssets).toHaveBeenCalledWith([first])
  })

  it("disables single-URL import when creating a multi-image gallery", () => {
    renderDialog({
      mode: "upload",
      multiple: true,
      minimumSelection: 2,
      maximumSelection: 12,
    })

    expect(
      screen.getByRole("tab", { name: "URL" }).getAttribute("aria-disabled")
    ).toBe("true")
  })

  it("edits asset defaults without mutating an article node", async () => {
    const original = asset("asset-metadata", {
      title: "Original title",
      default_alt_text: "Original alt",
    })
    const updated = asset("asset-metadata", {
      title: "Updated title",
      default_alt_text: "Updated alt",
      caption: "Updated caption",
      description: "Internal notes",
    })
    vi.mocked(listAssets).mockResolvedValue({ items: [original], next_cursor: null })
    vi.mocked(getAssetUsage).mockResolvedValue(usage(original.asset_id))
    vi.mocked(updateAssetMetadata).mockResolvedValue(updated)
    renderDialog()

    fireEvent.click(await screen.findByText("Original title"))
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "Updated title" },
    })
    fireEvent.change(screen.getByLabelText("默认替代文本"), {
      target: { value: "Updated alt" },
    })
    fireEvent.change(screen.getByLabelText("默认说明文字"), {
      target: { value: "Updated caption" },
    })
    fireEvent.change(screen.getByLabelText("描述"), {
      target: { value: "Internal notes" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存元数据" }))

    await waitFor(() =>
      expect(updateAssetMetadata).toHaveBeenCalledWith(
        "project-1",
        original.asset_id,
        {
          title: "Updated title",
          default_alt_text: "Updated alt",
          caption: "Updated caption",
          description: "Internal notes",
        },
        undefined
      )
    )
    expect(await screen.findByText("Updated title")).toBeTruthy()
  })

  it("keeps asset details usable when a timestamp is missing or invalid", async () => {
    const incomplete = asset("asset-incomplete-dates", {
      updated_at: undefined as never,
      created_at: "not-a-date",
    })
    vi.mocked(listAssets).mockResolvedValue({
      items: [incomplete],
      next_cursor: null,
    })
    vi.mocked(getAssetUsage).mockResolvedValue(usage(incomplete.asset_id))
    renderDialog()

    fireEvent.click(await screen.findByText("asset-incomplete-dates.jpg"))

    expect(screen.getAllByText("未知")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "使用此资产" })).toBeTruthy()
  })

  it("shows referencing articles and prevents deletion", async () => {
    const referenced = asset("asset-referenced", { active_reference_count: 2 })
    vi.mocked(listAssets).mockResolvedValue({ items: [referenced], next_cursor: null })
    vi.mocked(getAssetUsage).mockResolvedValue(usage(referenced.asset_id, 2))
    renderDialog()

    fireEvent.click(await screen.findByText("asset-referenced.jpg"))
    expect(await screen.findByText("引用这张图片的文章")).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "删除" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      screen.getByText("资产仍被文章引用，解除全部引用后才能删除。")
    ).toBeTruthy()
  })

  it("reloads usage when a concurrent reference makes deletion return 409", async () => {
    const candidate = asset("asset-conflict")
    vi.mocked(listAssets).mockResolvedValue({ items: [candidate], next_cursor: null })
    vi.mocked(getAssetUsage)
      .mockResolvedValueOnce(usage(candidate.asset_id))
      .mockResolvedValueOnce(usage(candidate.asset_id, 1))
    vi.mocked(deleteAsset).mockRejectedValue(
      new ApiError(409, "The asset is still referenced.", {
        code: "asset_still_referenced",
      })
    )
    renderDialog()

    fireEvent.click(await screen.findByText("asset-conflict.jpg"))
    await waitFor(() => expect(getAssetUsage).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "删除" }))
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }))

    expect(await screen.findByText("引用这张图片的文章")).toBeTruthy()
    expect(getAssetUsage).toHaveBeenCalledTimes(2)
    expect(screen.getByText("The asset is still referenced.")).toBeTruthy()
  })

  it("passes selected local files to the existing upload queue boundary", () => {
    const callbacks = renderDialog({ mode: "upload" })
    const file = new File(["image"], "campaign.jpg", { type: "image/jpeg" })

    fireEvent.change(screen.getByLabelText("本地媒体文件"), {
      target: { files: [file] },
    })

    expect(callbacks.onChooseFiles).toHaveBeenCalledWith([file])
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false)
  })
})
