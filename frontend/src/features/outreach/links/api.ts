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
  getBacklinkProfile(websiteProjectKey, signal) {
    return requestBacklinks(
      "backlinksGetProfileV1",
      { path: { websiteProjectKey } },
      { signal }
    )
  },
  listBacklinkInventory(websiteProjectKey, input, signal) {
    return requestBacklinks(
      "backlinksListInventoryV1",
      {
        path: { websiteProjectKey },
        query: input,
      },
      { signal }
    )
  },
  requestBacklinkProfileSync(websiteProjectKey, idempotencyKey) {
    return requestBacklinks("backlinksRequestProfileSyncV1", {
      path: { websiteProjectKey },
      headers: { "idempotency-key": idempotencyKey },
    })
  },
  async getBacklinkProfileSyncJob(websiteProjectKey, jobId, signal) {
    const response = await requestBacklinks(
      "backlinksGetProfileSyncJobV1",
      { path: { websiteProjectKey, jobId } },
      { signal }
    )
    return response.job
  },
  importBacklinkInventoryItem(websiteProjectKey, input) {
    return requestBacklinks("backlinksImportInventoryItemV1", {
      path: { websiteProjectKey },
      body: input,
    })
  },
  updateBacklinkInventoryPolicy(websiteProjectKey, inventoryItemId, input) {
    return requestBacklinks("backlinksUpdateInventoryMonitoringPolicyV1", {
      path: { websiteProjectKey, inventoryItemId },
      body: input,
    })
  },
  requestBacklinkInventoryCheck(
    websiteProjectKey,
    inventoryItemId,
    idempotencyKey
  ) {
    return requestBacklinks("backlinksRequestInventoryCheckV1", {
      path: { websiteProjectKey, inventoryItemId },
      headers: { "idempotency-key": idempotencyKey },
    })
  },
  listBacklinkInventoryDirectObservations(
    websiteProjectKey,
    inventoryItemId,
    limit,
    signal
  ) {
    return requestBacklinks(
      "backlinksListInventoryDirectObservationsV1",
      {
        path: { websiteProjectKey, inventoryItemId },
        query: { limit },
      },
      { signal }
    )
  },
}

export const isLinksApiStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status
