import * as React from "react"

import { getArticleRun, type ArticleRun } from "@/api/articles"

const ACTIVE_STATUSES = new Set(["queued", "running"])

type ArticleRunPollingOptions = {
  projectId: string
  articleId: string
  run: ArticleRun | null
  onRunChange: (run: ArticleRun) => void
  onError: (message: string) => void
  onTerminal: (run: ArticleRun) => void | Promise<unknown>
  fetchRun?: typeof getArticleRun
  intervalMs?: number
}

export function useArticleRunPolling({
  projectId,
  articleId,
  run,
  onRunChange,
  onError,
  onTerminal,
  fetchRun = getArticleRun,
  intervalMs = 1500,
}: ArticleRunPollingOptions) {
  const selectionKey = `${projectId}:${articleId}`
  const selectionKeyRef = React.useRef(selectionKey)
  React.useLayoutEffect(() => {
    selectionKeyRef.current = selectionKey
  }, [selectionKey])

  React.useEffect(() => {
    if (!run || !ACTIVE_STATUSES.has(run.status)) return

    let active = true
    let timer: number
    let polling = true
    const poll = async () => {
      try {
        const nextRun = await fetchRun(projectId, articleId)
        if (!active || selectionKeyRef.current !== selectionKey) return
        polling = ACTIVE_STATUSES.has(nextRun.status)
        onRunChange(nextRun)
        onError("")
        if (!ACTIVE_STATUSES.has(nextRun.status)) {
          await onTerminal(nextRun)
        }
      } catch (error) {
        if (!active || selectionKeyRef.current !== selectionKey) return
        onError(error instanceof Error ? error.message : "读取文章生成进度失败")
      } finally {
        if (active && polling && selectionKeyRef.current === selectionKey) {
          timer = window.setTimeout(() => void poll(), intervalMs)
        }
      }
    }
    timer = window.setTimeout(() => void poll(), intervalMs)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [
    articleId,
    fetchRun,
    intervalMs,
    onError,
    onRunChange,
    onTerminal,
    projectId,
    run,
    selectionKey,
  ])
}
