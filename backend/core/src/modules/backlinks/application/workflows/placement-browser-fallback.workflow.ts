import type {
  BrowserFetchCapability,
  BrowserFetchEvidence,
  BrowserFetchRequest,
} from "../../ports/crawler-browser-fetch.port.js";

export const placementBrowserFallbackPolicyVersion =
  "placement-browser-fallback.v1";
export const placementBrowserFallbackEvidenceMarkerVersion =
  "placement-browser-fallback-marker.v1";
export const placementBrowserFallbackEvidenceMarkerSchemaVersion = 1;
export const sharedCrawlerEvidenceContractVersion = "crawler.evidence.v1";

export type BrowserFallbackBudgetRequest = Readonly<{
  requestId: string;
  workspaceId: string;
  websiteProjectId: string;
  placementId: string;
  staticEvidenceSnapshotId: string;
  staticEvidenceSnapshotHash: string;
  requestedAt: string;
}>;

export type BrowserFallbackBudgetReservation =
  | Readonly<{ outcome: "granted" }>
  | Readonly<{ outcome: "exhausted" }>;

export interface BrowserFallbackBudgetGate {
  reserve(
    request: BrowserFallbackBudgetRequest,
  ): Promise<BrowserFallbackBudgetReservation>;
}

export type PlacementBrowserFallbackWorkflowInput = Readonly<{
  request: BrowserFetchRequest;
  staticEvidenceSufficient: boolean;
  authorized: boolean;
}>;

export type PlacementBrowserFallbackEvidenceMarker = Readonly<{
  markerVersion: typeof placementBrowserFallbackEvidenceMarkerVersion;
  schemaVersion: typeof placementBrowserFallbackEvidenceMarkerSchemaVersion;
  policyVersion: typeof placementBrowserFallbackPolicyVersion;
  sharedCrawlerEvidenceContract: typeof sharedCrawlerEvidenceContractVersion;
  requestId: string;
  placementId: string;
  staticEvidenceSnapshotId: string;
  staticEvidenceSnapshotHash: string;
  disposition: PlacementBrowserFallbackDisposition;
  recordedAt: string;
  browserEvidence: Readonly<{
    contractVersion: string;
    evidenceSnapshotHash: string;
    observedAt: string;
  }> | null;
}>;

export type PlacementBrowserFallbackDisposition =
  | "static_evidence_sufficient"
  | "not_authorized"
  | "budget_exhausted"
  | "capability_disabled"
  | "browser_evidence_fetched";

export type PlacementBrowserFallbackWorkflowResult =
  | Readonly<{
    outcome: "not_requested";
    reason: Exclude<
      PlacementBrowserFallbackDisposition,
      "browser_evidence_fetched"
    >;
    evidenceMarker: PlacementBrowserFallbackEvidenceMarker;
  }>
  | Readonly<{
    outcome: "browser_evidence_fetched";
    evidence: BrowserFetchEvidence;
    evidenceMarker: PlacementBrowserFallbackEvidenceMarker;
  }>;

function budgetRequest(
  request: BrowserFetchRequest,
): BrowserFallbackBudgetRequest {
  return Object.freeze({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    websiteProjectId: request.websiteProjectId,
    placementId: request.placementId,
    staticEvidenceSnapshotId: request.staticEvidenceSnapshotId,
    staticEvidenceSnapshotHash: request.staticEvidenceSnapshotHash,
    requestedAt: request.requestedAt,
  });
}

function evidenceMarker(
  request: BrowserFetchRequest,
  disposition: PlacementBrowserFallbackDisposition,
  browserEvidence: BrowserFetchEvidence | null = null,
): PlacementBrowserFallbackEvidenceMarker {
  return Object.freeze({
    markerVersion: placementBrowserFallbackEvidenceMarkerVersion,
    schemaVersion: placementBrowserFallbackEvidenceMarkerSchemaVersion,
    policyVersion: placementBrowserFallbackPolicyVersion,
    sharedCrawlerEvidenceContract: sharedCrawlerEvidenceContractVersion,
    requestId: request.requestId,
    placementId: request.placementId,
    staticEvidenceSnapshotId: request.staticEvidenceSnapshotId,
    staticEvidenceSnapshotHash: request.staticEvidenceSnapshotHash,
    disposition,
    recordedAt: browserEvidence?.observedAt ?? request.requestedAt,
    browserEvidence: browserEvidence === null
      ? null
      : Object.freeze({
        contractVersion: browserEvidence.contractVersion,
        evidenceSnapshotHash: browserEvidence.evidenceSnapshotHash,
        observedAt: browserEvidence.observedAt,
      }),
  });
}

function notRequested(
  request: BrowserFetchRequest,
  reason: Exclude<
    PlacementBrowserFallbackDisposition,
    "browser_evidence_fetched"
  >,
): PlacementBrowserFallbackWorkflowResult {
  return Object.freeze({
    outcome: "not_requested" as const,
    reason,
    evidenceMarker: evidenceMarker(request, reason),
  });
}

export async function runPlacementBrowserFallbackWorkflow(
  input: PlacementBrowserFallbackWorkflowInput,
  dependencies: Readonly<{
    browserFetchCapability: BrowserFetchCapability;
    budgetGate: BrowserFallbackBudgetGate;
  }>,
): Promise<PlacementBrowserFallbackWorkflowResult> {
  if (input.staticEvidenceSufficient) {
    return notRequested(input.request, "static_evidence_sufficient");
  }
  if (!input.authorized) {
    return notRequested(input.request, "not_authorized");
  }
  if (!dependencies.browserFetchCapability.enabled) {
    return notRequested(input.request, "capability_disabled");
  }

  const reservation = await dependencies.budgetGate.reserve(
    budgetRequest(input.request),
  );
  if (reservation.outcome === "exhausted") {
    return notRequested(input.request, "budget_exhausted");
  }

  const result = await dependencies.browserFetchCapability.request(input.request);
  if (result.outcome === "disabled") {
    return notRequested(input.request, "capability_disabled");
  }

  return Object.freeze({
    outcome: "browser_evidence_fetched" as const,
    evidence: result.evidence,
    evidenceMarker: evidenceMarker(
      input.request,
      "browser_evidence_fetched",
      result.evidence,
    ),
  });
}
