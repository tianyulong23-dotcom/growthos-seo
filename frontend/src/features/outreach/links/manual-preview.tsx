import { createRoot } from "react-dom/client"

import { ApiError } from "@/api/client"
import "@/index.css"

import { LinksWorkspace } from "./links-workspace"
import type {
  CandidateLinkDetail,
  LifecycleEventsPage,
  LinkListItem,
  LinksClient,
  PlacementEvidence,
  PlacementLinkDetail,
} from "./types"

const scenario = new URLSearchParams(window.location.search).get("scenario")
const hash = (value: string) => value.repeat(64)

const candidate: CandidateLinkDetail = {
  recordType: "candidate",
  displayState: "candidate",
  candidateId: "11111111-1111-4111-8111-111111111111",
  sourcePageUrl: "https://publisher.example/resources",
  targetUrl: "https://client.example/product",
  candidateStatus: "PENDING",
  matchStatus: "MATCHED",
  validationStatus: "PENDING",
  version: 3,
  createdAt: "2026-07-29T01:00:00.000Z",
  countsTowardKpi: false,
  opportunityId: "22222222-2222-4222-8222-222222222222",
  normalizedSourceUrl: "https://publisher.example/resources",
  normalizedTargetUrl: "https://client.example/product",
  urlNormalizationVersion: "url-normalization.v1",
  latestValidation: {
    validationRunId: "33333333-3333-4333-8333-333333333333",
    status: "PENDING",
    observedAt: "2026-07-29T01:05:00.000Z",
    evidenceSnapshotHash: hash("a"),
    evidenceContractVersion: "placement.validation-evidence.v1",
    evidenceSchemaVersion: 1,
  },
}

const candidatePageTwo: LinkListItem = {
  ...candidate,
  candidateId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-07-28T01:00:00.000Z",
}

const confirmed: PlacementLinkDetail = {
  recordType: "placement",
  displayState: "confirmed",
  placementId: "55555555-5555-4555-8555-555555555555",
  candidateId: candidate.candidateId,
  sourcePageUrl: "https://publisher.example/resources",
  targetUrl: "https://client.example/product",
  initialValidationStatus: "PASSED",
  healthStatus: "healthy",
  monitoringStatus: "enabled",
  version: 4,
  createdAt: "2026-07-27T01:00:00.000Z",
  countsTowardKpi: true,
  opportunityId: candidate.opportunityId!,
  normalizedSourceUrl: "https://publisher.example/resources",
  normalizedTargetUrl: "https://client.example/product",
  urlNormalizationVersion: "url-normalization.v1",
  updatedAt: "2026-07-29T01:10:00.000Z",
  initialValidation: {
    validationRunId: "66666666-6666-4666-8666-666666666666",
    status: "PASSED",
    evidenceSnapshotHash: hash("b"),
    evidenceContractVersion: "placement.validation-evidence.v1",
    evidenceSchemaVersion: 1,
  },
  latestObservation: {
    observationId: "77777777-7777-4777-8777-777777777777",
    result: "present",
    observedAt: "2026-07-29T01:10:00.000Z",
    executionMode: "static",
    evidence: {
      evidenceId: "77777777-7777-4777-8777-777777777777",
      hash: hash("c"),
      contractVersion: "placement.observation-evidence.v1",
      schemaVersion: 1,
      freshness: "stale",
    },
    failure: { status: "none", code: null },
  },
  latestMonitorRun: {
    monitorRunId: "88888888-8888-4888-8888-888888888888",
    status: "running",
    scheduledFor: "2026-07-29T01:10:00.000Z",
    updatedAt: "2026-07-29T01:11:00.000Z",
  },
}

const changed: LinkListItem = {
  ...confirmed,
  displayState: "changed",
  placementId: "99999999-9999-4999-8999-999999999999",
  healthStatus: "changed",
}

const lost: LinkListItem = {
  ...confirmed,
  displayState: "lost",
  placementId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  healthStatus: "lost",
}

const recovered: LinkListItem = {
  ...confirmed,
  displayState: "recovered",
  placementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
}

