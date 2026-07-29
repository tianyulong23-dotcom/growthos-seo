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

export const placementMonitorObservationContractVersion =
  "placement.monitor-observation.v1";
export const placementMonitorObservationSchemaVersion = 1;
export const placementStaticMonitorPolicyVersion =
  "placement-monitor.static.v1";

export type PlacementMonitorObservationResult =
  | "present"
  | "changed"
  | "absent"
  | "inaccessible";

export type PreviousSuccessfulMonitorObservation = Readonly<{
  result: Exclude<PlacementMonitorObservationResult, "inaccessible">;
  evidenceFingerprint: string;
}>;

export type PlacementStaticMonitorActivityInput = Readonly<{
  workspaceId: string;
  websiteProjectId: string;
  sourcePageUrl: string;
  targetUrl: string;
  previousSuccessfulObservation:
    PreviousSuccessfulMonitorObservation | null;
}>;

export type PlacementStaticMonitorActivityResult = Readonly<{
  result: PlacementMonitorObservationResult;
  failureCode: string | null;
  retryable: boolean;
  evidenceSnapshot: Readonly<Record<string, unknown>>;
  evidenceSnapshotHash: string;
  evidenceFingerprint: string;
  evidenceContractVersion:
    typeof placementMonitorObservationContractVersion;
  evidenceSchemaVersion:
    typeof placementMonitorObservationSchemaVersion;
  observedAt: Date;
}>;

export type PlacementStaticMonitorActivity = Readonly<{
  execute(
    input: PlacementStaticMonitorActivityInput,
  ): Promise<PlacementStaticMonitorActivityResult>;
}>;

