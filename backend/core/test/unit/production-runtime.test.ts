import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { BacklinksRuntimeFactoryContext } from "../../src/index.js";
import { runtime } from "../../src/modules/backlinks/runtime/production-runtime.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const disabledProviderEnvironment = {
  GMAIL_SEND_ENABLED: "false",
  GMAIL_SYNC_ENABLED: "false",
  DATAFORSEO_ENABLED: "false",
  AI_PROVIDER_ENABLED: "false",
  BROWSER_PROVIDER_ENABLED: "false",
} as const;

function runtimeContext(
  processType: "api" | "worker",
): BacklinksRuntimeFactoryContext {
  return {
    process: processType,
    pool: {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release() {},
      }),
      async end() {},
    },
    temporal: {} as BacklinksRuntimeFactoryContext["temporal"],
  };
}

function enableCanaryEnvironment(): void {
  Object.assign(process.env, disabledProviderEnvironment);
}

describe("production Backlinks runtime", () => {
  it("contains no test-only or in-memory composition references", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toMatch(
      /(?:test\/|fixtures?|\bfake\b|\bmock\b|in[- ]?memory|memoryrepository)/i,
    );
    expect(source).not.toContain("LOCAL_PRODUCT_WEBSITE_PROJECT_ID");
    expect(source).toContain("createPostgresqlProjectScopeProvider");
    expect(source).toContain("runProjectScopedLane");
    expect(source).toContain('runLocalProjectLane("project-analysis"');
    expect(source).toContain("createBacklinkOutboxRelay({");
    expect(source).toContain(
      'event: "backlinks.project-analysis.outbox.relay"',
    );
  });

  it("persists the stable recommendation refill failure contract", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("'rootCause',$6::text");
    expect(source).toContain("'recovery',$7::text");
    expect(source).toContain("'providerCallOccurred',provider_call.occurred");
    expect(source).toContain("'diagnosticId',$8::text");
    expect(source).toContain(
      "JOIN backlink_recommendation_refills AS refill",
    );
    expect(source).toContain(
      "refill.refill_window_key \"refillWindowKey\"",
    );
    expect(source).toContain(
      "usage.reservation_key LIKE\n"
        + "                           failed_refill.\"refillWindowKey\"||':%'",
    );
    expect(source).toContain(
      "request.request_id LIKE\n"
        + "                           failed_refill.\"refillWindowKey\"||':%'",
    );
    expect(source).not.toContain("batch.started_at>=failed_job.\"startedAt\"");
    expect(source).toContain("website_project_id=$3 AND id=$4::uuid");
    expect(source).toContain("SET refill_state='paused'");
    expect(source).toContain(
      "WHEN 'PROVIDER_UNAVAILABLE'\n"
        + "                           THEN 'PROVIDER_UNAVAILABLE'",
    );
    expect(source).toContain("updated_at=now(),updated_by=$10");
    expect(source).not.toContain("'detail',input.message");
  });

  it("allows the bounded provider plan to outlive the old 15 minute limit", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/workflows/definitions/"
          + "backlink-recommendation-refill.workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('startToCloseTimeout: "2 hours"');
    expect(source).not.toContain('startToCloseTimeout: "15 minutes"');
    expect(source).toContain("retry: { maximumAttempts: 1 }");
  });

  it("completes recommendation refill jobs when inventory is sufficient", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("reserveRecommendationRefillJob(client,");
    expect(source).toContain("recommendationContextVersionId:");
    expect(source).toContain("ensureCommercialRecommendationRefill(client,");
    expect(source).toContain(
      'event: "backlinks.commercial-inventory.refill.queued"',
    );
    expect(source).toContain("createRecommendationRefillOutboxRelay({");
  });

  it("checks Gmail token health per account with bounded retries", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('runLocalProjectLane("gmail-sync"');
    expect(source).toContain("gmailSendRuntime.refreshTokenHealth({");
    expect(source).toContain('event: "backlinks.gmail-token-health.checked"');
    expect(source).toContain("gmailTokenHealthRetryByConnection");
    expect(source).toContain("calculateGmailTokenHealthRetryDelaySeconds(");
    expect(source).toContain("const nextAttemptAt = Date.now() + 86_400_000");
    expect(source).toContain(
      "nextGmailTokenHealthCheckAt = Date.now() + 60_000",
    );
  });

  it("prioritizes project recommendation closure over profile sync", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain(
      "job.trigger_source IN (\n                                'schedule','continuation'",
    );
    expect(source).toContain(
      "job.requested_cursor IS NOT DISTINCT FROM\n                                  cursor.search_after_token",
    );
    expect(source).not.toContain("job.next_sync_at>now()");
    expect(source).toContain("projectRecommendationWorkPending");
    expect(source).not.toContain("projectAnalysisPending");
    expect(source).not.toContain("job_type='project-analysis'");
    expect(source).toContain("recommendationScopes.sort");
    expect(source).toContain(
      "right.contextCreatedAtEpoch - left.contextCreatedAtEpoch ||\n              left.inventoryCount - right.inventoryCount",
    );
    expect(source).toContain("if (refillQueued || scopeWorkPending) break;");
    expect(source).not.toContain("if (scopeWorkPending) continue;");
    expect(source).toContain("job_type='recommendation_refill'");
    expect(source).toContain("refill_state IN ('running','waiting_contact')");
    expect(source).toContain('event: "backlinks.backlink-profile.deferred"');
    expect(source).toContain("const maxConcurrentContactEnrichmentJobs = 2");
    expect(source).toContain("contactScopes.sort");
    expect(source).toContain("maxConcurrentContactEnrichmentJobs -");
    expect(source).toContain("event.aggregate_version=job.version");
    expect(source).toContain("event.status='published'");
    expect(source).toContain("availableContactSlots - outcome.claimed");
  });

  it("rejects API and Worker process mismatches", async () => {
    enableCanaryEnvironment();

    await expect(
      runtime.createApiDependencies?.(runtimeContext("worker")),
    ).rejects.toThrow("BACKLINKS_RUNTIME_PROCESS_MISMATCH");
    await expect(
      runtime.createWorkerRegistrations?.(runtimeContext("api")),
    ).rejects.toThrow("BACKLINKS_RUNTIME_PROCESS_MISMATCH");
  });

  it("keeps paid and send providers fail-closed without requiring optional Browser", async () => {
    enableCanaryEnvironment();

    const api = await runtime.createApiDependencies?.(runtimeContext("api"));
    const worker = await runtime.createWorkerRegistrations?.(
      runtimeContext("worker"),
    );

    expect(api?.draftCommands.create).toBeTypeOf("function");
    await expect(
      api?.recommendationCommands.requestRefill({} as never),
    ).rejects.toMatchObject({
      code: "BACKLINK_INVALID_REQUEST",
      message: expect.stringContaining("INPUT_REQUIRED"),
      retryable: false,
      fieldErrors: expect.arrayContaining([
        {
          field: "DATAFORSEO_CREDENTIAL_SECRET_REF",
          message: expect.stringContaining("Secret Reference"),
        },
        {
          field: "DATAFORSEO_ENDPOINT_ALLOWLIST",
          message: expect.any(String),
        },
        {
          field: "DATAFORSEO_ESTIMATED_COST_MICROS",
          message: expect.any(String),
        },
        {
          field: "backlink_provider_budgets",
          message: expect.any(String),
        },
        {
          field: "backlinks.dataforseo.v1",
          message: expect.any(String),
        },
      ]),
    });
    await expect(api?.sendIntentCommands.create({} as never)).rejects.toThrow(
      "Gmail send is disabled",
    );
    await expect(
      api?.placementReverifyCommand.execute({
        context: {
          actor: createActorContext({
            userId: "user-runtime",
            sessionId: "session-runtime",
            roles: ["member"],
          }),
          tenant: createTenantContext({
            organizationId: "organization-runtime",
            workspaceId: "workspace-runtime",
          }),
          project: createProjectContext({
            websiteProjectId: "project-runtime",
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-runtime",
            promotionTargetVersionId: "target-runtime",
          }),
        },
        placementId: "018f0000-0000-7000-8000-000000000158",
        expectedVersion: 1,
        idempotencyKey: "runtime-placement-reverify",
        requestId: "runtime-placement-request",
      }),
    ).rejects.toMatchObject({
      code: "BACKLINK_CONFLICT",
    });
    await expect(
      worker?.activities.backlinksExecuteRecommendationRefillV1({} as never),
    ).rejects.toThrow("INPUT_REQUIRED");
  });
});
