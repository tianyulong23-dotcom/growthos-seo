import { describe, expect, it } from "vitest"

import type { ContentAsset } from "@/api/assets"
import {
  articleMediaNode,
  galleryItemsFromUploads,
  replacementMediaAttributes,
} from "@/features/content/article-media-document"
import { createArticleUploadTask } from "@/features/content/article-upload-queue"

const now = "2026-08-09T12:00:00.000Z"
const asset: ContentAsset = {
  asset_id: "asset-original",
  canonical_asset_id: "asset-canonical",
  asset_type: "image",
  status: "ready",
  original_filename: "proof.png",
  title: null,
  default_alt_text: null,
  caption: null,
  description: null,
  mime_type: "image/png",
  detected_mime_type: "image/png",
  byte_size: 5,
  content_hash: "hash",
  width: 1600,
  height: 900,
  duration_ms: null,
  source_type: "upload",
  source_url: null,
  final_source_url: null,
  failure_code: null,
  failure_detail: null,
  created_at: now,
  updated_at: now,
  ready_at: now,
  active_reference_count: 0,
  variants: [],
  actions: [],
}

describe("article media document operations", () => {
  it("creates the canonical image node without inventing alt text", () => {
    expect(articleMediaNode("image", asset, "image-1")).toEqual({
      type: "image",
      attrs: {
        node_id: "image-1",
        asset_id: "asset-canonical",
        alt: "",
        decorative: false,
        display: "regular",
        width: 1600,
        height: 900,
      },
    })
  })

  it("preserves semantic image fields when replacing asset facts", () => {
    expect(
      replacementMediaAttributes(
        "image",
        {
          node_id: "image-1",
          asset_id: "old",
          alt: "证据图",
          caption: "结论",
          link: "/report",
          display: "wide",
        },
        asset
      )
    ).toEqual({
      node_id: "image-1",
      asset_id: "asset-canonical",
      alt: "证据图",
      caption: "结论",
      link: "/report",
      display: "wide",
      width: 1600,
      height: 900,
    })
  })

  it.each([
    [
      "file" as const,
      {
        node_id: "file-1",
        asset_id: "old-file",
        display_name: "Evidence bundle",
        description: "Reviewed sources",
      },
      { ...asset, asset_id: "new-file", canonical_asset_id: null },
    ],
    [
      "audio" as const,
      {
        node_id: "audio-1",
        asset_id: "old-audio",
        title: "Founder interview",
        caption: "Edited recording",
        duration_ms: 10_000,
      },
      {
        ...asset,
        asset_id: "new-audio",
        canonical_asset_id: null,
        duration_ms: 65_000,
      },
    ],
    [
      "video" as const,
      {
        node_id: "video-1",
        asset_id: "old-video",
        poster_asset_id: "custom-poster",
        title: "Product launch",
        caption: "Final cut",
        duration_ms: 10_000,
      },
      {
        ...asset,
        asset_id: "new-video",
        canonical_asset_id: null,
        duration_ms: 65_000,
      },
    ],
  ])(
    "preserves %s semantics while replacing asset facts",
    (type, current, next) => {
      expect(replacementMediaAttributes(type, current, next)).toEqual({
        ...current,
        asset_id: next.asset_id,
        ...(type === "audio" || type === "video"
          ? { duration_ms: next.duration_ms }
          : {}),
      })
    }
  )

  it("keeps gallery selection order when uploads finish out of order", () => {
    const upload = (order: number, id: string) =>
      createArticleUploadTask({
        projectId: "project-1",
        articleId: "article-1",
        source: "picker",
        assetType: "image",
        file: new File([id], `${id}.png`, { type: "image/png" }),
        now,
        intent: {
          kind: "gallery",
          galleryNodeId: "gallery-1",
          itemId: id,
          position: 1,
          order,
          totalItems: 2,
          alt: `Image ${order + 1}`,
        },
      })

    expect(
      galleryItemsFromUploads([
        {
          task: upload(1, "second"),
          asset: { ...asset, asset_id: "asset-2", canonical_asset_id: null },
        },
        {
          task: upload(0, "first"),
          asset: { ...asset, asset_id: "asset-1", canonical_asset_id: null },
        },
      ])
    ).toEqual([
      {
        item_id: "first",
        asset_id: "asset-1",
        alt: "Image 1",
        width: 1600,
        height: 900,
      },
      {
        item_id: "second",
        asset_id: "asset-2",
        alt: "Image 2",
        width: 1600,
        height: 900,
      },
    ])
  })
})
