import { useEffect } from "react"

import {
  observeRecommendationFeed,
  type RecommendationFeedResponse,
} from "./recommendation-feed-api"

export function useRecommendationFeedObservation(
  projectId: string,
  generation: RecommendationFeedResponse["latestGeneration"] | null
) {
  const generationContractId = generation?.generationContractId
  const observedState = generation
    ? [
        generation.jobState,
        generation.discoveryResult,
        generation.contactPreparation,
        generation.releaseResult,
      ].join("|")
    : null

  useEffect(() => {
    if (!generationContractId || !observedState) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    let recorded = false
    let attempts = 0
    let clientObservedAt: string | undefined

    const observe = () => {
      if (
        document.visibilityState !== "visible" ||
        controller.signal.aborted ||
        pending ||
        recorded ||
        attempts >= 3
      ) return
      clientObservedAt ??= new Date().toISOString()
      pending = true
      attempts += 1
      void observeRecommendationFeed(
        projectId,
        { generationContractId, observedState, clientObservedAt },
        controller.signal
      ).then(() => {
        recorded = true
      }).catch(() => {
        // Telemetry failure cannot block the product or start discovery.
        if (!controller.signal.aborted && attempts < 3) {
          timer = setTimeout(observe, 5_000)
        }
      }).finally(() => {
        pending = false
      })
    }
    observe()
    document.addEventListener("visibilitychange", observe)
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", observe)
    }
  }, [projectId, generationContractId, observedState])
}
