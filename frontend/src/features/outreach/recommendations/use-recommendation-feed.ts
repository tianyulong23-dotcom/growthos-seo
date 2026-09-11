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
  const [response, setResponse] =
    React.useState<RecommendationFeedResponse | null>(null)
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

  const load = React.useCallback(
    async (foreground: boolean) => {
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
        setResponse(result)
        setState(result.items.length === 0 ? "empty" : "data")
        return result
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return null
        }
        setResponse(null)
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

  return { response, state, refresh, poll }
}

export function useRecommendationFeedStatus(
  websiteProjectKey: string,
  actorScope: string,
  contextVersion: number,
  enabled: boolean
) {
  const [status, setStatus] = React.useState<RecommendationFeedStatus | null>(
    null
  )
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

  const load = React.useCallback(
    async (foreground: boolean) => {
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
        setStatus(result)
        setState("data")
        return result
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return null
        }
        setStatus(null)
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

  return { status, state, refresh, poll }
}
