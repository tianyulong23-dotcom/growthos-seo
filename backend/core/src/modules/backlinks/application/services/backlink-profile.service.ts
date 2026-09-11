import { randomUUID } from "node:crypto";

import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import { createPlacementUrlKey } from "../../domain/placements/url-key.js";
import type {
  PlacementMonitorWorkflowInput,
} from "../workflows/placement-monitor.workflow.js";
import { buildBacklinksWorkflowId } from "../../workflows/namespaces.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";

export type BacklinkProfileClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type BacklinkProfileView = Readonly<{
  canonicalDomain: string;
  snapshot: Readonly<{
    snapshotId: string;
    provider: string;
    observedAt: string;
    freshUntil: string;
    freshness: "fresh" | "stale" | "unavailable";
    completeness: "full" | "partial" | "summary_only" | "unavailable";
    totalBacklinks: number | null;
    referringDomains: number | null;
    dofollow: number | null;
    nofollow: number | null;
    sponsored: number | null;
    ugc: number | null;
    newBacklinks: number | null;
    lostBacklinks: number | null;
    inventoryPulledCount: number;
    inventoryCoverage: number | null;
    distributions: Readonly<Record<string, unknown>>;
    unavailableMetrics: readonly string[];
    costMicros: number;
    nextSyncAt: string | null;
  }> | null;
  health: Readonly<{
    score: number | null;
    grade: string;
    components: readonly Readonly<Record<string, unknown>>[];
    risks: readonly string[];
    positives: readonly string[];
    evidenceObservedAt: string;
    modelVersion: string;
  }> | null;
  sync: Readonly<{
    providerEnabled: boolean;
    status: string;
    lastSyncAt: string | null;
    nextSyncAt: string | null;
    estimatedCostMicros: number;
    actualCostMicros: number;
    stale: boolean;
    partial: boolean;
    providerInputRequired: boolean;
  }>;
}>;

export type BacklinkInventoryPage = Readonly<{
  items: readonly Readonly<{
    inventoryItemId: string;
    sourceType: "DATAFORSEO" | "USER_IMPORTED";
    provider: string;
    sourceDomain: string | null;
    sourceUrl: string;
    targetUrl: string;
    anchorText: string;
    relAttributes: readonly string[];
    providerStatus: "live" | "lost" | "unknown";
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    rank: number | null;
    spamScore: number | null;
    countryCode: string | null;
    tld: string | null;
    languageCode: string | null;
    sourceHttpStatus: number | null;
    targetHttpStatus: number | null;
    redirectUrl: string | null;
    placementId: string | null;
    opportunityId: string | null;
    pinned: boolean;
    managed: boolean;
    directHealthStatus:
      | "pending_verification"
      | "active"
      | "suspected_changed"
      | "changed"
      | "suspected_lost"
      | "lost";
    directValidationStatus:
      | "UNVERIFIED"
      | "VALID"
      | "SUSPECTED_CHANGED"
      | "CHANGED"
      | "SUSPECTED_LOST"
      | "LOST"
      | "RECOVERED"
      | "INACCESSIBLE";
    lastDirectCheckedAt: string | null;
    restrictionReason: string | null;
    userNotes: string | null;
    latestDirectEvidenceId: string | null;
    tier: "A" | "B" | "C";
    importance: "normal" | "important";
    monitoringStatus: "enabled" | "paused" | "provider_only";
    policyVersion: "inventory-monitoring-v1";
    policyRevision: number;
    nextCheckAt: string | null;
    providerOnlyReason: string | null;
  }>[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}>;

export type BacklinkProfileSyncResult = Readonly<{
  jobId: string;
  workflowId: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "partial"
    | "waiting_provider"
    | "failed";
  canonicalDomain: string;
  estimatedCostMicros: number;
  providerInputRequired: boolean;
  replayed: boolean;
}>;

export type BacklinkProfileSyncScheduler = Readonly<{
  start(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    profileSyncJobId: string;
    canonicalDomain: string;
  }>): Promise<void>;
}>;

export type BacklinkInventoryMonitorScheduler = Readonly<{
  start(input: PlacementMonitorWorkflowInput): Promise<unknown>;
}>;

export type BacklinkInventoryImportResult = Readonly<{
  inventoryItemId: string;
  sourceUrl: string;
  targetUrl: string;
  tier: "A" | "B" | "C";
  monitoringStatus: "enabled" | "paused" | "provider_only";
  nextCheckAt: string | null;
  replayed: boolean;
}>;

export type BacklinkInventoryPolicyResult = Readonly<{
  inventoryItemId: string;
  tier: "A" | "B" | "C";
  importance: "normal" | "important";
  monitoringStatus: "enabled" | "paused" | "provider_only";
  policyVersion: "inventory-monitoring-v1";
  policyRevision: number;
  nextCheckAt: string | null;
  providerOnlyReason: string | null;
}>;

export type BacklinkInventoryCheckResult = Readonly<{
  inventoryItemId: string;
  runId: string;
  observationId: string;
  workflowId: string;
  scheduledFor: string;
  replayed: boolean;
  monitorInput: PlacementMonitorWorkflowInput;
}>;

export type BacklinkInventoryDirectObservationPage = Readonly<{
  items: readonly Readonly<{
    observationId: string;
    runId: string;
    result: "present" | "changed" | "absent" | "inaccessible";
    directValidationStatus:
      | "VALID"
      | "SUSPECTED_CHANGED"
      | "CHANGED"
      | "SUSPECTED_LOST"
      | "LOST"
      | "RECOVERED"
      | "INACCESSIBLE";
    failureCode: string | null;
    restrictionReason: string | null;
    evidenceSnapshot: Readonly<Record<string, unknown>>;
    observedAt: string;
  }>[];
}>;

