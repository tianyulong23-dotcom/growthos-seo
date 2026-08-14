import type { Editor } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import type { ArticleUploadTask } from "@/features/content/article-upload-queue"

export const articleUploadPlaceholderKey = new PluginKey<DecorationSet>(
  "articleUploadPlaceholder"
)

type PlaceholderAction =
  | {
      add: {
        uploadId: string
        pos: number
        filename: string
        previewUrl: string | null
        assetType: string
        side?: number
      }
    }
  | {
      update: {
        task: ArticleUploadTask
        groupProgress?: { completed: number; total: number }
      }
    }
  | { remove: { uploadIds: string[] } }

export type ArticleUploadPlaceholderHandlers = {
  onCancel?: (uploadId: string) => void
  onRemove?: (uploadId: string) => void
  onRetry?: (uploadId: string) => void
  onReselect?: (uploadId: string) => void
  onReplaceFile?: (uploadId: string) => void
}

function placeholderDom(
  input: Extract<PlaceholderAction, { add: unknown }>["add"],
  handlers: ArticleUploadPlaceholderHandlers,
  initialTask?: ArticleUploadTask,
  groupProgress?: { completed: number; total: number }
) {
  const wrapper = document.createElement("figure")
  wrapper.className = "article-upload-placeholder"
  wrapper.dataset.uploadId = input.uploadId
  wrapper.setAttribute("contenteditable", "false")
  wrapper.setAttribute("role", "status")
  wrapper.setAttribute("aria-live", "polite")

  const preview = document.createElement("div")
  preview.className = "article-upload-placeholder__preview"
  if (input.previewUrl && input.assetType === "image") {
    const image = document.createElement("img")
    image.src = input.previewUrl
    image.alt = ""
    preview.append(image)
  }
  const body = document.createElement("div")
  body.className = "article-upload-placeholder__body"
  const title = document.createElement("strong")
  title.textContent = input.filename
  const status = document.createElement("span")
  status.dataset.uploadStatus = ""
  status.textContent = "等待上传"
  const progress = document.createElement("progress")
  progress.max = 100
  progress.value = 0
  progress.dataset.uploadProgress = ""
  const actions = document.createElement("div")
  actions.className = "article-upload-placeholder__actions"
  actions.dataset.uploadActions = ""
  body.append(title, status, progress, actions)
  wrapper.append(preview, body)

  const button = (label: string, action: () => void) => {
    const element = document.createElement("button")
    element.type = "button"
    element.textContent = label
    element.addEventListener("click", action)
    return element
  }
  const renderActions = (task?: ArticleUploadTask) => {
    actions.replaceChildren()
    if (
      !task ||
      ["queued", "initializing", "uploading", "processing"].includes(
        task.status
      )
    ) {
      actions.append(button("取消", () => handlers.onCancel?.(input.uploadId)))
    } else if (task.status === "needs_file") {
      actions.append(
        button("重新选择文件", () => handlers.onReselect?.(input.uploadId))
      )
      actions.append(button("移除", () => handlers.onRemove?.(input.uploadId)))
    } else if (task.status === "failed") {
      actions.append(button("重试", () => handlers.onRetry?.(input.uploadId)))
      if (task.failureKind !== "placement" && task.source !== "url") {
        actions.append(
          button("更换文件", () => handlers.onReplaceFile?.(input.uploadId))
        )
      }
      actions.append(button("移除", () => handlers.onRemove?.(input.uploadId)))
    }
  }
  const updateTask = (task: ArticleUploadTask) => {
    const labels: Record<ArticleUploadTask["status"], string> = {
      queued: "等待上传",
      initializing: "正在校验文件",
      uploading: `正在上传 ${Math.round(task.progress)}%`,
      processing: "上传完成，正在处理",
      ready: "处理完成",
      failed: task.failureDetail || "上传失败",
      cancelled: "已取消",
      needs_file: "需要重新选择原文件",
    }
    const groupLabel = groupProgress
      ? `图库 ${groupProgress.completed}/${groupProgress.total} · `
      : ""
    status.textContent = `${groupLabel}${labels[task.status]}`
    progress.value = task.progress
    progress.hidden = !["initializing", "uploading", "processing"].includes(
      task.status
    )
    wrapper.dataset.status = task.status
    renderActions(task)
  }
  if (initialTask) {
    updateTask(initialTask)
  } else {
    renderActions()
  }
  return wrapper
}

export function articleUploadPlaceholderPlugin(
  handlers: ArticleUploadPlaceholderHandlers = {}
) {
  return new Plugin<DecorationSet>({
    key: articleUploadPlaceholderKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, current) {
        let decorations = current.map(transaction.mapping, transaction.doc)
        const action = transaction.getMeta(articleUploadPlaceholderKey) as
          PlaceholderAction | undefined
        if (action && "add" in action) {
          const element = placeholderDom(action.add, handlers)
          decorations = decorations.add(transaction.doc, [
            Decoration.widget(action.add.pos, element, {
              uploadId: action.add.uploadId,
              input: action.add,
              side: action.add.side ?? -1,
            }),
          ])
        }
        if (action && "update" in action) {
          for (const decoration of decorations.find(
            undefined,
            undefined,
            (spec) => spec.uploadId === action.update.task.uploadId
          )) {
            const input = decoration.spec.input as Extract<
              PlaceholderAction,
              { add: unknown }
            >["add"]
            decorations = decorations.remove([decoration])
            decorations = decorations.add(transaction.doc, [
              Decoration.widget(
                decoration.from,
                placeholderDom(
                  input,
                  handlers,
                  action.update.task,
                  action.update.groupProgress
                ),
                {
                  uploadId: action.update.task.uploadId,
                  input,
                  side: input.side ?? -1,
                }
              ),
            ])
          }
        }
        if (action && "remove" in action) {
          const uploadIds = new Set(action.remove.uploadIds)
          decorations = decorations.remove(
            decorations.find(undefined, undefined, (spec) =>
              uploadIds.has(spec.uploadId)
            )
          )
        }
        return decorations
      },
    },
    props: {
      decorations(state) {
        return (
          articleUploadPlaceholderKey.getState(state) ?? DecorationSet.empty
        )
      },
    },
  })
}

export function addArticleUploadPlaceholder(
  editor: Editor,
  input: Extract<PlaceholderAction, { add: unknown }>["add"]
) {
  editor.view.dispatch(
    editor.state.tr.setMeta(articleUploadPlaceholderKey, { add: input })
  )
}

export function updateArticleUploadPlaceholder(
  editor: Editor,
  task: ArticleUploadTask,
  groupProgress?: { completed: number; total: number }
) {
  editor.view.dispatch(
    editor.state.tr.setMeta(articleUploadPlaceholderKey, {
      update: { task, groupProgress },
    })
  )
}

export function removeArticleUploadPlaceholder(
  editor: Editor,
  uploadId: string
) {
  removeArticleUploadPlaceholders(editor, [uploadId])
}

export function removeArticleUploadPlaceholders(
  editor: Editor,
  uploadIds: string[]
) {
  editor.view.dispatch(
    editor.state.tr.setMeta(articleUploadPlaceholderKey, {
      remove: { uploadIds },
    })
  )
}

export function findArticleUploadPlaceholder(editor: Editor, uploadId: string) {
  const decorations = articleUploadPlaceholderKey.getState(editor.state)
  return decorations?.find(
    undefined,
    undefined,
    (spec) => spec.uploadId === uploadId
  )[0]?.from
}
