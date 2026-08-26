import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  createOfficialDataForSeoProfileRuntime,
  type DataForSeoProfileInventoryItem,
  type DataForSeoProfileInventoryPage,
  type DataForSeoProfileSummary,
} from "../adapters/dataforseo/profile-official-runtime.js";
import {
  mapDataForSeoProviderError,
  type DataForSeoProviderError,
} from "../adapters/dataforseo/error-mapper.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import {
  calculateBacklinkProfileHealth,
} from "../domain/profile/backlink-profile-health.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../db/tenant-transaction.js";
import { secretKinds } from "../ports/secret-store.port.js";
import {
  localProductDataForSeoAvailabilityDecision,
  type LocalProductDataForSeoConfiguration,
} from "./local-product-dataforseo-runtime.js";

const summaryEndpoint = "/v3/backlinks/summary/live";
const inventoryEndpoint = "/v3/backlinks/backlinks/live";
const freshnessMilliseconds = 86_400_000;
const continuationMilliseconds = 3_600_000;

const credentialSchema = z.object({
  login: z.string().trim().min(1),
  password: z.string().min(1),
}).strict();

export type BacklinkProfileSyncActivityInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  profileSyncJobId: string;
  canonicalDomain: string;
}>;

type ProviderRequest = Readonly<{
  id: string;
  ledgerId: string;
  endpoint: typeof summaryEndpoint | typeof inventoryEndpoint;
  fingerprint: string;
  reservationKey: string;
}>;

type ReservedJob = Readonly<{
  actorId: string;
  backlinkJobId: string;
  requestedCursor: string | null;
  summaryRequest: ProviderRequest;
  inventoryRequest: ProviderRequest;
}>;

const scopeFrom = (
  input: BacklinkProfileSyncActivityInput,
): BacklinkTenantContext => ({
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  websiteProjectId: input.websiteProjectId,
});

const text = (value: unknown): string => String(value);
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const numeric = (value: unknown): number => Number(value);
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const jsonObject = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : { value };

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new TypeError("BACKLINK_PROFILE_URL_INVALID");
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  return url.href;
}

function providerDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function counts(values: readonly (string | null)[]) {
  const output: Record<string, number> = {};
  for (const value of values) {
    const key = value?.trim() || "unknown";
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}

function unavailableMetrics(summary: DataForSeoProfileSummary): string[] {
  return [
    ["totalBacklinks", summary.totalBacklinks],
    ["referringDomains", summary.referringDomains],
    ["dofollow", summary.dofollow],
    ["nofollow", summary.nofollow],
    ["sponsored", summary.sponsored],
    ["ugc", summary.ugc],
  ].filter((entry) => entry[1] === null).map((entry) => String(entry[0]));
}

async function setWaitingProvider(
  pool: BacklinkTenantPool,
  input: BacklinkProfileSyncActivityInput,
  errorCode = "provider_input_required",
) {
  const nextSyncAt = new Date(Date.now() + freshnessMilliseconds);
  await withBacklinkTenantTransaction(pool, scopeFrom(input), async (client) => {
    await client.query(`
      WITH profile AS (
        UPDATE backlink_profile_sync_jobs
           SET status='waiting_provider',error_code=$5,next_sync_at=$6,
               finished_at=now(),updated_at=now(),version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4
         RETURNING backlink_job_id
      )
      UPDATE backlink_jobs
         SET status='waiting_provider',step='provider_input_required',
             progress=0,error=jsonb_build_object('code',$5::text),
             updated_at=now(),version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3
         AND id=(SELECT backlink_job_id FROM profile)
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
      errorCode,
      nextSyncAt,
    ]);
  });
  return Object.freeze({
    status: "waiting_provider" as const,
    providerInputRequired: true,
  });
}

async function reserveProviderRequests(
  pool: BacklinkTenantPool,
  input: BacklinkProfileSyncActivityInput,
  configuration: LocalProductDataForSeoConfiguration,
): Promise<ReservedJob | null> {
  const scope = scopeFrom(input);
  return withBacklinkTenantTransaction(pool, scope, async (client) => {
    const jobResult = await client.query(`
      SELECT backlink_job_id "backlinkJobId",requested_cursor "requestedCursor",
             created_by "createdBy",status
        FROM backlink_profile_sync_jobs
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
       FOR UPDATE
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
    ]);
    const job = jobResult.rows[0];
    if (job === undefined) {
      throw new Error("BACKLINK_PROFILE_SYNC_JOB_NOT_FOUND");
    }
    if (["completed", "partial"].includes(text(job.status))) return null;

    const budget = await client.query(`
      SELECT id,limit_micros,spent_micros,reserved_micros
        FROM backlink_provider_budgets
       WHERE organization_id=$1 AND workspace_id=$2
         AND provider='dataforseo'
         AND period_start<=now() AND period_end>now()
       ORDER BY period_start DESC
       LIMIT 1
       FOR UPDATE
    `, [input.organizationId, input.workspaceId]);
    const budgetRow = budget.rows[0];
    if (budgetRow === undefined) return null;

    const gate = await client.query(`
      WITH calls AS (
        SELECT count(*)::integer count
          FROM backlink_provider_usage_ledger
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3
           AND budget_id=$4
           AND provider='dataforseo'
           AND status IN ('reserved','settled')
      ), switches AS (
        SELECT
          COALESCE((
            SELECT NOT blocked
              FROM backlink_kill_switch_versions
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3
               AND capability='backlinks.dataforseo.v1'
               AND layer='project' AND provider IS NULL
             ORDER BY version DESC LIMIT 1
          ),false)
          AND COALESCE((
            SELECT NOT blocked
              FROM backlink_kill_switch_versions
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3
               AND capability='backlinks.dataforseo.v1'
               AND layer='provider' AND provider='dataforseo'
             ORDER BY version DESC LIMIT 1
          ),false) available
      )
      SELECT calls.count "paidCallCount",switches.available
        FROM calls CROSS JOIN switches
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      budgetRow.id,
    ]);
    const gateRow = gate.rows[0];
    const totalEstimate = configuration.estimatedCostMicros * 2;
    if (
      gateRow === undefined
      || gateRow.available !== true
      || numeric(budgetRow.limit_micros)
        - numeric(budgetRow.spent_micros)
        - numeric(budgetRow.reserved_micros) < totalEstimate
      || numeric(gateRow.paidCallCount) + 2 > configuration.maxPaidCalls
    ) {
      return null;
    }

    const requests = [summaryEndpoint, inventoryEndpoint].map((endpoint) => {
      const requestPayload = endpoint === summaryEndpoint
        ? { target: input.canonicalDomain, requestIntent: "MONITORING" }
        : {
            target: input.canonicalDomain,
            requestIntent: "MONITORING",
            limit: configuration.candidateLimit,
            searchAfterToken: nullableText(job.requestedCursor),
          };
      return {
        id: randomUUID(),
        ledgerId: randomUUID(),
        endpoint,
        fingerprint: hash(requestPayload),
        reservationKey: [
          "backlink-profile",
          input.profileSyncJobId,
          endpoint,
        ].join(":"),
        requestPayload,
      };
    });
    for (const request of requests) {
      await client.query(`
        INSERT INTO backlink_provider_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_fingerprint,active_request_bucket,request_schema_version,
          request_payload,status,started_at,created_by
        ) VALUES (
          $1,$2,$3,$4,'dataforseo',$5,$6,$7,1,$8::jsonb,'running',now(),$9
        )
      `, [
        request.id,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        request.endpoint,
        request.fingerprint,
        request.reservationKey,
        JSON.stringify(request.requestPayload),
        text(job.createdBy),
      ]);
      await client.query(`
        SELECT backlink_reserve_provider_cost(
          $1,$2,$3,$4,$5,$6,'dataforseo',$7,$8,$9
        )
      `, [
        request.ledgerId,
        budgetRow.id,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        request.id,
        request.reservationKey,
        configuration.estimatedCostMicros,
        text(job.createdBy),
      ]);
    }
    await client.query(`
      UPDATE backlink_profile_sync_jobs
         SET status='running',started_at=COALESCE(started_at,now()),
             error_code=NULL,updated_at=now(),version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
    ]);
    await client.query(`
      UPDATE backlink_jobs
         SET status='running',step='provider_request',progress=10,
             updated_at=now(),version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      job.backlinkJobId,
    ]);
    return Object.freeze({
      actorId: text(job.createdBy),
      backlinkJobId: text(job.backlinkJobId),
      requestedCursor: nullableText(job.requestedCursor),
      summaryRequest: requests[0] as ProviderRequest,
      inventoryRequest: requests[1] as ProviderRequest,
    });
  });
}

async function settleProviderRequest(
  client: BacklinkTransactionClient,
  requestId: string,
  actualCostMicros: number,
  settledAt: Date,
) {
  await client.query(`
    WITH ledger AS (
      UPDATE backlink_provider_usage_ledger
         SET status='settled',actual_cost_micros=$2,settled_at=$3
       WHERE provider_request_id=$1 AND status='reserved'
       RETURNING budget_id,estimated_cost_micros
    ), budget AS (
      UPDATE backlink_provider_budgets budget
         SET reserved_micros=budget.reserved_micros-ledger.estimated_cost_micros,
             spent_micros=budget.spent_micros+$2,version=budget.version+1
        FROM ledger
       WHERE budget.id=ledger.budget_id
       RETURNING budget.id
    )
    UPDATE backlink_provider_requests
       SET status='succeeded',finished_at=$3
     WHERE id=$1 AND status='running'
       AND EXISTS (SELECT 1 FROM budget)
  `, [requestId, actualCostMicros, settledAt]);
}

async function failProviderRequest(
  client: BacklinkTransactionClient,
  requestId: string,
  failure: DataForSeoProviderError,
  failedAt: Date,
) {
  await client.query(`
    WITH ledger AS (
      UPDATE backlink_provider_usage_ledger
         SET status='released',released_at=$3
       WHERE provider_request_id=$1 AND status='reserved' AND $2='failed'
       RETURNING budget_id,estimated_cost_micros
    )
    UPDATE backlink_provider_budgets budget
       SET reserved_micros=budget.reserved_micros-ledger.estimated_cost_micros,
           version=budget.version+1
      FROM ledger
     WHERE budget.id=ledger.budget_id
  `, [requestId, failure.providerRequestStatus, failedAt]);
  await client.query(`
    UPDATE backlink_provider_requests
       SET status=$2,finished_at=$3
     WHERE id=$1 AND status='running'
  `, [requestId, failure.providerRequestStatus, failedAt]);
}

async function releaseUndispatchedRequest(
  client: BacklinkTransactionClient,
  requestId: string,
  releasedAt: Date,
) {
  await client.query(`
    WITH ledger AS (
      UPDATE backlink_provider_usage_ledger
         SET status='released',released_at=$2
       WHERE provider_request_id=$1 AND status='reserved'
       RETURNING budget_id,estimated_cost_micros
    )
    UPDATE backlink_provider_budgets budget
       SET reserved_micros=budget.reserved_micros-ledger.estimated_cost_micros,
           version=budget.version+1
      FROM ledger
     WHERE budget.id=ledger.budget_id
  `, [requestId, releasedAt]);
  await client.query(`
    UPDATE backlink_provider_requests
       SET status='failed',finished_at=$2
     WHERE id=$1 AND status='running'
  `, [requestId, releasedAt]);
}

async function insertSummaryArtifact(
  pool: BacklinkTenantPool,
  input: BacklinkProfileSyncActivityInput,
  job: ReservedJob,
  summary: DataForSeoProfileSummary,
  observedAt: Date,
): Promise<string> {
  const artifactId = randomUUID();
  await withBacklinkTenantTransaction(pool, scopeFrom(input), async (client) => {
    await settleProviderRequest(
      client,
      job.summaryRequest.id,
      summary.costMicros,
      observedAt,
    );
    await client.query(`
      INSERT INTO backlink_profile_provider_artifacts (
        id,organization_id,workspace_id,website_project_id,
        profile_sync_job_id,provider,endpoint,request_intent,
        request_fingerprint,provider_task_id,page_identity,observed_at,
        fresh_until,request_payload,response_payload,cost_micros,
        schema_version,created_by
      ) VALUES (
        $1,$2,$3,$4,$5,'dataforseo',$6,'MONITORING',$7,$8,$9,$10,$11,
        $12::jsonb,$13::jsonb,$14,$15,$16
      )
    `, [
      artifactId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
      summaryEndpoint,
      job.summaryRequest.fingerprint,
      summary.providerTaskId,
      [
        "summary",
        summary.providerTaskId ?? input.profileSyncJobId,
      ].join(":"),
      observedAt,
      new Date(observedAt.getTime() + freshnessMilliseconds),
      JSON.stringify({ target: input.canonicalDomain }),
      JSON.stringify(jsonObject(summary.raw)),
      summary.costMicros,
      summary.schemaVersion,
      job.actorId,
    ]);
  });
  return artifactId;
}

function profileDistributions(
  summary: DataForSeoProfileSummary,
  inventory: DataForSeoProfileInventoryPage,
) {
  return {
    provider: summary.distributions,
    anchors: counts(inventory.items.map((item) => item.anchor)),
    countries: counts(inventory.items.map((item) => item.countryCode)),
    tlds: counts(inventory.items.map((item) => item.tld)),
    sourceDomains: counts(inventory.items.map((item) => item.sourceDomain)),
    targetPages: counts(inventory.items.map((item) => item.targetUrl)),
    status: {
      live: inventory.items.filter((item) => !item.isLost).length,
      lost: inventory.items.filter((item) => item.isLost).length,
    },
  };
}

function healthFor(
  summary: DataForSeoProfileSummary,
  inventory: DataForSeoProfileInventoryPage,
  coverage: number,
) {
  const anchors = counts(inventory.items.map((item) => item.anchor));
  const domains = new Map<string, DataForSeoProfileInventoryItem>();
  for (const item of inventory.items) {
    if (item.sourceDomain !== null) domains.set(item.sourceDomain, item);
  }
  const targetPages = new Set(inventory.items.map((item) => item.targetUrl));
  return calculateBacklinkProfileHealth({
    inventoryCoverage: coverage,
    totalBacklinks: summary.totalBacklinks ?? inventory.totalCount ?? 0,
    referringDomains: summary.referringDomains ?? domains.size,
    dofollow: summary.dofollow ?? 0,
    nofollow: summary.nofollow ?? 0,
    sponsored: summary.sponsored ?? 0,
    ugc: summary.ugc ?? 0,
    spamHighRisk: inventory.items.filter(
      (item) => (item.spamScore ?? 0) >= 50,
    ).length,
    commercialAnchorCount: inventory.items.filter((item) =>
      /\b(?:buy|price|discount|deal|cheap|best)\b/iu.test(item.anchor)
    ).length,
    largestAnchorCount: Math.max(0, ...Object.values(anchors)),
    newBacklinks: inventory.items.filter((item) => item.isNew).length,
    lostBacklinks: inventory.items.filter((item) => item.isLost).length,
    relevantCountryCount: inventory.items.filter(
      (item) => item.countryCode !== null,
    ).length,
    knownCountryCount: inventory.items.filter(
      (item) => item.countryCode !== null,
    ).length,
    targetPageCount: targetPages.size,
    brokenTargetCount: inventory.items.filter(
      (item) => (item.targetHttpStatus ?? 0) >= 400,
    ).length,
    qualityDomainCount: [...domains.values()].filter(
      (item) => (item.rank ?? 0) >= 50 && (item.spamScore ?? 0) < 50,
    ).length,
    knownPlacementCount: 0,
    validatedPlacementCount: 0,
  });
}

async function persistInventory(
  pool: BacklinkTenantPool,
  input: BacklinkProfileSyncActivityInput,
  job: ReservedJob,
  summaryArtifactId: string,
  summary: DataForSeoProfileSummary,
  inventory: DataForSeoProfileInventoryPage,
  observedAt: Date,
) {
  const inventoryArtifactId = randomUUID();
  const snapshotId = randomUUID();
  const freshUntil = new Date(observedAt.getTime() + freshnessMilliseconds);
  const totalCount = inventory.totalCount ?? summary.totalBacklinks;
  const nextSyncAt = new Date(
    observedAt.getTime()
      + (inventory.nextCursor === null
        ? freshnessMilliseconds
        : continuationMilliseconds),
  );
  return withBacklinkTenantTransaction(pool, scopeFrom(input), async (client) => {
    await settleProviderRequest(
      client,
      job.inventoryRequest.id,
      inventory.costMicros,
      observedAt,
    );
    await client.query(`
      INSERT INTO backlink_profile_provider_artifacts (
        id,organization_id,workspace_id,website_project_id,
        profile_sync_job_id,provider,endpoint,request_intent,
        request_fingerprint,provider_task_id,page_identity,observed_at,
        fresh_until,request_payload,response_payload,cost_micros,
        schema_version,created_by
      ) VALUES (
        $1,$2,$3,$4,$5,'dataforseo',$6,'MONITORING',$7,$8,$9,$10,$11,
        $12::jsonb,$13::jsonb,$14,$15,$16
      )
    `, [
      inventoryArtifactId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
      inventoryEndpoint,
      job.inventoryRequest.fingerprint,
      inventory.providerTaskId,
      [
        job.requestedCursor ?? "first-page",
        inventory.providerTaskId ?? input.profileSyncJobId,
      ].join(":"),
      observedAt,
      freshUntil,
      JSON.stringify({
        target: input.canonicalDomain,
        limit: inventory.pulledCount,
        searchAfterToken: job.requestedCursor,
      }),
      JSON.stringify(jsonObject(inventory.raw)),
      inventory.costMicros,
      inventory.schemaVersion,
      job.actorId,
    ]);
    await client.query(`
      INSERT INTO backlink_profile_snapshots (
        id,organization_id,workspace_id,website_project_id,
        profile_sync_job_id,summary_artifact_id,inventory_artifact_id,
        provider,endpoints,provider_task_ids,observed_at,fresh_until,
        freshness,completeness,total_backlinks,referring_domains,dofollow,
        nofollow,sponsored,ugc,new_backlinks,lost_backlinks,
        inventory_pulled_count,inventory_coverage,distributions,
        unavailable_metrics,cost_micros,schema_version,next_sync_at,created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,'dataforseo',$8::jsonb,$9::jsonb,$10,$11,
        'fresh','partial',$12,$13,$14,$15,$16,$17,$18,$19,0,NULL,$20::jsonb,
        $21::jsonb,$22,'backlink-profile.v1',$23,$24
      )
    `, [
      snapshotId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
      summaryArtifactId,
      inventoryArtifactId,
      JSON.stringify([summaryEndpoint, inventoryEndpoint]),
      JSON.stringify([
        summary.providerTaskId,
        inventory.providerTaskId,
      ].filter(Boolean)),
      observedAt,
      freshUntil,
      summary.totalBacklinks,
      summary.referringDomains,
      summary.dofollow,
      summary.nofollow,
      summary.sponsored,
      summary.ugc,
      inventory.items.filter((item) => item.isNew).length,
      inventory.items.filter((item) => item.isLost).length,
      JSON.stringify(profileDistributions(summary, inventory)),
      JSON.stringify(unavailableMetrics(summary)),
      summary.costMicros + inventory.costMicros,
      nextSyncAt,
      job.actorId,
    ]);

    for (const item of inventory.items) {
      let sourceUrl: string;
      let targetUrl: string;
      try {
        sourceUrl = normalizeUrl(item.sourceUrl);
        targetUrl = normalizeUrl(item.targetUrl);
      } catch {
        continue;
      }
      const previous = await client.query(`
        SELECT provider_status "providerStatus"
          FROM backlink_inventory_items
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3
           AND normalized_source_url=$4 AND normalized_target_url=$5
           AND provider='dataforseo' AND provider_identity=$6
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        sourceUrl,
        targetUrl,
        item.providerIdentity,
      ]);
      const upserted = await client.query(`
        INSERT INTO backlink_inventory_items (
          id,organization_id,workspace_id,website_project_id,
          latest_snapshot_id,latest_artifact_id,source_type,provider,
          provider_identity,normalized_source_url,normalized_target_url,
          source_domain,anchor_text,rel_attributes,provider_status,
          first_seen_at,last_seen_at,rank,spam_score,country_code,tld,
          language_code,source_http_status,target_http_status,redirect_url,
          created_by,updated_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,'DATAFORSEO','dataforseo',$7,$8,$9,$10,$11,
          $12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24
        )
        ON CONFLICT (
          organization_id,workspace_id,website_project_id,
          normalized_source_url,normalized_target_url,provider,
          provider_identity
        ) DO UPDATE SET
          latest_snapshot_id=EXCLUDED.latest_snapshot_id,
          latest_artifact_id=EXCLUDED.latest_artifact_id,
          source_domain=EXCLUDED.source_domain,
          anchor_text=EXCLUDED.anchor_text,
          rel_attributes=EXCLUDED.rel_attributes,
          provider_status=EXCLUDED.provider_status,
          first_seen_at=COALESCE(
            backlink_inventory_items.first_seen_at,EXCLUDED.first_seen_at
          ),
          last_seen_at=EXCLUDED.last_seen_at,
          rank=EXCLUDED.rank,spam_score=EXCLUDED.spam_score,
          country_code=EXCLUDED.country_code,tld=EXCLUDED.tld,
          language_code=EXCLUDED.language_code,
          source_http_status=EXCLUDED.source_http_status,
          target_http_status=EXCLUDED.target_http_status,
          redirect_url=EXCLUDED.redirect_url,updated_at=now(),
          updated_by=EXCLUDED.updated_by,
          version=backlink_inventory_items.version+1
        RETURNING id
      `, [
        randomUUID(),
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        snapshotId,
        inventoryArtifactId,
        item.providerIdentity,
        sourceUrl,
        targetUrl,
        item.sourceDomain,
        item.anchor,
        JSON.stringify(item.rel),
        item.isLost ? "lost" : "live",
        providerDate(item.firstSeenAt),
        providerDate(item.lastSeenAt) ?? observedAt,
        item.rank,
        item.spamScore,
        item.countryCode,
        item.tld,
        item.languageCode,
        item.sourceHttpStatus,
        item.targetHttpStatus,
        item.redirectUrl,
        job.actorId,
      ]);
      const inventoryItemId = text(upserted.rows[0]?.id);
      await client.query(`
        UPDATE backlink_inventory_items item
           SET placement_id=placement.id,
               opportunity_id=placement.opportunity_id,
               updated_at=now(),version=item.version+1
          FROM backlink_placements placement
         WHERE item.organization_id=$1 AND item.workspace_id=$2
           AND item.website_project_id=$3 AND item.id=$4
           AND placement.organization_id=item.organization_id
           AND placement.workspace_id=item.workspace_id
           AND placement.website_project_id=item.website_project_id
           AND placement.normalized_source_url=item.normalized_source_url
           AND placement.normalized_target_url=item.normalized_target_url
           AND item.placement_id IS DISTINCT FROM placement.id
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        inventoryItemId,
      ]);
      const previousStatus = nullableText(previous.rows[0]?.providerStatus);
      const observationType = item.isLost
        ? "lost"
        : previousStatus === "lost"
          ? "recovered"
          : item.isNew
            ? "new"
            : "observed";
      await client.query(`
        INSERT INTO backlink_inventory_observations (
          id,organization_id,workspace_id,website_project_id,
          inventory_item_id,snapshot_id,artifact_id,observation_type,
          page_identity,provider_status,observed_at,evidence,created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13
        )
        ON CONFLICT (
          organization_id,workspace_id,website_project_id,
          inventory_item_id,page_identity,observation_type
        ) DO NOTHING
      `, [
        randomUUID(),
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        inventoryItemId,
        snapshotId,
        inventoryArtifactId,
        observationType,
        [
          inventory.providerTaskId ?? input.profileSyncJobId,
          job.requestedCursor ?? "first-page",
        ].join(":"),
        item.isLost ? "lost" : "live",
        observedAt,
        JSON.stringify({
          provider: "dataforseo",
          providerTaskId: inventory.providerTaskId,
          sourceUrl,
          targetUrl,
        }),
        job.actorId,
      ]);
    }

    const inventoryCountResult = await client.query(`
      SELECT count(*)::integer count
        FROM backlink_inventory_items
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3
    `, [input.organizationId, input.workspaceId, input.websiteProjectId]);
    const pulledCount = numeric(inventoryCountResult.rows[0]?.count ?? 0);
    const coverage = totalCount === null
      ? null
      : totalCount === 0
        ? 1
        : Math.min(1, pulledCount / totalCount);
    const completeness = totalCount !== null && pulledCount >= totalCount
      ? "full"
      : pulledCount === 0 && (totalCount ?? 0) > 0
        ? "summary_only"
        : "partial";
    const health = healthFor(summary, inventory, coverage ?? 0);
    await client.query(`
      UPDATE backlink_profile_snapshots
         SET completeness=$5,inventory_pulled_count=$6,
             inventory_coverage=$7
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      snapshotId,
      completeness,
      pulledCount,
      coverage,
    ]);
    await client.query(`
      INSERT INTO backlink_profile_health_snapshots (
        id,organization_id,workspace_id,website_project_id,
        profile_snapshot_id,score,grade,components,risks,positives,
        evidence_observed_at,model_version,created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13
      )
    `, [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      snapshotId,
      health.score,
      health.grade,
      JSON.stringify(health.components),
      JSON.stringify(health.risks),
      JSON.stringify(health.positives),
      observedAt,
      health.modelVersion,
      job.actorId,
    ]);
    await client.query(`
      INSERT INTO backlink_profile_sync_cursors (
        id,organization_id,workspace_id,website_project_id,provider,endpoint,
        search_after_token,next_page_number,total_count,pulled_count,
        last_snapshot_id,last_synced_at,next_sync_at,created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,'dataforseo',$5,$6,$7,$8,$9,$10,$11,$12,$13,$13
      )
      ON CONFLICT (
        organization_id,workspace_id,website_project_id,provider,endpoint
      ) DO UPDATE SET
        search_after_token=EXCLUDED.search_after_token,
        next_page_number=EXCLUDED.next_page_number,
        total_count=EXCLUDED.total_count,
        pulled_count=EXCLUDED.pulled_count,
        last_snapshot_id=EXCLUDED.last_snapshot_id,
        last_synced_at=EXCLUDED.last_synced_at,
        next_sync_at=EXCLUDED.next_sync_at,updated_at=now(),
        updated_by=EXCLUDED.updated_by,
        version=backlink_profile_sync_cursors.version+1
    `, [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      inventoryEndpoint,
      inventory.nextCursor,
      inventory.nextCursor === null ? 1 : 2,
      totalCount,
      pulledCount,
      snapshotId,
      observedAt,
      nextSyncAt,
      job.actorId,
    ]);
    const profileStatus = inventory.nextCursor === null
      ? "completed"
      : "partial";
    await client.query(`
      UPDATE backlink_profile_sync_jobs
         SET status=$5,total_count=$6,pulled_count=$7,
             inventory_coverage=$8,actual_cost_micros=$9,
             next_sync_at=$10,finished_at=$11,updated_at=$11,
             version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
      profileStatus,
      totalCount,
      pulledCount,
      coverage,
      summary.costMicros + inventory.costMicros,
      nextSyncAt,
      observedAt,
    ]);
    await client.query(`
      UPDATE backlink_jobs
         SET status='success',step=$5,progress=100,error=NULL,
             finished_at=$6,updated_at=$6,version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      job.backlinkJobId,
      profileStatus === "completed" ? "profile_completed" : "profile_partial",
      observedAt,
    ]);
    return Object.freeze({
      status: profileStatus,
      snapshotId,
      totalCount,
      pulledCount,
      inventoryCoverage: coverage,
      nextCursor: inventory.nextCursor,
      costMicros: summary.costMicros + inventory.costMicros,
    });
  });
}

