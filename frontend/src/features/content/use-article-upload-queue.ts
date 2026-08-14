import * as React from "react"

import { cancelAsset, type AssetType, type ContentAsset } from "@/api/assets"
import type { ArticleRequestOptions } from "@/api/articles"
import {
  articleUploadReducer,
  articleUploadStorageKey,
  createArticleLibraryTask,
  createArticleUploadTask,
  createArticleUrlUploadTask,
  fileMatchesUploadTask,
  isArticleUploadReadyFailure,
  parseArticleUploadTasks,
  serializeArticleUploadTasks,
  type ArticleUploadSource,
  type ArticleUploadIntent,
  type ArticleUploadReadyResult,
  type ArticleUploadTask,
} from "@/features/content/article-upload-queue"
import {
  executeArticleFileUpload,
  executeArticleUrlImport,
  resumeArticleAssetProcessing,
  uploadErrorDetails,
} from "@/features/content/article-upload-executor"

export type EnqueueArticleFile = {
  file: File
  source: Exclude<ArticleUploadSource, "url" | "library">
  assetType?: AssetType
  previewUrl?: string | null
  uploadId?: string
  intent: ArticleUploadIntent
}

function inferAssetType(file: File): AssetType {
  if (file.type.startsWith("image/")) return "image"
  if (file.type.startsWith("video/")) return "video"
  if (file.type.startsWith("audio/")) return "audio"
  return "file"
}

