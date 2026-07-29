import { createHash, randomUUID } from "node:crypto";

import type {
  PlacementReviewBody,
} from "../schemas/placement-review.schema.js";
import type {
  PlacementManualConfirmationResponse,
  PlacementReviewCandidate,
  PlacementReviewRepository,
  PlacementRejectionResponse,
} from "../repositories/placement-review.repository.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type {
  ResolvedProjectContext,
} from "../../ports/project-context.port.js";

const manualEvidenceContractVersion = "placement.manual-review.v1";
const manualEvidenceSchemaVersion = 1;
const nonOverridableReasonCodes = new Set([
  "SAFE_FETCH_INVALID_REQUEST",
  "SAFE_FETCH_URL_BLOCKED",
  "SAFE_FETCH_NETWORK_BLOCKED",
  "SOURCE_NOT_FOUND",
  "SOURCE_GONE",
  "TARGET_LINK_MISSING",
  "TARGET_PATH_MISMATCH",
]);

type PlacementReviewCommandInput = PlacementReviewBody & Readonly<{
  context: ResolvedProjectContext;
  requestId: string;
  candidateId: string;
}>;

type ReviewableValidation = NonNullable<
  PlacementReviewCandidate["latestValidation"]
> & Readonly<{
  status: "INVALID" | "INCONCLUSIVE";
  reasonCode: string;
}>;

export type ConfirmPlacementCandidateResult =
  PlacementManualConfirmationResponse & Readonly<{
    countsTowardKpi: true;
  }>;

export type RejectPlacementCandidateResult =
  PlacementRejectionResponse & Readonly<{
    countsTowardKpi: false;
  }>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Placement review evidence must be JSON.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role))
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Placement review permission is required.",
    });
  }
}

function notFound(): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.notFound,
    message: "Placement Candidate was not found in this project.",
  });
}

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function assertVersion(
  candidate: PlacementReviewCandidate,
  expectedVersion: number,
): void {
  if (candidate.version !== expectedVersion) {
    throw conflict(
      "ExpectedVersion does not match the current Placement Candidate.",
    );
  }
}

function validationForReview(
  candidate: PlacementReviewCandidate,
): ReviewableValidation {
  const validation = candidate.latestValidation;
  if (
    candidate.candidateStatus !== "REVIEW_REQUIRED"
    || validation === null
    || (
      validation.status !== "INVALID"
      && validation.status !== "INCONCLUSIVE"
    )
  ) {
    throw conflict("Placement Candidate is not awaiting manual review.");
  }
  if (
    candidate.initialValidationStatus !== validation.status
    || validation.reasonCode === null
  ) {
    throw conflict(
      "Placement Candidate review evidence is incomplete or stale.",
    );
  }
  return validation as ReviewableValidation;
}

function assertConfirmable(candidate: PlacementReviewCandidate): void {
  const validation = validationForReview(candidate);
  if (
    candidate.matchStatus !== "AUTO_MATCHED"
    || candidate.opportunityId === null
    || candidate.sourcePageUrl === null
    || candidate.normalizedSourceUrl === null
    || candidate.normalizedSourceUrlHash === null
  ) {
    throw conflict(
      "Placement Candidate requires a unique match and page evidence.",
    );
  }
  if (
    candidate.initialValidationStatus !== "INCONCLUSIVE"
    || validation.status !== "INCONCLUSIVE"
  ) {
    throw conflict(
      "Only an inconclusive validation can be manually confirmed.",
    );
  }
  if (nonOverridableReasonCodes.has(validation.reasonCode ?? "")) {
    throw conflict(
      "Security or factual validation failures require corrected input and revalidation.",
    );
  }
}

