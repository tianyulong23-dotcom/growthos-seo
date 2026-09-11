import { createHash, randomUUID } from "node:crypto";

import {
  createDraftEvidence,
  type DraftEvidence,
} from "../../domain/drafts/draft.js";
import {
  approveDraftEvidence,
  containsInternalDraftMetadataMarker,
  type ApprovedDraftEvidence,
} from "../../domain/drafts/evidence-policy.js";
import { resolveDraftPromotionTarget } from "../../domain/drafts/promotion-target.js";
import type { AiDraftInput, AiDraftResult } from "../../ports/ai-draft.port.js";
import { buildDraftPrompt } from "../services/draft-prompt-builder.js";
import {
  draftRequestSchema,
  type DraftRequest,
} from "../schemas/draft-request.schema.js";
import {
  deriveDraftFreshness,
  type DraftFreshness,
} from "../read-models/draft-freshness.js";

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type DraftGenerationQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type DraftGenerationJobStatus =
  "QUEUED" | "RUNNING" | "RETRY_SCHEDULED" | "SUCCEEDED" | "FAILED" | "REFUSED";

export type DraftGenerationReadiness =
  | "QUEUED"
  | "GENERATING"
  | "RETRYING"
  | "AI_DRAFT_READY"
  | "BASIC_DRAFT_READY"
  | "POLICY_BLOCKED"
  | "BUDGET_BLOCKED"
  | "FAILED";

export type DraftGenerationJob = Readonly<{
  runId: string;
  draftId: string;
  status: DraftGenerationJobStatus;
  started: boolean;
  opportunityId: string;
  contactId: string | null;
  contactVersion: number | null;
  evidenceSnapshotId: string;
  requestSnapshotId: string | null;
  request: DraftRequest | null;
  generator: "AI" | "TEMPLATE_FALLBACK" | null;
  promptVersion: string;
  outputSchemaVersion: string;
  baseDraftVersion: number;
  versionId: string | null;
  lastSuccessfulVersionId: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  latencyMs: number | null;
  attemptCount: number;
  lastErrorCategory: string | null;
  diagnosticCode: string | null;
  persistenceLatencyMs: number | null;
  readiness: DraftGenerationReadiness;
  fallbackReason: string | null;
}>;

export type DraftInputSnapshot = Readonly<{
  evidenceSnapshotId: string;
  evidenceSnapshotHash: string;
  requestSnapshotId: string;
  request: DraftRequest;
  requestHash: string;
  recommendationId: string | null;
  profileVersionId: string | null;
  promotionTargetVersionId: string | null;
  opportunityVersion: number | null;
  contactId: string;
  contactVersion: number;
  createdAt: string;
}>;

export type DraftSnapshot = Readonly<{
  draftId: string;
  opportunityId: string;
  contactId: string | null;
  contactVersion: number | null;
  status: "generating" | "draft" | "approved" | "rejected" | "sent";
  draftVersion: number;
  approvedVersionId: string | null;
  currentVersion: Readonly<{
    id: string;
    versionNo: number;
    subjectText: string;
    bodyText: string;
    bodyDocument: unknown | null;
    source: "MODEL" | "TEMPLATE_FALLBACK" | "MANUAL" | "RESTORED";
    readiness: "AI_DRAFT_READY" | "BASIC_DRAFT_READY" | "EDITED_DRAFT_READY";
    fallbackReason: string | null;
    createdAt: string;
  }> | null;
  inputSnapshot?: DraftInputSnapshot | null;
  freshness?: DraftFreshness;
}>;

export type CreateDraftGenerationJobInput = Scope &
  Readonly<{
    opportunityId: string;
    contactId: string;
    contactVersion: number;
    evidenceSnapshotId: string;
    requestSnapshotId: string;
    draftId: string;
    runId: string;
    logicalDraftKey: string;
    idempotencyKey: string;
    requestHash: string;
    promptVersion: string;
    outputSchemaVersion: string;
    generationMode: DraftGenerationMode;
    actorId: string;
    recordedAt: Date;
  }>;

export type PrepareDraftEvidenceSnapshotInput = Scope &
  Readonly<{
    opportunityId: string;
    contactId: string;
    contactVersion: number;
    snapshotId: string;
    requestSnapshotId: string;
    request: DraftRequest;
    actorId: string;
    recordedAt: Date;
  }>;

type JobMutation = Scope &
  Readonly<{
    runId: string;
    actorId: string;
    recordedAt: Date;
  }>;

export type DraftGenerationMode = "MODEL" | "MANUAL";

export type DraftPromptContext = Readonly<{
  prompt: AiDraftInput;
  approvedEvidence: readonly ApprovedDraftEvidence[];
  forbiddenValues: readonly string[];
}>;

export type DraftGenerationRepository = Readonly<{
  prepareEvidenceSnapshot(input: PrepareDraftEvidenceSnapshotInput): Promise<
    Readonly<{
      snapshotId: string;
      requestSnapshotId: string;
      replayed: boolean;
    }>
  >;
  createJob(input: CreateDraftGenerationJobInput): Promise<DraftGenerationJob>;
  claimJob(input: JobMutation): Promise<DraftGenerationJob>;
  loadPromptContext(input: JobMutation): Promise<DraftPromptContext>;
  completeJob(
    input: JobMutation &
      Readonly<{
        versionId: string;
        result: AiDraftResult;
        source: "MODEL" | "TEMPLATE_FALLBACK";
        fallbackReason: string | null;
      }>,
  ): Promise<
    Readonly<{
      versionId: string;
      draftVersion: number;
      adoptedAsCurrent: boolean;
    }>
  >;
  failJob(
    input: JobMutation &
      Readonly<{
        errorClass: string;
        errorCode: string;
        diagnosticCode: string | null;
        refused: boolean;
      }>,
  ): Promise<void>;
  scheduleRetry(
    input: JobMutation &
      Readonly<{
        errorClass: string;
        errorCode: string;
      }>,
  ): Promise<void>;
  getJob(
    input: Scope & Readonly<{ runId: string }>,
  ): Promise<DraftGenerationJob>;
  findLatestJob(
    input: Scope &
      Readonly<{
        opportunityId: string;
        logicalDraftKey: string;
      }>,
  ): Promise<DraftGenerationJob | null>;
  getDraft(
    input: Scope & Readonly<{ draftId: string }>,
  ): Promise<DraftSnapshot>;
}>;

type DraftEditingMutation = Scope &
  Readonly<{
    draftId: string;
    expectedVersion: number;
    actorId: string;
    recordedAt: Date;
  }>;

type DraftEditingCompleted = Readonly<{
  state: "completed";
  draftId: string;
  versionId: string;
  draftVersion: number;
  status: "draft" | "approved";
}>;

type DraftEditingFailure =
  | Readonly<{ state: "not_found" }>
  | Readonly<{ state: "version_conflict"; currentVersion: number }>
  | Readonly<{ state: "invalid_content" }>;

export type DraftEditingRepository = Readonly<{
  saveManualVersion(
    input: DraftEditingMutation &
      Readonly<{
        versionId: string;
        subjectText: string;
        bodyText: string;
        bodyDocument: unknown;
      }>,
  ): Promise<DraftEditingCompleted | DraftEditingFailure>;
  approve(
    input: DraftEditingMutation,
  ): Promise<DraftEditingCompleted | DraftEditingFailure>;
}>;

export const draftApprovalFactContractVersion =
  "draft-approval-fact.v1" as const;

type DraftEditingRepositoryDependencies = Readonly<{
  newId?: () => string;
}>;

const scopeValues = (input: Scope) =>
  [input.organizationId, input.workspaceId, input.websiteProjectId] as const;

const nonBlank = (value: unknown, fallback: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "" ? fallback : normalized;
};

const asIsoString = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const readStringList = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === "string" && item.trim() !== "" ? [item.trim()] : [],
      )
    : [];

const readRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined || String(value).trim() === ""
    ? null
    : String(value);

const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const summarizeStructuredValue = (value: unknown): string => {
  if (value === null || value === undefined) return "not recorded";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length <= 1_500
    ? serialized
    : `${serialized.slice(0, 1_497)}...`;
};

const replaceForbiddenValue = (
  value: unknown,
  forbiddenValue: unknown,
): string => {
  const text = nonBlank(value, "not recorded");
  const forbidden = nonBlank(forbiddenValue, "");
  return forbidden === ""
    ? text
    : text.replaceAll(forbidden, "[confirmed contact email]");
};

