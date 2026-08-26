import { useCallback, useEffect, useMemo, useState } from "react"

import { ApiError } from "@/api/client"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"

import { listRecommendations, type RecommendationItem } from "./api"

export type RecommendationsState =
  "loading" | "data" | "empty" | "forbidden" | "conflict" | "offline" | "error"
export type RecommendationPresentationState = "current" | "legacy_stale"

export function useRecommendations(
  websiteProjectKey: string,
  enabled: boolean
) {
  const [items, setItems] = useState<readonly RecommendationItem[]>([])
  const [presentationState, setPresentationState] =
    useState<RecommendationPresentationState>("current")
  const [status, setStatus] = useState<RecommendationsState>("loading")
  const key = useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "recommendations",
        "active-pool"
      ),
    [websiteProjectKey]
  )

  const load = useCallback(async (foreground: boolean) => {
    if (foreground) setStatus("loading")
    try {
      const response = await backlinksProjectQueries.fetch(key, (signal) =>
        listRecommendations(websiteProjectKey, signal)
      )
      setItems(response.items)
      setPresentationState(response.presentationState)
      setStatus(response.items.length === 0 ? "empty" : "data")
      return response.items
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null
      }
      setItems([])
      setPresentationState("current")
      setStatus(
        isOutreachOffline()
          ? "offline"
          : error instanceof ApiError && error.status === 403
            ? "forbidden"
            : error instanceof ApiError && error.status === 409
              ? "conflict"
              : "error"
      )
      return null
    }
  }, [key, websiteProjectKey])

  useEffect(() => {
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

  const refresh = useCallback(() => {
    backlinksProjectQueries.invalidate(key)
    return load(true)
  }, [key, load])

  const poll = useCallback(() => {
    backlinksProjectQueries.invalidate(key)
    return load(false)
  }, [key, load])

  return { items, presentationState, status, refresh, poll }
}