type StaticDecision = Readonly<{
  result: PlacementMonitorObservationResult;
  reasonCode: string;
  failureCode: string | null;
  retryable: boolean;
  fetch: Readonly<Record<string, unknown>> | null;
  page: StaticLinkOccurrenceEvidence | null;
  evidenceFingerprint: string;
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

export function hashPlacementEvidence(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function fetchEvidence(page: SafeFetchResult): Readonly<
  Record<string, unknown>
> {
  return Object.freeze({
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    status: page.status,
    contentType: page.contentType,
    redirectChain: Object.freeze([...page.redirectChain]),
    resolvedIps: Object.freeze([...page.resolvedIps]),
    fetchedAt: page.fetchedAt,
    xRobotsTag: null,
  });
}

function inaccessibleDecision(
  input: PlacementStaticMonitorActivityInput,
  reasonCode: string,
  retryable: boolean,
  observedAt: Date,
  fetch: Readonly<Record<string, unknown>> | null,
): StaticDecision {
  return {
    result: "inaccessible",
    reasonCode,
    failureCode: reasonCode,
    retryable,
    fetch,
    page: null,
    evidenceFingerprint: hashPlacementEvidence({
      sourcePageUrl: input.sourcePageUrl,
      targetUrl: input.targetUrl,
      result: "inaccessible",
      reasonCode,
    }),
    observedAt,
  };
}

function isCanonicalElsewhere(
  page: SafeFetchResult,
  evidence: StaticLinkOccurrenceEvidence,
): boolean {
  return evidence.canonicalUrl !== null
    && createPlacementUrlKey(evidence.canonicalUrl).normalizedUrlHash
      !== createPlacementUrlKey(page.finalUrl).normalizedUrlHash;
}

function linkStateFingerprint(
  page: SafeFetchResult,
  evidence: StaticLinkOccurrenceEvidence | null,
): string {
  const occurrences = evidence?.occurrences.map((occurrence) => ({
    normalizedHref: occurrence.normalizedHref,
    anchorText: occurrence.anchorText,
    rel: [...occurrence.rel].sort(),
    nofollow: occurrence.nofollow,
    sponsored: occurrence.sponsored,
    ugc: occurrence.ugc,
  })).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ) ?? [];
  return hashPlacementEvidence({
    status: page.status,
    finalUrl: createPlacementUrlKey(page.finalUrl).normalizedUrl,
    canonicalUrl: evidence?.canonicalUrl ?? null,
    noindex: evidence?.noindex ?? false,
    occurrences,
  });
}

function decideHtml(
  input: PlacementStaticMonitorActivityInput,
  page: SafeFetchResult,
): StaticDecision {
  const fetch = fetchEvidence(page);
  const observedAt = new Date(page.fetchedAt);
  if (page.status === 429 || page.status === 408 || page.status >= 500) {
    return inaccessibleDecision(
      input,
      `HTTP_${page.status}`,
      true,
      observedAt,
      fetch,
    );
  }
  if (page.status === 404 || page.status === 410) {
    return {
      result: "absent",
      reasonCode: page.status === 410 ? "SOURCE_GONE" : "SOURCE_NOT_FOUND",
      failureCode: null,
      retryable: false,
      fetch,
      page: null,
      evidenceFingerprint: linkStateFingerprint(page, null),
      observedAt,
    };
  }
  if (page.status < 200 || page.status >= 300) {
    return inaccessibleDecision(
      input,
      `HTTP_${page.status}`,
      false,
      observedAt,
      fetch,
    );
  }

  let evidence: StaticLinkOccurrenceEvidence;
  try {
    evidence = parseStaticLinkOccurrences({
      page,
      targetUrl: input.targetUrl,
    });
  } catch {
    return inaccessibleDecision(
      input,
      "STATIC_HTML_PARSE_FAILED",
      false,
      observedAt,
      fetch,
    );
  }

  const evidenceFingerprint = linkStateFingerprint(page, evidence);
  if (evidence.occurrences.length === 0) {
    return {
      result: "absent",
      reasonCode: "TARGET_LINK_ABSENT",
      failureCode: null,
      retryable: false,
      fetch,
      page: evidence,
      evidenceFingerprint,
      observedAt,
    };
  }

  const previous = input.previousSuccessfulObservation;
  const canonicalElsewhere = isCanonicalElsewhere(page, evidence);
  const remainsChanged = previous?.result === "changed"
    && previous.evidenceFingerprint === evidenceFingerprint;
  const changedFromPrevious = (
    previous?.result === "present"
    || previous?.result === "changed"
  ) && previous.evidenceFingerprint !== evidenceFingerprint;
  if (
    evidence.noindex
    || canonicalElsewhere
    || remainsChanged
    || changedFromPrevious
  ) {
    const reasonCode = evidence.noindex
      ? "SOURCE_NOINDEX"
      : canonicalElsewhere
      ? "CANONICAL_POINTS_ELSEWHERE"
      : remainsChanged
      ? "LINK_EVIDENCE_STILL_CHANGED"
      : "LINK_EVIDENCE_CHANGED";
    return {
      result: "changed",
      reasonCode,
      failureCode: null,
      retryable: false,
      fetch,
      page: evidence,
      evidenceFingerprint,
      observedAt,
    };
  }

  return {
    result: "present",
    reasonCode: "TARGET_LINK_PRESENT",
    failureCode: null,
    retryable: false,
    fetch,
    page: evidence,
    evidenceFingerprint,
    observedAt,
  };
}

function decideFailure(
  input: PlacementStaticMonitorActivityInput,
  error: unknown,
  observedAt: Date,
): StaticDecision {
  if (error instanceof SafeFetchError) {
    return inaccessibleDecision(
      input,
      error.code,
      error.retryable,
      observedAt,
      null,
    );
  }
  return inaccessibleDecision(
    input,
    "PLACEMENT_MONITOR_SAFE_FETCH_FAILED",
    true,
    observedAt,
    null,
  );
}

export async function executePlacementStaticMonitorActivity(
  input: PlacementStaticMonitorActivityInput,
  safeFetch: SafeFetchPort,
): Promise<PlacementStaticMonitorActivityResult> {
  let decision: StaticDecision;
  try {
    decision = decideHtml(input, await safeFetch.fetch({
      url: input.sourcePageUrl,
      purpose: "placement-check",
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      maxBytes: 2_000_000,
      maxRedirects: 5,
    }));
  } catch (error) {
    decision = decideFailure(input, error, new Date());
  }

  const evidenceSnapshot = Object.freeze({
    contractVersion: placementMonitorObservationContractVersion,
    schemaVersion: placementMonitorObservationSchemaVersion,
    policyVersion: placementStaticMonitorPolicyVersion,
    fetchMode: "safe_fetch_static",
    sourcePageUrl: input.sourcePageUrl,
    targetUrl: input.targetUrl,
    fetch: decision.fetch,
    page: decision.page,
    result: Object.freeze({
      status: decision.result,
      reasonCode: decision.reasonCode,
      retryable: decision.retryable,
    }),
  });
  return Object.freeze({
    result: decision.result,
    failureCode: decision.failureCode,
    retryable: decision.retryable,
    evidenceSnapshot,
    evidenceSnapshotHash: hashPlacementEvidence(evidenceSnapshot),
    evidenceFingerprint: decision.evidenceFingerprint,
    evidenceContractVersion: placementMonitorObservationContractVersion,
    evidenceSchemaVersion: placementMonitorObservationSchemaVersion,
    observedAt: decision.observedAt,
  });
}

export function createPlacementStaticMonitorActivity(
  safeFetch: SafeFetchPort,
): PlacementStaticMonitorActivity {
  return {
    execute: async (input) =>
      executePlacementStaticMonitorActivity(input, safeFetch),
  };
}
