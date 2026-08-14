import type { Editor, JSONContent } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

import type { ContentAsset } from "@/api/assets"
import {
  articleMediaNode,
  galleryItemsFromUploads,
  mergeGalleryItemsFromUploads,
  replaceGalleryItemAsset,
  replacementMediaAttributes,
  type ReadyGalleryUpload,
} from "@/features/content/article-media-document"
import {
  articleGalleryUploadGroupKey,
  type ArticleImageProperties,
  type ArticleUploadIntent,
  type ArticleUploadTask,
  type ArticleUploadReadyFailure,
  type ArticleUploadReadyResult,
} from "@/features/content/article-upload-queue"
import {
  articleUploadPlaceholderKey,
  findArticleUploadPlaceholder,
} from "@/features/content/article-upload-placeholder"

export type ReadyGalleryUploadGroups = Map<
  string,
  Map<string, ReadyGalleryUpload>
>

type LocatedArticleNode = {
  node: ProseMirrorNode
  position: number
}

export function findArticleNodeById(
  editor: Editor,
  nodeId: string
): LocatedArticleNode | null {
  let result: LocatedArticleNode | null = null
  editor.state.doc.descendants((node, position) => {
    if (node.attrs.node_id !== nodeId) return
    result = { node, position }
    return false
  })
  return result
}

export function articleMediaInsertionPosition(editor: Editor, position: number) {
  const clamped = Math.max(0, Math.min(position, editor.state.doc.content.size))
  const resolved = editor.state.doc.resolve(clamped)
  return resolved.parent.isTextblock && resolved.depth > 0
    ? resolved.after(resolved.depth)
    : clamped
}

export function convertArticleGalleryToImage(
  editor: Editor,
  galleryNodeId: string,
  removedItemId: string
) {
  const located = findArticleNodeById(editor, galleryNodeId)
  if (!located || located.node.type.name !== "gallery") return false
  const items = Array.isArray(located.node.attrs.items)
    ? (located.node.attrs.items as Array<Record<string, unknown>>)
    : []
  const remaining = items.filter((item) => item.item_id !== removedItemId)
  if (items.length !== 2 || remaining.length !== 1) return false
  const item = remaining[0]
  const image = editor.schema.nodes.image.create({
    node_id: galleryNodeId,
    asset_id: item.asset_id,
    alt: item.alt,
    decorative: false,
    caption: item.caption ?? null,
    link: item.link ?? null,
    display: located.node.attrs.display ?? "regular",
    width: item.width ?? null,
    height: item.height ?? null,
  })
  editor.view.dispatch(
    editor.state.tr.replaceWith(
      located.position,
      located.position + located.node.nodeSize,
      image
    )
  )
  return true
}

function dispatchMediaNode(
  editor: Editor,
  position: number,
  content: JSONContent,
  uploadIds: string[]
) {
  editor.view.dispatch(
    editor.state.tr
      .insert(position, editor.schema.nodeFromJSON(content))
      .setMeta(articleUploadPlaceholderKey, { remove: { uploadIds } })
  )
}

function uploadAnchorFailure(
  code: "article_upload_anchor_missing" | "article_upload_anchor_edited",
  detail: string
): ArticleUploadReadyFailure {
  return { failure: { code, detail } }
}

function uploadPlacementFailure(
  code:
    | "article_upload_placement_missing"
    | "article_upload_placement_type_mismatch"
    | "article_upload_placement_gallery_item_missing"
    | "article_image_properties_required",
  detail: string
): ArticleUploadReadyFailure {
  return { failure: { code, detail } }
}

function imagePropertiesFromIntent(
  intent: Extract<ArticleUploadIntent, { kind: "insert" }>
): ArticleImageProperties {
  return {
    alt: intent.alt ?? "",
    decorative: intent.decorative ?? false,
    caption: intent.caption,
    link: intent.link,
    display: intent.display,
  }
}

function imagePropertiesMissing(intent: ArticleUploadIntent) {
  if (intent.kind === "insert" && intent.nodeType !== "image") return false
  if (
    intent.kind !== "insert" &&
    intent.kind !== "gallery" &&
    intent.kind !== "gallery_add"
  ) {
    return false
  }
  return intent.decorative !== true && !intent.alt?.trim()
}

