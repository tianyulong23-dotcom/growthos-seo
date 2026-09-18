import * as React from "react"

import { ApiError } from "@/api/client"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"

import {
  getRecommendationFeedStatus,
  listRecommendationFeed,
  type RecommendationFeedFilters,
  type RecommendationFeedResponse,
  type RecommendationFeedStatus,
} from "./recommendation-feed-api"
import {
  activateRecommendationFeedContext,
  recommendationFeedQueryKey,
  recommendationFeedStatusQueryKey,
} from "./recommendation-feed-cache"

export type RecommendationFeedLoadState =
  "loading" | "data" | "empty" | "forbidden" | "conflict" | "offline" | "error"

function loadErrorState(error: unknown): RecommendationFeedLoadState {
  if (isOutreachOffline()) return "offline"
  if (error instanceof ApiError && error.status === 403) return "forbidden"
  if (error instanceof ApiError && error.status === 409) return "conflict"
  return "error"
}

export function useRecommendationFeed(
  websiteProjectKey: string,
  actorScope: string,
  contextVersion: number,
  filters: RecommendationFeedFilters,
  cursor: string | null,
  enabled: boolean
) {
  const [data, setData] = React.useState<{
    key: ReturnType<typeof recommendationFeedQueryKey>
    value: RecommendationFeedResponse
  } | null>(null)
  const [state, setState] =
    React.useState<RecommendationFeedLoadState>("loading")
  const key = React.useMemo(
    () =>
      recommendationFeedQueryKey(
        websiteProjectKey,
        actorScope,
        contextVersion,
        filters,
        cursor
      ),
    [actorScope, contextVersion, cursor, filters, websiteProjectKey]
  )
  const [loadedKey, setLoadedKey] = React.useState<typeof key | null>(null)
  const selection = React.useRef<typeof key | null>(key)
  const requestId = React.useRef(0)
  React.useLayoutEffect(() => {
    selection.current = key
    return () => {
      selection.current = null
      requestId.current += 1
    }
  }, [key])

  const load = React.useCallback(
    async (foreground: boolean) => {
      if (selection.current !== key) return null
      const id = ++requestId.current
      if (foreground) setState("loading")
      activateRecommendationFeedContext(
        websiteProjectKey,
        actorScope,
        contextVersion
      )
      try {
        const result = await backlinksProjectQueries.fetch(key, (signal) =>
          listRecommendationFeed(websiteProjectKey, filters, cursor, signal)
        )
        if (selection.current !== key || requestId.current !== id) return null
        setLoadedKey(key)
        setData({ key, value: result })
        setState(result.items.length === 0 ? "empty" : "data")
        return result
      } catch (error) {
        if (selection.current !== key || requestId.current !== id) return null
        if (error instanceof DOMException && error.name === "AbortError") {
          return null
        }
        if (error instanceof ApiError && [403, 409].includes(error.status)) {
          setData(null)
        }
        setLoadedKey(key)
        setState(loadErrorState(error))
        return null
      }
    },
    [actorScope, contextVersion, cursor, filters, key, websiteProjectKey]
  )

  React.useEffect(() => {
    if (!enabled) return
    let active = true
    queueMicrotask(() => {
      if (active) void load(true)
    })
    return () => {
      active = false
      backlinksProjectQueries.invalidate(key)
    }
  }, [enabled, key, load])

  const refresh = React.useCallback(() => {
    backlinksProjectQueries.invalidate(key)
    return load(true)
  }, [key, load])

  const poll = React.useCallback(() => {
    backlinksProjectQueries.invalidate(key)
    return load(false)
  }, [key, load])

  return {
    response: data?.key === key ? data.value : null,
    state: loadedKey === key ? state : ("loading" as const),
    refresh,
    poll,
  }
}

export function useRecommendationFeedStatus(
  websiteProjectKey: string,
  actorScope: string,
  contextVersion: number,
  enabled: boolean
) {
  const [data, setData] = React.useState<{
    key: ReturnType<typeof recommendationFeedStatusQueryKey>
    value: RecommendationFeedStatus
  } | null>(null)
  const [state, setState] =
    React.useState<RecommendationFeedLoadState>("loading")
  const key = React.useMemo(
    () =>
      recommendationFeedStatusQueryKey(
        websiteProjectKey,
        actorScope,
        contextVersion
      ),
    [actorScope, contextVersion, websiteProjectKey]
  )
  const [loadedKey, setLoadedKey] = React.useState<typeof key | null>(null)
  const selection = React.useRef<typeof key | null>(key)
  const requestId = React.useRef(0)
  React.useLayoutEffect(() => {
    selection.current = key
    return () => {
      selection.current = null
      requestId.current += 1
    }
  }, [key])

  const load = React.useCallback(
    async (foreground: boolean) => {
      if (selection.current !== key) return null
      const id = ++requestId.current
      if (foreground) setState("loading")
      activateRecommendationFeedContext(
        websiteProjectKey,
        actorScope,
        contextVersion
      )
      try {
        const result = await backlinksProjectQueries.fetch(key, (signal) =>
          getRecommendationFeedStatus(websiteProjectKey, signal)
        )
        if (selection.current !== key || requestId.current !== id) return null
        setLoadedKey(key)
        setData({ key, value: result })
        setState("data")
        return result
      } catch (error) {
        if (selection.current !== key || requestId.current !== id) return null
        if (error instanceof DOMException && error.name === "AbortError") {
          return null
        }
        if (error instanceof ApiError && [403, 409].includes(error.status)) {
          setData(null)
        }
        setLoadedKey(key)
        setState(loadErrorState(error))
        return null
      }
    },
    [actorScope, contextVersion, key, websiteProjectKey]
  )

  React.useEffect(() => {
    if (!enabled) return
    let active = true
    queueMicrotask(() => {
      if (active) void load(true)
    })
    return () => {
      active = false
      backlinksProjectQueries.invalidate(key)
    }
  }, [enabled, key, load])

  const refresh = React.useCallback(() => {
    backlinksProjectQueries.invalidate(key)
    return load(true)
  }, [key, load])

  const poll = React.useCallback(() => {
    backlinksProjectQueries.invalidate(key)
    return load(false)
  }, [key, load])

  return {
    status: data?.key === key ? data.value : null,
    state: loadedKey === key ? state : ("loading" as const),
    refresh,
    poll,
  }
}