const scope = (context: ResolvedProjectContext) => [
  context.tenant.organizationId,
  context.tenant.workspaceId,
  context.project.websiteProjectId,
] as const;

const text = (value: unknown): string => String(value);
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const number = (value: unknown): number => Number(value);
const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const timestamp = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const nullableTimestamp = (value: unknown): string | null =>
  value === null || value === undefined ? null : timestamp(value);
const object = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

function policyResult(
  row: Record<string, unknown>,
): BacklinkInventoryPolicyResult {
  return {
    inventoryItemId: text(row.inventoryItemId),
    tier: text(row.tier) as "A" | "B" | "C",
    importance: text(row.importance) as "normal" | "important",
    monitoringStatus: text(row.monitoringStatus) as
      "enabled" | "paused" | "provider_only",
    policyVersion: "inventory-monitoring-v1",
    policyRevision: number(row.policyRevision),
    nextCheckAt: nullableTimestamp(row.nextCheckAt),
    providerOnlyReason: nullableText(row.providerOnlyReason),
  };
}

function requireInventoryWriteAccess(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) =>
    ["owner", "admin", "member"].includes(role)
  )) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "The current actor cannot manage backlink inventory.",
    });
  }
}

export function createBacklinkProfileStore(
  client: BacklinkProfileClient,
  options: Readonly<{
    providerEnabled: boolean;
    providerAvailable: boolean;
    estimatedCostMicros: number;
    newId?: () => string;
    now?: () => Date;
  }>,
) {
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async getProfile(
      context: ResolvedProjectContext,
    ): Promise<BacklinkProfileView> {
      const result = await client.query(`
        SELECT snapshot.id "snapshotId",snapshot.provider,
               snapshot.observed_at "observedAt",
               snapshot.fresh_until "freshUntil",snapshot.freshness,
               snapshot.completeness,snapshot.total_backlinks "totalBacklinks",
               snapshot.referring_domains "referringDomains",
               snapshot.dofollow,snapshot.nofollow,snapshot.sponsored,
               snapshot.ugc,snapshot.new_backlinks "newBacklinks",
               snapshot.lost_backlinks "lostBacklinks",
               snapshot.inventory_pulled_count "inventoryPulledCount",
               snapshot.inventory_coverage "inventoryCoverage",
               snapshot.distributions,
               snapshot.unavailable_metrics "unavailableMetrics",
               snapshot.cost_micros "costMicros",
               snapshot.next_sync_at "nextSyncAt",
               health.score,health.grade,health.components,health.risks,
               health.positives,
               health.evidence_observed_at "evidenceObservedAt",
               health.model_version "modelVersion"
          FROM backlink_profile_snapshots snapshot
          LEFT JOIN backlink_profile_health_snapshots health ON (
            health.organization_id,health.workspace_id,
            health.website_project_id,health.profile_snapshot_id
          )=(
            snapshot.organization_id,snapshot.workspace_id,
            snapshot.website_project_id,snapshot.id
          )
         WHERE (
           snapshot.organization_id,snapshot.workspace_id,
           snapshot.website_project_id
         )=($1,$2,$3)
         ORDER BY snapshot.observed_at DESC,snapshot.id DESC
         LIMIT 1
      `, scope(context));
      const jobs = await client.query(`
        SELECT status,started_at "startedAt",finished_at "finishedAt",
               next_sync_at "nextSyncAt",
               estimated_cost_micros "estimatedCostMicros",
               actual_cost_micros "actualCostMicros"
          FROM backlink_profile_sync_jobs
         WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
         ORDER BY created_at DESC,id DESC
         LIMIT 1
      `, scope(context));
      const row = result.rows[0];
      const job = jobs.rows[0];
      const freshUntil = row === undefined ? null : new Date(timestamp(row.freshUntil));
      const stale = row !== undefined
        && (!options.providerEnabled || freshUntil === null || freshUntil <= now());
      const snapshot = row === undefined ? null : {
        snapshotId: text(row.snapshotId),
        provider: text(row.provider),
        observedAt: timestamp(row.observedAt),
        freshUntil: timestamp(row.freshUntil),
        freshness: stale
          ? "stale" as const
          : text(row.freshness) as "fresh" | "unavailable",
        completeness: text(row.completeness) as
          "full" | "partial" | "summary_only" | "unavailable",
        totalBacklinks: nullableNumber(row.totalBacklinks),
        referringDomains: nullableNumber(row.referringDomains),
        dofollow: nullableNumber(row.dofollow),
        nofollow: nullableNumber(row.nofollow),
        sponsored: nullableNumber(row.sponsored),
        ugc: nullableNumber(row.ugc),
        newBacklinks: nullableNumber(row.newBacklinks),
        lostBacklinks: nullableNumber(row.lostBacklinks),
        inventoryPulledCount: number(row.inventoryPulledCount),
        inventoryCoverage: nullableNumber(row.inventoryCoverage),
        distributions: object(row.distributions),
        unavailableMetrics: array(row.unavailableMetrics).map(text),
        costMicros: number(row.costMicros),
        nextSyncAt: nullableTimestamp(row.nextSyncAt),
      };
      return {
        canonicalDomain: context.project.canonicalDomain,
        snapshot,
        health: row === undefined || row.modelVersion === null ? null : {
          score: nullableNumber(row.score),
          grade: text(row.grade),
          components: array(row.components).map(object),
          risks: array(row.risks).map(text),
          positives: array(row.positives).map(text),
          evidenceObservedAt: timestamp(row.evidenceObservedAt),
          modelVersion: text(row.modelVersion),
        },
        sync: {
          providerEnabled: options.providerEnabled,
          status: job === undefined ? "idle" : text(job.status),
          lastSyncAt: job === undefined
            ? snapshot?.observedAt ?? null
            : nullableTimestamp(job.finishedAt ?? job.startedAt),
          nextSyncAt: job === undefined
            ? snapshot?.nextSyncAt ?? null
            : nullableTimestamp(job.nextSyncAt),
          estimatedCostMicros: job === undefined
            ? options.estimatedCostMicros
            : number(job.estimatedCostMicros),
          actualCostMicros: job === undefined ? 0 : number(job.actualCostMicros),
          stale,
          partial: snapshot?.completeness === "partial"
            || snapshot?.completeness === "summary_only",
          providerInputRequired: !options.providerAvailable
            || job?.status === "waiting_provider",
        },
      };
    },

    async listInventory(
      context: ResolvedProjectContext,
      input: Readonly<{
        page: number;
        pageSize: number;
        view?: "all" | "referring_domains" | "new" | "lost";
        status?: "live" | "lost" | "unknown" | undefined;
        source?: "DATAFORSEO" | "USER_IMPORTED" | undefined;
        query?: string | undefined;
        sort: "last_seen_desc" | "rank_desc" | "spam_desc";
      }>,
    ): Promise<BacklinkInventoryPage> {
      const view = input.view ?? "all";
      const order = input.sort === "rank_desc"
        ? "inventory.rank DESC NULLS LAST,inventory.updated_at DESC,inventory.id"
        : input.sort === "spam_desc"
          ? "inventory.spam_score DESC NULLS LAST,inventory.updated_at DESC,inventory.id"
          : "inventory.last_seen_at DESC NULLS LAST,inventory.updated_at DESC,inventory.id";
      const values = [
        ...scope(context),
        view,
        input.status ?? null,
        input.source ?? null,
        input.query?.trim() || null,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ];
      const result = await client.query(`
        WITH latest_snapshot AS (
          SELECT snapshot.id
            FROM backlink_profile_snapshots snapshot
           WHERE (
             snapshot.organization_id,snapshot.workspace_id,
             snapshot.website_project_id
           )=($1,$2,$3)
           ORDER BY snapshot.observed_at DESC,snapshot.id DESC
           LIMIT 1
        ),
        filtered_inventory AS (
          SELECT inventory.*,
                 policy.tier,policy.importance,
                 policy.monitoring_status,
                 policy.policy_version,
                 policy.version AS policy_revision,
                 policy.next_check_at,
                 policy.provider_only_reason,
                 row_number() OVER (
                   PARTITION BY COALESCE(
                     NULLIF(lower(inventory.source_domain),''),
                     inventory.normalized_source_url
                   )
                   ORDER BY ${order}
                 ) AS source_domain_rank
            FROM backlink_inventory_items inventory
            JOIN backlink_inventory_monitor_policies policy ON (
              policy.organization_id,policy.workspace_id,
              policy.website_project_id,policy.inventory_item_id
            )=(
              inventory.organization_id,inventory.workspace_id,
              inventory.website_project_id,inventory.id
            )
           WHERE (
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id
           )=($1,$2,$3)
             AND ($5::text IS NULL OR inventory.provider_status=$5)
             AND ($6::text IS NULL OR inventory.source_type=$6)
             AND ($7::text IS NULL
                  OR inventory.source_domain ILIKE '%'||$7||'%'
                  OR inventory.normalized_source_url ILIKE '%'||$7||'%'
                  OR inventory.anchor_text ILIKE '%'||$7||'%')
             AND (
               $4::text IN ('all','referring_domains')
               OR EXISTS (
                 SELECT 1
                   FROM backlink_inventory_observations observation
                  WHERE (
                    observation.organization_id,observation.workspace_id,
                    observation.website_project_id
                  )=($1,$2,$3)
                    AND observation.inventory_item_id=inventory.id
                    AND observation.snapshot_id=(
                      SELECT id FROM latest_snapshot
                    )
                    AND observation.observation_type=$4
               )
             )
        ),
        projected_inventory AS (
          SELECT *
            FROM filtered_inventory inventory
           WHERE $4::text<>'referring_domains'
              OR inventory.source_domain_rank=1
        )
        SELECT inventory.id "inventoryItemId",
               inventory.source_type "sourceType",inventory.provider,
               inventory.source_domain "sourceDomain",
               inventory.normalized_source_url "sourceUrl",
               inventory.normalized_target_url "targetUrl",
               inventory.anchor_text "anchorText",
               inventory.rel_attributes "relAttributes",
               inventory.provider_status "providerStatus",
               inventory.first_seen_at "firstSeenAt",
               inventory.last_seen_at "lastSeenAt",
               inventory.rank,inventory.spam_score "spamScore",
               inventory.country_code "countryCode",
               inventory.tld,inventory.language_code "languageCode",
               inventory.source_http_status "sourceHttpStatus",
               inventory.target_http_status "targetHttpStatus",
               inventory.redirect_url "redirectUrl",
               inventory.placement_id "placementId",
               inventory.opportunity_id "opportunityId",
               inventory.pinned,inventory.managed,
               inventory.direct_health_status "directHealthStatus",
               inventory.direct_validation_status "directValidationStatus",
               inventory.last_direct_checked_at "lastDirectCheckedAt",
               inventory.restriction_reason "restrictionReason",
               inventory.user_notes "userNotes",
               inventory.latest_direct_evidence_id "latestDirectEvidenceId",
               inventory.tier,inventory.importance,
               inventory.monitoring_status "monitoringStatus",
               inventory.policy_version "policyVersion",
               inventory.policy_revision "policyRevision",
               inventory.next_check_at "nextCheckAt",
               inventory.provider_only_reason "providerOnlyReason",
               count(*) OVER() "totalCount"
          FROM projected_inventory inventory
         ORDER BY ${order}
         LIMIT $8 OFFSET $9
      `, values);
      const totalCount = number(result.rows[0]?.totalCount ?? 0);
      return {
        items: result.rows.map((row) => ({
          inventoryItemId: text(row.inventoryItemId),
          sourceType: text(row.sourceType) as "DATAFORSEO" | "USER_IMPORTED",
          provider: text(row.provider),
          sourceDomain: nullableText(row.sourceDomain),
          sourceUrl: text(row.sourceUrl),
          targetUrl: text(row.targetUrl),
          anchorText: text(row.anchorText),
          relAttributes: array(row.relAttributes).map(text),
          providerStatus: text(row.providerStatus) as "live" | "lost" | "unknown",
          firstSeenAt: nullableTimestamp(row.firstSeenAt),
          lastSeenAt: nullableTimestamp(row.lastSeenAt),
          rank: nullableNumber(row.rank),
          spamScore: nullableNumber(row.spamScore),
          countryCode: nullableText(row.countryCode),
          tld: nullableText(row.tld),
          languageCode: nullableText(row.languageCode),
          sourceHttpStatus: nullableNumber(row.sourceHttpStatus),
          targetHttpStatus: nullableNumber(row.targetHttpStatus),
          redirectUrl: nullableText(row.redirectUrl),
          placementId: nullableText(row.placementId),
          opportunityId: nullableText(row.opportunityId),
          pinned: row.pinned === true,
          managed: row.managed === true,
          directHealthStatus: text(row.directHealthStatus) as
            BacklinkInventoryPage["items"][number]["directHealthStatus"],
          directValidationStatus: text(row.directValidationStatus) as
            BacklinkInventoryPage["items"][number]["directValidationStatus"],
          lastDirectCheckedAt: nullableTimestamp(row.lastDirectCheckedAt),
          restrictionReason: nullableText(row.restrictionReason),
          userNotes: nullableText(row.userNotes),
          latestDirectEvidenceId: nullableText(row.latestDirectEvidenceId),
          tier: text(row.tier) as "A" | "B" | "C",
          importance: text(row.importance) as "normal" | "important",
          monitoringStatus: text(row.monitoringStatus) as
            "enabled" | "paused" | "provider_only",
          policyVersion: "inventory-monitoring-v1",
          policyRevision: number(row.policyRevision),
          nextCheckAt: nullableTimestamp(row.nextCheckAt),
          providerOnlyReason: nullableText(row.providerOnlyReason),
        })),
        page: input.page,
        pageSize: input.pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / input.pageSize),
      };
    },

    async getSyncJob(context: ResolvedProjectContext, jobId: string) {
      const result = await client.query(`
        SELECT id "jobId",status,canonical_domain "canonicalDomain",
               total_count "totalCount",pulled_count "pulledCount",
               inventory_coverage "inventoryCoverage",
               estimated_cost_micros "estimatedCostMicros",
               actual_cost_micros "actualCostMicros",
               next_sync_at "nextSyncAt",error_code "errorCode",
               started_at "startedAt",finished_at "finishedAt",
               created_at "createdAt",updated_at "updatedAt"
          FROM backlink_profile_sync_jobs
         WHERE (
           organization_id,workspace_id,website_project_id,id
         )=($1,$2,$3,$4::uuid)
      `, [...scope(context), jobId]);
      const row = result.rows[0];
      return row === undefined ? null : {
        jobId: text(row.jobId),
        status: text(row.status),
        canonicalDomain: text(row.canonicalDomain),
        totalCount: nullableNumber(row.totalCount),
        pulledCount: number(row.pulledCount),
        inventoryCoverage: nullableNumber(row.inventoryCoverage),
        estimatedCostMicros: number(row.estimatedCostMicros),
        actualCostMicros: number(row.actualCostMicros),
        nextSyncAt: nullableTimestamp(row.nextSyncAt),
        errorCode: nullableText(row.errorCode),
        startedAt: nullableTimestamp(row.startedAt),
        finishedAt: nullableTimestamp(row.finishedAt),
        createdAt: timestamp(row.createdAt),
        updatedAt: timestamp(row.updatedAt),
      };
    },

    async createSyncJob(
      context: ResolvedProjectContext,
      input: Readonly<{
        idempotencyKey: string;
        syncMode?: "initial_full" | "incremental" | "page";
        triggerSource?: "manual" | "schedule" | "continuation";
        requestedCursor?: string | null;
      }>,
    ): Promise<BacklinkProfileSyncResult> {
      const prior = await client.query(`
        SELECT id "jobId",status,idempotency_key "idempotencyKey"
          FROM backlink_profile_sync_jobs
         WHERE (
           organization_id,workspace_id,website_project_id,idempotency_key
          )=($1,$2,$3,$4)
      `, [...scope(context), input.idempotencyKey]);
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (
          text(existing.status) === "waiting_provider"
          && options.providerAvailable
        ) {
          const resumedAt = now();
          const resumed = await client.query(`
            WITH resumed_profile AS (
              UPDATE backlink_profile_sync_jobs
                 SET status='queued',error_code=NULL,next_sync_at=NULL,
                     started_at=NULL,finished_at=NULL,updated_at=$5,
                     updated_by=$6,version=version+1
               WHERE (
                 organization_id,workspace_id,website_project_id,id
               )=($1,$2,$3,$4)
                 AND status='waiting_provider'
                 AND next_sync_at IS NOT NULL
                 AND next_sync_at<=$5
               RETURNING backlink_job_id
            )
            UPDATE backlink_jobs
               SET status='queued',step='scheduled',progress=0,error=NULL,
                   retry_count=retry_count+1,started_at=NULL,finished_at=NULL,
                   updated_at=$5,updated_by=$6,version=version+1
             WHERE (
               organization_id,workspace_id,website_project_id,id
             )=(
               $1,$2,$3,(SELECT backlink_job_id FROM resumed_profile)
             )
             RETURNING id
          `, [
            ...scope(context),
            text(existing.jobId),
            resumedAt,
            context.actor.userId,
          ]);
          if (resumed.rows[0] !== undefined) {
            return {
              jobId: text(existing.jobId),
              workflowId: buildBacklinksWorkflowId({
                organizationId: context.tenant.organizationId,
                workspaceId: context.tenant.workspaceId,
                websiteProjectId: context.project.websiteProjectId,
                workflow: "backlink-profile-sync",
                instanceId: text(existing.jobId),
              }),
              status: "queued",
              canonicalDomain: context.project.canonicalDomain,
              estimatedCostMicros: options.estimatedCostMicros,
              providerInputRequired: false,
              replayed: false,
            };
          }
        }
        return {
          jobId: text(existing.jobId),
          workflowId: buildBacklinksWorkflowId({
            organizationId: context.tenant.organizationId,
            workspaceId: context.tenant.workspaceId,
            websiteProjectId: context.project.websiteProjectId,
            workflow: "backlink-profile-sync",
            instanceId: text(existing.jobId),
          }),
          status: text(existing.status) as BacklinkProfileSyncResult["status"],
          canonicalDomain: context.project.canonicalDomain,
          estimatedCostMicros: options.estimatedCostMicros,
          providerInputRequired: text(existing.status) === "waiting_provider",
          replayed: true,
        };
      }
      const backlinkJobId = newId();
      const profileSyncJobId = newId();
      const createdAt = now();
      const status = options.providerAvailable ? "queued" : "waiting_provider";
      const workflowId = buildBacklinksWorkflowId({
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        workflow: "backlink-profile-sync",
        instanceId: profileSyncJobId,
      });
      await client.query(`
        WITH inserted_job AS (
          INSERT INTO backlink_jobs (
            id,organization_id,workspace_id,website_project_id,job_type,
            source_object_type,source_object_id,status,step,progress,workflow_id,
            correlation_id,created_at,updated_at,created_by,updated_by
          ) VALUES (
            $4,$1,$2,$3,'backlink_profile_sync','website_project',$3,$8,
            $9,0,$6,$7,$10,$10,$11,$11
          )
          RETURNING id
        )
        INSERT INTO backlink_profile_sync_jobs (
          id,organization_id,workspace_id,website_project_id,backlink_job_id,
          canonical_domain,sync_mode,trigger_source,status,provider,
          requested_cursor,estimated_cost_micros,idempotency_key,next_sync_at,
          created_at,updated_at,created_by,updated_by
        ) VALUES (
          $5,$1,$2,$3,$4,$12,$16,$17,$8,'dataforseo',
          $18,$13,$14,$15,$10,$10,$11,$11
        )
        RETURNING id
      `, [
        ...scope(context),
        backlinkJobId,
        profileSyncJobId,
        workflowId,
        input.idempotencyKey,
        status,
        status === "queued" ? "scheduled" : "provider_input_required",
        createdAt,
        context.actor.userId,
        context.project.canonicalDomain.toLowerCase(),
        options.estimatedCostMicros,
        input.idempotencyKey,
        status === "waiting_provider"
          ? new Date(createdAt.getTime() + 86_400_000)
          : null,
        input.syncMode ?? "initial_full",
        input.triggerSource ?? "manual",
        input.requestedCursor ?? null,
      ]);
      return {
        jobId: profileSyncJobId,
        workflowId,
        status,
        canonicalDomain: context.project.canonicalDomain,
        estimatedCostMicros: options.estimatedCostMicros,
        providerInputRequired: !options.providerAvailable,
        replayed: false,
      };
    },

    async importInventory(
      context: ResolvedProjectContext,
      input: Readonly<{
        sourceUrl: string;
        targetUrl: string;
        anchorText?: string | undefined;
        notes?: string | undefined;
        managed?: boolean | undefined;
      }>,
    ): Promise<BacklinkInventoryImportResult> {
      const source = createPlacementUrlKey(input.sourceUrl);
      const target = createPlacementUrlKey(input.targetUrl);
      const existing = await client.query(`
        SELECT inventory.id "inventoryItemId",
               inventory.normalized_source_url "sourceUrl",
               inventory.normalized_target_url "targetUrl",
               policy.tier,policy.monitoring_status "monitoringStatus",
               policy.next_check_at "nextCheckAt"
          FROM backlink_inventory_items inventory
          JOIN backlink_inventory_monitor_policies policy ON (
            policy.organization_id,policy.workspace_id,
            policy.website_project_id,policy.inventory_item_id
          )=(
            inventory.organization_id,inventory.workspace_id,
            inventory.website_project_id,inventory.id
          )
         WHERE (
           inventory.organization_id,inventory.workspace_id,
           inventory.website_project_id,
           inventory.normalized_source_url,inventory.normalized_target_url
         )=($1,$2,$3,$4,$5)
      `, [...scope(context), source.normalizedUrl, target.normalizedUrl]);
      const prior = existing.rows[0];
      if (prior !== undefined) {
        return {
          inventoryItemId: text(prior.inventoryItemId),
          sourceUrl: text(prior.sourceUrl),
          targetUrl: text(prior.targetUrl),
          tier: text(prior.tier) as "A" | "B" | "C",
          monitoringStatus: text(prior.monitoringStatus) as
            "enabled" | "paused" | "provider_only",
          nextCheckAt: nullableTimestamp(prior.nextCheckAt),
          replayed: true,
        };
      }

      const inventoryItemId = newId();
      const observationId = newId();
      const createdAt = now();
      const inserted = await client.query(`
        WITH inserted_inventory AS (
          INSERT INTO backlink_inventory_items (
            id,organization_id,workspace_id,website_project_id,
            source_type,provider,provider_identity,
            normalized_source_url,normalized_target_url,source_domain,
            anchor_text,rel_attributes,provider_status,managed,user_notes,
            created_at,updated_at,created_by,updated_by
          ) VALUES (
            $4,$1,$2,$3,'USER_IMPORTED','user_import',$5,
            $6,$7,$8,$9,'[]'::jsonb,'unknown',$10,$11,
            $12,$12,$13,$13
          )
          ON CONFLICT (
            organization_id,workspace_id,website_project_id,
            normalized_source_url,normalized_target_url
          ) DO NOTHING
          RETURNING id
        )
        INSERT INTO backlink_inventory_observations (
          id,organization_id,workspace_id,website_project_id,
          inventory_item_id,observation_type,page_identity,provider_status,
          observed_at,evidence,created_at,created_by
        )
        SELECT $14,$1,$2,$3,id,'imported',$15,'unknown',$12,
          jsonb_build_object(
            'source','user_import',
            'sourceUrl',$6::text,
            'targetUrl',$7::text,
            'notes',$11::text
          ),
          $12,$13
        FROM inserted_inventory
        RETURNING inventory_item_id "inventoryItemId"
      `, [
        ...scope(context),
        inventoryItemId,
        `user:${inventoryItemId}`,
        source.normalizedUrl,
        target.normalizedUrl,
        source.hostnameAscii,
        input.anchorText?.trim() ?? "",
        input.managed === true,
        input.notes?.trim() || null,
        createdAt,
        context.actor.userId,
        observationId,
        `${source.normalizedUrlHash}:${target.normalizedUrlHash}`,
      ]);
      if (inserted.rows[0] === undefined) {
        const concurrent = await client.query(`
          SELECT inventory.id "inventoryItemId",
                 inventory.normalized_source_url "sourceUrl",
                 inventory.normalized_target_url "targetUrl",
                 policy.tier,policy.monitoring_status "monitoringStatus",
                 policy.next_check_at "nextCheckAt"
            FROM backlink_inventory_items inventory
            JOIN backlink_inventory_monitor_policies policy ON (
              policy.organization_id,policy.workspace_id,
              policy.website_project_id,policy.inventory_item_id
            )=(
              inventory.organization_id,inventory.workspace_id,
              inventory.website_project_id,inventory.id
            )
           WHERE (
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id,
             inventory.normalized_source_url,inventory.normalized_target_url
           )=($1,$2,$3,$4,$5)
        `, [...scope(context), source.normalizedUrl, target.normalizedUrl]);
        const replay = concurrent.rows[0];
        if (replay === undefined) {
          throw new Error("Concurrent backlink inventory import was not found.");
        }
        return {
          inventoryItemId: text(replay.inventoryItemId),
          sourceUrl: text(replay.sourceUrl),
          targetUrl: text(replay.targetUrl),
          tier: text(replay.tier) as "A" | "B" | "C",
          monitoringStatus: text(replay.monitoringStatus) as
            "enabled" | "paused" | "provider_only",
          nextCheckAt: nullableTimestamp(replay.nextCheckAt),
          replayed: true,
        };
      }
      const policy = await client.query(`
        SELECT inventory_item_id "inventoryItemId",tier,
               monitoring_status "monitoringStatus",next_check_at "nextCheckAt"
          FROM backlink_inventory_monitor_policies
         WHERE (
           organization_id,workspace_id,website_project_id,inventory_item_id
         )=($1,$2,$3,$4)
           AND policy_version='inventory-monitoring-v1'
      `, [...scope(context), inventoryItemId]);
      const row = policy.rows[0];
      if (row === undefined) {
        throw new Error("Imported backlink inventory policy was not created.");
      }
      return {
        inventoryItemId,
        sourceUrl: source.normalizedUrl,
        targetUrl: target.normalizedUrl,
        tier: text(row.tier) as "A" | "B" | "C",
        monitoringStatus: text(row.monitoringStatus) as
          "enabled" | "paused" | "provider_only",
        nextCheckAt: nullableTimestamp(row.nextCheckAt),
        replayed: false,
      };
    },

    async updateInventoryPolicy(
      context: ResolvedProjectContext,
      inventoryItemId: string,
      input: Readonly<{
        expectedVersion: number;
        important: boolean;
        monitoringStatus: "enabled" | "paused";
      }>,
    ): Promise<BacklinkInventoryPolicyResult> {
      const result = await client.query(`
        UPDATE backlink_inventory_monitor_policies policy
           SET importance=CASE WHEN $6 THEN 'important' ELSE 'normal' END,
               monitoring_status=CASE
                 WHEN inventory.source_type='USER_IMPORTED'
                   OR inventory.placement_id IS NOT NULL
                   OR inventory.pinned OR inventory.managed OR $6
                   THEN $7
                 ELSE 'provider_only'
               END,
               tier=CASE
                 WHEN $6 THEN 'A'
                 WHEN inventory.placement_id IS NOT NULL
                   OR inventory.pinned OR inventory.managed
                   OR inventory.provider_status='lost'
                   THEN 'A'
                 WHEN COALESCE(inventory.rank,0)>=60 THEN 'B'
                 ELSE 'C'
               END,
               normal_interval_seconds=CASE
                 WHEN $6
                   OR inventory.placement_id IS NOT NULL
                   OR inventory.pinned OR inventory.managed
                   OR inventory.provider_status='lost'
                   THEN 86400
                 WHEN COALESCE(inventory.rank,0)>=60 THEN 604800
                 ELSE 2592000
               END,
               jitter_window_seconds=CASE
                 WHEN $6
                   OR inventory.placement_id IS NOT NULL
                   OR inventory.pinned OR inventory.managed
                   OR inventory.provider_status='lost'
                   THEN 3600
                 WHEN COALESCE(inventory.rank,0)>=60 THEN 21600
                 ELSE 86400
               END,
                next_check_at=CASE
                  WHEN inventory.source_type<>'USER_IMPORTED'
                    AND inventory.placement_id IS NULL
                    AND NOT inventory.pinned
                    AND NOT inventory.managed
                    AND NOT $6
                    THEN NULL
                  WHEN $7='enabled'
                    THEN LEAST(COALESCE(policy.next_check_at,$8),$8)
                  ELSE COALESCE(policy.next_check_at,$8)
                END,
                provider_only_reason=CASE
                  WHEN inventory.source_type='USER_IMPORTED'
                    OR inventory.placement_id IS NOT NULL
                    OR inventory.pinned OR inventory.managed OR $6
                    THEN NULL
                  ELSE 'provider_inventory_requires_pin_or_management'
                END,
               updated_at=$8,updated_by=$9,version=policy.version+1
          FROM backlink_inventory_items inventory
         WHERE policy.organization_id=$1 AND policy.workspace_id=$2
           AND policy.website_project_id=$3
           AND policy.inventory_item_id=$4 AND policy.version=$5
           AND policy.policy_version='inventory-monitoring-v1'
           AND (
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id,inventory.id
           )=(
             policy.organization_id,policy.workspace_id,
             policy.website_project_id,policy.inventory_item_id
           )
        RETURNING policy.inventory_item_id "inventoryItemId",policy.tier,
          policy.importance,policy.monitoring_status "monitoringStatus",
          policy.policy_version "policyVersion",
          policy.version "policyRevision",
          policy.next_check_at "nextCheckAt",
          policy.provider_only_reason "providerOnlyReason"
      `, [
        ...scope(context),
        inventoryItemId,
        input.expectedVersion,
        input.important,
        input.monitoringStatus,
        now(),
        context.actor.userId,
      ]);
      const row = result.rows[0];
      if (row !== undefined) {
        await client.query(`
          UPDATE backlink_inventory_items
             SET pinned=$5,updated_at=$6,updated_by=$7,version=version+1
           WHERE (
             organization_id,workspace_id,website_project_id,id
           )=($1,$2,$3,$4)
        `, [
          ...scope(context),
          inventoryItemId,
          input.important,
          now(),
          context.actor.userId,
        ]);
        const updated = await client.query(`
          SELECT inventory_item_id "inventoryItemId",tier,importance,
                 monitoring_status "monitoringStatus",
                 policy_version "policyVersion",version "policyRevision",
                 next_check_at "nextCheckAt",
                 provider_only_reason "providerOnlyReason"
            FROM backlink_inventory_monitor_policies
           WHERE (
             organization_id,workspace_id,website_project_id,inventory_item_id
           )=($1,$2,$3,$4)
             AND policy_version='inventory-monitoring-v1'
        `, [...scope(context), inventoryItemId]);
        return policyResult(updated.rows[0] ?? row);
      }
      const exists = await client.query(`
        SELECT version
          FROM backlink_inventory_monitor_policies
         WHERE (
           organization_id,workspace_id,website_project_id,inventory_item_id
         )=($1,$2,$3,$4)
      `, [...scope(context), inventoryItemId]);
      throw new BacklinkError({
        code: exists.rows[0] === undefined
          ? backlinkErrorCodes.notFound
          : backlinkErrorCodes.conflict,
        message: exists.rows[0] === undefined
          ? "Backlink inventory item was not found."
          : "Backlink inventory monitoring policy changed. Refresh and retry.",
      });
    },

    async requestInventoryCheck(
      context: ResolvedProjectContext,
      inventoryItemId: string,
      input: Readonly<{ idempotencyKey: string }>,
    ): Promise<BacklinkInventoryCheckResult> {
      const prior = await client.query(`
        SELECT request.inventory_item_id "inventoryItemId",
               request.run_id "runId",
               request.observation_id "observationId",
               request.monitor_policy_id "monitorPolicyId",
               request.policy_version "policyVersion",
               request.scheduled_for "scheduledFor"
          FROM backlink_inventory_monitor_requests request
         WHERE (
           request.organization_id,request.workspace_id,
           request.website_project_id,request.idempotency_key
         )=($1,$2,$3,$4)
      `, [...scope(context), input.idempotencyKey]);
      const existing = prior.rows[0];
      if (
        existing !== undefined
        && text(existing.inventoryItemId) !== inventoryItemId
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Idempotency key belongs to another inventory item.",
        });
      }
      if (existing !== undefined) {
        const runId = text(existing.runId);
        const monitorInput = {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          placementId: inventoryItemId,
          monitorPolicyId: text(existing.monitorPolicyId),
          policyVersion: text(existing.policyVersion),
          scheduledFor: timestamp(existing.scheduledFor),
          runId,
          observationId: text(existing.observationId),
          workerId: context.actor.userId,
          now: now().toISOString(),
        } satisfies PlacementMonitorWorkflowInput;
        return {
          inventoryItemId,
          runId,
          observationId: monitorInput.observationId,
          workflowId: buildBacklinksWorkflowId({
            organizationId: context.tenant.organizationId,
            workspaceId: context.tenant.workspaceId,
            websiteProjectId: context.project.websiteProjectId,
            workflow: "placement-monitoring",
            instanceId: runId,
          }),
          scheduledFor: timestamp(existing.scheduledFor),
          replayed: true,
          monitorInput,
        };
      }

      const policy = await client.query(`
        SELECT id "monitorPolicyId",policy_version "policyVersion"
          FROM backlink_inventory_monitor_policies
         WHERE (
           organization_id,workspace_id,website_project_id,inventory_item_id
         )=($1,$2,$3,$4)
           AND policy_version='inventory-monitoring-v1'
           AND monitoring_status='enabled'
         FOR UPDATE
      `, [...scope(context), inventoryItemId]);
      const policyRow = policy.rows[0];
      if (policyRow === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Backlink inventory monitoring must be enabled first.",
        });
      }
      const requestId = newId();
      const runId = newId();
      const observationId = newId();
      const scheduledFor = now();
      await client.query(`
        UPDATE backlink_inventory_monitor_policies
           SET next_check_at=$5,updated_at=$5,updated_by=$6,version=version+1
         WHERE (
           organization_id,workspace_id,website_project_id,inventory_item_id
         )=($1,$2,$3,$4)
           AND policy_version='inventory-monitoring-v1'
           AND monitoring_status='enabled'
      `, [
        ...scope(context),
        inventoryItemId,
        scheduledFor,
        context.actor.userId,
      ]);
      await client.query(`
        INSERT INTO backlink_inventory_monitor_requests (
          id,organization_id,workspace_id,website_project_id,
          inventory_item_id,monitor_policy_id,run_id,observation_id,
          idempotency_key,policy_version,scheduled_for,
          requested_at,requested_by
        ) VALUES (
          $5,$1,$2,$3,$4,$6,$7,$8,$9,$10,$11,$11,$12
        )
      `, [
        ...scope(context),
        inventoryItemId,
        requestId,
        text(policyRow.monitorPolicyId),
        runId,
        observationId,
        input.idempotencyKey,
        text(policyRow.policyVersion),
        scheduledFor,
        context.actor.userId,
      ]);
      const monitorInput = {
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        placementId: inventoryItemId,
        monitorPolicyId: text(policyRow.monitorPolicyId),
        policyVersion: text(policyRow.policyVersion),
        scheduledFor: scheduledFor.toISOString(),
        runId,
        observationId,
        workerId: context.actor.userId,
        now: scheduledFor.toISOString(),
      } satisfies PlacementMonitorWorkflowInput;
      return {
        inventoryItemId,
        runId,
        observationId,
        workflowId: buildBacklinksWorkflowId({
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          workflow: "placement-monitoring",
          instanceId: runId,
        }),
        scheduledFor: scheduledFor.toISOString(),
        replayed: false,
        monitorInput,
      };
    },

    async listDirectObservations(
      context: ResolvedProjectContext,
      inventoryItemId: string,
      limit: number,
    ): Promise<BacklinkInventoryDirectObservationPage> {
      const result = await client.query(`
        SELECT id "observationId",monitor_run_id "runId",result,
               direct_validation_status "directValidationStatus",
               failure_code "failureCode",
               restriction_reason "restrictionReason",
               evidence_snapshot "evidenceSnapshot",observed_at "observedAt"
          FROM backlink_inventory_monitor_observations
         WHERE (
           organization_id,workspace_id,website_project_id,inventory_item_id
         )=($1,$2,$3,$4)
         ORDER BY observed_at DESC,id DESC
         LIMIT $5
      `, [...scope(context), inventoryItemId, limit]);
      return {
        items: result.rows.map((row) => ({
          observationId: text(row.observationId),
          runId: text(row.runId),
          result: text(row.result) as
            "present" | "changed" | "absent" | "inaccessible",
          directValidationStatus: text(row.directValidationStatus) as
            BacklinkInventoryDirectObservationPage["items"][number][
              "directValidationStatus"
            ],
          failureCode: nullableText(row.failureCode),
          restrictionReason: nullableText(row.restrictionReason),
          evidenceSnapshot: object(row.evidenceSnapshot),
          observedAt: timestamp(row.observedAt),
        })),
      };
    },
  });
}

