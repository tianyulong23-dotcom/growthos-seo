import { createHash, randomUUID } from "node:crypto";

import type {
  CreatePlacementCandidateBody,
  PlacementCandidateDiscoveryEvidence,
} from "../schemas/placement-candidate.schema.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  createPlacementUrlKey,
  type PlacementUrlKey,
} from "../../domain/placements/url-key.js";
import type {
  ResolvedProjectContext,
} from "../../ports/project-context.port.js";

export type PlacementCandidateCreation = Readonly<{
  candidateId: string;
  status: "PENDING_MATCH";
  matchStatus: "UNMATCHED";
  initialValidationStatus: "PENDING";
  version: number;
}>;

export type CreatePlacementCandidateRepositoryInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  candidateId: string;
  sourceType: CreatePlacementCandidateBody["sourceType"];
  sourceExternalId?: string;
  sourcePageUrl?: string;
  normalizedSourceUrl?: string;
  normalizedSourceUrlHash?: string;
  targetUrl: string;
  normalizedTargetUrl: string;
  normalizedTargetUrlHash: string;
  urlNormalizationVersion: string;
  status: "PENDING_MATCH";
  matchStatus: "UNMATCHED";
  initialValidationStatus: "PENDING";
  discoveryEvidenceSnapshot: PlacementCandidateDiscoveryEvidence;
  discoveryEvidenceHash: string;
  evidenceContractVersion: string;
  evidenceSchemaVersion: number;
  idempotencyKey: string;
  idempotencyRecordId: string;
  requestHash: string;
  requestId: string;
}>;

export type PlacementCandidateRepositoryResult = Readonly<{
  state: "completed" | "replay";
  requestHash: string;
  responseBody?: PlacementCandidateCreation;
}>;

export interface PlacementCandidateRepository {
  create(
    input: CreatePlacementCandidateRepositoryInput,
  ): Promise<PlacementCandidateRepositoryResult>;
}

export type CreatePlacementCandidateCommandInput =
  CreatePlacementCandidateBody & Readonly<{
    context: ResolvedProjectContext;
    idempotencyKey: string;
    requestId: string;
  }>;

export type CreatePlacementCandidateCommandResult =
  PlacementCandidateCreation & Readonly<{
    countsTowardKpi: false;
    replayed: boolean;
  }>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Evidence must contain JSON values only.");
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
      message: "Placement write permission is required.",
    });
  }
}

function urlKey(rawUrl: string, field: string): PlacementUrlKey {
  try {
    return createPlacementUrlKey(rawUrl);
  } catch {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message: "Placement URL validation failed.",
      fieldErrors: [{
        field,
        message: "Must be a supported public HTTP(S) URL.",
      }],
    });
  }
}

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

export function createPlacementCandidateCommand(
  dependencies: Readonly<{
    repository: PlacementCandidateRepository;
    newId?: () => string;
  }>,
) {
  const newId = dependencies.newId ?? randomUUID;

  return Object.freeze({
    async execute(
      input: CreatePlacementCandidateCommandInput,
    ): Promise<CreatePlacementCandidateCommandResult> {
      authorize(input.context);
      const sourcePageUrl = input.sourcePageUrl;
      const sourceUrl = sourcePageUrl === undefined
        ? undefined
        : {
            rawUrl: sourcePageUrl,
            key: urlKey(sourcePageUrl, "sourcePageUrl"),
          };
      const targetUrlKey = urlKey(input.targetUrl, "targetUrl");
      const discoveryEvidenceSnapshot = Object.freeze({
        contractVersion: input.evidence.contractVersion,
        schemaVersion: input.evidence.schemaVersion,
        evidenceId: input.evidence.evidenceId,
        observedAt: input.evidence.observedAt,
        sourceRef: input.evidence.sourceRef,
        payload: input.evidence.payload,
      });
      const discoveryEvidenceHash = digest(discoveryEvidenceSnapshot);
      const requestHash = digest({
        sourceType: input.sourceType,
        sourceExternalId: input.sourceExternalId ?? null,
        normalizedSourceUrlHash:
          sourceUrl?.key.normalizedUrlHash ?? null,
        normalizedTargetUrlHash: targetUrlKey.normalizedUrlHash,
        discoveryEvidenceHash,
        evidenceContractVersion: input.evidence.contractVersion,
        evidenceSchemaVersion: input.evidence.schemaVersion,
      });
      const sourceFields = sourceUrl === undefined
        ? {}
        : {
            sourcePageUrl: sourceUrl.rawUrl,
            normalizedSourceUrl: sourceUrl.key.normalizedUrl,
            normalizedSourceUrlHash: sourceUrl.key.normalizedUrlHash,
          };
      const sourceExternalId = input.sourceExternalId === undefined
        ? {}
        : { sourceExternalId: input.sourceExternalId };
      const row = await dependencies.repository.create({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        candidateId: newId(),
        sourceType: input.sourceType,
        ...sourceExternalId,
        ...sourceFields,
        targetUrl: input.targetUrl,
        normalizedTargetUrl: targetUrlKey.normalizedUrl,
        normalizedTargetUrlHash: targetUrlKey.normalizedUrlHash,
        urlNormalizationVersion: targetUrlKey.normalizationVersion,
        status: "PENDING_MATCH",
        matchStatus: "UNMATCHED",
        initialValidationStatus: "PENDING",
        discoveryEvidenceSnapshot,
        discoveryEvidenceHash,
        evidenceContractVersion: input.evidence.contractVersion,
        evidenceSchemaVersion: input.evidence.schemaVersion,
        idempotencyKey: input.idempotencyKey,
        idempotencyRecordId: newId(),
        requestHash,
        requestId: input.requestId,
      });

      if (row.requestHash !== requestHash) {
        throw conflict(
          "Idempotency key is already bound to a different request.",
        );
      }
      if (row.responseBody === undefined) {
        throw conflict("The idempotent command is already in progress.");
      }

      return {
        ...row.responseBody,
        countsTowardKpi: false,
        replayed: row.state === "replay",
      };
    },
  });
}
