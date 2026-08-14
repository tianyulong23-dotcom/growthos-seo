import type { JSONContent } from "@tiptap/core"

import type { ContentAsset } from "@/api/assets"
import type {
  ArticleImageProperties,
  ArticleUploadIntent,
  ArticleUploadTask,
} from "@/features/content/article-upload-queue"

export function articleMediaNodeId(prefix = "blk") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}

function assetId(asset: ContentAsset) {
  return asset.canonical_asset_id ?? asset.asset_id
}

function imageDimensions(asset: ContentAsset) {
  return {
    ...(typeof asset.width === "number" ? { width: asset.width } : {}),
    ...(typeof asset.height === "number" ? { height: asset.height } : {}),
  }
}

export function articleMediaNode(
  nodeType: "image" | "file" | "audio" | "video",
  asset: ContentAsset,
  nodeId = articleMediaNodeId(),
  image?: ArticleImageProperties
): JSONContent {
  const facts = {
    node_id: nodeId,
    asset_id: assetId(asset),
  }
  if (nodeType === "image") {
    return {
      type: "image",
      attrs: {
        ...facts,
        alt: image?.decorative ? "" : image?.alt.trim() || "",
        decorative: image?.decorative ?? false,
        ...(image?.caption?.trim() ? { caption: image.caption.trim() } : {}),
        ...(image?.link?.trim() ? { link: image.link.trim() } : {}),
        display: image?.display ?? "regular",
        width: asset.width,
        height: asset.height,
      },
    }
  }
  if (nodeType === "file") {
    return {
      type: "file",
      attrs: {
        ...facts,
        display_name: asset.original_filename,
      },
    }
  }
  if (nodeType === "audio") {
    return {
      type: "audio",
      attrs: {
        ...facts,
        title: asset.original_filename,
        duration_ms: asset.duration_ms,
      },
    }
  }
  return {
    type: "video",
    attrs: {
      ...facts,
      title: asset.original_filename,
      duration_ms: asset.duration_ms,
    },
  }
}

export function replacementMediaAttributes(
  nodeType: "image" | "file" | "audio" | "video",
  current: Record<string, unknown>,
  asset: ContentAsset
) {
  const facts: Record<string, unknown> = { asset_id: assetId(asset) }
  if (nodeType === "image") {
    facts.width = asset.width
    facts.height = asset.height
  }
  if (nodeType === "audio" || nodeType === "video") {
    facts.duration_ms = asset.duration_ms
  }
  return { ...current, ...facts }
}

export type ReadyGalleryUpload = {
  task: ArticleUploadTask
  asset: ContentAsset
}

export function galleryItemsFromUploads(uploads: ReadyGalleryUpload[]) {
  return [...uploads]
    .sort((left, right) => {
      const leftIntent = left.task.intent as Extract<
        ArticleUploadIntent,
        { kind: "gallery" | "gallery_add" }
      >
      const rightIntent = right.task.intent as typeof leftIntent
      return leftIntent.order - rightIntent.order
    })
    .map(({ task, asset }) => {
      const intent = task.intent as Extract<
        ArticleUploadIntent,
        { kind: "gallery" | "gallery_add" }
      >
      return {
        item_id: intent.itemId,
        asset_id: assetId(asset),
        alt: intent.decorative ? "" : intent.alt?.trim() || "",
        ...(intent.decorative !== undefined
          ? { decorative: intent.decorative }
          : {}),
        ...(intent.caption?.trim() ? { caption: intent.caption.trim() } : {}),
        ...(intent.link?.trim() ? { link: intent.link.trim() } : {}),
        ...imageDimensions(asset),
      }
    })
}

export function mergeGalleryItemsFromUploads(
  currentItems: Array<Record<string, unknown>>,
  uploads: ReadyGalleryUpload[],
  groupTasks: ArticleUploadTask[]
) {
  const currentById = new Map(
    currentItems.map((item) => [String(item.item_id), item])
  )
  const merged = new Map(currentById)
  for (const item of galleryItemsFromUploads(uploads)) {
    const current = currentById.get(item.item_id)
    merged.set(item.item_id, current ? { ...current, ...item } : item)
  }

  const orderByItemId = new Map<string, number>()
  for (const task of groupTasks) {
    if (task.intent.kind !== "gallery" && task.intent.kind !== "gallery_add") {
      continue
    }
    orderByItemId.set(task.intent.itemId, task.intent.order)
  }
  const currentIndex = new Map(
    currentItems.map((item, index) => [String(item.item_id), index])
  )
  return [...merged.values()].sort((left, right) => {
    const leftId = String(left.item_id)
    const rightId = String(right.item_id)
    const leftOrder = orderByItemId.get(leftId)
    const rightOrder = orderByItemId.get(rightId)
    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder
    }
    if (leftOrder !== undefined) return 1
    if (rightOrder !== undefined) return -1
    return (currentIndex.get(leftId) ?? 0) - (currentIndex.get(rightId) ?? 0)
  })
}

export function replaceGalleryItemAsset(
  items: Array<Record<string, unknown>>,
  itemId: string,
  asset: ContentAsset
) {
  return items.map((item) => {
    if (item.item_id !== itemId) return item
    const metadata = { ...item }
    delete metadata.width
    delete metadata.height
    return {
      ...metadata,
      asset_id: assetId(asset),
      ...imageDimensions(asset),
    }
  })
}