const projectMarketingContext = (
  row: Record<string, unknown>,
  requestedTargetUrl?: string,
) => {
  const canonicalDomain = nonBlank(row.canonicalDomain, "");
  const targetUrls = readStringList(row.targetUrls);
  const products = readStringList(row.products);
  const keywords = readStringList(row.keywords);
  if (
    canonicalDomain === "" ||
    products.length === 0 ||
    keywords.length === 0
  ) {
    throw new Error("DRAFT_PROJECT_CONTEXT_INCOMPLETE");
  }
  const promotionTarget = resolveDraftPromotionTarget({
    canonicalDomain,
    configuredTargetUrls: targetUrls,
    ...(requestedTargetUrl === undefined ? {} : { requestedTargetUrl }),
  });
  if (promotionTarget.state === "missing") {
    throw new Error("DRAFT_PROJECT_CONTEXT_INCOMPLETE");
  }
  if (promotionTarget.state === "invalid") {
    throw new Error("DRAFT_PROMOTION_TARGET_INVALID");
  }
  if (promotionTarget.state === "outside_project") {
    throw new Error("DRAFT_PROMOTION_TARGET_OUTSIDE_PROJECT");
  }
  return {
    products,
    keywords,
    targetMarkets: [
      nonBlank(row.locale, ""),
      nonBlank(row.countryCode, ""),
    ].filter((value) => value !== ""),
    targetUrl: promotionTarget.targetUrl,
  };
};

const recommendationReason = (row: Record<string, unknown>): string =>
  [
    row.recommendationScore === null || row.recommendationScore === undefined
      ? "Current Opportunity selected from the recommendation inventory"
      : `Recommendation score ${Number(row.recommendationScore)}`,
    `components ${summarizeStructuredValue(row.recommendationComponents)}`,
    `evidence ${summarizeStructuredValue(row.recommendationEvidence)}`,
  ].join("; ");

const targetPublicContent = (row: Record<string, unknown>): string =>
  [
    `source ${nonBlank(row.publicSourceUrl, "not recorded")}`,
    `observed content ${replaceForbiddenValue(
      row.publicEvidenceSnippet,
      row.normalizedEmail,
    )}`,
    `extraction ${nonBlank(row.publicExtractionMethod, "not recorded")}`,
    `confidence ${Number(row.publicEvidenceConfidence ?? 0)}`,
  ].join("; ");

const evidenceItem = (
  input: Readonly<{
    id: string;
    sourceKind: DraftEvidence["sourceKind"];
    value: string;
    observedAt: string;
    dataVersion: string;
  }>,
): DraftEvidence =>
  createDraftEvidence({
    ...input,
    status: "ACTIVE",
    visibility: "VISIBLE",
    confidence: 1,
    contentHash: createHash("sha256")
      .update(
        JSON.stringify({
          id: input.id,
          sourceKind: input.sourceKind,
          value: input.value,
          observedAt: input.observedAt,
          dataVersion: input.dataVersion,
        }),
      )
      .digest("hex"),
  });

const asEvidence = (
  value: unknown,
  index: number,
  defaults: Readonly<{ observedAt: string; dataVersion: string }>,
): DraftEvidence => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Evidence Snapshot contains an invalid Evidence item.");
  }
  const item = value as Record<string, unknown>;
  const contentHash =
    typeof item.contentHash === "string" &&
    /^[a-f0-9]{64}$/u.test(item.contentHash)
      ? item.contentHash
      : createHash("sha256").update(JSON.stringify(item)).digest("hex");
  return createDraftEvidence({
    id: nonBlank(item.id, `evidence:${index + 1}`),
    status: item.status as DraftEvidence["status"],
    visibility: item.visibility as DraftEvidence["visibility"],
    confidence: Number(item.confidence),
    sourceKind: item.sourceKind as DraftEvidence["sourceKind"],
    value: nonBlank(item.value, ""),
    observedAt: nonBlank(item.observedAt, defaults.observedAt),
    dataVersion: nonBlank(item.dataVersion, defaults.dataVersion),
    contentHash,
  });
};

const asJob = (
  row: Record<string, unknown> | undefined,
  message: string,
): DraftGenerationJob => {
  if (row === undefined) throw new Error(message);
  const status = row.status as DraftGenerationJobStatus;
  const generator =
    row.generator === "AI" || row.generator === "TEMPLATE_FALLBACK"
      ? row.generator
      : null;
  const lastErrorCategory =
    row.lastErrorCategory === null || row.lastErrorCategory === undefined
      ? null
      : String(row.lastErrorCategory);
  const readiness: DraftGenerationReadiness =
    status === "QUEUED"
      ? "QUEUED"
      : status === "RUNNING"
        ? "GENERATING"
        : status === "RETRY_SCHEDULED"
          ? "RETRYING"
          : status === "SUCCEEDED"
            ? generator === "TEMPLATE_FALLBACK"
              ? "BASIC_DRAFT_READY"
              : "AI_DRAFT_READY"
            : status === "REFUSED" ||
                lastErrorCategory === "POLICY_VIOLATION" ||
                lastErrorCategory === "REFUSED"
              ? "POLICY_BLOCKED"
              : lastErrorCategory === "BUDGET_EXCEEDED"
                ? "BUDGET_BLOCKED"
                : "FAILED";
  return {
    ...(row as DraftGenerationJob),
    status,
    request:
      row.request === null || row.request === undefined
        ? null
        : draftRequestSchema.parse(row.request),
    generator,
    lastErrorCategory,
    diagnosticCode: nullableString(row.diagnosticCode),
    readiness,
    fallbackReason:
      row.fallbackReason === null || row.fallbackReason === undefined
        ? null
        : String(row.fallbackReason),
  };
};

const asDraft = (row: Record<string, unknown> | undefined): DraftSnapshot => {
  if (row === undefined) throw new Error("Draft was not found.");
  const currentVersionId = row.currentVersionId;
  const snapshotContext = readRecord(row.snapshotContextData);
  const snapshotProject = readRecord(snapshotContext.project);
  const snapshotOpportunity = readRecord(snapshotContext.opportunity);
  const requestPayload =
    row.requestPayload === null || row.requestPayload === undefined
      ? null
      : draftRequestSchema.parse(row.requestPayload);
  const inputSnapshot: DraftInputSnapshot | null =
    currentVersionId === null ||
    row.evidenceSnapshotId === null ||
    row.evidenceSnapshotId === undefined ||
    row.requestSnapshotId === null ||
    row.requestSnapshotId === undefined ||
    requestPayload === null ||
    row.evidenceSnapshotHash === null ||
    row.evidenceSnapshotHash === undefined ||
    row.requestHash === null ||
    row.requestHash === undefined
      ? null
      : {
          evidenceSnapshotId: String(row.evidenceSnapshotId),
          evidenceSnapshotHash: String(row.evidenceSnapshotHash),
          requestSnapshotId: String(row.requestSnapshotId),
          request: requestPayload,
          requestHash: String(row.requestHash),
          recommendationId: nullableString(
            snapshotOpportunity.recommendationId,
          ),
          profileVersionId: nullableString(snapshotProject.profileVersionId),
          promotionTargetVersionId: nullableString(
            snapshotProject.promotionTargetVersionId,
          ),
          opportunityVersion: nullableNumber(snapshotOpportunity.version),
          contactId: String(row.snapshotContactId),
          contactVersion: Number(row.snapshotContactVersion),
          createdAt: asIsoString(row.evidenceSnapshotCreatedAt),
        };
  const freshness = deriveDraftFreshness({
    snapshotProfileVersionId: inputSnapshot?.profileVersionId ?? null,
    currentProfileVersionId: nullableString(row.currentProfileVersionId),
    snapshotPromotionTargetVersionId:
      inputSnapshot?.promotionTargetVersionId ?? null,
    currentPromotionTargetVersionId: nullableString(
      row.currentPromotionTargetVersionId,
    ),
    snapshotOpportunityVersion: inputSnapshot?.opportunityVersion ?? null,
    currentOpportunityVersion: nullableNumber(row.currentOpportunityVersion),
    snapshotContactId: inputSnapshot?.contactId ?? null,
    snapshotContactVersion: inputSnapshot?.contactVersion ?? null,
    currentContactId: nullableString(row.currentContactId),
    currentContactVersion: nullableNumber(row.currentContactVersion),
    currentContactUsable: row.currentContactUsable === true,
  });
  return {
    draftId: String(row.draftId),
    opportunityId: String(row.opportunityId),
    contactId: row.contactId === null ? null : String(row.contactId),
    contactVersion:
      row.contactVersion === null ? null : Number(row.contactVersion),
    status: row.status as DraftSnapshot["status"],
    draftVersion: Number(row.draftVersion),
    approvedVersionId:
      row.approvedVersionId === null ? null : String(row.approvedVersionId),
    currentVersion:
      currentVersionId === null
        ? null
        : {
            id: String(currentVersionId),
            versionNo: Number(row.currentVersionNo),
            subjectText: String(row.subjectText),
            bodyText: String(row.bodyText),
            bodyDocument: row.bodyDocument ?? null,
            source: row.source as NonNullable<
              DraftSnapshot["currentVersion"]
            >["source"],
            readiness:
              row.source === "MODEL"
                ? "AI_DRAFT_READY"
                : row.source === "TEMPLATE_FALLBACK"
                  ? "BASIC_DRAFT_READY"
                  : "EDITED_DRAFT_READY",
            fallbackReason:
              row.currentVersionFallbackReason === null ||
              row.currentVersionFallbackReason === undefined
                ? null
                : String(row.currentVersionFallbackReason),
            createdAt:
              row.currentVersionCreatedAt instanceof Date
                ? row.currentVersionCreatedAt.toISOString()
                : String(row.currentVersionCreatedAt),
          },
    inputSnapshot,
    freshness,
  };
};

