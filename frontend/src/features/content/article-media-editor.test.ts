import { Editor } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import type { ContentAsset } from "@/api/assets"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"
import {
  applyReadyAssetToArticleEditor,
  articleMediaInsertionPosition,
  convertArticleGalleryToImage,
  removeArticleUploadAnchor,
  type ReadyGalleryUploadGroups,
} from "@/features/content/article-media-editor"
import { createArticleUploadTask } from "@/features/content/article-upload-queue"
import { addArticleUploadPlaceholder } from "@/features/content/article-upload-placeholder"

const now = "2026-08-09T12:00:00.000Z"

function asset(id: string, type: ContentAsset["asset_type"] = "image") {
  return {
    asset_id: id,
    canonical_asset_id: null,
    asset_type: type,
    status: "ready",
    original_filename: `${id}.${type === "image" ? "png" : "bin"}`,
    title: null,
    default_alt_text: null,
    caption: null,
    description: null,
    mime_type: type === "image" ? "image/png" : "application/octet-stream",
    detected_mime_type:
      type === "image" ? "image/png" : "application/octet-stream",
    byte_size: 5,
    content_hash: `hash-${id}`,
    width: type === "image" ? 1200 : null,
    height: type === "image" ? 800 : null,
    duration_ms: type === "video" ? 2_000 : null,
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
  } satisfies ContentAsset
}

function upload(input: {
  uploadId: string
  order?: number
  totalItems?: number
  kind?: "gallery" | "gallery_add"
}) {
  const order = input.order ?? 0
  const kind = input.kind ?? "gallery"
  return createArticleUploadTask({
    projectId: "project-1",
    articleId: "article-1",
    source: "picker",
    assetType: "image",
    file: new File([input.uploadId], `${input.uploadId}.png`, {
      type: "image/png",
    }),
    now,
    uploadId: input.uploadId,
    intent:
      kind === "gallery"
        ? {
            kind,
            galleryNodeId: "gallery-1",
            batchId: "batch-1",
            itemId: `item-${order}`,
            position: 0,
            order,
            totalItems: input.totalItems ?? 5,
            alt: `Gallery image ${order + 1}`,
          }
        : {
            kind,
            galleryNodeId: "gallery-1",
            batchId: "batch-1",
            itemId: `item-${order}`,
            order,
            totalItems: input.totalItems ?? 5,
            alt: `Added gallery image ${order + 1}`,
          },
  })
}

function editor(content: object[] = [{ type: "paragraph" }]) {
  return new Editor({
    extensions: articleEditorExtensions,
    content: { type: "doc", content },
  })
}

function mediaTask(input: {
  uploadId: string
  intent: Parameters<typeof createArticleUploadTask>[0]["intent"]
}) {
  return createArticleUploadTask({
    projectId: "project-1",
    articleId: "article-1",
    source: "replace",
    assetType: "image",
    file: new File([input.uploadId], `${input.uploadId}.png`, {
      type: "image/png",
    }),
    uploadId: input.uploadId,
    now,
    intent: input.intent,
  })
}