export function createBacklinkProfileService(options: Readonly<{
  queryStore: ReturnType<typeof createBacklinkProfileStore>;
  commandStore: (
    context: ResolvedProjectContext,
    input: Readonly<{ idempotencyKey: string }>,
  ) => Promise<BacklinkProfileSyncResult>;
  scheduler: BacklinkProfileSyncScheduler;
  inventoryScheduler: BacklinkInventoryMonitorScheduler;
}>) {
  return Object.freeze({
    getProfile: options.queryStore.getProfile,
    listInventory: options.queryStore.listInventory,
    getSyncJob: options.queryStore.getSyncJob,
    listDirectObservations: options.queryStore.listDirectObservations,
    async importInventory(
      context: ResolvedProjectContext,
      input: Parameters<
        ReturnType<typeof createBacklinkProfileStore>["importInventory"]
      >[1],
    ) {
      requireInventoryWriteAccess(context);
      return options.queryStore.importInventory(context, input);
    },
    async updateInventoryPolicy(
      context: ResolvedProjectContext,
      inventoryItemId: string,
      input: Parameters<
        ReturnType<typeof createBacklinkProfileStore>["updateInventoryPolicy"]
      >[2],
    ) {
      requireInventoryWriteAccess(context);
      return options.queryStore.updateInventoryPolicy(
        context,
        inventoryItemId,
        input,
      );
    },
    async requestInventoryCheck(
      context: ResolvedProjectContext,
      inventoryItemId: string,
      input: Readonly<{ idempotencyKey: string }>,
    ) {
      requireInventoryWriteAccess(context);
      const result = await options.queryStore.requestInventoryCheck(
        context,
        inventoryItemId,
        input,
      );
      if (!result.replayed) {
        await options.inventoryScheduler.start(result.monitorInput);
      }
      return result;
    },
    async requestSync(
      context: ResolvedProjectContext,
      input: Readonly<{ idempotencyKey: string }>,
    ) {
      requireInventoryWriteAccess(context);
      const result = await options.commandStore(context, input);
      if (result.status === "queued" && !result.replayed) {
        await options.scheduler.start({
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          profileSyncJobId: result.jobId,
          canonicalDomain: result.canonicalDomain,
        });
      }
      return result;
    },
  });
}