export function useArticleUploadQueue({
  projectId,
  articleId,
  requestOptions,
  onReady,
}: {
  projectId: string
  articleId: string
  requestOptions?: Omit<ArticleRequestOptions, "signal">
  onReady: (task: ArticleUploadTask, asset: ContentAsset) => ArticleUploadReadyResult
}) {
  const [tasks, dispatch] = React.useReducer(articleUploadReducer, [])
  const files = React.useRef(new Map<string, File>())
  const controllers = React.useRef(new Map<string, AbortController>())
  const taskSnapshot = React.useRef(tasks)
  const running = React.useRef(new Set<string>())
  const readyCallback = React.useRef(onReady)
  const storageKey = articleUploadStorageKey(projectId, articleId)

  React.useEffect(() => {
    taskSnapshot.current = tasks
  }, [tasks])

  React.useEffect(() => {
    readyCallback.current = onReady
  }, [onReady])

  const applyReadyTask = React.useCallback(
    (task: ArticleUploadTask, asset: ContentAsset) => {
      const result = readyCallback.current(task, asset)
      if (Array.isArray(result)) {
        result.forEach((uploadId) => dispatch({ type: "remove", uploadId }))
      } else if (isArticleUploadReadyFailure(result)) {
        dispatch({
          type: "failed",
          uploadId: task.uploadId,
          code: result.failure.code,
          detail: result.failure.detail,
          at: new Date().toISOString(),
        })
      }
      return result
    },
    []
  )

  React.useEffect(() => {
    dispatch({
      type: "restore",
      tasks: parseArticleUploadTasks(
        localStorage.getItem(storageKey),
        projectId,
        articleId
      ),
      at: new Date().toISOString(),
    })
  }, [articleId, projectId, storageKey])

  React.useEffect(() => {
    localStorage.setItem(storageKey, serializeArticleUploadTasks(tasks))
  }, [storageKey, tasks])

  React.useEffect(
    () => () => {
      controllers.current.forEach((controller) => controller.abort())
      for (const task of taskSnapshot.current) {
        if (task.previewUrl) URL.revokeObjectURL(task.previewUrl)
      }
    },
    []
  )

  React.useEffect(() => {
    for (const task of tasks) {
      if (!["queued", "processing"].includes(task.status)) continue
      if (running.current.has(task.uploadId)) continue
      const file = files.current.get(task.uploadId)
      if (task.status === "queued" && task.source !== "url" && !file) {
        dispatch({
          type: "retry",
          uploadId: task.uploadId,
          fileAvailable: false,
          at: new Date().toISOString(),
        })
        continue
      }
      const controller = new AbortController()
      controllers.current.set(task.uploadId, controller)
      running.current.add(task.uploadId)
      const options = { ...requestOptions, signal: controller.signal }
      if (task.status === "queued") {
        dispatch({
          type: "initializing",
          uploadId: task.uploadId,
          at: new Date().toISOString(),
        })
      }
      const run =
        task.status === "processing"
          ? resumeArticleAssetProcessing(task, options)
          : task.source === "url" && task.sourceUrl
            ? executeArticleUrlImport(
                task,
                task.sourceUrl,
                {
                  onSessionStarted: (assetId) =>
                    dispatch({
                      type: "session_started",
                      uploadId: task.uploadId,
                      assetId,
                      at: new Date().toISOString(),
                    }),
                  onProcessing: (asset) =>
                    dispatch({
                      type: "processing",
                      uploadId: task.uploadId,
                      asset,
                      at: new Date().toISOString(),
                    }),
                },
                options
              )
            : executeArticleFileUpload(
                task,
                file!,
                {
                  onSessionStarted: (assetId) =>
                    dispatch({
                      type: "session_started",
                      uploadId: task.uploadId,
                      assetId,
                      at: new Date().toISOString(),
                    }),
                  onProgress: (uploadedBytes, totalBytes) =>
                    dispatch({
                      type: "progress",
                      uploadId: task.uploadId,
                      uploadedBytes,
                      totalBytes,
                      at: new Date().toISOString(),
                    }),
                  onProcessing: (asset) =>
                    dispatch({
                      type: "processing",
                      uploadId: task.uploadId,
                      asset,
                      at: new Date().toISOString(),
                    }),
                },
                options
              )
      void run
        .then((asset) => {
          dispatch({
            type: "ready",
            uploadId: task.uploadId,
            asset,
            at: new Date().toISOString(),
          })
          applyReadyTask(task, asset)
          files.current.delete(task.uploadId)
          if (task.previewUrl) URL.revokeObjectURL(task.previewUrl)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          const details = uploadErrorDetails(error)
          dispatch({
            type: "failed",
            uploadId: task.uploadId,
            code: details.code,
            detail: details.detail,
            at: new Date().toISOString(),
          })
        })
        .finally(() => {
          running.current.delete(task.uploadId)
          controllers.current.delete(task.uploadId)
        })
    }
  }, [applyReadyTask, requestOptions, tasks])

  const enqueueFiles = React.useCallback(
    (inputs: EnqueueArticleFile[]) =>
      inputs.map((input) => {
        const previewUrl =
          input.previewUrl ??
          (input.file.type.startsWith("image/")
            ? URL.createObjectURL(input.file)
            : null)
        const task = createArticleUploadTask({
          projectId,
          articleId,
          source: input.source,
          assetType: input.assetType ?? inferAssetType(input.file),
          file: input.file,
          previewUrl,
          uploadId: input.uploadId,
          intent: input.intent,
        })
        files.current.set(task.uploadId, input.file)
        dispatch({ type: "enqueue", task })
        return task
      }),
    [articleId, projectId]
  )

  const cancel = React.useCallback(
    async (uploadId: string) => {
      const task = tasks.find((item) => item.uploadId === uploadId)
      controllers.current.get(uploadId)?.abort()
      if (task?.assetId) {
        try {
          await cancelAsset(projectId, task.assetId, requestOptions)
        } catch {
          // The local task is still cancelled when the remote session already ended.
        }
      }
      files.current.delete(uploadId)
      if (task?.previewUrl) URL.revokeObjectURL(task.previewUrl)
      dispatch({ type: "cancelled", uploadId, at: new Date().toISOString() })
    },
    [projectId, requestOptions, tasks]
  )

  const retry = React.useCallback(
    (uploadId: string) => {
      const task = taskSnapshot.current.find((item) => item.uploadId === uploadId)
      if (task?.failureKind === "placement" && task.asset) {
        dispatch({
          type: "ready",
          uploadId,
          asset: task.asset,
          at: new Date().toISOString(),
        })
        applyReadyTask(task, task.asset)
        return
      }
      dispatch({
        type: "retry",
        uploadId,
        fileAvailable: files.current.has(uploadId),
        at: new Date().toISOString(),
      })
    },
    [applyReadyTask]
  )

  const attachFile = React.useCallback(
    (uploadId: string, file: File) => {
      const task = tasks.find((item) => item.uploadId === uploadId)
      if (!task || !fileMatchesUploadTask(file, task)) return false
      files.current.set(uploadId, file)
      retry(uploadId)
      return true
    },
    [retry, tasks]
  )

  const replaceFile = React.useCallback(
    (uploadId: string, file: File) => {
      const previous = tasks.find((item) => item.uploadId === uploadId)
      if (!previous) return null
      controllers.current.get(uploadId)?.abort()
      controllers.current.delete(uploadId)
      running.current.delete(uploadId)
      files.current.delete(uploadId)
      if (previous.previewUrl) URL.revokeObjectURL(previous.previewUrl)
      if (previous.assetId) {
        void cancelAsset(projectId, previous.assetId, requestOptions).catch(
          () => {
            // A failed or completed remote session may no longer be cancellable.
          }
        )
      }
      const previewUrl = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : null
      const replacement = createArticleUploadTask({
        projectId,
        articleId,
        source: "replace",
        assetType: previous.assetType,
        file,
        previewUrl,
        intent: previous.intent,
      })
      files.current.set(replacement.uploadId, file)
      dispatch({ type: "remove", uploadId })
      dispatch({ type: "enqueue", task: replacement })
      return replacement
    },
    [articleId, projectId, requestOptions, tasks]
  )

  const enqueueUrl = React.useCallback(
    (sourceUrl: string, assetType: AssetType, intent: ArticleUploadIntent) => {
      const task = createArticleUrlUploadTask({
        projectId,
        articleId,
        sourceUrl,
        assetType,
        intent,
      })
      dispatch({ type: "enqueue", task })
      return task
    },
    [articleId, projectId]
  )

  const chooseLibraryAsset = React.useCallback(
    (asset: ContentAsset, intent: ArticleUploadIntent, uploadId?: string) => {
      const task = createArticleLibraryTask({
        projectId,
        articleId,
        asset,
        intent,
        uploadId,
      })
      dispatch({ type: "enqueue", task })
      applyReadyTask(task, asset)
      return task
    },
    [applyReadyTask, articleId, projectId]
  )

  const discardReady = React.useCallback((uploadId: string) => {
    const task = taskSnapshot.current.find((item) => item.uploadId === uploadId)
    files.current.delete(uploadId)
    if (task?.previewUrl) URL.revokeObjectURL(task.previewUrl)
    dispatch({ type: "remove", uploadId })
  }, [])

  return {
    tasks,
    enqueueFiles,
    enqueueUrl,
    chooseLibraryAsset,
    cancel,
    retry,
    attachFile,
    replaceFile,
    applyReadyTask,
    discardReady,
  }
}
