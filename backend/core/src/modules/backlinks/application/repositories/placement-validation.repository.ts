export type PlacementValidationResultStatus =
  | "VALID"
  | "INVALID"
  | "INCONCLUSIVE";

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type PlacementValidationCandidate = Readonly<{
  candidateId: string;
  opportunityId: string | null;
  replyId: string | null;
  plannedPlacementId: string;
  sourceType: string;
  sourcePageUrl: string;
  normalizedSourceUrl: string;
  normalizedSourceUrlHash: string;
  targetUrl: string;
  normalizedTargetUrl: string;
  normalizedTargetUrlHash: string;
  urlNormalizationVersion: string;
  version: number;
}>;

export type PlacementValidationCandidateState =
  | Readonly<{
      state: "ready";
      candidate: PlacementValidationCandidate;
    }>
  | Readonly<{
      state: "already_validated";
      candidateId: string;
      validationRunId: string;
      status: PlacementValidationResultStatus;
      placementId: string | null;
      monitoringOutboxEventId: string | null;
    }>
  | Readonly<{
      state: "not_ready";
      candidateId: string;
      candidateStatus: string;
      matchStatus: string;
      validationStatus: string;
    }>
  | Readonly<{ state: "not_found" }>;

export type RecordPlacementInitialValidationInput = Scope & Readonly<{
  candidateId: string;
  expectedCandidateVersion: number;
  validationRunId: string;
  placementId: string;
  monitoringOutboxEventId: string;
  placementLifecycleEventId: string;
  status: PlacementValidationResultStatus;
  evidenceSnapshot: Readonly<Record<string, unknown>>;
  evidenceSnapshotHash: string;
  evidenceContractVersion: string;
  evidenceSchemaVersion: number;
  evidenceObservedAt: Date;
  verifiedAt: Date;
  verifiedBy: string;
  auditEventId: string;
  initialEvidenceRef: string;
}>;

export type PlacementInitialValidationRecord = Readonly<{
  state: "recorded" | "existing";
  candidateId: string;
  validationRunId: string;
  status: PlacementValidationResultStatus;
  placementId: string | null;
  monitoringOutboxEventId: string | null;
}>;

export type PlacementInitialValidationRepository = Readonly<{
  getCandidate(
    input: Scope & Readonly<{ candidateId: string }>,
  ): Promise<PlacementValidationCandidateState>;
  record(
    input: RecordPlacementInitialValidationInput,
  ): Promise<PlacementInitialValidationRecord>;
}>;

export type PlacementValidationQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const monitoringEventType =
  "backlinks.placement-monitoring.requested.v1";

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asValidationStatus(value: unknown): PlacementValidationResultStatus {
  if (value === "VALID" || value === "INVALID" || value === "INCONCLUSIVE") {
    return value;
  }
  throw new Error("Placement validation status is invalid.");
}

function hasDirectValidationBinding(
  row: Record<string, unknown>,
): boolean {
  return (
    row.opportunityId !== null
    && row.matchStatus === "AUTO_MATCHED"
  ) || (
    row.opportunityId === null
    && row.matchStatus === "UNMATCHED"
    && (row.sourceType === "manual" || row.sourceType === "import")
  );
}

function mapCandidate(
  row: Record<string, unknown> | undefined,
): PlacementValidationCandidateState {
  if (row === undefined) return { state: "not_found" };

  const candidateId = String(row.candidateId);
  if (row.validationRunId !== null) {
    return {
      state: "already_validated",
      candidateId,
      validationRunId: String(row.validationRunId),
      status: asValidationStatus(row.validationStatus),
      placementId: asNullableString(row.placementId),
      monitoringOutboxEventId: asNullableString(
        row.monitoringOutboxEventId,
      ),
    };
  }

  if (
    row.candidateStatus === "PENDING_VALIDATION"
    && row.initialValidationStatus === "PENDING"
    && hasDirectValidationBinding(row)
    && row.sourcePageUrl !== null
    && row.normalizedSourceUrl !== null
    && row.normalizedSourceUrlHash !== null
  ) {
    return {
      state: "ready",
      candidate: {
        candidateId,
        opportunityId: asNullableString(row.opportunityId),
        replyId: asNullableString(row.replyId),
        plannedPlacementId: String(row.plannedPlacementId),
        sourceType: String(row.sourceType),
        sourcePageUrl: String(row.sourcePageUrl),
        normalizedSourceUrl: String(row.normalizedSourceUrl),
        normalizedSourceUrlHash: String(row.normalizedSourceUrlHash),
        targetUrl: String(row.targetUrl),
        normalizedTargetUrl: String(row.normalizedTargetUrl),
        normalizedTargetUrlHash: String(row.normalizedTargetUrlHash),
        urlNormalizationVersion: String(row.urlNormalizationVersion),
        version: Number(row.version),
      },
    };
  }

  return {
    state: "not_ready",
    candidateId,
    candidateStatus: String(row.candidateStatus),
    matchStatus: String(row.matchStatus),
    validationStatus: String(row.initialValidationStatus),
  };
}

