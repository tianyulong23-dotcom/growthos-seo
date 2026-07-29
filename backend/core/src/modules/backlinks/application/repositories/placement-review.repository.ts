export type PlacementReviewValidationStatus =
  | "PENDING"
  | "VALID"
  | "INVALID"
  | "INCONCLUSIVE"
  | "MANUALLY_CONFIRMED";

export type PlacementReviewCandidate = Readonly<{
  candidateId: string;
  opportunityId: string | null;
  candidateStatus: string;
  matchStatus: string;
  initialValidationStatus: PlacementReviewValidationStatus;
  sourcePageUrl: string | null;
  normalizedSourceUrl: string | null;
  normalizedSourceUrlHash: string | null;
  targetUrl: string;
  normalizedTargetUrl: string;
  normalizedTargetUrlHash: string;
  urlNormalizationVersion: string;
  version: number;
  latestValidation: Readonly<{
    validationRunId: string;
    runNumber: number;
    validationMethod: string;
    status: Exclude<PlacementReviewValidationStatus, "PENDING">;
    reasonCode: string | null;
    evidenceSnapshot: Readonly<Record<string, unknown>>;
    evidenceSnapshotHash: string;
    evidenceContractVersion: string;
    evidenceSchemaVersion: number;
    evidenceObservedAt: string;
    initialEvidenceRef: string;
  }> | null;
}>;

type PlacementReviewScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

type PlacementReviewCommonInput = PlacementReviewScope & Readonly<{
  actorId: string;
  candidateId: string;
  expectedVersion: number;
  reason: string;
  previousValidationRunId: string;
  previousValidationStatus: "INVALID" | "INCONCLUSIVE";
  previousReasonCode: string;
  lifecycleEventId: string;
  auditEventId: string;
  requestId: string;
  auditIntegrityHash: string;
  reviewedAt: Date;
}>;

export type PlacementManualConfirmationRepositoryInput =
  PlacementReviewCommonInput & Readonly<{
    action: "manual_confirm";
    validationRunId: string;
    placementId: string;
    monitoringOutboxEventId: string;
    placementLifecycleEventId: string;
    manualEvidenceSnapshot: Readonly<Record<string, unknown>>;
    manualEvidenceSnapshotHash: string;
    evidenceContractVersion: string;
    evidenceSchemaVersion: number;
    initialEvidenceRef: string;
  }>;

export type PlacementRejectionRepositoryInput =
  PlacementReviewCommonInput & Readonly<{
    action: "reject";
  }>;

export type PlacementReviewRepositoryInput =
  | PlacementManualConfirmationRepositoryInput
  | PlacementRejectionRepositoryInput;

export type PlacementManualConfirmationResponse = Readonly<{
  action: "manual_confirm";
  candidateId: string;
  candidateStatus: "PROMOTED";
  initialValidationStatus: "MANUALLY_CONFIRMED";
  candidateVersion: number;
  validationRunId: string;
  placementId: string;
  placementVersion: number;
  monitoringOutboxEventId: string;
  lifecycleEventId: string;
  auditEventId: string;
}>;

export type PlacementRejectionResponse = Readonly<{
  action: "reject";
  candidateId: string;
  candidateStatus: "REJECTED";
  initialValidationStatus: "INVALID" | "INCONCLUSIVE";
  candidateVersion: number;
  lifecycleEventId: string;
  auditEventId: string;
}>;

export type PlacementReviewRepositoryResult =
  | Readonly<{
      state: "completed";
      response:
        | PlacementManualConfirmationResponse
        | PlacementRejectionResponse;
    }>
  | Readonly<{ state: "version_conflict" }>;

export interface PlacementReviewRepository {
  getCandidate(
    input: PlacementReviewScope & Readonly<{ candidateId: string }>,
  ): Promise<PlacementReviewCandidate | null>;
  review(
    input: PlacementReviewRepositoryInput,
  ): Promise<PlacementReviewRepositoryResult>;
}

export type PlacementReviewQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const monitoringEventType =
  "backlinks.placement-monitoring.requested.v1";

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    return JSON.parse(value) as Readonly<Record<string, unknown>>;
  }
  return value as Readonly<Record<string, unknown>>;
}

function asIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function reasonCode(
  evidence: Readonly<Record<string, unknown>>,
): string | null {
  const result = evidence.result;
  if (result === null || typeof result !== "object") return null;
  const value = (result as Readonly<Record<string, unknown>>).reasonCode;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function asValidationStatus(
  value: unknown,
): Exclude<PlacementReviewValidationStatus, "PENDING"> {
  if (
    value === "VALID"
    || value === "INVALID"
    || value === "INCONCLUSIVE"
    || value === "MANUALLY_CONFIRMED"
  ) {
    return value;
  }
  throw new Error("Placement review validation status is invalid.");
}

function mapCandidate(
  row: Record<string, unknown> | undefined,
): PlacementReviewCandidate | null {
  if (row === undefined) return null;
  const evidence = row.validationRunId === null
    ? null
    : asRecord(row.evidenceSnapshot);
  return {
    candidateId: String(row.candidateId),
    opportunityId: row.opportunityId === null
      ? null
      : String(row.opportunityId),
    candidateStatus: String(row.candidateStatus),
    matchStatus: String(row.matchStatus),
    initialValidationStatus:
      row.initialValidationStatus as PlacementReviewValidationStatus,
    sourcePageUrl: row.sourcePageUrl === null
      ? null
      : String(row.sourcePageUrl),
    normalizedSourceUrl: row.normalizedSourceUrl === null
      ? null
      : String(row.normalizedSourceUrl),
    normalizedSourceUrlHash: row.normalizedSourceUrlHash === null
      ? null
      : String(row.normalizedSourceUrlHash),
    targetUrl: String(row.targetUrl),
    normalizedTargetUrl: String(row.normalizedTargetUrl),
    normalizedTargetUrlHash: String(row.normalizedTargetUrlHash),
    urlNormalizationVersion: String(row.urlNormalizationVersion),
    version: Number(row.version),
    latestValidation: evidence === null
      ? null
      : {
          validationRunId: String(row.validationRunId),
          runNumber: Number(row.runNumber),
          validationMethod: String(row.validationMethod),
          status: asValidationStatus(row.validationStatus),
          reasonCode: reasonCode(evidence),
          evidenceSnapshot: evidence,
          evidenceSnapshotHash: String(row.evidenceSnapshotHash),
          evidenceContractVersion: String(row.evidenceContractVersion),
          evidenceSchemaVersion: Number(row.evidenceSchemaVersion),
          evidenceObservedAt: asIso(row.evidenceObservedAt),
          initialEvidenceRef: String(row.initialEvidenceRef),
        },
  };
}

function mapResponse(
  row: Record<string, unknown> | undefined,
  action: PlacementReviewRepositoryInput["action"],
): PlacementReviewRepositoryResult {
  if (row === undefined) return { state: "version_conflict" };
  if (action === "manual_confirm") {
    return {
      state: "completed",
      response: {
        action,
        candidateId: String(row.candidateId),
        candidateStatus: "PROMOTED",
        initialValidationStatus: "MANUALLY_CONFIRMED",
        candidateVersion: Number(row.candidateVersion),
        validationRunId: String(row.validationRunId),
        placementId: String(row.placementId),
        placementVersion: Number(row.placementVersion),
        monitoringOutboxEventId: String(
          row.monitoringOutboxEventId,
        ),
        lifecycleEventId: String(row.lifecycleEventId),
        auditEventId: String(row.auditEventId),
      },
    };
  }
  return {
    state: "completed",
    response: {
      action,
      candidateId: String(row.candidateId),
      candidateStatus: "REJECTED",
      initialValidationStatus:
        row.initialValidationStatus as "INVALID" | "INCONCLUSIVE",
      candidateVersion: Number(row.candidateVersion),
      lifecycleEventId: String(row.lifecycleEventId),
      auditEventId: String(row.auditEventId),
    },
  };
}

async function confirm(
  client: PlacementReviewQueryClient,
  input: PlacementManualConfirmationRepositoryInput,
): Promise<PlacementReviewRepositoryResult> {
  const result = await client.query(`
    WITH target AS (
      SELECT c.*,v.id AS previous_validation_id,
        v.run_number AS previous_run_number,
        v.status AS previous_validation_status,
        v.evidence_snapshot AS previous_evidence_snapshot,
        v.evidence_snapshot_hash AS previous_evidence_hash
      FROM backlink_placement_candidates c
      JOIN LATERAL (
        SELECT validation.*
        FROM backlink_placement_validation_runs validation
        WHERE (
          validation.organization_id,validation.workspace_id,
          validation.website_project_id,validation.candidate_id
        )=(
          c.organization_id,c.workspace_id,c.website_project_id,c.id
        )
        ORDER BY validation.run_number DESC
        LIMIT 1
      ) v ON true
      WHERE (
        c.organization_id,c.workspace_id,c.website_project_id,c.id
      )=($1,$2,$3,$4)
        AND c.version=$5
        AND c.status='REVIEW_REQUIRED'
        AND c.match_status='AUTO_MATCHED'
        AND c.initial_validation_status='INCONCLUSIVE'
        AND c.opportunity_id IS NOT NULL
        AND c.source_page_url IS NOT NULL
        AND c.normalized_source_url IS NOT NULL
        AND c.normalized_source_url_hash IS NOT NULL
        AND v.id=$6
        AND v.status='INCONCLUSIVE'
      FOR UPDATE OF c
    ), inserted_validation AS (
      INSERT INTO backlink_placement_validation_runs (
        id,organization_id,workspace_id,website_project_id,candidate_id,
        opportunity_id,run_number,validation_method,status,source_page_url,
        normalized_source_url,normalized_source_url_hash,target_url,
        normalized_target_url,normalized_target_url_hash,
        url_normalization_version,evidence_snapshot,evidence_snapshot_hash,
        evidence_contract_version,evidence_schema_version,
        evidence_observed_at,verified_by,verified_at,audit_event_id,
        initial_evidence_ref,manual_confirmation_reason,created_at,created_by
      )
      SELECT $7,t.organization_id,t.workspace_id,t.website_project_id,t.id,
        t.opportunity_id,t.previous_run_number+1,'manual_confirmation',
        'MANUALLY_CONFIRMED',t.source_page_url,t.normalized_source_url,
        t.normalized_source_url_hash,t.target_url,t.normalized_target_url,
        t.normalized_target_url_hash,t.url_normalization_version,$15::jsonb,
        $16,$17,$18,$14,$12,$14,$11,$19,$13,$14,$12
      FROM target t
      RETURNING *
    ), inserted_placement AS (
      INSERT INTO backlink_placements (
        id,organization_id,workspace_id,website_project_id,candidate_id,
        opportunity_id,initial_validation_id,initial_validation_status,
        source_page_url,normalized_source_url,normalized_source_url_hash,
        target_url,normalized_target_url,normalized_target_url_hash,
        url_normalization_version,initial_evidence_snapshot_hash,
        evidence_contract_version,initial_evidence_schema_version,
        created_at,updated_at,created_by,updated_by
      )
      SELECT $8,t.organization_id,t.workspace_id,t.website_project_id,t.id,
        t.opportunity_id,v.id,v.status,t.source_page_url,
        t.normalized_source_url,t.normalized_source_url_hash,t.target_url,
        t.normalized_target_url,t.normalized_target_url_hash,
        t.url_normalization_version,v.evidence_snapshot_hash,
        v.evidence_contract_version,v.evidence_schema_version,
        $14,$14,$12,$12
      FROM target t
      JOIN inserted_validation v ON true
      ON CONFLICT (
        website_project_id,normalized_source_url_hash,
        normalized_target_url_hash
      ) DO NOTHING
      RETURNING *
    ), updated_candidate AS (
      UPDATE backlink_placement_candidates c
      SET status='PROMOTED',
        initial_validation_status='MANUALLY_CONFIRMED',
        version=c.version+1,updated_at=$14,updated_by=$12
      FROM target t,inserted_placement p
      WHERE c.id=t.id
      RETURNING c.*
    ), updated_opportunity AS (
      UPDATE backlink_opportunities o
      SET business_stage=CASE
            WHEN o.business_stage='WAITING_PLACEMENT'
            THEN 'RELATIONSHIP_ACTIVE'
            ELSE o.business_stage
          END,
        fulfillment_status=CASE
            WHEN o.fulfillment_status IN ('PENDING','PARTIAL')
            THEN 'FULFILLED'
            ELSE o.fulfillment_status
          END,
        version=o.version+1,updated_at=$14,updated_by=$12
      FROM target t,inserted_placement p
      WHERE (
        o.organization_id,o.workspace_id,o.website_project_id,o.id
      )=(
        t.organization_id,t.workspace_id,t.website_project_id,
        t.opportunity_id
      )
        AND (
          o.business_stage='WAITING_PLACEMENT'
          OR o.fulfillment_status IN ('PENDING','PARTIAL')
        )
      RETURNING o.id
    ), inserted_outbox AS (
      INSERT INTO backlink_outbox_events (
        id,organization_id,workspace_id,website_project_id,event_type,
        aggregate_id,aggregate_version,idempotency_key,payload,
        payload_schema_version,available_at,created_at,updated_at,
        created_by,updated_by
      )
      SELECT $9,p.organization_id,p.workspace_id,p.website_project_id,$22,
        p.id,p.version,'placement-monitoring:'||p.id,
        jsonb_build_object(
          'contractVersion',$22::text,
          'placementId',p.id,
          'candidateId',p.candidate_id,
          'opportunityId',p.opportunity_id,
          'initialValidationId',p.initial_validation_id,
          'websiteProjectId',p.website_project_id,
          'countsTowardKpi',true,
          'reviewAction','manual_confirm'
        ),
        1,$14,$14,$14,$12,$12
      FROM inserted_placement p
      RETURNING *
    ), inserted_lifecycle AS (
      INSERT INTO backlink_lifecycle_events (
        id,organization_id,workspace_id,website_project_id,aggregate_type,
        aggregate_id,sequence,aggregate_version,event_type,actor_type,
        actor_id,before_state,after_state,reason,correlation_id,
        idempotency_key,created_at
      )
      SELECT $10,c.organization_id,c.workspace_id,c.website_project_id,
        'placement_candidate',c.id,c.version,c.version,
        'placement_candidate.manually_confirmed','user',$12,
        jsonb_build_object(
          'candidateStatus',t.status,
          'candidateVersion',t.version,
          'initialValidationStatus',t.initial_validation_status,
          'validationRunId',t.previous_validation_id,
          'validationStatus',t.previous_validation_status,
          'reasonCode',
            t.previous_evidence_snapshot #>> '{result,reasonCode}',
          'evidenceSnapshotHash',t.previous_evidence_hash
        ),
        jsonb_build_object(
          'candidateStatus',c.status,
          'candidateVersion',c.version,
          'initialValidationStatus',c.initial_validation_status,
          'validationRunId',v.id,
          'placementId',p.id,
          'countsTowardKpi',true
        ),
        $13,$20,'placement-candidate-review:'||c.id||':'||c.version,$14
      FROM updated_candidate c
      JOIN target t ON t.id=c.id
      JOIN inserted_validation v ON true
      JOIN inserted_placement p ON true
      RETURNING *
    ), inserted_placement_lifecycle AS (
      INSERT INTO backlink_lifecycle_events (
        id,organization_id,workspace_id,website_project_id,aggregate_type,
        aggregate_id,sequence,aggregate_version,event_type,actor_type,
        actor_id,before_state,after_state,reason,correlation_id,
        causation_id,idempotency_key,created_at
      )
      SELECT $23,p.organization_id,p.workspace_id,p.website_project_id,
        'placement',p.id,p.version,p.version,'placement.confirmed','user',$12,
        NULL,
        jsonb_build_object(
          'healthStatus',p.health_status,
          'placementVersion',p.version,
          'observationId',v.id
        ),
        'MANUAL_CONFIRM', $20,v.id,
        'placement-confirmed:'||p.id||':'||p.version,$14
      FROM inserted_placement p
      JOIN inserted_validation v ON v.id=p.initial_validation_id
      RETURNING *
    ), inserted_audit AS (
      INSERT INTO backlink_audit_events (
        id,organization_id,workspace_id,website_project_id,
        lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
        outcome,reason,before_redacted,after_redacted,request_id,
        correlation_id,integrity_hash,created_at
      )
      SELECT $11::uuid,l.organization_id,l.workspace_id,
        l.website_project_id,l.id,
        $12,'user','placement_candidate.manually_confirmed',
        'placement_candidate',l.aggregate_id,'success',$13,l.before_state,
        l.after_state,$20,$20,$21,$14
      FROM inserted_lifecycle l
      RETURNING *
    )
    SELECT c.id AS "candidateId",c.version AS "candidateVersion",
      v.id AS "validationRunId",p.id AS "placementId",
      p.version AS "placementVersion",e.id AS "monitoringOutboxEventId",
      l.id AS "lifecycleEventId",a.id AS "auditEventId"
    FROM updated_candidate c
    JOIN inserted_validation v ON true
    JOIN inserted_placement p ON true
    JOIN inserted_outbox e ON true
    JOIN inserted_lifecycle l ON true
    JOIN inserted_placement_lifecycle placement_lifecycle ON true
    JOIN inserted_audit a ON true
    LEFT JOIN updated_opportunity o ON true
  `, [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.candidateId,
    input.expectedVersion,
    input.previousValidationRunId,
    input.validationRunId,
    input.placementId,
    input.monitoringOutboxEventId,
    input.lifecycleEventId,
    input.auditEventId,
    input.actorId,
    input.reason,
    input.reviewedAt,
    JSON.stringify(input.manualEvidenceSnapshot),
    input.manualEvidenceSnapshotHash,
    input.evidenceContractVersion,
    input.evidenceSchemaVersion,
    input.initialEvidenceRef,
    input.requestId,
    input.auditIntegrityHash,
    monitoringEventType,
    input.placementLifecycleEventId,
  ]);
  return mapResponse(result.rows[0], input.action);
}

async function reject(
  client: PlacementReviewQueryClient,
  input: PlacementRejectionRepositoryInput,
): Promise<PlacementReviewRepositoryResult> {
  const result = await client.query(`
    WITH target AS (
      SELECT c.*,v.id AS previous_validation_id,
        v.status AS previous_validation_status,
        v.evidence_snapshot AS previous_evidence_snapshot,
        v.evidence_snapshot_hash AS previous_evidence_hash
      FROM backlink_placement_candidates c
      JOIN LATERAL (
        SELECT validation.*
        FROM backlink_placement_validation_runs validation
        WHERE (
          validation.organization_id,validation.workspace_id,
          validation.website_project_id,validation.candidate_id
        )=(
          c.organization_id,c.workspace_id,c.website_project_id,c.id
        )
        ORDER BY validation.run_number DESC
        LIMIT 1
      ) v ON true
      WHERE (
        c.organization_id,c.workspace_id,c.website_project_id,c.id
      )=($1,$2,$3,$4)
        AND c.version=$5
        AND c.status='REVIEW_REQUIRED'
        AND c.initial_validation_status IN ('INVALID','INCONCLUSIVE')
        AND v.id=$6
        AND v.status IN ('INVALID','INCONCLUSIVE')
      FOR UPDATE OF c
    ), updated_candidate AS (
      UPDATE backlink_placement_candidates c
      SET status='REJECTED',version=c.version+1,
        updated_at=$11,updated_by=$9
      FROM target t
      WHERE c.id=t.id
      RETURNING c.*
    ), inserted_lifecycle AS (
      INSERT INTO backlink_lifecycle_events (
        id,organization_id,workspace_id,website_project_id,aggregate_type,
        aggregate_id,sequence,aggregate_version,event_type,actor_type,
        actor_id,before_state,after_state,reason,correlation_id,
        idempotency_key,created_at
      )
      SELECT $7,c.organization_id,c.workspace_id,c.website_project_id,
        'placement_candidate',c.id,c.version,c.version,
        'placement_candidate.rejected','user',$9,
        jsonb_build_object(
          'candidateStatus',t.status,
          'candidateVersion',t.version,
          'initialValidationStatus',t.initial_validation_status,
          'validationRunId',t.previous_validation_id,
          'validationStatus',t.previous_validation_status,
          'reasonCode',
            t.previous_evidence_snapshot #>> '{result,reasonCode}',
          'evidenceSnapshotHash',t.previous_evidence_hash
        ),
        jsonb_build_object(
          'candidateStatus',c.status,
          'candidateVersion',c.version,
          'initialValidationStatus',c.initial_validation_status,
          'countsTowardKpi',false
        ),
        $10,$12,'placement-candidate-review:'||c.id||':'||c.version,$11
      FROM updated_candidate c
      JOIN target t ON t.id=c.id
      RETURNING *
    ), inserted_audit AS (
      INSERT INTO backlink_audit_events (
        id,organization_id,workspace_id,website_project_id,
        lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
        outcome,reason,before_redacted,after_redacted,request_id,
        correlation_id,integrity_hash,created_at
      )
      SELECT $8,l.organization_id,l.workspace_id,l.website_project_id,l.id,
        $9,'user','placement_candidate.rejected','placement_candidate',
        l.aggregate_id,'success',$10,l.before_state,l.after_state,$12,$12,
        $13,$11
      FROM inserted_lifecycle l
      RETURNING *
    )
    SELECT c.id AS "candidateId",c.version AS "candidateVersion",
      c.initial_validation_status AS "initialValidationStatus",
      l.id AS "lifecycleEventId",a.id AS "auditEventId"
    FROM updated_candidate c
    JOIN inserted_lifecycle l ON true
    JOIN inserted_audit a ON true
  `, [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.candidateId,
    input.expectedVersion,
    input.previousValidationRunId,
    input.lifecycleEventId,
    input.auditEventId,
    input.actorId,
    input.reason,
    input.reviewedAt,
    input.requestId,
    input.auditIntegrityHash,
  ]);
  return mapResponse(result.rows[0], input.action);
}

export function createPlacementReviewRepository(
  client: PlacementReviewQueryClient,
): PlacementReviewRepository {
  return {
    async getCandidate(input) {
      const result = await client.query(`
        SELECT c.id AS "candidateId",c.opportunity_id AS "opportunityId",
          c.status AS "candidateStatus",c.match_status AS "matchStatus",
          c.initial_validation_status AS "initialValidationStatus",
          c.source_page_url AS "sourcePageUrl",
          c.normalized_source_url AS "normalizedSourceUrl",
          c.normalized_source_url_hash AS "normalizedSourceUrlHash",
          c.target_url AS "targetUrl",
          c.normalized_target_url AS "normalizedTargetUrl",
          c.normalized_target_url_hash AS "normalizedTargetUrlHash",
          c.url_normalization_version AS "urlNormalizationVersion",c.version,
          v.id AS "validationRunId",v.run_number AS "runNumber",
          v.validation_method AS "validationMethod",
          v.status AS "validationStatus",
          v.evidence_snapshot AS "evidenceSnapshot",
          v.evidence_snapshot_hash AS "evidenceSnapshotHash",
          v.evidence_contract_version AS "evidenceContractVersion",
          v.evidence_schema_version AS "evidenceSchemaVersion",
          v.evidence_observed_at AS "evidenceObservedAt",
          v.initial_evidence_ref AS "initialEvidenceRef"
        FROM backlink_placement_candidates c
        LEFT JOIN LATERAL (
          SELECT validation.*
          FROM backlink_placement_validation_runs validation
          WHERE (
            validation.organization_id,validation.workspace_id,
            validation.website_project_id,validation.candidate_id
          )=(
            c.organization_id,c.workspace_id,c.website_project_id,c.id
          )
          ORDER BY validation.run_number DESC
          LIMIT 1
        ) v ON true
        WHERE (
          c.organization_id,c.workspace_id,c.website_project_id,c.id
        )=($1,$2,$3,$4)
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.candidateId,
      ]);
      return mapCandidate(result.rows[0]);
    },
    async review(input) {
      return input.action === "manual_confirm"
        ? confirm(client, input)
        : reject(client, input);
    },
  };
}
