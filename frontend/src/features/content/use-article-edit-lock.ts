import * as React from "react"

import {
  acquireArticleLock,
  forceReleaseArticleLock,
  getActiveArticleLock,
  releaseArticleLock,
  renewArticleLock,
  type ArticleLock,
  type ArticleLockCredential,
} from "@/api/articles"
import { ApiError } from "@/api/client"

const LEASE_SECONDS = 90
const RENEW_INTERVAL_MS = 30_000
const RENEW_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const LOCK_CONFLICT_CODES = new Set([
  "article_lock_already_held",
  "article_edit_lock_not_found",
  "article_lock_expired",
  "article_lock_stale_fence",
  "article_lock_type_mismatch",
])

export type ArticleEditLockStatus =
  "idle" | "acquiring" | "held" | "blocked" | "lost"

function lockCredential(lock: ArticleLock): ArticleLockCredential | null {
  if (!lock.token) return null
  return { lockId: lock.id, token: lock.token, fence: lock.fence }
}

function isImmediateRenewalFailure(error: unknown) {
  if (!(error instanceof ApiError)) return false
  if (error.status === 401 || error.status === 403) return true
  if (error.code && LOCK_CONFLICT_CODES.has(error.code)) return true
  return error.status >= 400 && error.status < 500 && !error.retryable
}

export function useArticleEditLock(input: {
  projectId: string
  articleId: string
  enabled: boolean
  onLost: () => void
}) {
  const { projectId, articleId, enabled, onLost } = input
  const [status, setStatus] = React.useState<ArticleEditLockStatus>("idle")
  const [lock, setLock] = React.useState<ArticleLock | null>(null)
  const [credential, setCredential] =
    React.useState<ArticleLockCredential | null>(null)
  const [error, setError] = React.useState("")
  const credentialRef = React.useRef<ArticleLockCredential | null>(null)
  const generationRef = React.useRef(0)
  const onLostRef = React.useRef(onLost)

  React.useEffect(() => {
    onLostRef.current = onLost
  }, [onLost])

  const applyCredential = React.useCallback(
    (next: ArticleLockCredential | null) => {
      credentialRef.current = next
      setCredential(next)
    },
    []
  )

  const markLost = React.useCallback(
    (message = "编辑锁已失效，当前编辑器已转为只读。") => {
      generationRef.current += 1
      applyCredential(null)
      setStatus("lost")
      setError(message)
      onLostRef.current()
    },
    [applyCredential]
  )

  const acquire = React.useCallback(async () => {
    if (!enabled) return false
    const generation = ++generationRef.current
    setStatus("acquiring")
    setError("")
    try {
      const acquired = await acquireArticleLock(projectId, articleId, {
        lock_type: "edit_lock",
        reason: "article_editor",
        lease_seconds: LEASE_SECONDS,
      })
      if (generation !== generationRef.current) return false
      const nextCredential = lockCredential(acquired)
      if (!nextCredential) throw new Error("编辑锁响应缺少凭证")
      setLock(acquired)
      applyCredential(nextCredential)
      setStatus("held")
      return true
    } catch (requestError) {
      if (generation !== generationRef.current) return false
      applyCredential(null)
      let activeLock: ArticleLock | null = null
      try {
        activeLock = await getActiveArticleLock(
          projectId,
          articleId,
          "edit_lock"
        )
      } catch {
        // Preserve the acquisition error when lock discovery is unavailable.
      }
      if (generation !== generationRef.current) return false
      setLock(activeLock)
      setStatus("blocked")
      setError(
        requestError instanceof ApiError &&
          requestError.code === "article_lock_already_held"
          ? "文章正在被其他成员编辑。"
          : requestError instanceof Error
            ? requestError.message
            : "无法获取编辑锁"
      )
      return false
    }
  }, [applyCredential, articleId, enabled, projectId])

  React.useEffect(() => {
    if (!enabled) {
      generationRef.current += 1
      let active = true
      queueMicrotask(() => {
        if (!active) return
        applyCredential(null)
        setLock(null)
        setStatus("idle")
        setError("")
      })
      return () => {
        active = false
      }
    }
    let active = true
    queueMicrotask(() => {
      if (active) void acquire()
    })
    const releaseCurrentLock = () => {
      const current = credentialRef.current
      if (!current) return
      applyCredential(null)
      void releaseArticleLock(projectId, articleId, current, "editor_closed", {
        keepalive: true,
      }).catch(() => undefined)
    }
    window.addEventListener("pagehide", releaseCurrentLock)
    return () => {
      active = false
      generationRef.current += 1
      window.removeEventListener("pagehide", releaseCurrentLock)
      releaseCurrentLock()
    }
  }, [acquire, applyCredential, articleId, enabled, projectId])

  React.useEffect(() => {
    if (status !== "held" || !credential || !lock) return
    let cancelled = false
    let timer: number | null = null
    let retryAttempt = 0
    const leaseExpiresAt = Date.parse(lock.expires_at)

    const schedule = (delayMs: number, callback: () => void) => {
      timer = window.setTimeout(callback, delayMs)
    }

    const loseAtLeaseBoundary = () => {
      const remainingMs = leaseExpiresAt - Date.now()
      if (!Number.isFinite(leaseExpiresAt) || remainingMs <= 0) {
        markLost("编辑锁租约已到期，当前编辑器已转为只读。")
        return
      }
      schedule(remainingMs, () => {
        if (!cancelled) {
          markLost("编辑锁租约已到期，当前编辑器已转为只读。")
        }
      })
    }

    const renew = () => {
      const current = credentialRef.current
      if (!current || cancelled) return
      void renewArticleLock(projectId, articleId, current, LEASE_SECONDS)
        .then((renewed) => {
          if (cancelled || credentialRef.current !== current) return
          setLock(renewed)
          applyCredential({
            lockId: renewed.id,
            token: current.token,
            fence: renewed.fence,
          })
        })
        .catch((requestError: unknown) => {
          if (cancelled || credentialRef.current !== current) return
          if (isImmediateRenewalFailure(requestError)) {
            markLost()
            return
          }
          const remainingMs = leaseExpiresAt - Date.now()
          const retryDelay =
            RENEW_RETRY_DELAYS_MS[
              Math.min(retryAttempt, RENEW_RETRY_DELAYS_MS.length - 1)
            ]
          retryAttempt += 1
          if (!Number.isFinite(leaseExpiresAt) || remainingMs <= retryDelay) {
            loseAtLeaseBoundary()
            return
          }
          schedule(retryDelay, renew)
        })
    }

    schedule(RENEW_INTERVAL_MS, renew)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [
    applyCredential,
    articleId,
    credential,
    lock,
    markLost,
    projectId,
    status,
  ])

  const forceRelease = React.useCallback(
    async (reason: string) => {
      if (!lock || !reason.trim()) return false
      await forceReleaseArticleLock(
        projectId,
        articleId,
        lock.id,
        reason.trim()
      )
      setLock(null)
      return acquire()
    },
    [acquire, articleId, lock, projectId]
  )

  return {
    status,
    lock,
    credential,
    error,
    acquire,
    forceRelease,
    markLost,
  }
}
