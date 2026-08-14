import { createHash } from "node:crypto";

import {
  parseStaticLinkOccurrences,
  type StaticLinkOccurrenceEvidence,
} from "../../adapters/html/link-occurrence-parser.js";
import {
  createPlacementUrlKey,
} from "../../domain/placements/url-key.js";
import {
  SafeFetchError,
  type SafeFetchPort,
  type SafeFetchResult,
} from "../../ports/safe-fetch.port.js";
import type {
  PlacementInitialValidationRecord,
  PlacementInitialValidationRepository,
  PlacementValidationCandidate,
  PlacementValidationResultStatus,
} from "../repositories/placement-validation.repository.js";

export const placementInitialValidationPolicyVersion =
  "placement-initial-validation.static.v1";
export const placementInitialValidationEvidenceContractVersion =
  "placement.initial-validation.v1";
export const placementInitialValidationEvidenceSchemaVersion = 1;

export type PlacementInitialValidationWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  candidateId: string;
  validationRunId: string;
  placementId: string;
  monitoringOutboxEventId: string;
  placementLifecycleEventId: string;
  auditEventId: string;
  actorId: string;
  recordedAt: Date | string;
}>;

type ValidationDecision = Readonly<{
  status: PlacementValidationResultStatus;
  reasonCode: string;
  page: StaticLinkOccurrenceEvidence | null;
  fetch: Readonly<{
    requestedUrl: string;
    finalUrl: string;
    status: number;
    contentType: string;
    redirectChain: readonly string[];
    resolvedIps: readonly string[];
    fetchedAt: string;
    xRobotsTag: string | null;
  }> | null;
  failure: Readonly<{
    code: string;
    retryable: boolean;
  }> | null;
  observedAt: Date;
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function parseRecordedAt(value: Date | string): Date {
  const recordedAt = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new Error("Placement validation recordedAt is invalid.");
  }
  return recordedAt;
}

function fetchEvidence(page: SafeFetchResult): NonNullable<
  ValidationDecision["fetch"]