function anchoredMediaNode(
  editor: Editor,
  task: ArticleUploadTask,
  asset: ContentAsset
): true | ArticleUploadReadyFailure {
  const intent = task.intent
  if (intent.kind !== "insert" || !intent.anchorNodeId) {
    return uploadAnchorFailure(
      "article_upload_anchor_missing",
      "The upload insertion anchor is missing."
    )
  }
  const located = findArticleNodeById(editor, intent.anchorNodeId)
  if (!located) {
    return uploadAnchorFailure(
      "article_upload_anchor_missing",
      "The original upload position no longer exists. The asset was not inserted."
    )
  }
  if (located.node.type.name !== "paragraph" || located.node.content.size > 0) {
    return uploadAnchorFailure(
      "article_upload_anchor_edited",
      "The original upload position was edited. User content was preserved and the asset was not inserted."
    )
  }
  if (imagePropertiesMissing(intent)) {
    return uploadPlacementFailure(
      "article_image_properties_required",
      "Alternative text is required unless the image is explicitly decorative."
    )
  }
  const content = articleMediaNode(
    intent.nodeType,
    asset,
    undefined,
    intent.nodeType === "image" ? imagePropertiesFromIntent(intent) : undefined
  )
  editor.view.dispatch(
    editor.state.tr
      .replaceWith(
        located.position,
        located.position + located.node.nodeSize,
        editor.schema.nodeFromJSON(content)
      )
      .setMeta(articleUploadPlaceholderKey, {
        remove: { uploadIds: [task.uploadId] },
      })
  )
  return true
}

export function removeArticleUploadAnchor(
  editor: Editor,
  task: ArticleUploadTask
) {
  const intent = task.intent
  if (intent.kind !== "insert" || !intent.anchorNodeId) return false
  const located = findArticleNodeById(editor, intent.anchorNodeId)
  if (
    !located ||
    located.node.type.name !== "paragraph" ||
    located.node.content.size > 0
  ) {
    return false
  }
  editor.view.dispatch(
    editor.state.tr
      .delete(located.position, located.position + located.node.nodeSize)
      .setMeta(articleUploadPlaceholderKey, {
        remove: { uploadIds: [task.uploadId] },
      })
  )
  return true
}

function groupTasksFor(task: ArticleUploadTask, tasks: ArticleUploadTask[]) {
  const groupKey = articleGalleryUploadGroupKey(task.intent)
  return tasks.filter(
    (candidate) => articleGalleryUploadGroupKey(candidate.intent) === groupKey
  )
}

function completeGalleryUpload(
  editor: Editor,
  task: ArticleUploadTask,
  asset: ContentAsset,
  readyGroups: ReadyGalleryUploadGroups,
  allTasks: ArticleUploadTask[]
) {
  const intent = task.intent
  if (intent.kind !== "gallery" && intent.kind !== "gallery_add") return
  const groupKey = articleGalleryUploadGroupKey(intent)
  if (!groupKey) return
  const groupTasks = groupTasksFor(task, allTasks)
  const located = findArticleNodeById(editor, intent.galleryNodeId)

  if (intent.kind === "gallery_add" && !located) {
    return uploadPlacementFailure(
      "article_upload_placement_missing",
      "The target gallery no longer exists. The uploaded assets were not placed."
    )
  }
  if (located && located.node.type.name !== "gallery") {
    return uploadPlacementFailure(
      "article_upload_placement_type_mismatch",
      "The target node is no longer a gallery. The uploaded assets were not placed."
    )
  }
  if (imagePropertiesMissing(intent)) {
    return uploadPlacementFailure(
      "article_image_properties_required",
      "Alternative text is required unless the image is explicitly decorative."
    )
  }

  const uploads = readyGroups.get(groupKey) ?? new Map()
  uploads.set(task.uploadId, { task, asset })
  readyGroups.set(groupKey, uploads)

  const readyUploads = [...uploads.values()]
  const readyUploadIds = [...uploads.keys()]

  if (intent.kind === "gallery" && !located) {
    if (readyUploads.length < 2) return
    const first = readyUploads
      .map((item) => findArticleUploadPlaceholder(editor, item.task.uploadId))
      .filter((position): position is number => position !== undefined)
      .sort((left, right) => left - right)[0]
    if (first === undefined) {
      return uploadPlacementFailure(
        "article_upload_placement_missing",
        "The gallery insertion position no longer exists. The uploaded assets were not placed."
      )
    }
    dispatchMediaNode(
      editor,
      first,
      {
        type: "gallery",
        attrs: {
          node_id: intent.galleryNodeId,
          display: "regular",
          items: galleryItemsFromUploads(readyUploads),
        },
      },
      readyUploadIds
    )
  } else if (located) {
    const currentItems = Array.isArray(located.node.attrs.items)
      ? located.node.attrs.items
      : []
    const items = mergeGalleryItemsFromUploads(
      currentItems,
      readyUploads,
      groupTasks
    )
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(located.position, undefined, {
          ...located.node.attrs,
          items,
        })
        .setMeta(articleUploadPlaceholderKey, {
          remove: { uploadIds: readyUploadIds },
        })
    )
  }

  if (uploads.size < intent.totalItems) return []
  readyGroups.delete(groupKey)
  return readyUploadIds
}