describe("article media editor transactions", () => {
  it("places block media after the selected text block without splitting it", () => {
    const current = editor([
      {
        type: "heading",
        attrs: { level: 2, node_id: "heading-intro" },
        content: [{ type: "text", text: "Solar battery payback guide" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "Summary" }] },
    ])
    const position = articleMediaInsertionPosition(current, 1)
    const task = mediaTask({
      uploadId: "insert-after-heading",
      intent: {
        kind: "insert",
        nodeType: "image",
        position,
        alt: "Solar battery system",
      },
    })
    addArticleUploadPlaceholder(current, {
      uploadId: task.uploadId,
      pos: position,
      filename: task.filename,
      previewUrl: null,
      assetType: "image",
    })

    applyReadyAssetToArticleEditor({
      editor: current,
      task,
      asset: asset("asset-after-heading"),
      readyGroups: new Map(),
      allTasks: [task],
    })

    expect(current.getJSON().content).toMatchObject([
      {
        type: "heading",
        content: [{ type: "text", text: "Solar battery payback guide" }],
      },
      { type: "image", attrs: { asset_id: "asset-after-heading" } },
      { type: "paragraph", content: [{ type: "text", text: "Summary" }] },
    ])
    current.destroy()
  })

  it("replaces stable paste anchors in source order when uploads finish out of order", () => {
    const current = editor([
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "paragraph", attrs: { node_id: "paste-anchor-1" } },
      { type: "paragraph", content: [{ type: "text", text: "Middle" }] },
      { type: "paragraph", attrs: { node_id: "paste-anchor-2" } },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ])
    const tasks = [
      createArticleUploadTask({
        projectId: "project-1",
        articleId: "article-1",
        source: "paste",
        assetType: "image",
        file: new File(["first"], "first.png", { type: "image/png" }),
        uploadId: "paste-upload-1",
        now,
        intent: {
          kind: "insert",
          nodeType: "image",
          position: 8,
          anchorNodeId: "paste-anchor-1",
          alt: "First alt",
        },
      }),
      createArticleUploadTask({
        projectId: "project-1",
        articleId: "article-1",
        source: "paste",
        assetType: "image",
        file: new File(["second"], "second.png", { type: "image/png" }),
        uploadId: "paste-upload-2",
        now,
        intent: {
          kind: "insert",
          nodeType: "image",
          position: 18,
          anchorNodeId: "paste-anchor-2",
          alt: "Second alt",
        },
      }),
    ]
    tasks.forEach((task) =>
      addArticleUploadPlaceholder(current, {
        uploadId: task.uploadId,
        pos: task.intent.kind === "insert" ? task.intent.position : 0,
        filename: task.filename,
        previewUrl: null,
        assetType: "image",
      })
    )

    applyReadyAssetToArticleEditor({
      editor: current,
      task: tasks[1],
      asset: asset("asset-second"),
      readyGroups: new Map(),
      allTasks: tasks,
    })
    applyReadyAssetToArticleEditor({
      editor: current,
      task: tasks[0],
      asset: asset("asset-first"),
      readyGroups: new Map(),
      allTasks: tasks,
    })

    expect(current.getJSON().content?.map((node) => node.type)).toEqual([
      "paragraph",
      "image",
      "paragraph",
      "image",
      "paragraph",
    ])
    expect(current.getJSON().content?.[1].attrs).toMatchObject({
      asset_id: "asset-first",
      alt: "First alt",
    })
    expect(current.getJSON().content?.[3].attrs).toMatchObject({
      asset_id: "asset-second",
      alt: "Second alt",
    })
    current.destroy()
  })

  it("removes a cancelled paste anchor but keeps a failed anchor available", () => {
    const current = editor([
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "paragraph", attrs: { node_id: "paste-anchor-cancel" } },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ])
    const task = createArticleUploadTask({
      projectId: "project-1",
      articleId: "article-1",
      source: "paste",
      assetType: "image",
      file: new File(["cancel"], "cancel.png", { type: "image/png" }),
      uploadId: "paste-upload-cancel",
      now,
      intent: {
        kind: "insert",
        nodeType: "image",
        position: 8,
        anchorNodeId: "paste-anchor-cancel",
      },
    })

    expect(current.getJSON().content).toHaveLength(3)
    expect(removeArticleUploadAnchor(current, task)).toBe(true)
    expect(current.getJSON().content).toHaveLength(2)
    expect(removeArticleUploadAnchor(current, task)).toBe(false)
    current.destroy()
  })

  it("does not fall back to a stale placeholder when the stable anchor is missing", () => {
    const current = editor([
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ])
    const task = createArticleUploadTask({
      projectId: "project-1",
      articleId: "article-1",
      source: "paste",
      assetType: "image",
      file: new File(["missing"], "missing.png", { type: "image/png" }),
      uploadId: "paste-upload-missing",
      now,
      intent: {
        kind: "insert",
        nodeType: "image",
        position: 8,
        anchorNodeId: "paste-anchor-missing",
      },
    })
    addArticleUploadPlaceholder(current, {
      uploadId: task.uploadId,
      pos: 8,
      filename: task.filename,
      previewUrl: null,
      assetType: "image",
    })

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task,
        asset: asset("asset-missing"),
        readyGroups: new Map(),
        allTasks: [task],
      })
    ).toEqual({
      failure: {
        code: "article_upload_anchor_missing",
        detail:
          "The original upload position no longer exists. The asset was not inserted.",
      },
    })
    expect(current.getJSON().content?.map((node) => node.type)).toEqual([
      "paragraph",
      "paragraph",
    ])
    current.destroy()
  })

  it("preserves an edited anchor on completion and cancellation", () => {
    const current = editor([
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      {
        type: "paragraph",
        attrs: { node_id: "paste-anchor-edited" },
        content: [{ type: "text", text: "User draft" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ])
    const task = createArticleUploadTask({
      projectId: "project-1",
      articleId: "article-1",
      source: "paste",
      assetType: "image",
      file: new File(["edited"], "edited.png", { type: "image/png" }),
      uploadId: "paste-upload-edited",
      now,
      intent: {
        kind: "insert",
        nodeType: "image",
        position: 8,
        anchorNodeId: "paste-anchor-edited",
      },
    })

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task,
        asset: asset("asset-edited"),
        readyGroups: new Map(),
        allTasks: [task],
      })
    ).toEqual({
      failure: {
        code: "article_upload_anchor_edited",
        detail:
          "The original upload position was edited. User content was preserved and the asset was not inserted.",
      },
    })
    expect(removeArticleUploadAnchor(current, task)).toBe(false)
    expect(current.getJSON().content?.[1]).toMatchObject({
      type: "paragraph",
      attrs: { node_id: "paste-anchor-edited" },
      content: [{ type: "text", text: "User draft" }],
    })
    current.destroy()
  })

  it("reports a recoverable placement failure when a normal insert placeholder is gone", () => {
    const current = editor()
    const task = mediaTask({
      uploadId: "insert-missing",
      intent: { kind: "insert", nodeType: "image", position: 0 },
    })

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task,
        asset: asset("asset-insert-missing"),
        readyGroups: new Map(),
        allTasks: [task],
      })
    ).toEqual({
      failure: {
        code: "article_upload_placement_missing",
        detail:
          "The upload insertion position no longer exists. The asset was not inserted.",
      },
    })
    current.destroy()
  })

  it("keeps a ready image out of the document until valid image properties exist", () => {
    const current = editor()
    const task = mediaTask({
      uploadId: "insert-needs-properties",
      intent: { kind: "insert", nodeType: "image", position: 0 },
    })
    addArticleUploadPlaceholder(current, {
      uploadId: task.uploadId,
      pos: 0,
      filename: task.filename,
      previewUrl: null,
      assetType: "image",
    })

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task,
        asset: asset("asset-needs-properties"),
        readyGroups: new Map(),
        allTasks: [task],
      })
    ).toEqual({
      failure: {
        code: "article_image_properties_required",
        detail:
          "Alternative text is required unless the image is explicitly decorative.",
      },
    })
    expect(
      current.getJSON().content?.some((node) => node.type === "image")
    ).toBe(false)
    current.destroy()
  })

  it.each([
    {
      name: "alternative text",
      properties: { alt: "Solar panel installation", decorative: false },
      expected: { alt: "Solar panel installation", decorative: false },
    },
    {
      name: "an explicit decorative choice",
      properties: { alt: "", decorative: true },
      expected: { alt: "", decorative: true },
    },
  ])("inserts an image after $name is confirmed", ({ properties, expected }) => {
    const current = editor()
    const task = mediaTask({
      uploadId: `insert-${properties.decorative ? "decorative" : "alt"}`,
      intent: {
        kind: "insert",
        nodeType: "image",
        position: 0,
        ...properties,
      },
    })
    addArticleUploadPlaceholder(current, {
      uploadId: task.uploadId,
      pos: 0,
      filename: task.filename,
      previewUrl: null,
      assetType: "image",
    })

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task,
        asset: asset(`asset-${properties.decorative ? "decorative" : "alt"}`),
        readyGroups: new Map(),
        allTasks: [task],
      })
    ).toEqual([task.uploadId])
    expect(current.getJSON().content?.[0]).toMatchObject({
      type: "image",
      attrs: expected,
    })
    current.destroy()
  })

  it("keeps successful gallery items when part of the batch fails", () => {
    const current = editor()
    const tasks = Array.from({ length: 5 }, (_, order) =>
      upload({ uploadId: `upload-${order}`, order })
    )
    const groups: ReadyGalleryUploadGroups = new Map()
    tasks.forEach((task, side) =>
      addArticleUploadPlaceholder(current, {
        uploadId: task.uploadId,
        pos: 0,
        filename: task.filename,
        previewUrl: null,
        assetType: "image",
        side,
      })
    )

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task: tasks[0],
        asset: asset("asset-0"),
        readyGroups: groups,
        allTasks: tasks,
      })
    ).toBeUndefined()
    expect(
      current.getJSON().content?.some((node) => node.type === "gallery")
    ).toBe(false)

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task: tasks[3],
        asset: asset("asset-3"),
        readyGroups: groups,
        allTasks: tasks,
      })
    ).toEqual([])
    expect(current.getJSON().content?.[0]).toMatchObject({
      type: "gallery",
      attrs: {
        node_id: "gallery-1",
        items: [
          { item_id: "item-0", asset_id: "asset-0" },
          { item_id: "item-3", asset_id: "asset-3" },
        ],
      },
    })

    applyReadyAssetToArticleEditor({
      editor: current,
      task: tasks[1],
      asset: asset("asset-1"),
      readyGroups: groups,
      allTasks: tasks,
    })
    expect(current.getJSON().content?.[0].attrs?.items).toEqual([
      {
        item_id: "item-0",
        asset_id: "asset-0",
        alt: "Gallery image 1",
        width: 1200,
        height: 800,
      },
      {
        item_id: "item-1",
        asset_id: "asset-1",
        alt: "Gallery image 2",
        width: 1200,
        height: 800,
      },
      {
        item_id: "item-3",
        asset_id: "asset-3",
        alt: "Gallery image 4",
        width: 1200,
        height: 800,
      },
    ])
    current.destroy()
  })

  it("appends a batch after existing gallery items and keeps selection order", () => {
    const current = editor([
      {
        type: "gallery",
        attrs: {
          node_id: "gallery-1",
          display: "wide",
          items: [
            { item_id: "old-1", asset_id: "old-asset-1", alt: "Old 1" },
            { item_id: "old-2", asset_id: "old-asset-2", alt: "Old 2" },
          ],
        },
      },
    ])
    const tasks = [
      upload({
        uploadId: "add-0",
        order: 0,
        totalItems: 2,
        kind: "gallery_add",
      }),
      upload({
        uploadId: "add-1",
        order: 1,
        totalItems: 2,
        kind: "gallery_add",
      }),
    ]
    const groups: ReadyGalleryUploadGroups = new Map()

    applyReadyAssetToArticleEditor({
      editor: current,
      task: tasks[1],
      asset: asset("new-asset-1"),
      readyGroups: groups,
      allTasks: tasks,
    })
    const completed = applyReadyAssetToArticleEditor({
      editor: current,
      task: tasks[0],
      asset: asset("new-asset-0"),
      readyGroups: groups,
      allTasks: tasks,
    })

    expect(completed).toEqual(["add-1", "add-0"])
    expect(current.getJSON().content?.[0].attrs?.items).toEqual([
      { item_id: "old-1", asset_id: "old-asset-1", alt: "Old 1" },
      { item_id: "old-2", asset_id: "old-asset-2", alt: "Old 2" },
      {
        item_id: "item-0",
        asset_id: "new-asset-0",
        alt: "Added gallery image 1",
        width: 1200,
        height: 800,
      },
      {
        item_id: "item-1",
        asset_id: "new-asset-1",
        alt: "Added gallery image 2",
        width: 1200,
        height: 800,
      },
    ])
    current.destroy()
  })

  it("reports placement failure when an existing gallery disappears during an add batch", () => {
    const current = editor()
    const task = upload({
      uploadId: "gallery-add-missing",
      totalItems: 2,
      kind: "gallery_add",
    })

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task,
        asset: asset("asset-gallery-add-missing"),
        readyGroups: new Map(),
        allTasks: [task],
      })
    ).toEqual({
      failure: {
        code: "article_upload_placement_missing",
        detail:
          "The target gallery no longer exists. The uploaded assets were not placed.",
      },
    })
    current.destroy()
  })

  it("waits for enough new-gallery assets, then reports a missing insertion position", () => {
    const current = editor()
    const tasks = [
      upload({ uploadId: "gallery-new-0", order: 0, totalItems: 2 }),
      upload({ uploadId: "gallery-new-1", order: 1, totalItems: 2 }),
    ]
    const groups: ReadyGalleryUploadGroups = new Map()

    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task: tasks[0],
        asset: asset("asset-gallery-new-0"),
        readyGroups: groups,
        allTasks: tasks,
      })
    ).toBeUndefined()
    expect(
      applyReadyAssetToArticleEditor({
        editor: current,
        task: tasks[1],
        asset: asset("asset-gallery-new-1"),
        readyGroups: groups,
        allTasks: tasks,
      })
    ).toEqual({
      failure: {
        code: "article_upload_placement_missing",
        detail:
          "The gallery insertion position no longer exists. The uploaded assets were not placed.",
      },
    })
    current.destroy()
  })

  it.each([
    {
      name: "missing poster target",
      content: [{ type: "paragraph" }],
      intent: { kind: "poster", nodeId: "video-missing" } as const,
      code: "article_upload_placement_missing",
    },
    {
      name: "poster target changed type",
      content: [
        {
          type: "image",
          attrs: { node_id: "video-1", asset_id: "old", alt: "" },
        },
      ],
      intent: { kind: "poster", nodeId: "video-1" } as const,
      code: "article_upload_placement_type_mismatch",
    },
    {
      name: "replacement target changed type",
      content: [
        {
          type: "video",
          attrs: { node_id: "image-1", asset_id: "old" },
        },
      ],
      intent: {
        kind: "replace",
        nodeId: "image-1",
        nodeType: "image",
      } as const,
      code: "article_upload_placement_type_mismatch",
    },
    {
      name: "gallery item disappeared",
      content: [
        {
          type: "gallery",
          attrs: {
            node_id: "gallery-1",
            items: [{ item_id: "remaining", asset_id: "old" }],
          },
        },
      ],
      intent: {
        kind: "replace",
        nodeId: "gallery-1",
        nodeType: "gallery",
        itemId: "missing-item",
      } as const,
      code: "article_upload_placement_gallery_item_missing",
    },
  ])("reports $name as a recoverable placement failure", ({ content, intent, code }) => {
    const current = editor(content)
    const task = mediaTask({ uploadId: `failure-${code}`, intent })

    const result = applyReadyAssetToArticleEditor({
      editor: current,
      task,
      asset: asset("asset-ready"),
      readyGroups: new Map(),
      allTasks: [task],
    })

    expect(result).toMatchObject({ failure: { code } })
    current.destroy()
  })

  it("replaces image facts in one undoable transaction", () => {
    const current = editor([
      {
        type: "image",
        attrs: {
          node_id: "image-1",
          asset_id: "old-asset",
          alt: "Evidence",
          decorative: false,
          caption: "Caption",
          link: "https://example.com/report",
          display: "wide",
          width: 800,
          height: 600,
        },
      },
    ])
    const task = createArticleUploadTask({
      projectId: "project-1",
      articleId: "article-1",
      source: "replace",
      assetType: "image",
      file: new File(["new"], "new.png", { type: "image/png" }),
      uploadId: "replace-1",
      now,
      intent: { kind: "replace", nodeId: "image-1", nodeType: "image" },
    })

    applyReadyAssetToArticleEditor({
      editor: current,
      task,
      asset: asset("new-asset"),
      readyGroups: new Map(),
      allTasks: [task],
    })
    expect(current.getJSON().content?.[0].attrs).toMatchObject({
      node_id: "image-1",
      asset_id: "new-asset",
      alt: "Evidence",
      caption: "Caption",
      link: "https://example.com/report",
      display: "wide",
      width: 1200,
      height: 800,
    })
    expect(current.commands.undo()).toBe(true)
    expect(current.getJSON().content?.[0].attrs?.asset_id).toBe("old-asset")
    current.destroy()
  })

  it("converts a two-item gallery to the remaining image in one transaction", () => {
    const current = editor([
      {
        type: "gallery",
        attrs: {
          node_id: "gallery-1",
          display: "wide",
          items: [
            {
              item_id: "remove-me",
              asset_id: "asset-old",
              alt: "Old",
              width: 640,
              height: 480,
            },
            {
              item_id: "keep-me",
              asset_id: "asset-keep",
              alt: "Evidence",
              caption: "Caption",
              link: "/guide/evidence",
              width: 1600,
              height: 900,
            },
          ],
        },
      },
    ])

    expect(
      convertArticleGalleryToImage(current, "gallery-1", "remove-me")
    ).toBe(true)
    expect(current.getJSON().content?.[0]).toMatchObject({
      type: "image",
      attrs: {
        node_id: "gallery-1",
        asset_id: "asset-keep",
        alt: "Evidence",
        decorative: false,
        caption: "Caption",
        link: "/guide/evidence",
        display: "wide",
        width: 1600,
        height: 900,
      },
    })
    expect(current.commands.undo()).toBe(true)
    expect(current.getJSON().content?.[0]).toMatchObject({
      type: "gallery",
      attrs: { node_id: "gallery-1" },
    })
    current.destroy()
  })
})