export function createDraftGenerationRepository(
  client: DraftGenerationQueryClient,
): DraftGenerationRepository {
  const getJob = async (
    input: Scope & Readonly<{ runId: string }>,
  ): Promise<DraftGenerationJob> => {
    const result = await client.query(
      `
      SELECT r.id AS "runId", r.draft_id AS "draftId", r.status, false started,
        r.opportunity_id AS "opportunityId",
        r.contact_id AS "contactId",
        r.contact_version AS "contactVersion",
        r.evidence_snapshot_id AS "evidenceSnapshotId",
        r.request_snapshot_id AS "requestSnapshotId",
        request.request_payload AS request,
        CASE
          WHEN r.provider_ref='template-fallback' THEN 'TEMPLATE_FALLBACK'
          WHEN r.status='SUCCEEDED' THEN 'AI'
          ELSE NULL
        END AS generator,
        r.prompt_version AS "promptVersion",
        r.output_schema_version AS "outputSchemaVersion",
        r.base_draft_version AS "baseDraftVersion",
        v.id AS "versionId",
        d.last_successful_version_id AS "lastSuccessfulVersionId",
        r.created_at AS "queuedAt",
        r.started_at AS "startedAt",
        r.finished_at AS "finishedAt",
        r.latency_ms AS "latencyMs",
        r.attempt_count AS "attemptCount",
        COALESCE(r.error_code,r.error_class) AS "lastErrorCategory",
        NULLIF(r.quality_result->>'providerDiagnosticCode','')
          AS "diagnosticCode",
        NULLIF(r.quality_result->>'fallbackReason','') AS "fallbackReason",
        CASE
          WHEN (r.quality_result->>'persistenceLatencyMs') ~ '^[0-9]+$'
          THEN (r.quality_result->>'persistenceLatencyMs')::integer
          ELSE NULL
        END AS "persistenceLatencyMs"
      FROM backlink_model_runs r
      JOIN backlink_email_drafts d ON
        (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
        (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
      LEFT JOIN backlink_draft_request_snapshots request ON
        (request.organization_id,request.workspace_id,
         request.website_project_id,request.id)=
        (r.organization_id,r.workspace_id,r.website_project_id,
         r.request_snapshot_id)
      LEFT JOIN backlink_draft_versions v ON
        (v.organization_id,v.workspace_id,v.website_project_id,v.model_run_id)=
        (r.organization_id,r.workspace_id,r.website_project_id,r.id)
      WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
        ($1,$2,$3,$4)
    `,
      [...scopeValues(input), input.runId],
    );
    return asJob(result.rows[0], "Draft generation Job was not found.");
  };

  return {
    async prepareEvidenceSnapshot(input) {
      const source = await client.query(
        `
        SELECT
          p.canonical_domain AS "canonicalDomain",
          p.locale,
          p.country_code AS "countryCode",
          p.profile_version_id AS "profileVersionId",
          p.promotion_target_version_id AS "promotionTargetVersionId",
          p.products,
          p.keywords,
          p.target_urls AS "targetUrls",
          p.created_at AS "projectContextCreatedAt",
          o.recommendation_id AS "recommendationId",
          o.target_host_ascii AS "targetHost",
          o.version AS "opportunityVersion",
          o.updated_at AS "opportunityUpdatedAt",
          COALESCE(types.method_keys,'other') AS "cooperationType",
          c.normalized_email AS "normalizedEmail",
          COALESCE(NULLIF(c.observed_role,''),c.contact_role)
            AS "contactRole",
          c.inferred_purpose AS "contactPurpose",
          c.purpose_confidence AS "purposeConfidence",
          c.purpose_evidence AS "purposeEvidence",
          c.confidence AS "contactConfidence",
          candidate.domain_relation AS "contactDomainRelation",
          score.total_score::double precision AS "recommendationScore",
          score.components AS "recommendationComponents",
          score.evidence AS "recommendationEvidence",
          commercial.source_types AS "commercialSourceTypes",
          commercial.static_assessment AS "commercialStaticAssessment",
          commercial.gate_decision AS "commercialGateDecision",
          commercial.commercial_score AS "commercialScore",
          commercial.provider_collected_at AS "providerCollectedAt",
          public_contact.source_url AS "publicSourceUrl",
          public_contact.evidence_snippet AS "publicEvidenceSnippet",
          public_contact.extraction_method AS "publicExtractionMethod",
          public_contact.confidence AS "publicEvidenceConfidence",
          public_contact.observed_at AS "publicEvidenceObservedAt",
          public_contact.parser_version AS "publicParserVersion",
          recommendation_selection.after_state->>'poolContractVersion'
            AS "poolContractVersion",
          recommendation_selection.after_state->>'recommendationFeedItemId'
            AS "recommendationFeedItemId",
          recommendation_selection.after_state->>'generationContractId'
            AS "generationContractId",
          recommendation_selection.after_state->>'inputPinId' AS "inputPinId",
          recommendation_selection.after_state->>'immutableFingerprint'
            AS "immutableFingerprint",
          recommendation_selection.after_state->>'selectedTargetUrl'
            AS "selectedTargetUrl",
          recommendation_selection.after_state->>'recommendationMarkerVersion'
            AS "recommendationMarkerVersion",
          recommendation_selection.after_state->>'selectionPolicyVersion'
            AS "selectionPolicyVersion",
          recommendation_selection.created_at AS "recommendationSelectedAt",
          c.updated_at AS "contactUpdatedAt"
        FROM backlink_opportunities o
        JOIN backlink_contacts c ON
          (c.organization_id,c.workspace_id,c.website_project_id,
           c.prospect_id,c.recommendation_context_version_id)=
          (o.organization_id,o.workspace_id,o.website_project_id,
           o.prospect_id,o.recommendation_context_version_id)
          AND c.id=$5 AND c.version=$6
          AND c.status='active' AND c.guessed=false
          AND c.invalidated_at IS NULL
        JOIN LATERAL (
          SELECT context.*
          FROM backlink_project_context_snapshots context
          WHERE (
            context.organization_id,
            context.workspace_id,
            context.website_project_id
          )=(o.organization_id,o.workspace_id,o.website_project_id)
            AND context.project_status='ACTIVE'
          ORDER BY context.snapshot_version DESC
          LIMIT 1
        ) p ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(t.method_key,',' ORDER BY t.method_key)
            AS method_keys
          FROM backlink_opportunity_cooperation_types t
          WHERE (t.organization_id,t.workspace_id,t.website_project_id,
                 t.opportunity_id)=
            (o.organization_id,o.workspace_id,o.website_project_id,o.id)
        ) types ON true
        LEFT JOIN backlink_contact_candidates candidate ON
          (candidate.organization_id,candidate.workspace_id,
           candidate.website_project_id,candidate.id)=
          (c.organization_id,c.workspace_id,c.website_project_id,
           c.source_candidate_id)
        LEFT JOIN LATERAL (
          SELECT s.total_score,s.components,s.evidence
          FROM backlink_recommendation_scores s
          WHERE (s.organization_id,s.workspace_id,s.website_project_id,
                 s.recommendation_id)=
            (o.organization_id,o.workspace_id,o.website_project_id,
             o.recommendation_id)
            AND s.score_model_version='recommendation-commercial-fit.v3'
          ORDER BY s.generated_at DESC,s.id DESC
          LIMIT 1
        ) score ON true
        LEFT JOIN LATERAL (
          SELECT candidate.source_types,candidate.static_assessment,
                 candidate.gate_decision,candidate.commercial_score,
                 candidate.provider_collected_at
          FROM backlink_commercial_candidates candidate
          WHERE (
            candidate.organization_id,candidate.workspace_id,
            candidate.website_project_id,candidate.recommendation_id
          )=(
            o.organization_id,o.workspace_id,o.website_project_id,
            o.recommendation_id
          )
            AND candidate.score_model_version=
              'recommendation-commercial-fit.v3'
            AND candidate.commercial_score->>'decision'='eligible'
          ORDER BY candidate.updated_at DESC,candidate.id DESC
          LIMIT 1
        ) commercial ON true
        LEFT JOIN LATERAL (
          SELECT e.source_url,e.evidence_snippet,e.extraction_method,
                 e.confidence,e.observed_at,e.parser_version
          FROM backlink_contact_evidence e
          WHERE (e.organization_id,e.workspace_id,e.website_project_id,
                 e.candidate_id)=
            (c.organization_id,c.workspace_id,c.website_project_id,
             c.source_candidate_id)
            AND e.invalidated_at IS NULL
          ORDER BY e.confidence DESC,e.observed_at DESC,e.id DESC
          LIMIT 1
        ) public_contact ON true
        LEFT JOIN LATERAL (
          SELECT event.after_state,event.created_at
          FROM backlink_lifecycle_events event
          WHERE (
            event.organization_id,event.workspace_id,event.website_project_id,
            event.aggregate_id
          )=(
            o.organization_id,o.workspace_id,o.website_project_id,o.id
          )
            AND event.aggregate_type='opportunity'
            AND event.event_type='opportunity.created'
            AND event.after_state->>'poolContractVersion'=
              'recommendation-pool.v2'
          ORDER BY event.sequence DESC,event.id DESC
          LIMIT 1
        ) recommendation_selection ON true
        WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)=
          ($1,$2,$3,$4)
      `,
        [
          ...scopeValues(input),
          input.opportunityId,
          input.contactId,
          input.contactVersion,
        ],
      );
      const row = source.rows[0];
      if (row === undefined) {
        throw new Error("Draft Contact is unavailable or version is stale.");
      }

      const canonicalDomain = nonBlank(row.canonicalDomain, "");
      if (canonicalDomain === "") {
        throw new Error("Draft resource was not found in this project.");
      }
      const projectObservedAt = asIsoString(row.projectContextCreatedAt);
      const opportunityObservedAt = asIsoString(row.opportunityUpdatedAt);
      const contactObservedAt = asIsoString(row.contactUpdatedAt);
      const marketing = projectMarketingContext(
        row,
        input.request.promotionTargetUrl,
      );
      const requestHash = createHash("sha256")
        .update(JSON.stringify(input.request))
        .digest("hex");
      const requestStored = await client.query(
        `
        WITH inserted AS (
          INSERT INTO backlink_draft_request_snapshots (
            id,organization_id,workspace_id,website_project_id,opportunity_id,
            contact_id,contact_version,request_payload,request_hash,
            schema_version,created_at,created_by
          ) VALUES (
            $5,$1,$2,$3,$4,$6,$7,$8::jsonb,$9,1,$10,$11
          )
          ON CONFLICT (
            organization_id,workspace_id,website_project_id,opportunity_id,
            contact_id,contact_version,request_hash
          ) DO NOTHING
          RETURNING id,true AS inserted,created_at AS "createdAt"
        )
        SELECT id AS "snapshotId",inserted,"createdAt" FROM inserted
        UNION ALL
        SELECT r.id AS "snapshotId",false AS inserted,
          r.created_at AS "createdAt"
        FROM backlink_draft_request_snapshots r
        WHERE (
          r.organization_id,r.workspace_id,r.website_project_id,
          r.opportunity_id,r.contact_id,r.contact_version,r.request_hash
        )=($1,$2,$3,$4,$6,$7,$9)
          AND NOT EXISTS (SELECT 1 FROM inserted)
        LIMIT 1
      `,
        [
          ...scopeValues(input),
          input.opportunityId,
          input.requestSnapshotId,
          input.contactId,
          input.contactVersion,
          JSON.stringify(input.request),
          requestHash,
          input.recordedAt,
          input.actorId,
        ],
      );
      const requestRow = requestStored.rows[0];
      if (requestRow === undefined) {
        throw new Error("Draft Request Snapshot could not be persisted.");
      }
      const requestObservedAt = asIsoString(requestRow.createdAt);
      const isRecommendationPoolV2 =
        row.poolContractVersion === "recommendation-pool.v2";
      const recommendationSelection = isRecommendationPoolV2
        ? {
            contractVersion: String(row.poolContractVersion),
            recommendationFeedItemId: String(row.recommendationFeedItemId),
            generationContractId: String(row.generationContractId),
            inputPinId: String(row.inputPinId),
            immutableFingerprint: String(row.immutableFingerprint),
            selectedTargetUrl: String(row.selectedTargetUrl),
            recommendationMarkerVersion: String(
              row.recommendationMarkerVersion,
            ),
            selectionPolicyVersion: String(row.selectionPolicyVersion),
          }
        : null;
      const evidence = [
        evidenceItem({
          id: "profile:current",
          sourceKind: "PROFILE",
          value: [
            `Project site ${canonicalDomain}`,
            `locale ${String(row.locale)}`,
            `country ${String(row.countryCode)}`,
            `products ${marketing.products.join(", ")}`,
            `keywords ${marketing.keywords.join(", ") || "not recorded"}`,
          ].join("; "),
          observedAt: projectObservedAt,
          dataVersion: `profile:${String(row.profileVersionId)}`,
        }),
        evidenceItem({
          id: "promotion-target:current",
          sourceKind: "PROMOTION_TARGET",
          value: `Promotion target ${marketing.targetUrl}`,
          observedAt: projectObservedAt,
          dataVersion: `promotion-target:${String(row.promotionTargetVersionId)}`,
        }),
        evidenceItem({
          id: "opportunity:current",
          sourceKind: "OPPORTUNITY",
          value: [
            `Target host ${String(row.targetHost)}`,
            `cooperation ${String(row.cooperationType)}`,
            isRecommendationPoolV2
              ? "Selected from an entitled recommendation release"
              : recommendationReason(row),
          ].join("; "),
          observedAt: opportunityObservedAt,
          dataVersion: `opportunity:v${Number(row.opportunityVersion)}`,
        }),
        ...(recommendationSelection === null
          ? [
              evidenceItem({
                id: "target-context:current",
                sourceKind: "ASSESSMENT",
                value: [
                  `topic and audience ${summarizeStructuredValue(
                    row.recommendationComponents,
                  )}`,
                  `candidate pages ${summarizeStructuredValue(
                    row.recommendationEvidence,
                  )}`,
                  `commercial assessment ${summarizeStructuredValue(
                    row.commercialScore,
                  )}`,
                  `commercial gate ${summarizeStructuredValue(
                    row.commercialGateDecision,
                  )}`,
                  `provider facts ${summarizeStructuredValue(
                    row.commercialStaticAssessment,
                  )}`,
                ].join("; "),
                observedAt: opportunityObservedAt,
                dataVersion: "target-context.v1",
              }),
            ]
          : [
              evidenceItem({
                id: "recommendation-selection:v2",
                sourceKind: "OPPORTUNITY",
                value: [
                  `Feed item ${recommendationSelection.recommendationFeedItemId}`,
                  `target ${recommendationSelection.selectedTargetUrl}`,
                  `selection fingerprint ${
                    recommendationSelection.immutableFingerprint
                  }`,
                ].join("; "),
                observedAt: asIsoString(row.recommendationSelectedAt),
                dataVersion:
                  `${recommendationSelection.recommendationMarkerVersion}:` +
                  recommendationSelection.selectionPolicyVersion,
              }),
            ]),
        evidenceItem({
          id: "contact:confirmed",
          sourceKind: "CONTACT",
          value: [
            `Confirmed contact role ${nonBlank(row.contactRole, "contact")}`,
            `purpose ${nonBlank(row.contactPurpose, "unknown")}`,
            `purpose confidence ${Number(row.purposeConfidence ?? 0)}`,
            `contact confidence ${Number(row.contactConfidence ?? 0)}`,
            `domain relation ${nonBlank(row.contactDomainRelation, "unknown")}`,
            `purpose evidence ${summarizeStructuredValue(row.purposeEvidence)}`,
          ].join("; "),
          observedAt: contactObservedAt,
          dataVersion: `contact:v${input.contactVersion}`,
        }),
        ...(row.publicSourceUrl === null || row.publicSourceUrl === undefined
          ? []
          : [
              evidenceItem({
                id: "target-public-content:contact",
                sourceKind: "ASSESSMENT",
                value: targetPublicContent(row),
                observedAt: asIsoString(row.publicEvidenceObservedAt),
                dataVersion: `contact-public:${nonBlank(row.publicParserVersion, "v1")}`,
              }),
            ]),
        evidenceItem({
          id: "user-input:request",
          sourceKind: "USER_INPUT",
          value: [
            `cooperation ${input.request.cooperationType}`,
            `link preference ${input.request.linkAttributePreference}`,
            `promotion target ${input.request.promotionTargetUrl}`,
            `anchor suggestion ${
              input.request.anchorTextSuggestion ?? "not specified"
            }`,
            `language ${input.request.language}`,
            `tone ${input.request.tone}`,
            `subject style ${input.request.subjectStyle}`,
            `additional requirements ${
              input.request.additionalRequirements || "not specified"
            }`,
            `forbidden phrases ${
              input.request.forbiddenPhrases.join(", ") || "not specified"
            }`,
          ].join("; "),
          observedAt: requestObservedAt,
          dataVersion: "draft-request.v1",
        }),
      ].sort((left, right) => left.id.localeCompare(right.id));
      const contextData = {
        project: {
          canonicalDomain,
          locale: nonBlank(row.locale, ""),
          countryCode: nonBlank(row.countryCode, ""),
          profileVersionId: String(row.profileVersionId),
          promotionTargetVersionId: String(row.promotionTargetVersionId),
          products: marketing.products,
          keywords: marketing.keywords,
          targetMarkets: marketing.targetMarkets,
          targetUrls: readStringList(row.targetUrls),
        },
        opportunity: {
          recommendationId: String(row.recommendationId),
          version: Number(row.opportunityVersion),
          targetHost: String(row.targetHost),
          cooperationType: String(row.cooperationType),
          recommendationReason: isRecommendationPoolV2
            ? "Selected from an entitled recommendation release"
            : recommendationReason(row),
          targetPublicContent: targetPublicContent(row),
          targetContext:
            recommendationSelection === null
              ? {
                  sourceTypes: row.commercialSourceTypes ?? [],
                  staticAssessment: row.commercialStaticAssessment ?? {},
                  gateDecision: row.commercialGateDecision ?? {},
                  commercialScore: row.commercialScore ?? {},
                  providerCollectedAt: row.providerCollectedAt ?? null,
                }
              : { recommendationPoolV2: recommendationSelection },
        },
        contact: {
          id: input.contactId,
          version: input.contactVersion,
          displayName: nonBlank(row.contactRole, "Contact"),
          role: nonBlank(row.contactRole, "contact"),
          purpose: nonBlank(row.contactPurpose, "unknown"),
          purposeEvidence: [
            `confidence ${Number(row.purposeConfidence ?? 0)}`,
            `contact confidence ${Number(row.contactConfidence ?? 0)}`,
            `domain relation ${nonBlank(row.contactDomainRelation, "unknown")}`,
            summarizeStructuredValue(row.purposeEvidence),
          ].join("; "),
        },
        forbiddenValues: [
          String(row.normalizedEmail),
          ...input.request.forbiddenPhrases,
        ],
      };
      const snapshotHash = createHash("sha256")
        .update(
          JSON.stringify({
            evidence,
            contextData,
            requestSnapshotId: String(requestRow.snapshotId),
          }),
        )
        .digest("hex");
      const stored = await client.query(
        `
        WITH inserted AS (
          INSERT INTO backlink_evidence_snapshots (
            id,organization_id,workspace_id,website_project_id,opportunity_id,
            evidence_items,context_data,snapshot_hash,schema_version,
            created_at,created_by
          ) VALUES ($5,$1,$2,$3,$4,$6::jsonb,$7::jsonb,$8,2,$9,$10)
          ON CONFLICT (
            organization_id,workspace_id,website_project_id,opportunity_id,
            snapshot_hash
          ) DO NOTHING
          RETURNING id,true AS inserted
        )
        SELECT id AS "snapshotId",inserted FROM inserted
        UNION ALL
        SELECT e.id AS "snapshotId",false AS inserted
        FROM backlink_evidence_snapshots e
        WHERE (
          e.organization_id,e.workspace_id,e.website_project_id,
          e.opportunity_id,e.snapshot_hash
        )=($1,$2,$3,$4,$8)
          AND NOT EXISTS (SELECT 1 FROM inserted)
        LIMIT 1
      `,
        [
          ...scopeValues(input),
          input.opportunityId,
          input.snapshotId,
          JSON.stringify(evidence),
          JSON.stringify(contextData),
          snapshotHash,
          input.recordedAt,
          input.actorId,
        ],
      );
      const storedRow = stored.rows[0];
      if (storedRow === undefined) {
        throw new Error("Draft Evidence Snapshot could not be persisted.");
      }
      return {
        snapshotId: String(storedRow.snapshotId),
        requestSnapshotId: String(requestRow.snapshotId),
        replayed: storedRow.inserted !== true,
      };
    },

    async createJob(input) {
      await client.query(
        `
        WITH eligible_contact AS (
          SELECT c.id,c.version
          FROM backlink_opportunities o
          JOIN backlink_contacts c ON
            (c.organization_id,c.workspace_id,c.website_project_id,
             c.prospect_id,c.recommendation_context_version_id)=
            (o.organization_id,o.workspace_id,o.website_project_id,
             o.prospect_id,o.recommendation_context_version_id)
          WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)=
            ($1,$2,$3,$4)
            AND c.id=$15 AND c.version=$16
            AND c.status='active' AND c.guessed=false
            AND c.invalidated_at IS NULL
        ), inserted_draft AS (
          INSERT INTO backlink_email_drafts (
            id,organization_id,workspace_id,website_project_id,opportunity_id,
            contact_id,contact_version,logical_draft_key,status,
            created_at,updated_at,created_by,updated_by
          )
          SELECT $5,$1,$2,$3,$4,c.id,c.version,$6,'generating',
            $13,$13,$12,$12
          FROM eligible_contact c
          ON CONFLICT (workspace_id,logical_draft_key) DO NOTHING
          RETURNING *
        ), target_draft AS (
          SELECT * FROM inserted_draft
          UNION ALL
          SELECT d.* FROM backlink_email_drafts d
          WHERE (d.organization_id,d.workspace_id,d.website_project_id,
                 d.opportunity_id,d.logical_draft_key)=($1,$2,$3,$4,$6)
            AND d.contact_id=$15 AND d.contact_version=$16
            AND NOT EXISTS (SELECT 1 FROM inserted_draft)
        ), inserted_run AS (
          INSERT INTO backlink_model_runs (
            id,organization_id,workspace_id,website_project_id,draft_id,
            opportunity_id,contact_id,contact_version,evidence_snapshot_id,
            request_snapshot_id,idempotency_key,request_hash,status,prompt_version,
            output_schema_version,base_draft_version,
            quality_result,created_at,updated_at,created_by,updated_by
          )
          SELECT $7,$1,$2,$3,d.id,$4,d.contact_id,d.contact_version,$8,$18,$9,$10,
            'QUEUED',$11,$14,d.version,$17::jsonb,$13,$13,$12,$12
          FROM target_draft d
          ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
          RETURNING id
        )
        SELECT id FROM inserted_run
      `,
        [
          ...scopeValues(input),
          input.opportunityId,
          input.draftId,
          input.logicalDraftKey,
          input.runId,
          input.evidenceSnapshotId,
          input.idempotencyKey,
          input.requestHash,
          input.promptVersion,
          input.actorId,
          input.recordedAt,
          input.outputSchemaVersion,
          input.contactId,
          input.contactVersion,
          JSON.stringify({
            generationMode: input.generationMode,
            requiresUserConfirmation: true,
            canAutoSend: false,
          }),
          input.requestSnapshotId,
        ],
      );
      const result = await client.query(
        `
        SELECT r.id AS "runId",r.draft_id AS "draftId",r.status,false started,
          r.opportunity_id AS "opportunityId",
          r.contact_id AS "contactId",
          r.contact_version AS "contactVersion",
          r.evidence_snapshot_id AS "evidenceSnapshotId",
          r.request_snapshot_id AS "requestSnapshotId",
          request.request_payload AS request,
          CASE
            WHEN r.provider_ref='template-fallback' THEN 'TEMPLATE_FALLBACK'
            WHEN r.status='SUCCEEDED' THEN 'AI'
            ELSE NULL
          END AS generator,
          r.prompt_version AS "promptVersion",
          r.output_schema_version AS "outputSchemaVersion",
          r.base_draft_version AS "baseDraftVersion",
          v.id AS "versionId",
          d.last_successful_version_id AS "lastSuccessfulVersionId",
          r.request_hash AS "requestHash",
          r.created_at AS "queuedAt",
          r.started_at AS "startedAt",
          r.finished_at AS "finishedAt",
          r.latency_ms AS "latencyMs",
          r.attempt_count AS "attemptCount",
          COALESCE(r.error_code,r.error_class) AS "lastErrorCategory",
          NULLIF(r.quality_result->>'providerDiagnosticCode','')
            AS "diagnosticCode",
          NULLIF(r.quality_result->>'fallbackReason','') AS "fallbackReason",
          CASE
            WHEN (r.quality_result->>'persistenceLatencyMs') ~ '^[0-9]+$'
            THEN (r.quality_result->>'persistenceLatencyMs')::integer
            ELSE NULL
          END AS "persistenceLatencyMs"
        FROM backlink_model_runs r
        JOIN backlink_email_drafts d ON
          (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
        LEFT JOIN backlink_draft_request_snapshots request ON
          (request.organization_id,request.workspace_id,
           request.website_project_id,request.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,
           r.request_snapshot_id)
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.model_run_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.id)
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,
               r.idempotency_key)=($1,$2,$3,$4)
      `,
        [...scopeValues(input), input.idempotencyKey],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Draft Contact is unavailable or version is stale.");
      }
      if (row.requestHash !== input.requestHash) {
        throw new Error("Idempotency key payload mismatch.");
      }
      return asJob(row, "Draft generation Job was not found.");
    },

    async claimJob(input) {
      const result = await client.query(
        `
        WITH timing AS MATERIALIZED (
          SELECT clock_timestamp() AS started_at
        ), started AS (
          UPDATE backlink_model_runs AS run
          SET status='RUNNING',attempt_count=attempt_count+1,
            started_at=timing.started_at,finished_at=NULL,
            error_class=NULL,error_code=NULL,
            updated_at=timing.started_at,updated_by=$5
          FROM timing
          WHERE (
            run.organization_id,run.workspace_id,run.website_project_id,run.id
          )=
            ($1,$2,$3,$4) AND status IN ('QUEUED','RETRY_SCHEDULED')
          RETURNING run.id,run.status,run.started_at,run.finished_at,
            run.attempt_count,run.error_class,run.error_code
        )
        SELECT r.id AS "runId",r.draft_id AS "draftId",
          COALESCE(s.status,r.status) AS status,
          (s.id IS NOT NULL) started,
          r.opportunity_id AS "opportunityId",
          r.contact_id AS "contactId",
          r.contact_version AS "contactVersion",
          r.evidence_snapshot_id AS "evidenceSnapshotId",
          r.request_snapshot_id AS "requestSnapshotId",
          request.request_payload AS request,
          CASE
            WHEN r.provider_ref='template-fallback' THEN 'TEMPLATE_FALLBACK'
            WHEN r.status='SUCCEEDED' THEN 'AI'
            ELSE NULL
          END AS generator,
          r.prompt_version AS "promptVersion",
          r.output_schema_version AS "outputSchemaVersion",
          r.base_draft_version AS "baseDraftVersion",
          v.id AS "versionId",
          d.last_successful_version_id AS "lastSuccessfulVersionId",
          r.created_at AS "queuedAt",
          COALESCE(s.started_at,r.started_at) AS "startedAt",
          CASE
            WHEN s.id IS NOT NULL THEN s.finished_at
            ELSE r.finished_at
          END AS "finishedAt",
          r.latency_ms AS "latencyMs",
          COALESCE(s.attempt_count,r.attempt_count) AS "attemptCount",
          CASE
            WHEN s.id IS NOT NULL THEN COALESCE(s.error_code,s.error_class)
            ELSE COALESCE(r.error_code,r.error_class)
          END AS "lastErrorCategory",
          NULLIF(r.quality_result->>'providerDiagnosticCode','')
            AS "diagnosticCode",
          NULLIF(r.quality_result->>'fallbackReason','') AS "fallbackReason",
          CASE
            WHEN (r.quality_result->>'persistenceLatencyMs') ~ '^[0-9]+$'
            THEN (r.quality_result->>'persistenceLatencyMs')::integer
            ELSE NULL
          END AS "persistenceLatencyMs"
        FROM backlink_model_runs r
        JOIN backlink_email_drafts d ON
          (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
        LEFT JOIN backlink_draft_request_snapshots request ON
          (request.organization_id,request.workspace_id,
           request.website_project_id,request.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,
           r.request_snapshot_id)
        LEFT JOIN started s ON s.id=r.id
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.model_run_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.id)
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
          ($1,$2,$3,$4)
      `,
        [...scopeValues(input), input.runId, input.actorId],
      );
      return asJob(result.rows[0], "Draft generation Job was not found.");
    },

    async loadPromptContext(input) {
      const result = await client.query(
        `
        SELECT
          r.opportunity_id AS "opportunityId",
          r.evidence_snapshot_id AS "evidenceSnapshotId",
          r.request_snapshot_id AS "requestSnapshotId",
          r.prompt_version AS "promptVersion",
          r.output_schema_version AS "outputSchemaVersion",
          e.evidence_items AS "evidenceItems",
          e.context_data AS "contextData",
          e.schema_version AS "evidenceSchemaVersion",
          e.created_at AS "evidenceCreatedAt",
          request.request_payload AS request
        FROM backlink_model_runs r
        JOIN backlink_evidence_snapshots e ON
          (e.organization_id,e.workspace_id,e.website_project_id,
           e.id,e.opportunity_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,
           r.evidence_snapshot_id,r.opportunity_id)
        JOIN backlink_draft_request_snapshots request ON
          (request.organization_id,request.workspace_id,
           request.website_project_id,request.id,request.opportunity_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,
           r.request_snapshot_id,r.opportunity_id)
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
          ($1,$2,$3,$4)
          AND r.status='RUNNING'
      `,
        [...scopeValues(input), input.runId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Draft generation context is unavailable.");
      }
      const observedAt = asIsoString(row.evidenceCreatedAt);
      const evidenceItems = Array.isArray(row.evidenceItems)
        ? row.evidenceItems
        : [];
      const scope = {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        opportunityId: String(row.opportunityId),
      };
      const approvedEvidence = approveDraftEvidence(
        {
          ...scope,
          id: String(row.evidenceSnapshotId),
          evidence: evidenceItems.map((item, index) =>
            asEvidence(item, index, {
              observedAt,
              dataVersion: `evidence-snapshot.v${Number(
                row.evidenceSchemaVersion,
              )}`,
            }),
          ),
        },
        scope,
      );
      const contextData = readRecord(row.contextData);
      const project = readRecord(contextData.project);
      const opportunity = readRecord(contextData.opportunity);
      const contact = readRecord(contextData.contact);
      const request = draftRequestSchema.parse(row.request);
      const canonicalDomain = nonBlank(project.canonicalDomain, "");
      if (canonicalDomain === "") {
        throw new Error("Project Profile is unavailable for Draft generation.");
      }
      return {
        prompt: buildDraftPrompt({
          ...scope,
          evidenceSnapshotId: String(row.evidenceSnapshotId),
          promptVersion: String(row.promptVersion),
          outputSchemaVersion: String(row.outputSchemaVersion),
          project: {
            siteName: canonicalDomain,
            siteSummary: [
              `Profile ${String(project.profileVersionId)}`,
              `locale ${String(project.locale)}`,
              `country ${String(project.countryCode)}`,
            ].join("; "),
            products: readStringList(project.products),
            targetMarkets: readStringList(project.targetMarkets),
            keywords: readStringList(project.keywords),
          },
          promotionTarget: {
            label: `Promotion target ${String(
              project.promotionTargetVersionId,
            )}`,
            url: request.promotionTargetUrl,
          },
          opportunity: {
            targetHost: String(opportunity.targetHost),
            cooperationType: request.cooperationType,
            recommendationReason: String(opportunity.recommendationReason),
            targetPublicContent: String(opportunity.targetPublicContent),
          },
          contact: {
            displayName: nonBlank(contact.displayName, "Contact"),
            role: nonBlank(contact.role, "contact"),
            purpose: nonBlank(contact.purpose, "unknown"),
            purposeEvidence: nonBlank(
              contact.purposeEvidence,
              "confirmed contact",
            ),
          },
          preferences: {
            cooperationType: request.cooperationType,
            linkAttributePreference: request.linkAttributePreference,
            promotionTargetUrl: request.promotionTargetUrl,
            anchorTextSuggestion: request.anchorTextSuggestion ?? null,
            language: request.language,
            tone: request.tone,
            subjectStyle: request.subjectStyle,
            additionalRequirements: request.additionalRequirements,
            forbiddenPhrases: request.forbiddenPhrases,
          },
          approvedEvidence,
        }),
        approvedEvidence,
        forbiddenValues: readStringList(contextData.forbiddenValues),
      };
    },

    async completeJob(input) {
      const evidenceIds = [
        ...new Set(
          input.result.output.factsUsed.flatMap((claim) => claim.evidenceIds),
        ),
      ].sort();
      const structuredOutput = {
        ...input.result.output,
        evidenceRefs: evidenceIds,
      };
      const result = await client.query(
        `
        WITH timing AS MATERIALIZED (
          SELECT clock_timestamp() AS finished_at
        ), target AS (
          SELECT r.*,d.version AS current_draft_version,
            d.current_version_id
          FROM backlink_model_runs r
          JOIN backlink_email_drafts d ON
            (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
          WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
            ($1,$2,$3,$4) AND r.status='RUNNING'
          FOR UPDATE OF r,d
        ), next_version AS (
          SELECT COALESCE(max(v.version_no),0)+1 AS value
          FROM target t
          LEFT JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,v.draft_id)=
            (t.organization_id,t.workspace_id,t.website_project_id,t.draft_id)
        ), inserted AS (
          INSERT INTO backlink_draft_versions (
            id,organization_id,workspace_id,website_project_id,draft_id,
            opportunity_id,contact_id,contact_version,version_no,
            parent_version_id,source,model_run_id,evidence_snapshot_id,
            request_snapshot_id,
            subject_text,body_text,structured_output,
            evidence_ids,prompt_version,output_schema_version,model_id,
            model_version,requires_user_confirmation,can_auto_send,
            created_at,created_by
          )
          SELECT $5,t.organization_id,t.workspace_id,t.website_project_id,
            t.draft_id,t.opportunity_id,t.contact_id,t.contact_version,n.value,
            t.current_version_id,$19,t.id,t.evidence_snapshot_id,
            t.request_snapshot_id,
            $6,$7,$8::jsonb,$9::jsonb,
            t.prompt_version,t.output_schema_version,
            $10,$11,
            true,false,timing.finished_at,$16
          FROM target t
          JOIN next_version n ON true
          CROSS JOIN timing
          RETURNING id,draft_id,version_no
        ), updated_run AS (
          UPDATE backlink_model_runs r
          SET status='SUCCEEDED',provider_ref=$12,model_id=$10,
            model_version=$11,input_tokens=$13,output_tokens=$14,
            estimated_cost_usd=$20,latency_ms=$15,repair_count=$18,
            quality_result=$21::jsonb || jsonb_build_object(
              'persistenceLatencyMs',
              GREATEST(
                0,
                floor(
                  extract(epoch FROM (
                    timing.finished_at-$17::timestamptz
                  ))*1000
                )::integer
              )
            ),
            finished_at=timing.finished_at,
            updated_at=timing.finished_at,updated_by=$16
          FROM inserted i
          CROSS JOIN timing
          WHERE r.id=$4
          RETURNING r.id
        ), updated_draft AS (
          UPDATE backlink_email_drafts d
          SET current_version_id=CASE
                WHEN d.version=t.base_draft_version THEN i.id
                ELSE d.current_version_id
              END,
            last_successful_version_id=i.id,
            status=CASE
                WHEN d.version=t.base_draft_version THEN 'draft'
                ELSE d.status
              END,
            version=d.version+1,
            updated_at=timing.finished_at,updated_by=$16
          FROM target t,inserted i,updated_run r,timing
          WHERE d.id=t.draft_id
          RETURNING d.version,
            d.current_version_id=i.id AS adopted
        )
        SELECT i.id AS "versionId",d.version AS "draftVersion",
          d.adopted AS "adoptedAsCurrent"
        FROM inserted i JOIN updated_draft d ON true
      `,
        [
          ...scopeValues(input),
          input.runId,
          input.versionId,
          input.result.output.subject,
          input.result.output.bodyText,
          JSON.stringify(structuredOutput),
          JSON.stringify(evidenceIds),
          input.result.model.modelId,
          input.result.model.modelVersion,
          input.result.model.providerRef,
          input.result.usage.inputTokens,
          input.result.usage.outputTokens,
          input.result.latencyMs,
          input.actorId,
          input.recordedAt,
          input.result.repairCount,
          input.source,
          input.result.estimatedCostUsd,
          JSON.stringify({
            passed: true,
            generationMode: input.source,
            generator: input.source === "MODEL" ? "AI" : "TEMPLATE_FALLBACK",
            requiresUserConfirmation: true,
            canAutoSend: false,
            fallbackReason: input.fallbackReason,
          }),
        ],
      );
      const row = result.rows[0] as
        | {
            versionId: string;
            draftVersion: number;
            adoptedAsCurrent: boolean;
          }
        | undefined;
      if (row === undefined) {
        throw new Error("Draft generation Job was not running.");
      }
      return row;
    },

    async failJob(input) {
      await client.query(
        `
        WITH timing AS MATERIALIZED (
          SELECT clock_timestamp() AS finished_at
        )
        UPDATE backlink_model_runs
        SET status=$6,error_class=$7,error_code=$8,
          finished_at=timing.finished_at,
          estimated_cost_usd=NULL,
          quality_result=jsonb_strip_nulls(
            (quality_result-'budgetReservationUsd')
            || jsonb_build_object(
              'providerDiagnosticCode',
              $9::text
            )
          ),
          updated_at=timing.finished_at,updated_by=$5
        FROM timing
        WHERE (organization_id,workspace_id,website_project_id,id)=
          ($1,$2,$3,$4) AND status='RUNNING'
      `,
        [
          ...scopeValues(input),
          input.runId,
          input.actorId,
          input.refused ? "REFUSED" : "FAILED",
          input.errorClass,
          input.errorCode,
          input.diagnosticCode,
        ],
      );
    },

    async scheduleRetry(input) {
      await client.query(
        `
        UPDATE backlink_model_runs
        SET status='RETRY_SCHEDULED',error_class=$6,error_code=$7,
          updated_at=$5,updated_by=$8
        WHERE (organization_id,workspace_id,website_project_id,id)=
          ($1,$2,$3,$4) AND status='RUNNING' AND attempt_count < 2
      `,
        [
          ...scopeValues(input),
          input.runId,
          input.recordedAt,
          input.errorClass,
          input.errorCode,
          input.actorId,
        ],
      );
    },

    getJob,
    async findLatestJob(input) {
      const result = await client.query(
        `
        SELECT r.id AS "runId",r.draft_id AS "draftId",r.status,false started,
          r.opportunity_id AS "opportunityId",
          r.contact_id AS "contactId",
          r.contact_version AS "contactVersion",
          r.evidence_snapshot_id AS "evidenceSnapshotId",
          r.request_snapshot_id AS "requestSnapshotId",
          request.request_payload AS request,
          CASE
            WHEN r.provider_ref='template-fallback' THEN 'TEMPLATE_FALLBACK'
            WHEN r.status='SUCCEEDED' THEN 'AI'
            ELSE NULL
          END AS generator,
          r.prompt_version AS "promptVersion",
          r.output_schema_version AS "outputSchemaVersion",
          r.base_draft_version AS "baseDraftVersion",
          v.id AS "versionId",
          d.last_successful_version_id AS "lastSuccessfulVersionId",
          r.created_at AS "queuedAt",
          r.started_at AS "startedAt",
          r.finished_at AS "finishedAt",
          r.latency_ms AS "latencyMs",
          r.attempt_count AS "attemptCount",
          COALESCE(r.error_code,r.error_class) AS "lastErrorCategory",
          NULLIF(r.quality_result->>'providerDiagnosticCode','')
            AS "diagnosticCode",
          NULLIF(r.quality_result->>'fallbackReason','') AS "fallbackReason",
          CASE
            WHEN (r.quality_result->>'persistenceLatencyMs') ~ '^[0-9]+$'
            THEN (r.quality_result->>'persistenceLatencyMs')::integer
            ELSE NULL
          END AS "persistenceLatencyMs"
        FROM backlink_email_drafts d
        JOIN backlink_model_runs r ON
          (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)=
          (d.organization_id,d.workspace_id,d.website_project_id,d.id)
        LEFT JOIN backlink_draft_request_snapshots request ON
          (request.organization_id,request.workspace_id,
           request.website_project_id,request.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,
           r.request_snapshot_id)
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.model_run_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.id)
        WHERE (d.organization_id,d.workspace_id,d.website_project_id,
               d.opportunity_id,d.logical_draft_key)=($1,$2,$3,$4,$5)
        ORDER BY r.created_at DESC,r.id DESC
        LIMIT 1
      `,
        [...scopeValues(input), input.opportunityId, input.logicalDraftKey],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : asJob(row, "Draft generation Job was not found.");
    },
    async getDraft(input) {
      const result = await client.query(
        `
        SELECT d.id AS "draftId",d.opportunity_id AS "opportunityId",
          d.contact_id AS "contactId",d.contact_version AS "contactVersion",
          d.status,d.version AS "draftVersion",
          d.approved_version_id AS "approvedVersionId",
          v.id AS "currentVersionId",v.version_no AS "currentVersionNo",
          v.subject_text AS "subjectText",v.body_text AS "bodyText",
          v.body_document AS "bodyDocument",v.source,
          v.evidence_snapshot_id AS "evidenceSnapshotId",
          v.request_snapshot_id AS "requestSnapshotId",
          evidence.snapshot_hash AS "evidenceSnapshotHash",
          evidence.context_data AS "snapshotContextData",
          evidence.created_at AS "evidenceSnapshotCreatedAt",
          request.request_payload AS "requestPayload",
          request.request_hash AS "requestHash",
          request.contact_id AS "snapshotContactId",
          request.contact_version AS "snapshotContactVersion",
          opportunity.version AS "currentOpportunityVersion",
          current_context.profile_version_id AS "currentProfileVersionId",
          current_context.promotion_target_version_id
            AS "currentPromotionTargetVersionId",
          current_contact.id AS "currentContactId",
          current_contact.version AS "currentContactVersion",
          COALESCE(
            current_contact.status='active'
            AND current_contact.guessed=false
            AND current_contact.invalidated_at IS NULL,
            false
          ) AS "currentContactUsable",
          NULLIF(r.quality_result->>'fallbackReason','')
            AS "currentVersionFallbackReason",
          v.created_at AS "currentVersionCreatedAt"
        FROM backlink_email_drafts d
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.id,v.draft_id,v.opportunity_id)=
          (d.organization_id,d.workspace_id,d.website_project_id,
           d.current_version_id,d.id,d.opportunity_id)
        LEFT JOIN backlink_model_runs r ON
          (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
          (v.organization_id,v.workspace_id,v.website_project_id,v.model_run_id)
        LEFT JOIN backlink_evidence_snapshots evidence ON
          (evidence.organization_id,evidence.workspace_id,
           evidence.website_project_id,evidence.id,
           evidence.opportunity_id)=
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.evidence_snapshot_id,v.opportunity_id)
        LEFT JOIN backlink_draft_request_snapshots request ON
          (request.organization_id,request.workspace_id,
           request.website_project_id,request.id,
           request.opportunity_id)=
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.request_snapshot_id,v.opportunity_id)
        LEFT JOIN backlink_opportunities opportunity ON
          (opportunity.organization_id,opportunity.workspace_id,
           opportunity.website_project_id,opportunity.id)=
          (d.organization_id,d.workspace_id,d.website_project_id,
           d.opportunity_id)
        LEFT JOIN backlink_contacts current_contact ON
          (current_contact.organization_id,current_contact.workspace_id,
           current_contact.website_project_id,current_contact.id)=
          (request.organization_id,request.workspace_id,
           request.website_project_id,request.contact_id)
        LEFT JOIN LATERAL (
          SELECT context.profile_version_id,
            context.promotion_target_version_id
          FROM backlink_project_context_snapshots context
          WHERE (
            context.organization_id,
            context.workspace_id,
            context.website_project_id
          )=(d.organization_id,d.workspace_id,d.website_project_id)
            AND context.project_status='ACTIVE'
          ORDER BY context.snapshot_version DESC
          LIMIT 1
        ) current_context ON true
        WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          ($1,$2,$3,$4)
      `,
        [...scopeValues(input), input.draftId],
      );
      return asDraft(result.rows[0]);
    },
  };
}

export function createDraftEditingRepository(
  client: DraftGenerationQueryClient,
  dependencies: DraftEditingRepositoryDependencies = {},
): DraftEditingRepository {
  const newId = dependencies.newId ?? randomUUID;
  const failure = async (
    input: DraftEditingMutation,
  ): Promise<DraftEditingFailure> => {
    const result = await client.query(
      `
      SELECT version
      FROM backlink_email_drafts
      WHERE (organization_id,workspace_id,website_project_id,id)=
        ($1,$2,$3,$4)
    `,
      [...scopeValues(input), input.draftId],
    );
    const row = result.rows[0];
    return row === undefined
      ? { state: "not_found" }
      : {
          state: "version_conflict",
          currentVersion: Number(row.version),
        };
  };

  return {
    async saveManualVersion(input) {
      const result = await client.query(
        `
        WITH target AS (
          SELECT d.*,v.evidence_snapshot_id,v.structured_output,
            v.request_snapshot_id,v.evidence_ids,v.output_schema_version
          FROM backlink_email_drafts d
          JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,
             v.id,v.draft_id,v.opportunity_id)=
            (d.organization_id,d.workspace_id,d.website_project_id,
             d.current_version_id,d.id,d.opportunity_id)
          WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            ($1,$2,$3,$4) AND d.version=$5 AND d.status<>'sent'
          FOR UPDATE OF d
        ), next_version AS (
          SELECT COALESCE(max(v.version_no),0)+1 AS value
          FROM target t
          LEFT JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,v.draft_id)=
            (t.organization_id,t.workspace_id,t.website_project_id,t.id)
        ), inserted AS (
          INSERT INTO backlink_draft_versions (
            id,organization_id,workspace_id,website_project_id,draft_id,
            opportunity_id,contact_id,contact_version,version_no,
            parent_version_id,source,
            evidence_snapshot_id,request_snapshot_id,
            subject_text,body_text,body_document,
            structured_output,
            evidence_ids,prompt_version,output_schema_version,
            requires_user_confirmation,can_auto_send,created_at,created_by
          )
          SELECT $6,t.organization_id,t.workspace_id,t.website_project_id,t.id,
            t.opportunity_id,t.contact_id,t.contact_version,n.value,
            t.current_version_id,'MANUAL',
            t.evidence_snapshot_id,t.request_snapshot_id,$7,$8,$11::jsonb,
            jsonb_set(
              jsonb_set(t.structured_output,'{subject}',to_jsonb($7::text),true),
              '{bodyText}',to_jsonb($8::text),true
            ),
            t.evidence_ids,'manual-edit.v1',t.output_schema_version,
            true,false,$10,$9
          FROM target t JOIN next_version n ON true
          RETURNING id,draft_id
        ), updated AS (
          UPDATE backlink_email_drafts d
          SET current_version_id=i.id,approved_version_id=NULL,status='draft',
            version=d.version+1,updated_at=$10,updated_by=$9
          FROM inserted i
          WHERE d.id=i.draft_id
          RETURNING d.id,d.current_version_id,d.version,d.status
        )
        SELECT id AS "draftId",current_version_id AS "versionId",
          version AS "draftVersion",status
        FROM updated
      `,
        [
          ...scopeValues(input),
          input.draftId,
          input.expectedVersion,
          input.versionId,
          input.subjectText,
          input.bodyText,
          input.actorId,
          input.recordedAt,
          JSON.stringify(input.bodyDocument),
        ],
      );
      const row = result.rows[0] as
        Omit<DraftEditingCompleted, "state"> | undefined;
      return row === undefined
        ? failure(input)
        : { state: "completed", ...row };
    },

    async approve(input) {
      const currentContent = await client.query(
        `
        SELECT v.subject_text AS "subjectText",v.body_text AS "bodyText"
        FROM backlink_email_drafts d
        JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.draft_id,v.id)=
          (d.organization_id,d.workspace_id,d.website_project_id,
           d.id,d.current_version_id)
        WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          ($1,$2,$3,$4)
          AND d.version=$5
      `,
        [...scopeValues(input), input.draftId, input.expectedVersion],
      );
      const currentContentRow = currentContent.rows[0] as
        | Readonly<{
            subjectText: string;
            bodyText: string;
          }>
        | undefined;
      if (currentContentRow === undefined) return failure(input);
      if (
        containsInternalDraftMetadataMarker(currentContentRow.subjectText) ||
        containsInternalDraftMetadataMarker(currentContentRow.bodyText)
      ) {
        return { state: "invalid_content" };
      }

      const lifecycleEventId = newId();
      const auditEventId = newId();
      const integrityHash = createHash("sha256")
        .update(
          JSON.stringify({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId,
            draftId: input.draftId,
            expectedVersion: input.expectedVersion,
            actorId: input.actorId,
            recordedAt: input.recordedAt.toISOString(),
            contractVersion: draftApprovalFactContractVersion,
          }),
        )
        .digest("hex");
      const result = await client.query(
        `
        WITH target AS (
          SELECT d.id,d.status AS previous_status,
            d.version AS previous_aggregate_version,d.current_version_id
          FROM backlink_email_drafts d
          JOIN backlink_contacts c ON
            (c.organization_id,c.workspace_id,c.website_project_id,c.id)=
            (d.organization_id,d.workspace_id,d.website_project_id,d.contact_id)
          JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,
             v.draft_id,v.id)=
            (d.organization_id,d.workspace_id,d.website_project_id,
             d.id,d.current_version_id)
          WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            ($1,$2,$3,$4)
            AND d.version=$5
            AND c.version=d.contact_version
            AND c.status='active'
            AND c.guessed=false
            AND c.invalidated_at IS NULL
            AND d.current_version_id IS NOT NULL
            AND v.source<>'TEMPLATE_FALLBACK'
            AND NOT (
              d.status='approved'
              AND d.approved_version_id=d.current_version_id
            )
          FOR UPDATE OF d,c
        ), changed AS (
          UPDATE backlink_email_drafts d
          SET approved_version_id=t.current_version_id,status='approved',
            version=d.version+1,updated_at=$7,updated_by=$6
          FROM target t
          WHERE d.id=t.id
          RETURNING d.id,d.current_version_id,d.version,d.status,
            t.previous_status,t.previous_aggregate_version
        ), lifecycle AS (
          INSERT INTO backlink_lifecycle_events (
            id,organization_id,workspace_id,website_project_id,
            aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
            actor_type,actor_id,before_state,after_state,reason,correlation_id,
            idempotency_key,event_schema_version
          )
          SELECT $8,$1,$2,$3,'email_draft',c.id,c.version,c.version,
            'draft.approval.recorded','user',$6,
            jsonb_build_object(
              'status',c.previous_status,
              'aggregateVersion',c.previous_aggregate_version
            ),
            jsonb_build_object(
              'draftId',c.id,
              'approvedVersionId',c.current_version_id,
              'previousStatus',c.previous_status,
              'nextStatus',c.status,
              'previousAggregateVersion',c.previous_aggregate_version,
              'nextAggregateVersion',c.version,
              'actorId',$6,
              'occurredAt',$7::timestamptz,
              'contractVersion',$10::text
            ),
            'approved_current_version',
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            1
          FROM changed c
          RETURNING id
        ), audit AS (
          INSERT INTO backlink_audit_events (
            id,organization_id,workspace_id,website_project_id,
            lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
            outcome,reason,before_redacted,after_redacted,request_id,
            correlation_id,integrity_hash,event_schema_version
          )
          SELECT $9,$1,$2,$3,lifecycle.id,$6,'user','draft.approved',
            'email_draft',c.id,'success','approved_current_version',
            jsonb_build_object(
              'status',c.previous_status,
              'aggregateVersion',c.previous_aggregate_version
            ),
            jsonb_build_object(
              'status',c.status,
              'approvedVersionId',c.current_version_id,
              'aggregateVersion',c.version,
              'contractVersion',$10::text
            ),
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            $11,1
          FROM lifecycle CROSS JOIN changed c
          RETURNING id
        )
        SELECT c.id AS "draftId",c.current_version_id AS "versionId",
          c.version AS "draftVersion",c.status
        FROM changed c CROSS JOIN lifecycle CROSS JOIN audit
      `,
        [
          ...scopeValues(input),
          input.draftId,
          input.expectedVersion,
          input.actorId,
          input.recordedAt,
          lifecycleEventId,
          auditEventId,
          draftApprovalFactContractVersion,
          integrityHash,
        ],
      );
      const row = result.rows[0] as
        Omit<DraftEditingCompleted, "state"> | undefined;
      return row === undefined
        ? failure(input)
        : { state: "completed", ...row };
    },
  };
}
