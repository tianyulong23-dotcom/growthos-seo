import { ApiError, apiRequest } from "@/api/client"

import type {
  CandidateLinkDetail,
  LifecycleEventsPage,
  LinksClient,
  LinksPage,
  PlacementEvidence,
  PlacementLinkDetail,
  PlacementReverifyResult,
} from "./types"

const pathFor = (websiteProjectKey: string, suffix = "") =>
  `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/links${suffix}`

export const linksApi: LinksClient = {
  async listLinks(websiteProjectKey, input) {
    const params = new URLSearchParams({
      view: input.view,
      limit: String(input.limit),
    })
    if (input.cursor) params.set("cursor", input.cursor)

    return apiRequest<LinksPage>(
      `${pathFor(websiteProjectKey)}?${params.toString()}`
    )
  },
  async getCandidateLink(websiteProjectKey, candidateId) {
    const response = await apiRequest<{ link: CandidateLinkDetail }>(
      pathFor(
        websiteProjectKey,
        `/candidates/${encodeURIComponent(candidateId)}`
      )
    )
    return response.link
  },
  async getPlacementLink(websiteProjectKey, placementId) {
    const response = await apiRequest<{ link: PlacementLinkDetail }>(
      pathFor(
        websiteProjectKey,
        `/placements/${encodeURIComponent(placementId)}`
      )
    )
    return response.link
  },
  async listPlacementEvents(websiteProjectKey, placementId, input) {
    const params = new URLSearchParams({ limit: String(input.limit) })
    if (input.cursor) params.set("cursor", input.cursor)

    return apiRequest<LifecycleEventsPage>(
      `${pathFor(
        websiteProjectKey,
        `/placements/${encodeURIComponent(placementId)}/events`
      )}?${params.toString()}`
    )
  },
  async getPlacementEvidence(websiteProjectKey, evidenceId) {
    const response = await apiRequest<{ evidence: PlacementEvidence }>(
      pathFor(websiteProjectKey, `/evidence/${encodeURIComponent(evidenceId)}`)
    )
    return response.evidence
  },
  reverifyPlacement(websiteProjectKey, placementId, input) {
    return apiRequest<PlacementReverifyResult>(
      pathFor(
        websiteProjectKey,
        `/placements/${encodeURIComponent(placementId)}/reverify`
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ expectedVersion: input.expectedVersion }),
      }
    )
  },
}

export const isLinksApiStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status
