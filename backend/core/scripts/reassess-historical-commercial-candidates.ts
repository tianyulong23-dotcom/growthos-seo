import { readFile } from "node:fs/promises";

import pg from "pg";
import { z } from "zod";

import {
  runHistoricalCommercialReassessment,
} from "../src/modules/backlinks/application/services/historical-commercial-reassessment.service.js";
import {
  createPostgresqlProjectScopeProvider,
} from "../src/modules/backlinks/db/repositories/project-scope.repository.js";
import type {
  BacklinkTenantContext,
} from "../src/modules/backlinks/db/tenant-transaction.js";

const expectedBuildId =
  "local-product-2337ef16419c97c3e86628d1";
const commandSchema = z.object({
  action: z.enum(["dry-run", "apply"]),
  actorId: z.string().trim().min(1),
  expectedBuildId: z.literal(expectedBuildId),
  guards: z.object({
    waitingRecommendationRefillJobId: z.uuid(),
    runningCommercialDiscoveryBatchId: z.uuid(),
    pendingProjectAnalysisOutboxEventId: z.uuid(),
    auditWebsiteProjectIds: z.array(z.uuid()).min(1).max(10),
  }).strict(),
}).strict();

type QueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>>;
}>;

type SafetySnapshot = Readonly<{
  provider: Readonly<Record<string, string>>;
  budget: Readonly<Record<string, string>>;
  gmail: Readonly<Record<string, string>>;
  business: Readonly<Record<string, string>>;
  guards: Readonly<Record<string, unknown>>;
  contact: Readonly<Record<string, string>>;
}>;

function requiredEnvironment(
  name: string,
  expected?: string,
): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`LOCAL_PRODUCT_035_ENV_REQUIRED:${name}`);
  }
  if (expected !== undefined && value !== expected) {
    throw new Error(`LOCAL_PRODUCT_035_ENV_MISMATCH:${name}`);
  }
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`LOCAL_PRODUCT_035_ENV_INVALID:${name}`);
  }
  return value;
}

async function readStandardInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 100_000) {
      throw new Error("LOCAL_PRODUCT_035_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) {
    throw new Error("LOCAL_PRODUCT_035_STDIN_REQUIRED");
  }
  return JSON.parse(value) as unknown;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LOCAL_PRODUCT_035_SAFETY_SNAPSHOT_INVALID");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, String(nested)]),
  ));
}

async function scalarJson(
  client: QueryClient,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Readonly<Record<string, unknown>>> {
  const row = (await client.query(sql, values)).rows[0];
  const value = row?.snapshot;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LOCAL_PRODUCT_035_SAFETY_SNAPSHOT_INVALID");
  }
  return Object.freeze(value as Record<string, unknown>);
}

async function assertMigrationReady(client: QueryClient): Promise<void> {
  const result = await client.query(
    `SELECT (
       (
         SELECT count(*)
           FROM information_schema.columns
          WHERE table_schema='backlinks'
            AND table_name='backlink_commercial_inventory_policies'
            AND column_name IN (
              'paid_refill_tier','paid_refill_round',
              'resource_refill_tier','resource_refill_round'
            )
       )=4
       AND (
         SELECT count(*)
           FROM pg_constraint
          WHERE conrelid=
            'backlinks.backlink_commercial_inventory_policies'::regclass
            AND conname IN (
              'backlink_commercial_paid_refill_cursor_check',
              'backlink_commercial_resource_refill_cursor_check'
            )
       )=2
     ) AS ready`,
  );
  if (result.rows[0]?.ready !== true) {
    throw new Error("LOCAL_PRODUCT_035_MIGRATION_0058_REQUIRED");
  }
}

