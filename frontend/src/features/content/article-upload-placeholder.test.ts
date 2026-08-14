import { Editor } from "@tiptap/core"
import { describe, expect, it, vi } from "vitest"

import { createArticleEditorExtensions } from "@/features/content/article-editor-extensions"
import {
  articleUploadReducer,
  createArticleUrlUploadTask,
} from "@/features/content/article-upload-queue"
import {
  addArticleUploadPlaceholder,
  updateArticleUploadPlaceholder,
} from "@/features/content/article-upload-placeholder"

describe("article upload placeholder", () => {
  it("lets a failed URL import be removed without offering a file replacement", () => {
    const onRemove = vi.fn()
    const element = document.createElement("div")
    document.body.append(element)
    const current = new Editor({
      element,
      extensions: createArticleEditorExtensions({
        uploadPlaceholders: { onRemove },
      }),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    })
    const queued = createArticleUrlUploadTask({
      projectId: "project-1",
      articleId: "article-1",
      sourceUrl: "https://example.com/image.png",
      assetType: "image",
      uploadId: "url-upload-1",
      intent: { kind: "insert", nodeType: "image", position: 0 },
    })
    const failed = articleUploadReducer([queued], {
      type: "failed",
      uploadId: queued.uploadId,
      code: "asset_import_network_error",
      detail: "Import failed.",
      at: "2026-08-11T12:00:00.000Z",
    })[0]
    addArticleUploadPlaceholder(current, {
      uploadId: failed.uploadId,
      pos: 0,
      filename: failed.filename,
      previewUrl: null,
      assetType: failed.assetType,
    })
    updateArticleUploadPlaceholder(current, failed)

    const actions = [...element.querySelectorAll("button")]
    expect(actions.map((button) => button.textContent)).toEqual(["重试", "移除"])
    actions[1].click()
    expect(onRemove).toHaveBeenCalledWith("url-upload-1")
    current.destroy()
    element.remove()
  })
})
