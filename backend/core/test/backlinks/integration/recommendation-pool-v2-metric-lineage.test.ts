import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommercialQualificationRequestRepository } from "../../../src/modules/backlinks/db/repositories/commercial-qualification-request.repository.js";
import { createProviderBudgetRepository } from "../../../src/modules/backlinks/db/repositories/provider-budget.repository.js";
import { withBacklinkTenantTransaction, type BacklinkTenantPool } from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { commercialQualificationBulkEndpoints } from "../../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";

type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const { Client: PgClient, Pool: PgPool } = createRequire(import.meta.url)("pg") as {
  Client: new (options: unknown) => Client;
  Pool: new (options: unknown) => BacklinkTenantPool & { end(): Promise<void> };
};
const id = (n: number) => `019a9100-0000-7000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), workspaceId: id(2), websiteProjectId: id(3) };
const lineage = { generationContractId: id(13), jobId: id(14) };

describe("V2 metrics under the production V1 write freeze", () => {
  let harness: BacklinksPostgresHarness;
  let admin: Client;
  let pool: BacklinkTenantPool & { end(): Promise<void> };
  let role: string;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    await installBacklinksManifestAfterFoundation(admin, "0101");
    await admin.query("SET search_path=backlinks,pg_catalog");
    // Isolated fixture database only; no live project or provider calls.
    await admin.query(`
      INSERT INTO backlink_outreach_profile_versions (
        id,organization_id,workspace_id,website_project_id,profile_version_id,promotion_target_version_id,
        keywords_and_topics,products_and_services,target_urls,target_audiences,partnership_goals,
        market,location,language,authorized_discovery_sources,immutable_fingerprint,created_by
      ) VALUES ('${id(10)}','${id(1)}','${id(2)}','${id(3)}','profile','promotion',
        '["seo"]','["platform"]','["https://owner.test"]','["publishers"]','["coverage"]',
        'BR','Brazil','pt','["shared-seo-evidence"]','metric-profile','fixture');
      INSERT INTO backlink_generation_input_pins (
        id,organization_id,workspace_id,website_project_id,project_context_version,site_profile_version_id,
        outreach_profile_version_id,promotion_target_version_id,keyword_evidence_snapshot_ids,
        shared_evidence_snapshot_ids,market,qualification_contract_version,immutable_fingerprint,created_by
      ) VALUES ('${id(11)}','${id(1)}','${id(2)}','${id(3)}',1,'profile','${id(10)}','promotion',
        '[]','[]','BR','recommendation-pool-admission.v2','metric-pin','fixture');
      INSERT INTO backlink_project_context_snapshots (
        id,organization_id,workspace_id,website_project_id,snapshot_version,project_status,canonical_domain,
        locale,country_code,profile_version_id,promotion_target_version_id,products,keywords,target_urls,created_by
      ) VALUES ('${id(12)}','${id(1)}','${id(2)}','${id(3)}',1,'ACTIVE','owner.test','pt-BR','BR',
        'profile','promotion','["platform"]','["seo"]','["https://owner.test"]','fixture');
      INSERT INTO backlink_recommendation_generation_contracts (
        id,organization_id,workspace_id,website_project_id,recommendation_context_version_id,
        visible_pool_generation,input_pin_id,qualification_contract_version,visibility_contract_version,
        score_model_version,metric_scope,market,location,language,traffic_location_code,traffic_language_code,
        request_fingerprints,creator_worker_contract_version,created_by,pool_contract_version,seed_contract_version,
        release_contract_version,recommendation_marker_version,discovery_budget_policy_version
      ) VALUES ('${id(13)}','${id(1)}','${id(2)}','${id(3)}','${id(12)}',1,'${id(11)}',
        'recommendation-pool-admission.v2','recommendation-pool-release-visibility.v2',
        'recommendation-pool-materialization.v2','TARGET_MARKET','BR','Brazil','pt',2076,'pt','{}',
        'recommendation-pool-worker.v2','fixture','recommendation-pool.v2','recommendation-seed.v2',
        'recommendation-release.v2','recommendation-marker.v2','recommendation-discovery-budget.v2');
      INSERT INTO backlink_jobs (
        id,organization_id,workspace_id,website_project_id,job_type,source_object_type,source_object_id,
        status,step,progress,workflow_id,correlation_id,result_summary,created_by,updated_by
      ) VALUES ('${id(14)}','${id(1)}','${id(2)}','${id(3)}','recommendation_pool_v2_generation',
        'project-context-snapshot','${id(12)}','running','metrics',50,'fixture-workflow','fixture-request',
        '{"poolContractVersion":"recommendation-pool.v2","generationContractId":"${id(13)}","inputPinId":"${id(11)}","visiblePoolGeneration":1,
          "providerBudgetAuthorization":{"provider":"dataforseo","authorizedBy":"fixture",
            "reasonCode":"user_authorized_bounded_real_refill","maxPaidCalls":25,"maxCostMicros":2000000}}',
        'fixture','fixture');
    `);
    role = `v2_metrics_${randomBytes(8).toString("hex")}`;
    const password = randomBytes(24).toString("base64url");
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${role}"`);
    const url = new URL(harness.connectionString);
    url.username = role;
    url.password = password;
    pool = new PgPool({ connectionString: url.toString(), max: 1, options: "-c search_path=backlinks,pg_catalog" });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (role && admin) await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await admin?.end();
    await harness?.stop();
  });

  function acquireInput(kind: "traffic" | "rank" | "spam", fingerprint: string) {
    return {
      context: {
        ...scope,
        requestId: `commercial-qualification-v4:${id(14)}:${kind}:${fingerprint}`,
        idempotencyKey: `commercial-qualification-v4:${id(14)}:${kind}:${fingerprint}`,
        budgetReservationId: `commercial-refill-operation:${id(14)}:qualification:${kind}:${fingerprint}`,
      },
      recommendationLineage: lineage,
      call: { kind, endpoint: commercialQualificationBulkEndpoints[kind], targets: ["publisher.test"],
        body: [{ targets: ["publisher.test"], location_code: 2076, language_code: "pt" }], requestFingerprint: fingerprint },
      estimatedCostMicros: 50_000,
      startedAt: new Date(),
    };
  }

  it.each(["traffic", "rank", "spam"] as const)("records and settles %s with real repository and freeze enabled, then reuses cache", async kind => {
    expect((await admin.query("SELECT backlink_phase9_v1_writes_are_frozen() frozen")).rows[0]?.frozen).toBe(true);
    const repository = createCommercialQualificationRequestRepository(pool);
    const input = acquireInput(kind, ({ traffic: "a", rank: "b", spam: "c" }[kind]).repeat(64));
    const acquired = await repository.acquire(input);
    expect(acquired.state).toBe("started");
    if (acquired.state !== "started") throw new Error("Expected new receipt");
    expect(await withBacklinkTenantTransaction(pool, scope, client =>
      createProviderBudgetRepository(client).reserveBudgetWithinOperationCeiling({
        context: input.context, provider: "dataforseo", requestFingerprint: input.call.requestFingerprint,
        reservationKey: input.context.budgetReservationId, estimatedCostMicros: input.estimatedCostMicros,
      }, `commercial-refill-operation:${id(14)}`, 25, 2_000_000, 2_000_000),
    )).toBe("allow");
    await repository.complete({
      context: input.context, call: input.call, batchRequestId: acquired.batchRequestId,
      response: { status: "completed", body: { items: [] }, costMicros: 25_000, providerRequestId: "fixture-receipt" },
      completedAt: new Date(),
    });
    expect((await repository.acquire(input)).state).toBe("cached");
    const stored = await admin.query("SELECT recommendation_job_id,actual_cost_micros,status FROM provider_batch_requests WHERE id=$1", [acquired.batchRequestId]);
    expect(stored.rows[0]).toMatchObject({ recommendation_job_id: id(14), actual_cost_micros: "25000", status: "succeeded" });
    await expect(withBacklinkTenantTransaction(pool, scope, client => client.query(
      "UPDATE backlinks.provider_batch_requests SET recommendation_job_id=NULL,recommendation_generation_contract_id=NULL WHERE id=$1",
      [acquired.batchRequestId],
    ))).rejects.toThrow();
  });

  it.each(["untyped", "wrong-generation", "cross-tenant", "over-budget", "wrong-endpoint", "wrong-request"] as const)(
    "rejects %s without admitting a paid request", async variant => {
      const input = acquireInput("traffic", "d".repeat(64));
      if (variant === "untyped") Object.assign(input, { recommendationLineage: undefined });
      if (variant === "wrong-generation") input.recommendationLineage = { ...lineage, generationContractId: id(99) };
      if (variant === "cross-tenant") input.context.workspaceId = id(99);
      if (variant === "over-budget") input.estimatedCostMicros = 2_000_001;
      if (variant === "wrong-endpoint") input.call.endpoint = "/v3/backlinks/summary/live";
      if (variant === "wrong-request") input.context.requestId = "unrelated";
      await expect(createCommercialQualificationRequestRepository(pool).acquire(input)).rejects.toThrow();
    },
  );

  it("quarantines an ambiguous receipt and prevents retry", async () => {
    const repository = createCommercialQualificationRequestRepository(pool);
    const input = acquireInput("traffic", "e".repeat(64));
    const acquired = await repository.acquire(input);
    if (acquired.state !== "started") throw new Error("Expected new receipt");
    await repository.fail({
      context: input.context, batchRequestId: acquired.batchRequestId,
      status: "unknown_charge", failureCode: "fixture", failedAt: new Date(),
    });
    expect(await repository.acquire(input)).toEqual({ state: "blocked", reason: "unknown_charge" });
  });
});
