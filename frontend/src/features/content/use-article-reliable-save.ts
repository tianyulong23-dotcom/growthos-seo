import * as React from "react"

import { ApiError } from "@/api/client"
import {
  saveArticleAutosave,
  type ArticleDocument,
  type ArticleLockCredential,
  type ArticleMetadataSnapshot,
} from "@/api/articles"
import {
  articleSnapshotHash,
  canonicalizeArticleDocument,
} from "@/features/content/article-document"
import {
  articleClientId,
  saveLocalArticleBackup,
} from "@/features/content/article-recovery"
import {
  articleSaveReducer,
  initialArticleSaveState,
} from "@/features/content/article-save-state"

const LOCAL_DELAY_MS = 1_000
const SERVER_DELAY_MS = 3_000
const MAX_AUTOSAVE_INTERVAL_MS = 30_000
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
const MAX_SEQUENCE_RESYNCS = 1
const ARTICLE_SEQUENCE_PREFIX = "seo:article-autosave-sequence:v1:"
const ARTICLE_LOCK_CONFLICT_CODES = new Set([
  "article_lock_already_held",
  "article_edit_lock_not_found",
  "article_lock_expired",
  "article_lock_stale_fence",
  "article_lock_type_mismatch",
])

type Snapshot = {
  document: ArticleDocument
  metadata: ArticleMetadataSnapshot
  hash: string
}

function sequenceStorageKey(
  projectId: string,
  articleId: string,
  clientId: string
) {
  return `${ARTICLE_SEQUENCE_PREFIX}${projectId}:${articleId}:${clientId}`
}