export function createPlacementReviewCommand(
  dependencies: Readonly<{
    repository: PlacementReviewRepository;
    newId?: () => string;
    now?: () => Date;
  }>,
) {
  const newId = dependencies.newId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  async function candidate(
    input: PlacementReviewCommandInput,
  ): Promise<PlacementReviewCandidate> {
    authorize(input.context);
    const current = await dependencies.repository.getCandidate({
      organizationId: input.context.tenant.organizationId,
      workspaceId: input.context.tenant.workspaceId,
      websiteProjectId: input.context.project.websiteProjectId,
      candidateId: input.candidateId,
    });
    if (current === null) throw notFound();
    assertVersion(current, input.expectedVersion);
    return current;
  }

  return Object.freeze({
    async confirm(
      input: PlacementReviewCommandInput,
    ): Promise<ConfirmPlacementCandidateResult> {
      const current = await candidate(input);
      assertConfirmable(current);
      const previous = validationForReview(current);
      const reviewedAt = now();
      const validationRunId = newId();
      const placementId = newId();
      const monitoringOutboxEventId = newId();
      const lifecycleEventId = newId();
      const placementLifecycleEventId = newId();
      const auditEventId = newId();
      const manualEvidenceSnapshot = Object.freeze({
        contractVersion: manualEvidenceContractVersion,
        schemaVersion: manualEvidenceSchemaVersion,
        decision: "MANUALLY_CONFIRMED",
        reason: input.reason,
        reviewer: Object.freeze({
          actorId: input.context.actor.userId,
          reviewedAt: reviewedAt.toISOString(),
        }),
        overriddenValidation: Object.freeze({
          validationRunId: previous.validationRunId,
          runNumber: previous.runNumber,
          validationMethod: previous.validationMethod,
          status: previous.status,
          reasonCode: previous.reasonCode,
          evidenceSnapshotHash: previous.evidenceSnapshotHash,
          evidenceContractVersion: previous.evidenceContractVersion,
          evidenceSchemaVersion: previous.evidenceSchemaVersion,
          evidenceObservedAt: previous.evidenceObservedAt,
          initialEvidenceRef: previous.initialEvidenceRef,
          evidenceSnapshot: previous.evidenceSnapshot,
        }),
      });
      const result = await dependencies.repository.review({
        action: "manual_confirm",
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        candidateId: input.candidateId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        previousValidationRunId: previous.validationRunId,
        previousValidationStatus: "INCONCLUSIVE",
        previousReasonCode: previous.reasonCode,
        validationRunId,
        placementId,
        monitoringOutboxEventId,
        lifecycleEventId,
        placementLifecycleEventId,
        auditEventId,
        requestId: input.requestId,
        reviewedAt,
        manualEvidenceSnapshot,
        manualEvidenceSnapshotHash: digest(manualEvidenceSnapshot),
        evidenceContractVersion: manualEvidenceContractVersion,
        evidenceSchemaVersion: manualEvidenceSchemaVersion,
        initialEvidenceRef:
          `placement-validation:${validationRunId};overrides:${previous.validationRunId}`,
        auditIntegrityHash: digest({
          action: "placement_candidate.manually_confirmed",
          actorId: input.context.actor.userId,
          candidateId: input.candidateId,
          expectedVersion: input.expectedVersion,
          previousValidationRunId: previous.validationRunId,
          previousValidationStatus: previous.status,
          previousReasonCode: previous.reasonCode,
          reason: input.reason,
          reviewedAt: reviewedAt.toISOString(),
        }),
      });
      if (
        result.state !== "completed"
        || result.response.action !== "manual_confirm"
      ) {
        throw conflict(
          "Placement Candidate changed before confirmation was recorded.",
        );
      }
      return { ...result.response, countsTowardKpi: true };
    },

    async reject(
      input: PlacementReviewCommandInput,
    ): Promise<RejectPlacementCandidateResult> {
      const current = await candidate(input);
      const previous = validationForReview(current);
      const reviewedAt = now();
      const result = await dependencies.repository.review({
        action: "reject",
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        candidateId: input.candidateId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        previousValidationRunId: previous.validationRunId,
        previousValidationStatus: previous.status,
        previousReasonCode: previous.reasonCode,
        lifecycleEventId: newId(),
        auditEventId: newId(),
        requestId: input.requestId,
        reviewedAt,
        auditIntegrityHash: digest({
          action: "placement_candidate.rejected",
          actorId: input.context.actor.userId,
          candidateId: input.candidateId,
          expectedVersion: input.expectedVersion,
          previousValidationRunId: previous.validationRunId,
          previousValidationStatus: previous.status,
          previousReasonCode: previous.reasonCode,
          reason: input.reason,
          reviewedAt: reviewedAt.toISOString(),
        }),
      });
      if (
        result.state !== "completed"
        || result.response.action !== "reject"
      ) {
        throw conflict(
          "Placement Candidate changed before rejection was recorded.",
        );
      }
      return { ...result.response, countsTowardKpi: false };
    },
  });
}