export function createPlacementInitialValidationRepository(
  client: PlacementValidationQueryClient,
): PlacementInitialValidationRepository {
  const getCandidate: PlacementInitialValidationRepository["getCandidate"] =
    async (input) => {
      const result = await client.query(`
        SELECT c.id AS "candidateId",c.opportunity_id AS "opportunityId",
          c.reply_id AS "replyId",
          c.planned_placement_id AS "plannedPlacementId",
          c.source_type AS "sourceType",
          c.source_page_url AS "sourcePageUrl",
          c.normalized_source_url AS "normalizedSourceUrl",
          c.normalized_source_url_hash AS "normalizedSourceUrlHash",
          c.target_url AS "targetUrl",
          c.normalized_target_url AS "normalizedTargetUrl",
          c.normalized_target_url_hash AS "normalizedTargetUrlHash",
          c.url_normalization_version AS "urlNormalizationVersion",
          c.status AS "candidateStatus",c.match_status AS "matchStatus",
          c.initial_validation_status AS "initialValidationStatus",
          c.version,v.id AS "validationRunId",
          v.status AS "validationStatus",p.id AS "placementId",
          e.id AS "monitoringOutboxEventId"
        FROM backlink_placement_candidates c
        LEFT JOIN LATERAL (
          SELECT validation.id,validation.status
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
        LEFT JOIN backlink_placements p ON (
          p.organization_id,p.workspace_id,p.website_project_id,p.candidate_id
        )=(c.organization_id,c.workspace_id,c.website_project_id,c.id)
        LEFT JOIN backlink_outbox_events e ON (
          e.organization_id,e.workspace_id,e.website_project_id,
          e.aggregate_id,e.event_type
        )=(
          p.organization_id,p.workspace_id,p.website_project_id,
          p.id,$5
        )
        WHERE (
          c.organization_id,c.workspace_id,c.website_project_id,c.id
        )=($1,$2,$3,$4)
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.candidateId,
        monitoringEventType,
      ]);
      return mapCandidate(result.rows[0]);
    };

  return {
    getCandidate,
    async record(input) {
      const result = await client.query(`
        WITH target AS (
          SELECT c.*
          FROM backlink_placement_candidates c
          WHERE (
            c.organization_id,c.workspace_id,c.website_project_id,c.id
          )=($1,$2,$3,$4)
            AND c.version=$5
            AND c.status='PENDING_VALIDATION'
            AND c.initial_validation_status='PENDING'
            AND (
              (
                c.opportunity_id IS NOT NULL
                AND c.match_status='AUTO_MATCHED'
              )
              OR (
                c.opportunity_id IS NULL
                AND c.source_type IN ('manual','import')
                AND c.match_status='UNMATCHED'
              )
            )
            AND c.source_page_url IS NOT NULL
            AND c.normalized_source_url IS NOT NULL
            AND c.normalized_source_url_hash IS NOT NULL
          FOR UPDATE
        ), inserted_validation AS (
          INSERT INTO backlink_placement_validation_runs (
            id,organization_id,workspace_id,website_project_id,candidate_id,
            opportunity_id,run_number,validation_method,status,
            source_page_url,normalized_source_url,normalized_source_url_hash,
            target_url,normalized_target_url,normalized_target_url_hash,
            url_normalization_version,evidence_snapshot,
            evidence_snapshot_hash,evidence_contract_version,
            evidence_schema_version,evidence_observed_at,verified_by,
            verified_at,audit_event_id,initial_evidence_ref,
            manual_confirmation_reason,created_by
          )
          SELECT $6,t.organization_id,t.workspace_id,t.website_project_id,
            t.id,t.opportunity_id,1,'direct_page_check',$7,
            t.source_page_url,t.normalized_source_url,
            t.normalized_source_url_hash,t.target_url,
            t.normalized_target_url,t.normalized_target_url_hash,
            t.url_normalization_version,$8::jsonb,$9,$10,$11,$12,$13,$14,
            $15,$16,NULL,$13
          FROM target t
          RETURNING *
        ), inserted_placement AS (
          INSERT INTO backlink_placements (
            id,organization_id,workspace_id,website_project_id,candidate_id,
            opportunity_id,reply_id,
            initial_validation_id,initial_validation_status,
            source_page_url,normalized_source_url,normalized_source_url_hash,
            target_url,normalized_target_url,normalized_target_url_hash,
            url_normalization_version,initial_evidence_snapshot_hash,
            evidence_contract_version,initial_evidence_schema_version,
            created_at,updated_at,created_by,updated_by
          )
          SELECT $17,t.organization_id,t.workspace_id,t.website_project_id,
            t.id,t.opportunity_id,t.reply_id,
            v.id,v.status,t.source_page_url,
            t.normalized_source_url,t.normalized_source_url_hash,t.target_url,
            t.normalized_target_url,t.normalized_target_url_hash,
            t.url_normalization_version,v.evidence_snapshot_hash,
            v.evidence_contract_version,v.evidence_schema_version,
            $14,$14,$13,$13
          FROM target t
          JOIN inserted_validation v ON true
          WHERE $7='VALID'
            AND $17::uuid=t.planned_placement_id
          ON CONFLICT (
            website_project_id,normalized_source_url_hash,
            normalized_target_url_hash
          ) DO NOTHING
          RETURNING *
        ), updated_candidate AS (
          UPDATE backlink_placement_candidates c
          SET status=CASE
                WHEN $7='VALID'
                  AND EXISTS (SELECT 1 FROM inserted_placement)
                THEN 'PROMOTED'
                ELSE 'REVIEW_REQUIRED'
              END,
            initial_validation_status=$7,version=c.version+1,
            updated_at=$14,updated_by=$13
          FROM target t,inserted_validation v
          WHERE c.id=t.id
          RETURNING c.id
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
            version=o.version+1,updated_at=$14,updated_by=$13
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
          SELECT $18,p.organization_id,p.workspace_id,p.website_project_id,
            $19::text,p.id,p.version,'placement-monitoring:'||p.id,
            jsonb_build_object(
              'contractVersion',$19::text,
              'placementId',p.id,
              'candidateId',p.candidate_id,
              'opportunityId',p.opportunity_id,
              'replyId',p.reply_id,
              'initialValidationId',p.initial_validation_id,
              'websiteProjectId',p.website_project_id
            ),
            1,$14,$14,$14,$13,$13
          FROM inserted_placement p
          RETURNING id
        ), inserted_lifecycle AS (
          INSERT INTO backlink_lifecycle_events (
            id,organization_id,workspace_id,website_project_id,aggregate_type,
            aggregate_id,sequence,aggregate_version,event_type,actor_type,
            actor_id,before_state,after_state,reason,correlation_id,
            causation_id,idempotency_key,created_at
          )
          SELECT $20,p.organization_id,p.workspace_id,p.website_project_id,
            'placement',p.id,p.version,p.version,'placement.confirmed',
            'worker',$13,NULL,
            jsonb_build_object(
              'healthStatus',p.health_status,
              'placementVersion',p.version,
              'observationId',v.id
            ),
            'INITIAL_VALIDATION_VALID',v.id,v.id,
            'placement-confirmed:'||p.id||':'||p.version,$14
          FROM inserted_placement p
          JOIN inserted_validation v ON v.id=p.initial_validation_id
          RETURNING id
        )
        SELECT v.candidate_id AS "candidateId",
          v.id AS "validationRunId",v.status,
          p.id AS "placementId",e.id AS "monitoringOutboxEventId"
        FROM inserted_validation v
        JOIN updated_candidate c ON c.id=v.candidate_id
        LEFT JOIN inserted_placement p ON true
        LEFT JOIN inserted_outbox e ON true
        LEFT JOIN inserted_lifecycle lifecycle ON true
        LEFT JOIN updated_opportunity o ON true
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.candidateId,
        input.expectedCandidateVersion,
        input.validationRunId,
        input.status,
        JSON.stringify(input.evidenceSnapshot),
        input.evidenceSnapshotHash,
        input.evidenceContractVersion,
        input.evidenceSchemaVersion,
        input.evidenceObservedAt,
        input.verifiedBy,
        input.verifiedAt,
        input.auditEventId,
        input.initialEvidenceRef,
        input.placementId,
        input.monitoringOutboxEventId,
        monitoringEventType,
        input.placementLifecycleEventId,
      ]);
      const row = result.rows[0];
      if (row !== undefined) {
        return {
          state: "recorded",
          candidateId: String(row.candidateId),
          validationRunId: String(row.validationRunId),
          status: asValidationStatus(row.status),
          placementId: asNullableString(row.placementId),
          monitoringOutboxEventId: asNullableString(
            row.monitoringOutboxEventId,
          ),
        };
      }

      const existing = await getCandidate(input);
      if (existing.state === "already_validated") {
        return {
          state: "existing",
          candidateId: existing.candidateId,
          validationRunId: existing.validationRunId,
          status: existing.status,
          placementId: existing.placementId,
          monitoringOutboxEventId:
            existing.monitoringOutboxEventId,
        };
      }
      throw new Error(
        "Placement Candidate changed before validation evidence was recorded.",
      );
    },
  };
}