async function recordFailure(
  pool: BacklinkTenantPool,
  input: BacklinkProfileSyncActivityInput,
  job: ReservedJob,
  requestId: string,
  undispatchedRequestId: string | null,
  error: unknown,
) {
  const failure = mapDataForSeoProviderError(error);
  const failedAt = new Date();
  await withBacklinkTenantTransaction(pool, scopeFrom(input), async (client) => {
    await failProviderRequest(client, requestId, failure, failedAt);
    if (undispatchedRequestId !== null) {
      await releaseUndispatchedRequest(client, undispatchedRequestId, failedAt);
    }
    await client.query(`
      UPDATE backlink_profile_sync_jobs
         SET status='failed',error_code=$5,finished_at=$6,
             updated_at=$6,version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.profileSyncJobId,
      failure.code,
      failedAt,
    ]);
    await client.query(`
      UPDATE backlink_jobs
         SET status='failed',step='provider_request_failed',progress=100,
             error=jsonb_build_object('code',$5::text),
             finished_at=$6,updated_at=$6,version=version+1
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      job.backlinkJobId,
      failure.code,
      failedAt,
    ]);
  });
  throw failure;
}

export function createLocalProductBacklinkProfileRuntime(options: Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string;
  configuration: LocalProductDataForSeoConfiguration;
}>) {
  const secretStore = new LocalProductSecretStoreClient({
    rootDirectory: options.secretStoreRoot,
  });
  return Object.freeze({
    async execute(input: BacklinkProfileSyncActivityInput) {
      const availability = localProductDataForSeoAvailabilityDecision(
        options.configuration,
      );
      if (availability.decision === "deny") {
        return setWaitingProvider(
          options.pool,
          input,
          availability.reasonCode,
        );
      }
      let credential: z.output<typeof credentialSchema>;
      try {
        credential = credentialSchema.parse(JSON.parse(
          await secretStore.resolve({
            reference: parseLocalProductSecretReference(
              options.configuration.credentialSecretRef,
              secretKinds.dataForSeoCredential,
            ),
            context: {
              organizationId: "local-product",
              subjectProvider: "dataforseo",
            },
          }),
        ));
      } catch {
        return setWaitingProvider(
          options.pool,
          input,
          "provider_credential_required",
        );
      }
      const job = await reserveProviderRequests(
        options.pool,
        input,
        options.configuration,
      );
      if (job === null) return setWaitingProvider(options.pool, input);
      const provider = createOfficialDataForSeoProfileRuntime({
        credentials: credential,
        endpointAllowlist: options.configuration.endpointAllowlist,
        timeoutMs: options.configuration.timeoutMs,
      });
      let summary: DataForSeoProfileSummary;
      try {
        summary = await provider.fetchSummary({
          canonicalDomain: input.canonicalDomain,
          requestTag: `monitoring:${input.websiteProjectId}:${input.profileSyncJobId}:summary`,
        });
      } catch (error) {
        return recordFailure(
          options.pool,
          input,
          job,
          job.summaryRequest.id,
          job.inventoryRequest.id,
          error,
        );
      }
      const summaryObservedAt = new Date();
      const summaryArtifactId = await insertSummaryArtifact(
        options.pool,
        input,
        job,
        summary,
        summaryObservedAt,
      );
      let inventory: DataForSeoProfileInventoryPage;
      try {
        inventory = await provider.fetchInventoryPage({
          canonicalDomain: input.canonicalDomain,
          requestTag: `monitoring:${input.websiteProjectId}:${input.profileSyncJobId}:inventory`,
          limit: options.configuration.candidateLimit,
          searchAfterToken: job.requestedCursor,
        });
      } catch (error) {
        return recordFailure(
          options.pool,
          input,
          job,
          job.inventoryRequest.id,
          null,
          error,
        );
      }
      return persistInventory(
        options.pool,
        input,
        job,
        summaryArtifactId,
        summary,
        inventory,
        new Date(),
      );
    },
  });
}

export const markBacklinkProfileInputRequired = setWaitingProvider;
