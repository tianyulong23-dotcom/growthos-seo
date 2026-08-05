import { ApiError } from "@/api/client"
import { requestBacklinks } from "@/api/generated/backlinks"

import type { LinksClient } from "./types"

export const linksApi: LinksClient = {
  listOpportunities(websiteProjectKey, signal) {
    return requestBacklinks(
      "backlinksListOpportunitiesV1",
      {
        path: { websiteProjectKey },
        query: { managementStatus: "ACTIVE", limit: 100 },
      },
      { signal }
    )
  },
  createPlacementCandidate(websiteProjectKey, input) {
    const { idempotencyKey, ...body } = input
    return requestBacklinks("backlinksCreatePlacementCandidateV1", {
      path: { websiteProjectKey },
      headers: { "idempotency-key": idempotencyKey },
      body,
    })
  },
  listLinks(websiteProjectKey, input, signal) {
    return requestBacklinks(
      "backlinksListLinksV1",
      {
        path: { websiteProjectKey },
        query: input,
      },
      { signal }
    )
  },
  async getCandidateLink(websiteProjectKey, candidateId, signal) {
    const response = await requestBacklinks(
      "backlinksGetCandidateLinkV1",
      { path: { websiteProjectKey, candidateId } },
      { signal }
    )
    return response.link
  },
  async getPlacementLink(websiteProjectKey, placementId, signal) {
    const response = await requestBacklinks(
      "backlinksGetPlacementLinkV1",
      { path: { websiteProjectKey, placementId } },
      { signal }
    )
    return response.link
  },
  listPlacementEvents(websiteProjectKey, placementId, input, signal) {
    return requestBacklinks(
      "backlinksListPlacementLifecycleEventsV1",
      {
        path: { websiteProjectKey, placementId },
        query: input,
      },
      { signal }
    )
  },
  async getPlacementEvidence(websiteProjectKey, evidenceId, signal) {
    const response = await requestBacklinks(
      "backlinksGetPlacementEvidenceV1",
      { path: { websiteProjectKey, evidenceId } },
      { signal }
    )
    return response.evidence
  },
  reverifyPlacement(websiteProjectKey, placementId, input) {
    return requestBacklinks("backlinksReverifyPlacementV1", {
      path: { websiteProjectKey, placementId },
      headers: { "idempotency-key": input.idempotencyKey },
      body: { expectedVersion: input.expectedVersion },
    })
  },
}

export const isLinksApiStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status