export function applyReadyAssetToArticleEditor(input: {
  editor: Editor
  task: ArticleUploadTask
  asset: ContentAsset
  readyGroups: ReadyGalleryUploadGroups
  allTasks: ArticleUploadTask[]
}): ArticleUploadReadyResult {
  const { editor, task, asset, readyGroups, allTasks } = input
  const intent = task.intent

  if (intent.kind === "insert") {
    if (intent.anchorNodeId) {
      const anchored = anchoredMediaNode(editor, task, asset)
      return anchored === true ? [task.uploadId] : anchored
    }
    const position = findArticleUploadPlaceholder(editor, task.uploadId)
    if (position === undefined) {
      return uploadPlacementFailure(
        "article_upload_placement_missing",
        "The upload insertion position no longer exists. The asset was not inserted."
      )
    }
    if (imagePropertiesMissing(intent)) {
      return uploadPlacementFailure(
        "article_image_properties_required",
        "Alternative text is required unless the image is explicitly decorative."
      )
    }
    dispatchMediaNode(
      editor,
      position,
      articleMediaNode(
        intent.nodeType,
        asset,
        undefined,
        intent.nodeType === "image" ? imagePropertiesFromIntent(intent) : undefined
      ),
      [task.uploadId]
    )
    return [task.uploadId]
  }

  if (intent.kind === "gallery" || intent.kind === "gallery_add") {
    return completeGalleryUpload(editor, task, asset, readyGroups, allTasks)
  }

  const located = findArticleNodeById(editor, intent.nodeId)
  if (!located) {
    return uploadPlacementFailure(
      "article_upload_placement_missing",
      "The target media node no longer exists. The uploaded asset was not placed."
    )
  }
  if (intent.kind === "poster") {
    if (located.node.type.name !== "video") {
      return uploadPlacementFailure(
        "article_upload_placement_type_mismatch",
        "The poster target is no longer a video. The uploaded asset was not placed."
      )
    }
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(located.position, undefined, {
          ...located.node.attrs,
          poster_asset_id: asset.canonical_asset_id ?? asset.asset_id,
        })
        .setMeta(articleUploadPlaceholderKey, {
          remove: { uploadIds: [task.uploadId] },
        })
    )
    return [task.uploadId]
  }
  if (intent.nodeType === "gallery" && intent.itemId) {
    if (located.node.type.name !== "gallery") {
      return uploadPlacementFailure(
        "article_upload_placement_type_mismatch",
        "The replacement target is no longer a gallery. The uploaded asset was not placed."
      )
    }
    const items = Array.isArray(located.node.attrs.items)
      ? located.node.attrs.items
      : []
    if (!items.some((item) => item.item_id === intent.itemId)) {
      return uploadPlacementFailure(
        "article_upload_placement_gallery_item_missing",
        "The target gallery item no longer exists. The uploaded asset was not placed."
      )
    }
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(located.position, undefined, {
          ...located.node.attrs,
          items: replaceGalleryItemAsset(items, intent.itemId, asset),
        })
        .setMeta(articleUploadPlaceholderKey, {
          remove: { uploadIds: [task.uploadId] },
        })
    )
    return [task.uploadId]
  }
  if (intent.nodeType === "gallery") {
    return uploadPlacementFailure(
      "article_upload_placement_gallery_item_missing",
      "The gallery replacement is missing its target item. The uploaded asset was not placed."
    )
  }
  if (located.node.type.name !== intent.nodeType) {
    return uploadPlacementFailure(
      "article_upload_placement_type_mismatch",
      "The target media type changed before upload completed. The uploaded asset was not placed."
    )
  }
  editor.view.dispatch(
    editor.state.tr
      .setNodeMarkup(located.position, undefined, {
        ...replacementMediaAttributes(
          intent.nodeType,
          located.node.attrs,
          asset
        ),
      })
      .setMeta(articleUploadPlaceholderKey, {
        remove: { uploadIds: [task.uploadId] },
      })
  )
  return [task.uploadId]
}