> {
  return Object.freeze({
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    status: page.status,
    contentType: page.contentType,
    redirectChain: Object.freeze([...page.redirectChain]),
    resolvedIps: Object.freeze([...page.resolvedIps]),
    fetchedAt: page.fetchedAt,
    xRobotsTag: page.xRobotsTag ?? null,
  });
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function hasDynamicRenderingSignals(page: SafeFetchResult): boolean {
  const html = decoder.decode(page.body);
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    /(?:id=["'](?:__next|__nuxt|root|app)["']|data-reactroot|ng-version|data-v-app)/iu
      .test(html)
    || (text.length < 300 && /<script\b[^>]+src=/iu.test(html))
  );
}

function decideHtml(
  candidate: PlacementValidationCandidate,
  page: SafeFetchResult,
): ValidationDecision {
  const fetch = fetchEvidence(page);
  const observedAt = new Date(page.fetchedAt);
  if (page.status === 404 || page.status === 410) {
    return {
      status: "INVALID",
      reasonCode: page.status === 410 ? "SOURCE_GONE" : "SOURCE_NOT_FOUND",
      page: null,
      fetch,
      failure: null,
      observedAt,
    };
  }
  if (page.status < 200 || page.status >= 300) {
    return {
      status: "INCONCLUSIVE",
      reasonCode: `HTTP_${page.status}`,
      page: null,
      fetch,
      failure: null,
      observedAt,
    };
  }

  try {
    const evidence = parseStaticLinkOccurrences({
      page,
      targetUrl: candidate.normalizedTargetUrl,
    });
    if (
      evidence.noindex
      || /\bnoindex\b/iu.test(page.xRobotsTag ?? "")
    ) {
      return {
        status: "INVALID",
        reasonCode: "SOURCE_NOINDEX",
        page: evidence,
        fetch,
        failure: null,
        observedAt,
      };
    }
    if (
      evidence.canonicalUrl !== null
      && createPlacementUrlKey(evidence.canonicalUrl).normalizedUrlHash
        !== createPlacementUrlKey(page.finalUrl).normalizedUrlHash
    ) {
      return {
        status: "INVALID",
        reasonCode: "CANONICAL_POINTS_ELSEWHERE",
        page: evidence,
        fetch,
        failure: null,
        observedAt,
      };
    }
    return {
      status: evidence.occurrences.length > 0 ? "VALID" : "INVALID",
      reasonCode: evidence.occurrences.length > 0
        ? "TARGET_LINK_FOUND"
        : "TARGET_LINK_MISSING",
      page: evidence,
      fetch,
      failure: null,
      observedAt,
    };
  } catch {
    return {
      status: "INCONCLUSIVE",
      reasonCode: "STATIC_HTML_PARSE_FAILED",
      page: null,
      fetch,
      failure: {
        code: "STATIC_HTML_PARSE_FAILED",
        retryable: false,
      },
      observedAt,
    };
  }
}

function decideFailure(
  error: unknown,
  observedAt: Date,
): ValidationDecision {
  if (error instanceof SafeFetchError) {
    return {
      status: "INCONCLUSIVE",
      reasonCode: error.code,
      page: null,
      fetch: null,
      failure: {
        code: error.code,
        retryable: error.retryable,
      },
      observedAt,
    };
  }
  return {
    status: "INCONCLUSIVE",
    reasonCode: "PLACEMENT_SAFE_FETCH_FAILED",
    page: null,
    fetch: null,
    failure: {
      code: "PLACEMENT_SAFE_FETCH_FAILED",
      retryable: true,
    },
    observedAt,
  };
}

function resultFromRecord(record: PlacementInitialValidationRecord) {
  if (record.state === "existing") {
    return {
      outcome: "already_validated" as const,
      candidateId: record.candidateId,
      validationRunId: record.validationRunId,
      status: record.status,
      placementId: record.placementId,
      monitoringOutboxEventId: record.monitoringOutboxEventId,
    };
  }
  return {
    outcome: record.placementId === null
      ? "review_required" as const
      : "confirmed" as const,
    candidateId: record.candidateId,
    validationRunId: record.validationRunId,
    status: record.status,
    placementId: record.placementId,
    monitoringOutboxEventId: record.monitoringOutboxEventId,
  };
}

export async function runPlacementInitialValidationWorkflow(
  input: PlacementInitialValidationWorkflowInput,
  repository: PlacementInitialValidationRepository,
  safeFetch: SafeFetchPort,
  browserFetch?: SafeFetchPort,
) {
  const state = await repository.getCandidate(input);
  if (state.state === "not_found") {
    return { outcome: "not_found" as const, candidateId: input.candidateId };
  }
  if (state.state === "not_ready") {
    return {
      outcome: "not_ready" as const,
      candidateId: state.candidateId,
      candidateStatus: state.candidateStatus,
      matchStatus: state.matchStatus,
      validationStatus: state.validationStatus,
    };
  }
  if (state.state === "already_validated") {
    return {
      outcome: "already_validated" as const,
      candidateId: state.candidateId,
      validationRunId: state.validationRunId,
      status: state.status,
      placementId: state.placementId,
      monitoringOutboxEventId: state.monitoringOutboxEventId,
    };
  }

  const recordedAt = parseRecordedAt(input.recordedAt);
  let decision: ValidationDecision;
  let fetchMode = "safe_fetch_static";
  try {
    const request = {
      url: state.candidate.sourcePageUrl,
      purpose: "placement-check" as const,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      maxBytes: 2_000_000,
      maxRedirects: 5,
    };
    const staticPage = await safeFetch.fetch(request);
    decision = decideHtml(state.candidate, staticPage);
    if (
      browserFetch !== undefined
      && decision.reasonCode === "TARGET_LINK_MISSING"
      && hasDynamicRenderingSignals(staticPage)
    ) {
      fetchMode = "shared_browser_worker";
      try {
        decision = decideHtml(
          state.candidate,
          await browserFetch.fetch(request),
        );
      } catch (error) {
        decision = decideFailure(error, recordedAt);
      }
    }
  } catch (error) {
    decision = decideFailure(
      error,
      recordedAt,
    );
  }

  const evidenceSnapshot = Object.freeze({
    contractVersion: placementInitialValidationEvidenceContractVersion,
    schemaVersion: placementInitialValidationEvidenceSchemaVersion,
    policyVersion: placementInitialValidationPolicyVersion,
    fetchMode,
    candidateId: state.candidate.candidateId,
    opportunityId: state.candidate.opportunityId,
    sourcePageUrl: state.candidate.sourcePageUrl,
    targetUrl: state.candidate.targetUrl,
    fetch: decision.fetch,
    page: decision.page,
    failure: decision.failure,
    result: Object.freeze({
      status: decision.status,
      reasonCode: decision.reasonCode,
    }),
  });
  const canonicalEvidence = JSON.stringify(canonicalize(evidenceSnapshot));
  const verifiedAt = decision.observedAt > recordedAt
    ? decision.observedAt
    : recordedAt;
  const record = await repository.record({
    ...input,
    expectedCandidateVersion: state.candidate.version,
    status: decision.status,
    evidenceSnapshot,
    evidenceSnapshotHash: createHash("sha256")
      .update(canonicalEvidence, "utf8")
      .digest("hex"),
    evidenceContractVersion:
      placementInitialValidationEvidenceContractVersion,
    evidenceSchemaVersion:
      placementInitialValidationEvidenceSchemaVersion,
    evidenceObservedAt: decision.observedAt,
    verifiedAt,
    verifiedBy: input.actorId,
    initialEvidenceRef: `placement-validation:${input.validationRunId}`,
  });
  return resultFromRecord(record);
}