const events: LifecycleEventsPage = {
  items: [
    {
      eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      eventType: "placement.recovered",
      occurredAt: "2026-07-29T00:55:00.000Z",
      placementVersion: 4,
      previousHealthStatus: "lost",
      nextHealthStatus: "healthy",
      observationId: confirmed.latestObservation!.observationId,
      reason: "static monitor observed the link again",
    },
    {
      eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      eventType: "placement.lost",
      occurredAt: "2026-07-28T00:55:00.000Z",
      placementVersion: 3,
      previousHealthStatus: "healthy",
      nextHealthStatus: "lost",
      observationId: null,
      reason: "static monitor reported absence",
    },
  ],
  hasMore: false,
  nextCursor: null,
}

const evidence: PlacementEvidence = {
  evidenceId: confirmed.latestObservation!.evidence.evidenceId,
  placementId: confirmed.placementId,
  kind: "placement_observation",
  immutable: true,
  hashVerified: true,
  hash: confirmed.latestObservation!.evidence.hash,
  contractVersion: "placement.observation-evidence.v1",
  schemaVersion: 1,
  observedAt: confirmed.latestObservation!.observedAt,
  executionMode: "static",
  result: "present",
  reasonCode: null,
  failure: { status: "none", code: null },
  freshness: "stale",
  source: {
    sourcePageUrl: confirmed.sourcePageUrl,
    targetUrl: confirmed.targetUrl,
    fetchMode: "static",
    httpStatus: 200,
    finalUrl: confirmed.sourcePageUrl,
    contentType: "text/html",
    fetchedAt: confirmed.latestObservation!.observedAt,
  },
  link: {
    canonicalUrl: confirmed.sourcePageUrl,
    noindex: false,
    occurrenceCount: 1,
  },
}

const errorFor = (name: string) => {
  if (scenario === name) {
    const status = name.endsWith("forbidden") ? 403 : name.endsWith("conflict") ? 409 : 500
    throw new ApiError(status, `Preview ${name}`)
  }
}

const previewClient: LinksClient = {
  async listLinks(_websiteProjectKey, input) {
    errorFor("list-forbidden")
    errorFor("list-conflict")
    errorFor("list-error")
    if (scenario === "empty") return { items: [], hasMore: false, nextCursor: null }
    if (input.view === "candidate") {
      return input.cursor === "candidate-page-2"
        ? { items: [candidatePageTwo], hasMore: false, nextCursor: null }
        : { items: [candidate], hasMore: true, nextCursor: "candidate-page-2" }
    }
    if (input.view === "confirmed") return { items: [confirmed], hasMore: false, nextCursor: null }
    if (input.view === "changed") return { items: [changed], hasMore: false, nextCursor: null }
    if (input.view === "lost") return { items: [lost], hasMore: false, nextCursor: null }
    if (input.view === "recovered") return { items: [recovered], hasMore: false, nextCursor: null }
    return { items: [], hasMore: false, nextCursor: null }
  },
  async getCandidateLink() {
    return candidate
  },
  async getPlacementLink(_websiteProjectKey, placementId) {
    errorFor("detail-forbidden")
    errorFor("detail-conflict")
    return placementId === confirmed.placementId
      ? confirmed
      : {
          ...confirmed,
          placementId,
          displayState: placementId === changed.placementId ? "changed" : "confirmed",
          healthStatus: placementId === changed.placementId ? "changed" : "healthy",
        }
  },
  async listPlacementEvents() {
    errorFor("events-forbidden")
    errorFor("events-conflict")
    return events
  },
  async getPlacementEvidence() {
    errorFor("evidence-forbidden")
    errorFor("evidence-conflict")
    return evidence
  },
  async reverifyPlacement(_websiteProjectKey, placementId, input) {
    errorFor("reverify-forbidden")
    errorFor("reverify-conflict")
    return {
      placementId,
      placementVersion: input.expectedVersion + 1,
      accepted: true,
      replayed: false,
      browserFallbackAllowed: false,
      monitorRun: {
        monitorRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        status: "running",
        scheduledFor: "2026-07-29T01:12:00.000Z",
      },
    }
  },
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-6xl p-4 sm:p-6">
    <LinksWorkspace client={previewClient} websiteProjectKey="preview-project" />
  </main>
)