async function safetySnapshot(
  pool: pg.Pool,
  input: z.infer<typeof commandSchema>,
  scopes: readonly BacklinkTenantContext[],
): Promise<SafetySnapshot> {
  const client = await pool.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const organizationId = requiredEnvironment(
      "LOCAL_PRODUCT_ORGANIZATION_ID",
    );
    const workspaceId = requiredEnvironment("LOCAL_PRODUCT_WORKSPACE_ID");
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.current_workspace_id', $2, true),
              set_config('app.current_website_project_id', '', true),
              set_config('app.current_project_id', '', true)`,
      [organizationId, workspaceId],
    );
    const budget = await scalarJson(client, `
      SELECT jsonb_build_object(
        'limitMicros',limit_micros::text,
        'spentMicros',spent_micros::text,
        'reservedMicros',reserved_micros::text,
        'remainingMicros',
          (limit_micros-spent_micros-reserved_micros)::text,
        'version',version::text
      ) snapshot
      FROM backlinks.backlink_provider_budgets
      WHERE organization_id=$1 AND workspace_id=$2
        AND provider='dataforseo'
      ORDER BY period_start DESC
      LIMIT 1
    `, [organizationId, workspaceId]);
    const workspaceGmail = await scalarJson(client, `
      SELECT jsonb_build_object(
        'connectionCursorCount',(
          SELECT count(*)::text
            FROM backlinks.backlink_gmail_connection_sync_cursors
        ),
        'connectionCursorVersionSum',(
          SELECT COALESCE(sum(version),0)::text
            FROM backlinks.backlink_gmail_connection_sync_cursors
        )
      ) snapshot
    `);
    const leases = await scalarJson(client, `
      SELECT jsonb_build_object(
        'leaseCount',(
          SELECT count(*)::text FROM backlinks.provider_fetch_leases
        ),
        'activeLeaseCount',(
          SELECT count(*)::text
            FROM backlinks.provider_fetch_leases
           WHERE status='acquired' AND lease_expires_at>now()
        )
      ) snapshot
    `);
    const providerTotals = {
      legacyRequestCount: 0,
      legacyActiveRequestCount: 0,
      ledgerCount: 0,
      ledgerReservedCount: 0,
      ledgerActualCostMicros: 0,
      batchRequestCount: 0,
      activeBatchRequestCount: 0,
      activeProviderTaskCount: 0,
      activeActualCostMicros: 0,
    };
    const gmailTotals = {
      sendAttemptCount: 0,
      mailCursorCount: 0,
      mailCursorVersionSum: 0,
    };
    const businessTotals = {
      recommendationRefillJobCount: 0,
      commercialDiscoveryBatchCount: 0,
      recommendationRefillOutboxCount: 0,
      projectAnalysisOutboxCount: 0,
      projectAnalysisPendingCount: 0,
    };
    const contactTotals = {
      jobCount: 0,
      outboxCount: 0,
    };
    const guardTotals: Record<string, unknown> = {
      waitingJob: null,
      runningBatch: null,
      pendingProjectAnalysisOutbox: null,
    };
    const addCounts = (
      target: Record<string, number>,
      source: Readonly<Record<string, unknown>>,
    ): void => {
      for (const key of Object.keys(target)) {
        target[key] += Number(source[key] ?? 0);
      }
    };
    for (const scope of scopes) {
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.current_workspace_id', $2, true),
                set_config('app.current_website_project_id', $3, true),
                set_config('app.current_project_id', $3, true)`,
        [
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
        ],
      );
      addCounts(
        providerTotals,
        await scalarJson(client, `
          SELECT jsonb_build_object(
            'legacyRequestCount',(
              SELECT count(*)::text FROM backlinks.backlink_provider_requests
            ),
            'legacyActiveRequestCount',(
              SELECT count(*)::text
                FROM backlinks.backlink_provider_requests
               WHERE status IN ('pending','running')
            ),
            'ledgerCount',(
              SELECT count(*)::text
                FROM backlinks.backlink_provider_usage_ledger
            ),
            'ledgerReservedCount',(
              SELECT count(*)::text
                FROM backlinks.backlink_provider_usage_ledger
               WHERE status='reserved'
            ),
            'ledgerActualCostMicros',(
              SELECT COALESCE(sum(actual_cost_micros),0)::text
                FROM backlinks.backlink_provider_usage_ledger
            ),
            'batchRequestCount',(
              SELECT count(*)::text
                FROM backlinks.provider_batch_requests
            ),
            'activeBatchRequestCount',(
              SELECT count(*)::text
                FROM backlinks.provider_batch_requests
               WHERE status='running'
            ),
            'activeProviderTaskCount',(
              SELECT count(*)::text
                FROM backlinks.provider_batch_requests
               WHERE status='running' AND provider_task_id IS NOT NULL
            ),
            'activeActualCostMicros',(
              SELECT COALESCE(sum(actual_cost_micros),0)::text
                FROM backlinks.provider_batch_requests
               WHERE status='running'
            )
          ) snapshot
        `),
      );
      addCounts(
        gmailTotals,
        await scalarJson(client, `
          SELECT jsonb_build_object(
            'sendAttemptCount',(
              SELECT count(*)::text FROM backlinks.backlink_send_attempts
            ),
            'mailCursorCount',(
              SELECT count(*)::text
                FROM backlinks.backlink_mail_sync_cursors
            ),
            'mailCursorVersionSum',(
              SELECT COALESCE(sum(version),0)::text
                FROM backlinks.backlink_mail_sync_cursors
            )
          ) snapshot
        `),
      );
      addCounts(
        businessTotals,
        await scalarJson(client, `
          SELECT jsonb_build_object(
            'recommendationRefillJobCount',(
              SELECT count(*)::text FROM backlinks.backlink_jobs
               WHERE job_type='recommendation_refill'
            ),
            'commercialDiscoveryBatchCount',(
              SELECT count(*)::text
                FROM backlinks.backlink_commercial_discovery_batches
            ),
            'recommendationRefillOutboxCount',(
              SELECT count(*)::text FROM backlinks.backlink_outbox_events
               WHERE event_type=
                 'backlinks.recommendation-refill.requested.v1'
            ),
            'projectAnalysisOutboxCount',(
              SELECT count(*)::text FROM backlinks.backlink_outbox_events
               WHERE event_type='backlinks.project-analysis.requested.v1'
            ),
            'projectAnalysisPendingCount',(
              SELECT count(*)::text FROM backlinks.backlink_outbox_events
               WHERE event_type='backlinks.project-analysis.requested.v1'
                 AND status='pending'
            )
          ) snapshot
        `),
      );
      const projectGuards = await scalarJson(client, `
          SELECT jsonb_build_object(
            'waitingJob',(
              SELECT jsonb_build_object(
                'status',status,'step',step,'progress',progress,
                'workflowId',workflow_id,'retryCount',retry_count,
                'version',version
              )
              FROM backlinks.backlink_jobs WHERE id=$1
            ),
            'runningBatch',(
              SELECT jsonb_build_object(
                'status',status,
                'providerFingerprintCount',
                  jsonb_array_length(provider_request_fingerprints),
                'paidCostMicros',paid_cost_micros::text,
                'refillTier',refill_tier,'refillRound',refill_round,
                'finishedAt',finished_at
              )
              FROM backlinks.backlink_commercial_discovery_batches
              WHERE id=$2
            ),
            'pendingProjectAnalysisOutbox',(
              SELECT jsonb_build_object(
                'status',status,'attemptCount',attempt_count,
                'claimedAt',claimed_at,'claimedBy',claimed_by,
                'publishedAt',published_at,
                'aggregateVersion',aggregate_version
              )
              FROM backlinks.backlink_outbox_events WHERE id=$3
            )
          ) snapshot
        `, [
        input.guards.waitingRecommendationRefillJobId,
        input.guards.runningCommercialDiscoveryBatchId,
        input.guards.pendingProjectAnalysisOutboxEventId,
      ]);
      for (const [key, value] of Object.entries(projectGuards)) {
        if (value !== null && value !== undefined) {
          if (guardTotals[key] !== null) {
            throw new Error("LOCAL_PRODUCT_035_GUARD_IDENTITY_AMBIGUOUS");
          }
          guardTotals[key] = value;
        }
      }
      addCounts(
        contactTotals,
        await scalarJson(client, `
          SELECT jsonb_build_object(
            'jobCount',(
              SELECT count(*)::text
                FROM backlinks.backlink_contact_enrichment_jobs
            ),
            'outboxCount',(
              SELECT count(*)::text FROM backlinks.backlink_outbox_events
               WHERE event_type=
                 'backlinks.contact-enrichment.requested.v1'
            )
          ) snapshot
        `),
      );
    }
    await client.query("COMMIT");
    return Object.freeze({
      provider: stringRecord({
        ...providerTotals,
        ...leases,
      }),
      budget: stringRecord(budget),
      gmail: stringRecord({
        ...gmailTotals,
        ...workspaceGmail,
      }),
      business: stringRecord(businessTotals),
      guards: Object.freeze(guardTotals),
      contact: stringRecord(contactTotals),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertSafeBefore(snapshot: SafetySnapshot): void {
  if (
    snapshot.provider.legacyActiveRequestCount !== "0"
    || snapshot.provider.activeBatchRequestCount !== "0"
    || snapshot.provider.activeProviderTaskCount !== "0"
    || snapshot.provider.activeActualCostMicros !== "0"
    || snapshot.provider.activeLeaseCount !== "0"
  ) {
    throw new Error("LOCAL_PRODUCT_035_ACTIVE_PROVIDER_WORK_BLOCKED");
  }
  if (
    snapshot.budget.limitMicros !== "1000000"
    || snapshot.budget.spentMicros !== "950976"
    || snapshot.budget.reservedMicros !== "0"
    || snapshot.budget.remainingMicros !== "49024"
  ) {
    throw new Error("LOCAL_PRODUCT_035_DATAFORSEO_BUDGET_MISMATCH");
  }
  const waitingJob = snapshot.guards.waitingJob;
  const runningBatch = snapshot.guards.runningBatch;
  const pendingOutbox = snapshot.guards.pendingProjectAnalysisOutbox;
  if (
    typeof waitingJob !== "object" || waitingJob === null
    || (waitingJob as Record<string, unknown>).status !== "waiting_provider"
    || typeof runningBatch !== "object" || runningBatch === null
    || (runningBatch as Record<string, unknown>).status !== "running"
    || String((runningBatch as Record<string, unknown>).paidCostMicros) !== "0"
    || Number(
      (runningBatch as Record<string, unknown>).providerFingerprintCount,
    ) !== 0
    || typeof pendingOutbox !== "object" || pendingOutbox === null
    || (pendingOutbox as Record<string, unknown>).status !== "pending"
  ) {
    throw new Error("LOCAL_PRODUCT_035_RUNTIME_GUARD_MISMATCH");
  }
}

function assertUnchanged(
  before: SafetySnapshot,
  after: SafetySnapshot,
): void {
  for (const key of ["provider", "budget", "gmail", "business", "guards"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`LOCAL_PRODUCT_035_SAFETY_DRIFT:${key}`);
    }
  }
}

async function listScopes(
  pool: pg.Pool,
  organizationId: string,
  workspaceId: string,
): Promise<readonly BacklinkTenantContext[]> {
  const provider = createPostgresqlProjectScopeProvider(pool);
  const scopes: BacklinkTenantContext[] = [];
  let cursor: string | null = null;
  do {
    const page = await provider.listActiveProjectScopes({
      organizationId,
      workspaceId,
      lane: "recommendation-refill",
      cursor,
      limit: 100,
    });
    scopes.push(...page.scopes.map((scope) => ({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      websiteProjectId: scope.websiteProjectId,
    })));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(scopes);
}

async function main(): Promise<void> {
  requiredEnvironment("BACKLINKS_RUNTIME_MODE", "LOCAL_PRODUCT");
  requiredEnvironment("BACKLINKS_WORKER_EXECUTION_MODE", "quiesced");
  requiredEnvironment("TEMPORAL_BUILD_ID", expectedBuildId);
  requiredEnvironment("DATAFORSEO_ABSOLUTE_BUDGET_MICROS", "1000000");
  requiredEnvironment("DATAFORSEO_MAX_PAID_CALLS", "250");
  requiredEnvironment("GMAIL_SEND_ENABLED", "true");
  requiredEnvironment("GMAIL_SYNC_ENABLED", "true");
  requiredEnvironment("BROWSER_PROVIDER_ENABLED", "false");

  const command = commandSchema.parse(await readStandardInput());
  const organizationId = requiredEnvironment(
    "LOCAL_PRODUCT_ORGANIZATION_ID",
  );
  const workspaceId = requiredEnvironment("LOCAL_PRODUCT_WORKSPACE_ID");
  const databaseUrlFile = requiredEnvironment("DATABASE_URL_FILE");
  const databaseUrl = (await readFile(databaseUrlFile, "utf8")).trim();
  if (databaseUrl.length === 0) {
    throw new Error("LOCAL_PRODUCT_035_DATABASE_URL_EMPTY");
  }
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await assertMigrationReady(pool);
    const scopes = await listScopes(
      pool,
      organizationId,
      workspaceId,
    );
    const safetyScopes = Object.freeze([
      ...scopes,
      ...command.guards.auditWebsiteProjectIds
        .filter((websiteProjectId) => !scopes.some(
          (scope) => scope.websiteProjectId === websiteProjectId,
        ))
        .map((websiteProjectId) => ({
          organizationId,
          workspaceId,
          websiteProjectId,
        })),
    ]);
    const before = await safetySnapshot(pool, command, safetyScopes);
    assertSafeBefore(before);
    const summary = await runHistoricalCommercialReassessment({
      pool,
      scopes,
      mode: command.action,
      actorId: command.actorId,
      now: new Date(),
      contactOptions: {
        maxPages: positiveIntegerEnvironment(
          "CONTACT_ENRICHMENT_MAX_PAGES",
        ),
        maxDepth: positiveIntegerEnvironment(
          "CONTACT_ENRICHMENT_MAX_DEPTH",
        ),
        maxAttempts: positiveIntegerEnvironment(
          "CONTACT_ENRICHMENT_MAX_ATTEMPTS",
        ),
        browserAllowed: false,
      },
    });
    const after = await safetySnapshot(pool, command, safetyScopes);
    assertUnchanged(before, after);
    console.log(JSON.stringify({
      taskId: "LOCAL-PRODUCT-035",
      buildId: expectedBuildId,
      workerExecutionMode: "quiesced",
      businessConsumersRunning: false,
      providerCalls: {
        dataForSeo: 0,
        ai: 0,
        gmailSend: 0,
        gmailSync: 0,
        browser: 0,
      },
      safety: {
        providerLedgerUnchanged: true,
        dataForSeoBudgetUnchanged: true,
        gmailUnchanged: true,
        guardedRuntimeRecordsUnchanged: true,
        before: {
          provider: before.provider,
          budget: before.budget,
          gmail: before.gmail,
          business: before.business,
          contact: before.contact,
        },
        after: {
          provider: after.provider,
          budget: after.budget,
          gmail: after.gmail,
          business: after.business,
          contact: after.contact,
        },
      },
      reassessment: summary,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "LOCAL_PRODUCT_035_REASSESSMENT_FAILED",
  );
  process.exitCode = 1;
});