function loadClientSequence(key: string) {
  const value = Number.parseInt(sessionStorage.getItem(key) ?? "", 10)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function persistClientSequence(key: string, sequence: number) {
  sessionStorage.setItem(key, String(sequence))
}

export function useArticleReliableSave(input: {
  projectId: string
  articleId: string
  recoveryScope: string | null
  document: ArticleDocument | null
  metadata: ArticleMetadataSnapshot | null
  baselineHash: string
  baseVersionNumber: number
  baseReviewVersion: number
  lockCredential: ArticleLockCredential | null
  enabled: boolean
  onLockLost?: (error: ApiError) => void
}) {
  const {
    projectId,
    articleId,
    recoveryScope,
    document,
    metadata,
    baselineHash,
    baseVersionNumber,
    baseReviewVersion,
    lockCredential,
    enabled,
    onLockLost,
  } = input
  const [state, dispatch] = React.useReducer(
    articleSaveReducer,
    initialArticleSaveState(baselineHash)
  )
  const clientId = React.useMemo(
    () => articleClientId(projectId, articleId),
    [articleId, projectId]
  )
  const sequenceKey = React.useMemo(
    () => sequenceStorageKey(projectId, articleId, clientId),
    [articleId, clientId, projectId]
  )
  const sequenceKeyRef = React.useRef("")
  const sequenceRef = React.useRef(0)
  if (sequenceKeyRef.current !== sequenceKey) {
    sequenceKeyRef.current = sequenceKey
    sequenceRef.current = loadClientSequence(sequenceKey)
  }
  const snapshotRef = React.useRef<Snapshot | null>(null)
  const requestGenerationRef = React.useRef(0)
  const activeRequestRef = React.useRef<AbortController | null>(null)
  const localTimerRef = React.useRef<number | null>(null)
  const serverTimerRef = React.useRef<number | null>(null)
  const maxTimerRef = React.useRef<number | null>(null)
  const retryTimerRef = React.useRef<number | null>(null)
  const unauthorizedRef = React.useRef(false)
  const onLockLostRef = React.useRef(onLockLost)
  const protectLocallyRef = React.useRef<() => boolean>(() => false)
  const flushRef = React.useRef<
    (retryAttempt?: number, sequenceResyncAttempt?: number) => Promise<boolean>
  >(async () => false)

  const clearTimer = React.useCallback((ref: React.RefObject<number | null>) => {
    if (ref.current !== null) window.clearTimeout(ref.current)
    ref.current = null
  }, [])

  React.useEffect(() => {
    onLockLostRef.current = onLockLost
  }, [onLockLost])

  const protectLocally = React.useCallback(() => {
    const snapshot = snapshotRef.current
    if (!snapshot || !recoveryScope) return false
    if (snapshot.hash === baselineHash) return true
    const saved = saveLocalArticleBackup({
      id: crypto.randomUUID(),
      environment: location.origin,
      projectId,
      articleId,
      recoveryScope,
      clientId,
      sequence: sequenceRef.current,
      baseVersionNumber,
      baseReviewVersion,
      document: snapshot.document,
      metadata: snapshot.metadata,
      contentHash: snapshot.hash,
      createdAt: new Date().toISOString(),
    })
    if (saved) dispatch({ type: "local_saved", hash: snapshot.hash })
    return saved
  }, [
    articleId,
    baseReviewVersion,
    baseVersionNumber,
    baselineHash,
    clientId,
    projectId,
    recoveryScope,
  ])

  const flushAutosave = React.useCallback(
    async (retryAttempt = 0, sequenceResyncAttempt = 0): Promise<boolean> => {
      const snapshot = snapshotRef.current
      if (
        !enabled ||
        !lockCredential ||
        unauthorizedRef.current ||
        !snapshot
      )
        return false
      if (snapshot.hash === baselineHash) return true
      clearTimer(serverTimerRef)
      clearTimer(maxTimerRef)
      clearTimer(retryTimerRef)
      protectLocally()
      activeRequestRef.current?.abort()
      const controller = new AbortController()
      activeRequestRef.current = controller
      const generation = ++requestGenerationRef.current
      const sequence = sequenceRef.current + 1
      sequenceRef.current = sequence
      persistClientSequence(sequenceKey, sequence)
      dispatch({ type: "autosave_started" })
      try {
        const saved = await saveArticleAutosave(
          projectId,
          articleId,
          {
            client_id: clientId,
            sequence,
            base_version_number: baseVersionNumber,
            base_review_version: baseReviewVersion,
            document: snapshot.document,
            metadata: snapshot.metadata,
            content_hash: snapshot.hash,
            idempotency_key: `${clientId}:${sequence}:${snapshot.hash}`,
          },
          lockCredential,
          { signal: controller.signal }
        )
        if (
          generation === requestGenerationRef.current &&
          snapshotRef.current?.hash === snapshot.hash
        ) {
          sequenceRef.current = Math.max(
            sequenceRef.current,
            saved.accepted_sequence
          )
          persistClientSequence(sequenceKey, sequenceRef.current)
          dispatch({
            type: "autosave_succeeded",
            hash: snapshot.hash,
            autosaveId: saved.id,
            savedAt: saved.server_time,
          })
        }
        return true
      } catch (error) {
        if (controller.signal.aborted) return false
        if (error instanceof ApiError && error.status === 401) {
          unauthorizedRef.current = true
          dispatch({ type: "unauthorized" })
          return false
        }
        if (
          error instanceof ApiError &&
          error.code === "autosave_stale" &&
          error.acceptedSequence !== null &&
          sequenceResyncAttempt < MAX_SEQUENCE_RESYNCS &&
          snapshotRef.current?.hash === snapshot.hash
        ) {
          sequenceRef.current = Math.max(
            sequenceRef.current,
            error.acceptedSequence
          )
          persistClientSequence(sequenceKey, sequenceRef.current)
          return flushRef.current(retryAttempt, sequenceResyncAttempt + 1)
        }
        if (
          error instanceof ApiError &&
          error.code &&
          ARTICLE_LOCK_CONFLICT_CODES.has(error.code)
        ) {
          protectLocally()
          requestGenerationRef.current += 1
          activeRequestRef.current?.abort()
          clearTimer(serverTimerRef)
          clearTimer(maxTimerRef)
          clearTimer(retryTimerRef)
          dispatch({
            type: "conflict",
            error: "编辑锁已失效，服务器自动保存已停止，本地副本已保护。",
          })
          onLockLostRef.current?.(error)
          return false
        }
        if (error instanceof ApiError && error.status === 409) {
          dispatch({ type: "conflict", error: "服务器版本已变化，请先处理恢复或冲突。" })
          return false
        }
        const retryable =
          !(error instanceof ApiError) || error.status >= 500 || error.retryable
        if (
          retryable &&
          retryAttempt < RETRY_DELAYS_MS.length &&
          snapshotRef.current?.hash === snapshot.hash
        ) {
          retryTimerRef.current = window.setTimeout(
            () => void flushRef.current(retryAttempt + 1, sequenceResyncAttempt),
            RETRY_DELAYS_MS[retryAttempt]
          )
        } else {
          dispatch({
            type: "autosave_failed",
            error: error instanceof Error ? error.message : "自动保存失败",
          })
        }
        return false
      }
    },
    [
      articleId,
      baseReviewVersion,
      baseVersionNumber,
      baselineHash,
      clearTimer,
      clientId,
      enabled,
      lockCredential,
      projectId,
      protectLocally,
      sequenceKey,
    ]
  )

  React.useEffect(() => {
    protectLocallyRef.current = protectLocally
  }, [protectLocally])

  React.useEffect(() => {
    flushRef.current = flushAutosave
  }, [flushAutosave])

  React.useEffect(() => {
    if (enabled && lockCredential) return
    requestGenerationRef.current += 1
    activeRequestRef.current?.abort()
    clearTimer(serverTimerRef)
    clearTimer(maxTimerRef)
    clearTimer(retryTimerRef)
  }, [clearTimer, enabled, lockCredential])

  React.useEffect(() => {
    let cancelled = false
    if (!document || !metadata) return
    const canonicalDocument = canonicalizeArticleDocument(document)
    void articleSnapshotHash(canonicalDocument, metadata).then((hash) => {
      if (cancelled) return
      snapshotRef.current = {
        document: canonicalDocument,
        metadata: structuredClone(metadata),
        hash,
      }
      dispatch({ type: "changed", hash, baselineHash })
      clearTimer(localTimerRef)
      clearTimer(serverTimerRef)
      if (!enabled || hash === baselineHash) {
        clearTimer(maxTimerRef)
        return
      }
      localTimerRef.current = window.setTimeout(protectLocally, LOCAL_DELAY_MS)
      serverTimerRef.current = window.setTimeout(
        () => void flushAutosave(),
        SERVER_DELAY_MS
      )
      if (maxTimerRef.current === null) {
        maxTimerRef.current = window.setTimeout(
          () => void flushAutosave(),
          MAX_AUTOSAVE_INTERVAL_MS
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    clearTimer,
    flushAutosave,
    baselineHash,
    document,
    enabled,
    metadata,
    protectLocally,
  ])

  React.useEffect(
    () => () => {
      clearTimer(localTimerRef)
      clearTimer(serverTimerRef)
      clearTimer(maxTimerRef)
      clearTimer(retryTimerRef)
      protectLocallyRef.current()
      activeRequestRef.current?.abort()
    }, [clearTimer]
  )

  const invalidateRequests = React.useCallback(() => {
    requestGenerationRef.current += 1
    activeRequestRef.current?.abort()
    clearTimer(serverTimerRef)
    clearTimer(maxTimerRef)
    clearTimer(retryTimerRef)
  }, [clearTimer])

  return {
    state,
    clientId,
    getCurrentHash: () => snapshotRef.current?.hash ?? baselineHash,
    protectLocally,
    flushAutosave,
    invalidateRequests,
    reset(hash: string) {
      unauthorizedRef.current = false
      dispatch({ type: "reset", hash })
    },
    markManualSaved(hash: string, hasNewerChanges: boolean) {
      dispatch({ type: "manual_saved", hash, hasNewerChanges })
    },
  }
}
