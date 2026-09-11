import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { BacklinksRuntimeFactoryContext } from "../../src/index.js";
import { automaticProfileSyncEnabled, runtime } from "../../src/modules/backlinks/runtime/production-runtime.js";
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
  it("disables background profile synchronization in manual mode", async () => {
    expect(automaticProfileSyncEnabled("manual")).toBe(false);
    expect(automaticProfileSyncEnabled(undefined)).toBe(true);
    expect(automaticProfileSyncEnabled("automatic")).toBe(true);
    expect(() => automaticProfileSyncEnabled("invalid")).toThrow(
      "BACKLINKS_PROFILE_SYNC_MODE_INVALID",
    );
    const source = await readFile(
      new URL("../../src/modules/backlinks/runtime/production-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("process.env.BACKLINKS_PROFILE_SYNC_MODE");
    expect(source).toMatch(/automaticProfileSync &&\s*!projectRecommendationWorkPending/);
    expect(source).toMatch(/automaticProfileSync &&\s*projectRecommendationWorkPending/);
  });
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

  it("loads project analysis without an implicit V1 refill", async () => {
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
      /createBacklinkProjectAnalysisActivities\(\s*createProjectContextSnapshotRepository\(client\),\s*undefined,\s*createProjectAnalysisJobWriter\(client\),\s*undefined,/,
    );
    expect(source.includes("ensureCommercialRecommendationRefill")).toBe(false);
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
        "../../src/modules/backlinks/application/services/" +
          "recommendation-refill-supersession.service.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(runtimeSource.includes("arbitrateRecommendationRefillFailure")).toBe(false);
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
      'refill.refill_window_key "refillWindowKey"',
    );
    expect(arbitrationSource).toMatch(
      /usage\.reservation_key LIKE\s+failed_refill\."refillWindowKey"\|\|':%'/,
    );
    expect(arbitrationSource).toMatch(
      /request\.request_id LIKE\s+failed_refill\."refillWindowKey"\|\|':%'/,
    );
    expect(arbitrationSource).not.toContain(
      'batch.started_at>=failed_job."startedAt"',
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

  it("rejects the retired V1 recovery Worker before registering work", async () => {
    enableCanaryEnvironment();
    process.env.BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT";
    process.env.BACKLINKS_WORKER_EXECUTION_MODE = "recovery";
    process.env.LOCAL_PRODUCT_ORGANIZATION_ID =
      "00000000-0000-4000-8000-000000000001";
    process.env.LOCAL_PRODUCT_WORKSPACE_ID =
      "00000000-0000-4000-8000-000000000002";
    process.env.LOCAL_PRODUCT_USER_ID = "00000000-0000-4000-8000-000000000003";
    process.env.BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID =
      "00000000-0000-4000-8000-000000000006";
    process.env.BACKLINKS_RECOVERY_REFILL_JOB_ID =
      "00000000-0000-4000-8000-000000000004";
    process.env.BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID =
      "00000000-0000-4000-8000-000000000005";
    try {
      await expect(
        runtime.createWorkerRegistrations?.(runtimeContext("worker")),
      ).rejects.toThrow("BACKLINKS_V1_RECOMMENDATION_RECOVERY_RETIRED");
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

  it("does not reopen V1 recovery for an already-published workflow", async () => {
    enableCanaryEnvironment();
    process.env.BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT";
    process.env.BACKLINKS_WORKER_EXECUTION_MODE = "recovery";
    process.env.LOCAL_PRODUCT_ORGANIZATION_ID =
      "00000000-0000-4000-8000-000000000001";
    process.env.LOCAL_PRODUCT_WORKSPACE_ID =
      "00000000-0000-4000-8000-000000000002";
    process.env.LOCAL_PRODUCT_USER_ID = "00000000-0000-4000-8000-000000000003";
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
      await expect(
        runtime.createWorkerRegistrations?.(context),
      ).rejects.toThrow("BACKLINKS_V1_RECOMMENDATION_RECOVERY_RETIRED");
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

  it("keeps Gmail runtimes mounted while provider diagnostics are pending", async () => {
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
      'providerHealth.ai.externalAvailability === "available"',
    );
    expect(source).toContain(
      'providerHealth.gmail.externalAvailability === "available"',
    );
    expect(source).toContain("browserAllowed: browserProviderAvailable");
    expect(source.match(/const aiRuntime = aiProviderAvailable/g)).toHaveLength(
      2,
    );
    expect(source).toMatch(
      /const gmailSendRuntime = capabilities\.gmailSendEnabled/,
    );
    expect(source).toMatch(
      /const gmailSyncRuntime = capabilities\.gmailSyncEnabled/,
    );
    expect(source).not.toContain(
      "capabilities.gmailSendEnabled && gmailProviderAvailable",
    );
    expect(source).not.toContain(
      "capabilities.gmailSyncEnabled && gmailProviderAvailable",
    );
    expect(source.includes("recommendationRefillRelay")).toBe(false);
    expect(source).not.toContain("calls.count+2 <= $5");
  });

  it("gates DataForSEO composition without retaining V1 source execution", async () => {
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
      /dataForSeoConfiguration !== null\s+&&\s+dataForSeoSecretStoreRoot !== null\s+&&\s+dataForSeoAvailable/,
    );
    expect(source.includes("backlinksExecuteRecommendationRefillV1")).toBe(false);
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

  it("allows contact enrichment to finish before stale-job recovery", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/workflows/definitions/" +
          "contact-enrichment.workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('startToCloseTimeout: "8 minutes"');
    expect(source).toContain("retry: { maximumAttempts: 1 }");
  });

  it("removes periodic V1 refill and static recovery producers", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/production-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    for (const retired of [
      "reserveRecommendationRefillJob",
      "ensureCommercialRecommendationRefill",
      "hasRecoverableAcceptedCommercialRecommendationRefill",
      "ensureCurrentCommercialStaticAssessmentRecovery",
      "nextRecommendationRecoveryScanAt",
      "createRecommendationRefillOutboxRelay",
    ]) {
      expect(source.includes(retired), retired).toBe(false);
    }
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
    const scopeStart = source.indexOf(
      "async function listContactEnrichmentRecoveryScopes(",
    );
    const scopeEnd = source.indexOf(
      "function localProductWorkerAuthority(",
      scopeStart,
    );
    const scopeSource = source.slice(scopeStart, scopeEnd);
    expect(scopeSource).not.toContain("UNION");
    expect(scopeSource).not.toContain(
      "backlink_recommendation_pool_project_contracts",
    );
    expect(scopeSource).not.toContain(
      "backlink_recommendation_pool_v2_native_generation_verify",
    );
    const recoveryStart = source.indexOf(
      "const scopes = await listContactEnrichmentRecoveryScopes(",
    );
    const recoveryEnd = source.indexOf(
      "const contactOutcome = await contactEnrichmentRelay.runOnce(",
      recoveryStart,
    );
    const recoverySource = source.slice(recoveryStart, recoveryEnd);
    expect(recoverySource).toContain("withBacklinkTenantTransaction(");
    expect(recoverySource).toContain(
      "await recoverRecommendationPoolV2CanonicalBatchPreparation(",
    );
    expect(recoverySource).not.toContain(
      'if (recovery.status !== "contract_not_applicable")',
    );
    expect(recoverySource).toContain(
      "const created = await ensureReadyContactEnrichmentJobs(",
    );
    expect(recoverySource).toMatch(
      /createNewJobs:\s+recovery\.status === "contract_not_applicable"/,
    );
    expect(
      recoverySource.indexOf(
        "await recoverRecommendationPoolV2CanonicalBatchPreparation(",
      ),
    ).toBeLessThan(
      recoverySource.indexOf(
        "const created = await ensureReadyContactEnrichmentJobs(",
      ),
    );
    const localRecoveryStart = source.indexOf(
      'await runLocalProjectLane("contact-enrichment"',
    );
    const localRecoveryEnd = source.indexOf(
      "contactScopes.sort(",
      localRecoveryStart,
    );
    const localRecoverySource = source.slice(
      localRecoveryStart,
      localRecoveryEnd,
    );
    expect(localRecoverySource).toContain(
      "await recoverRecommendationPoolV2CanonicalBatchPreparation(",
    );
    expect(localRecoverySource).toContain(
      "await ensureReadyContactEnrichmentJobs(client, {",
    );
    expect(localRecoverySource).toMatch(
      /createNewJobs:\s+recommendationPoolV2Recovery\?\.status ===\s+"contract_not_applicable"/,
    );
    expect(localRecoverySource).not.toMatch(
      /workerAuthority !== null &&\s+recommendationPoolV2Recovery\?\.status ===/,
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
    expect(source).toContain("transportCode: authError?.transportCode ?? null");
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
    expect(source).toContain('runLocalProjectLane("recommendation-pool-v2"');
    expect(source).toContain("job_type='recommendation_pool_v2_generation'");
    expect(source).toContain("status IN ('queued','running','waiting_provider')");
    expect(source.includes("job_type='recommendation_refill'")).toBe(false);
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
    expect(api).not.toHaveProperty("recommendationCommands");
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
    expect(worker?.activities).not.toHaveProperty(
      "backlinksExecuteRecommendationRefillV1",
    );
  });
});
