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
  GOOGLE_OAUTH_ENABLED: "false",
  PLATFORM_SECRET_STORE_ENABLED: "false",
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
    buildIdentity: {
      schemaVersion: "growthos.local-product-build.v1",
      buildId: "production-runtime-test",
      sourceFingerprint: "a".repeat(64),
      artifactFingerprint: "b".repeat(64),
      builtAt: "2026-08-18T00:00:00.000Z",
    },
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

  it("queues a governed recommendation refill after project analysis", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(
      source.match(/createBacklinkProjectAnalysisActivities\(/g),
    ).toHaveLength(1);
    expect(source).toMatch(
      /createBacklinkProjectAnalysisActivities\(\s*createProjectContextSnapshotRepository\(client\),\s*undefined,\s*createProjectAnalysisJobWriter\(client\),\s*\{\s*ensure: async \(refillInput\) => \{\s*await ensureCommercialRecommendationRefill\(client,/,
    );
    expect(source).toContain(
      "absoluteBudgetMicros:\n                    persistentProviderBudgetGrant.maxCostMicros",
    );
    expect(source).toContain(
      "providerBudgetGrant: persistentProviderBudgetGrant",
    );
  });

  it("persists the stable recommendation refill failure contract", async () => {
    const runtimeSource = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const arbitrationSource = await readFile(
      new URL(
        "../../src/modules/backlinks/application/services/"
          + "recommendation-refill-supersession.service.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(runtimeSource).toContain("arbitrateRecommendationRefillFailure");
    expect(arbitrationSource).toContain("'rootCause',$7::text");
    expect(arbitrationSource).toContain("'recovery',$8::text");
    expect(arbitrationSource).toContain(
      "'providerCallOccurred',provider_call.occurred",
    );
    expect(arbitrationSource).toContain("'diagnosticId',$9::text");
    expect(arbitrationSource).toContain(
      "JOIN backlink_recommendation_refills AS refill",
    );
    expect(arbitrationSource).toContain(
      "refill.refill_window_key \"refillWindowKey\"",
    );
    expect(arbitrationSource).toMatch(
      /usage\.reservation_key LIKE\s+failed_refill\."refillWindowKey"\|\|':%'/,
    );
    expect(arbitrationSource).toMatch(
      /request\.request_id LIKE\s+failed_refill\."refillWindowKey"\|\|':%'/,
    );
    expect(arbitrationSource).not.toContain(
      "batch.started_at>=failed_job.\"startedAt\"",
    );
    expect(arbitrationSource).toContain(
      "website_project_id=$3 AND job.id=$4::uuid",
    );
    expect(arbitrationSource).toContain("SET refill_state='paused'");
    expect(arbitrationSource).toMatch(
      /WHEN 'PROVIDER_UNAVAILABLE'\s+THEN 'PROVIDER_UNAVAILABLE'/,
    );
    expect(arbitrationSource).toContain("updated_at=$11");
    expect(arbitrationSource).not.toContain("'detail',input.message");
  });

  it("isolates recovery Worker registration to refill recovery work", async () => {
    enableCanaryEnvironment();
    process.env.BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT";
    process.env.BACKLINKS_WORKER_EXECUTION_MODE = "recovery";
    process.env.LOCAL_PRODUCT_ORGANIZATION_ID =
      "00000000-0000-4000-8000-000000000001";
    process.env.LOCAL_PRODUCT_WORKSPACE_ID =
      "00000000-0000-4000-8000-000000000002";
    process.env.LOCAL_PRODUCT_USER_ID =
      "00000000-0000-4000-8000-000000000003";
    process.env.BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID =
      "00000000-0000-4000-8000-000000000006";
    process.env.BACKLINKS_RECOVERY_REFILL_JOB_ID =
      "00000000-0000-4000-8000-000000000004";
    process.env.BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID =
      "00000000-0000-4000-8000-000000000005";
    try {
      const worker = await runtime.createWorkerRegistrations?.(
        runtimeContext("worker"),
      );
      expect(worker?.workflowsPath).toContain(
        "workflows\\definitions\\recovery.js",
      );
      expect(Object.keys(worker?.activities ?? {}).sort()).toEqual([
        "backlinksCompleteRecommendationRefillSupersessionV1",
        "backlinksCompleteRecommendationRefillSupplyV1",
        "backlinksExecuteRecommendationRefillV1",
        "backlinksPlanRecommendationRefillSupplyV1",
        "backlinksRecordRecommendationRefillFailureV1",
        "backlinksReserveRecommendationRefillV1",
        "backlinksStoreReadyRecommendationsV1",
      ]);
      expect(worker?.taskQueue).toBe(
        "growthos.backlinks.v1.recovery.00000000-0000-4000-8000-000000000004",
      );
      expect(worker?.backgroundServices).toHaveLength(1);
    } finally {
      delete process.env.BACKLINKS_RUNTIME_MODE;
      delete process.env.BACKLINKS_WORKER_EXECUTION_MODE;
      delete process.env.LOCAL_PRODUCT_ORGANIZATION_ID;
      delete process.env.LOCAL_PRODUCT_WORKSPACE_ID;
      delete process.env.LOCAL_PRODUCT_USER_ID;
      delete process.env.BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID;
      delete process.env.BACKLINKS_RECOVERY_REFILL_JOB_ID;
      delete process.env.BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID;
    }
  });

  it("attaches recovery Worker to an exact already-published workflow", async () => {
    enableCanaryEnvironment();
    process.env.BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT";
    process.env.BACKLINKS_WORKER_EXECUTION_MODE = "recovery";
    process.env.LOCAL_PRODUCT_ORGANIZATION_ID =
      "00000000-0000-4000-8000-000000000001";
    process.env.LOCAL_PRODUCT_WORKSPACE_ID =
      "00000000-0000-4000-8000-000000000002";
    process.env.LOCAL_PRODUCT_USER_ID =
      "00000000-0000-4000-8000-000000000003";
    process.env.BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID =
      "00000000-0000-4000-8000-000000000006";
    process.env.BACKLINKS_RECOVERY_REFILL_JOB_ID =
      "00000000-0000-4000-8000-000000000004";
    process.env.BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID =
      "00000000-0000-4000-8000-000000000005";
    const query = async (text: string) => ({
      rows: text.includes("FROM backlink_outbox_events AS event")
        ? [{ workflowId: "workflow-recovery-existing" }]
        : [],
      rowCount: 0,
    });
    const context: BacklinksRuntimeFactoryContext = {
      ...runtimeContext("worker"),
      pool: {
        query,
        connect: async () => ({
          query,
          release() {},
        }),
        async end() {},
      },
    };
    try {
      const worker = await runtime.createWorkerRegistrations?.(context);
      await expect(
        worker?.backgroundServices?.[0]?.start(),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.BACKLINKS_RUNTIME_MODE;
      delete process.env.BACKLINKS_WORKER_EXECUTION_MODE;
      delete process.env.LOCAL_PRODUCT_ORGANIZATION_ID;
      delete process.env.LOCAL_PRODUCT_WORKSPACE_ID;
      delete process.env.LOCAL_PRODUCT_USER_ID;
      delete process.env.BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID;
      delete process.env.BACKLINKS_RECOVERY_REFILL_JOB_ID;
      delete process.env.BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID;
    }
  });

  it("gates provider execution on external availability, not internal limits", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("createBacklinksProvidersHealth");
    expect(source).toContain(
      'providerHealth.dataForSeo.externalAvailability === "available"',
    );
    expect(source).toContain(
      'providerHealth.browser.externalAvailability === "available"',
    );
    expect(source).toContain(
      "browserAllowed: browserProviderAvailable",
    );
    expect(source).toMatch(
      /const recommendationRefillRelay =\s+workerAuthority === null/,
    );
    expect(source).toMatch(
      /dataForSeoRuntime === null\s+\|\|\s+\(!dataForSeoAvailable && input\.source === "paid"\)/,
    );
    expect(source).not.toContain("calls.count+2 <= $5");
  });

  it("keeps zero-cost recommendation refill sources independent from provider availability", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain(
      "dataForSeoConfiguration === null || !dataForSeoAvailable",
    );
    expect(source).toMatch(
      /dataForSeoConfiguration !== null\s+&& dataForSeoSecretStoreRoot !== null\s+&& dataForSeoAvailable/,
    );
    expect(source).toMatch(
      /dataForSeoRuntime === null\s+\|\|\s+\(!dataForSeoAvailable && input\.source === "paid"\)/,
    );
  });

  it("releases an AI Draft reservation when recovery creates a basic draft", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain(
      'let reservation: "active" | "terminal" | null = null',
    );
    expect(source).toContain("aiRuntime.draft(input)");
    expect(source).toMatch(
      /async generate\(prompt\)[\s\S]*reservation = await aiRuntime\.reserve\(input\)[\s\S]*return draft\.generate\(prompt\)/,
    );
    expect(source).toMatch(
      /result\.outcome === "completed_with_basic_draft"[\s\S]*await aiRuntime\.release\(input\)/,
    );
  });

  it("bounds each recommendation provider activity to 15 minutes", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/workflows/definitions/"
          + "backlink-recommendation-refill.workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('startToCloseTimeout: "15 minutes"');
    expect(source).not.toContain('startToCloseTimeout: "2 hours"');
    expect(source).toContain("retry: { maximumAttempts: 2 }");
    expect(source).toContain("continueAsNew");
  });

  it("allows contact enrichment to finish before stale-job recovery", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/workflows/definitions/"
          + "contact-enrichment.workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('startToCloseTimeout: "8 minutes"');
    expect(source).toContain("retry: { maximumAttempts: 1 }");
  });

  it("auto-queues from analysis and durably recovers provider and static work", async () => {
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
    expect(source).not.toContain("shouldScanRecommendationInventory");
    expect(source).not.toContain("nextRecommendationInventoryScanAt");
    expect(source).toContain(
      "hasRecoverableAcceptedCommercialRecommendationRefill(",
    );
    expect(source).not.toContain("if (!recoverable) return null");
    expect(source).toContain(
      "ensureCurrentCommercialStaticAssessmentRecovery(",
    );
    expect(source).toContain(
      "backlinks.recommendation-refill.static-assessment-recovery-queued",
    );
    expect(source).toContain("nextRecommendationRecoveryScanAt");
    expect(source).toContain(
      "backlinks.recommendation-refill.accepted-provider-recovered",
    );
    expect(source).toContain(
      "backlinks.recommendation-refill.inventory-refill-queued",
    );
    expect(source).toContain("createRecommendationRefillOutboxRelay({");
  });

  it("recovers contact work globally through tenant-scoped commands", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain(
      "backlink_list_contact_enrichment_recovery_scopes($1)",
    );
    expect(source).toContain("listContactEnrichmentRecoveryScopes(");
    expect(source).toMatch(
      /withBacklinkTenantTransaction\(\s*pool,\s*scope,\s*\(client\) => ensureReadyContactEnrichmentJobs\(client,/,
    );
    expect(source).toContain(
      'event: "backlinks.contact-enrichment.jobs.recovered"',
    );
    expect(source).toContain("contactEnrichment: {");
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
    expect(source).toContain("httpStatus: authError?.httpStatus ?? null");
    expect(source).toMatch(
      /providerRequestId:\s+authError\?\.providerRequestId \?\? null/,
    );
    expect(source).toContain(
      "transportCode: authError?.transportCode ?? null",
    );
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

    expect(source).toMatch(
      /job\.trigger_source IN \(\s*'schedule','continuation'\s*\)/,
    );
    expect(source).toMatch(
      /job\.requested_cursor IS NOT DISTINCT FROM\s+cursor\.search_after_token/,
    );
    expect(source).not.toContain("job.next_sync_at>now()");
    expect(source).toContain("projectRecommendationWorkPending");
    expect(source).not.toContain("projectAnalysisPending");
    expect(source).not.toContain("job_type='project-analysis'");
    expect(source).toContain("recommendationScopes.sort");
    expect(source).toMatch(
      /right\.contextCreatedAtEpoch - left\.contextCreatedAtEpoch \|\|\s+left\.inventoryCount - right\.inventoryCount/,
    );
    expect(source).toContain("if (scopeWorkPending) break;");
    expect(source).not.toContain("if (scopeWorkPending) continue;");
    expect(source).toContain("job_type='recommendation_refill'");
    expect(source).toContain("refill_state='running'");
    expect(source).not.toContain("refill_state IN ('running','waiting_contact')");
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

  it("keeps tenant scope and paid/send providers fail-closed without optional Browser", async () => {
    enableCanaryEnvironment();

    const api = await runtime.createApiDependencies?.(runtimeContext("api"));
    const worker = await runtime.createWorkerRegistrations?.(
      runtimeContext("worker"),
    );

    expect(api?.draftCommands.create).toBeTypeOf("function");
    await expect(
      api?.recommendationCommands.requestRefill({} as never),
    ).rejects.toThrow("invalid scope");
    await expect(
      api?.sendIntentCommands.preflight({
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
        draftId: "draft-runtime",
        approvedDraftVersionId: "draft-version-runtime",
        contactId: "contact-runtime",
        contactVersion: 1,
        gmailConnectionId: "gmail-runtime",
        messagePurpose: "INITIAL_OUTREACH",
        followUpIndex: 0,
      }),
    ).rejects.toThrow("Gmail send is disabled");
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
