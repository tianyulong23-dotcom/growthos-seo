import { describe, expect, it } from "vitest";

import {
  createProjectContextProjectionCommand,
  type ProjectContextProjectionInput,
} from "../../src/modules/backlinks/application/commands/project-context-projection.command.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const input: ProjectContextProjectionInput = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  actorId: "user-project-governance",
  actorSessionId: "session-project-governance",
  actorRoles: ["member"],
  correlationId: "correlation-project-governance",
  snapshotId: "018f0000-0000-7000-8000-000000000004",
  snapshotVersion: 4,
  projectStatus: "ACTIVE",
  canonicalDomain: "awolvision.com",
  locale: "en-US",
  countryCode: "US",
  targetMarket: "United States home cinema",
  profileVersionId: "018f0000-0000-7000-8000-000000000005",
  promotionTargetVersionId: "018f0000-0000-7000-8000-000000000006",
  products: ["Home cinema projector"],
  keywords: ["home cinema"],
  targetUrls: ["https://awolvision.com/"],
  targetAudiences: ["home cinema buyers"],
  partnershipGoals: ["editorial review"],
  inputComplete: true,
  jobId: "018f0000-0000-7000-8000-000000000007",
  outboxEventId: "018f0000-0000-7000-8000-000000000008",
  outreachProfile: {
    recordId: "018f0000-0000-7000-8000-000000000009",
    immutableFingerprint: "outreach-profile-fingerprint",
    profile: {
      organizationId: "018f0000-0000-7000-8000-000000000001",
      websiteProjectId: "018f0000-0000-7000-8000-000000000003",
      profileVersionId: "018f0000-0000-7000-8000-000000000005",
      promotionTargetVersionId:
        "018f0000-0000-7000-8000-000000000006",
      keywordsAndTopics: ["home cinema"],
      productsAndServices: ["Home cinema projector"],
      targetUrls: ["https://awolvision.com/"],
      targetAudiences: ["home cinema buyers"],
      partnershipGoals: ["editorial review"],
      market: "United States home cinema",
      location: "US",
      language: "en-US",
      authorizedDiscoverySources: ["KEYWORDS"],
      immutableFingerprint: "outreach-profile-fingerprint",
    },
  },
  sharedSeoEvidence: [
    {
      recordId: "018f0000-0000-7000-8000-000000000010",
      snapshot: {
        organizationId: "018f0000-0000-7000-8000-000000000001",
        websiteProjectId: "018f0000-0000-7000-8000-000000000003",
        evidenceType: "site-profile",
        sourceModule: "site-profile",
        sourceRecordId: "018f0000-0000-7000-8000-000000000005",
        sourceVersion: "4",
        provider: "website-project",
        endpoint: "website-project",
        normalizedParameters: {},
        requestFingerprint: "site-profile-fingerprint",
        market: "United States home cinema",
        location: "US",
        language: "en-US",
        fetchedAt: "2026-08-18T00:00:00.000Z",
        expiresAt: "2027-08-18T00:00:00.000Z",
        providerRequestId: "website-project:site-profile",
        providerTaskId: null,
        costMicros: 0,
        artifactRef: "website-project://site-profile",
        status: "ready",
      },
    },
    {
      recordId: "018f0000-0000-7000-8000-000000000011",
      snapshot: {
        organizationId: "018f0000-0000-7000-8000-000000000001",
        websiteProjectId: "018f0000-0000-7000-8000-000000000003",
        evidenceType: "keywords",
        sourceModule: "keywords",
        sourceRecordId: "018f0000-0000-7000-8000-000000000011",
        sourceVersion: "4",
        provider: "website-project",
        endpoint: "website-project",
        normalizedParameters: {},
        requestFingerprint: "keywords-fingerprint",
        market: "United States home cinema",
        location: "US",
        language: "en-US",
        fetchedAt: "2026-08-18T00:00:00.000Z",
        expiresAt: "2027-08-18T00:00:00.000Z",
        providerRequestId: "website-project:keywords",
        providerTaskId: null,
        costMicros: 0,
        artifactRef: "website-project://keywords",
        status: "ready",
      },
    },
  ],
  generationInputPins: {
    recordId: "018f0000-0000-7000-8000-000000000012",
    outreachProfileRecordId:
      "018f0000-0000-7000-8000-000000000009",
    immutableFingerprint: "generation-pin-fingerprint",
    pins: {
      organizationId: "018f0000-0000-7000-8000-000000000001",
      websiteProjectId: "018f0000-0000-7000-8000-000000000003",
      projectContextVersion: 4,
      siteProfileVersionId: "018f0000-0000-7000-8000-000000000005",
      outreachProfileVersionId:
        "018f0000-0000-7000-8000-000000000005",
      promotionTargetVersionId:
        "018f0000-0000-7000-8000-000000000006",
      keywordEvidenceSnapshotIds: [
        "018f0000-0000-7000-8000-000000000011",
      ],
      sharedEvidenceSnapshotIds: [
        "018f0000-0000-7000-8000-000000000010",
        "018f0000-0000-7000-8000-000000000011",
      ],
      market: "United States home cinema",
      qualificationContractVersion: "recommendation-pool-admission.v2",
    },
  },
};

describe("Website Project runtime governance projection", () => {
  it("projects V2 context without retired jobs or implicit provider work", async () => {
    const queries: Readonly<{
      sql: string;
      values: readonly unknown[];
    }>[] = [];
    const result = (
      rows: Record<string, unknown>[] = [],
    ): BacklinkTransactionQueryResult => ({
      rows,
      rowCount: rows.length,
    });
    const pool: BacklinkTenantPool = {
      async connect() {
        return {
          async query(text, values = []) {
            const sql = text.replace(/\s+/g, " ").trim();
            queries.push({ sql, values });
            if (sql.includes("FROM backlink_project_context_snapshots")) {
              return result();
            }
            if (
              sql.includes("INSERT INTO backlinks.backlink_")
              ||
              sql.startsWith("INSERT INTO backlink_jobs")
              || sql.startsWith("INSERT INTO backlink_outbox_events")
            ) {
              return result([{ id: values[0] }]);
            }
            return result();
          },
          release() {},
        };
      },
    };

    await expect(
      createProjectContextProjectionCommand(pool).project(input),
    ).resolves.toMatchObject({
      state: "projected",
      snapshotVersion: 4,
      jobScheduled: false,
      jobId: null,
    });

    const outbox = queries.find(({ sql }) =>
      sql.startsWith("INSERT INTO backlink_outbox_events")
    );
    expect(outbox).toBeUndefined();
    expect(queries.some(({ sql }) => sql.startsWith("INSERT INTO backlink_jobs"))).toBe(false);
    const demand = queries.find(({ sql }) =>
      sql.includes("INSERT INTO backlinks.backlink_recommendation_pool_project_contracts")
    );
    expect(demand?.sql).toContain("'recommendation-pool.v2','V2_READY'");
    expect(demand?.sql).toContain(
      "ON CONFLICT (organization_id,workspace_id,website_project_id) DO NOTHING",
    );
    expect(demand?.values.slice(1)).toEqual([
      input.organizationId, input.workspaceId, input.websiteProjectId, input.actorId,
    ]);
    expect(demand?.sql).not.toContain(
      "INSERT INTO backlink_recommendation_refills",
    );
    expect(demand?.sql).not.toContain("INSERT INTO backlink_jobs");
    expect(demand?.sql).not.toContain("INSERT INTO backlink_outbox_events");
    expect(queries.some(({ sql }) =>
      sql.includes("backlink_commercial_inventory_policies")
    )).toBe(false);
    expect(queries.some(({ sql }) =>
      sql.includes("INSERT INTO backlink_recommendation_refills")
      || sql.includes("'backlinks.recommendation-refill.requested.v1'")
    )).toBe(false);
    expect(queries.some(({ sql }) =>
      sql.includes("backlink_provider_requests")
      || sql.includes("backlink_provider_usage_ledger")
      || sql.includes("backlink_provider_budgets")
    )).toBe(false);
  });

  it("initializes enabled capabilities within the projected project only", async () => {
    const queries: Readonly<{
      sql: string;
      values: readonly unknown[];
    }>[] = [];
    const result = (
      rows: Record<string, unknown>[] = [],
    ): BacklinkTransactionQueryResult => ({
      rows,
      rowCount: rows.length,
    });
    const pool: BacklinkTenantPool = {
      async connect() {
        return {
          async query(text, values = []) {
            const sql = text.replace(/\s+/g, " ").trim();
            queries.push({ sql, values });
            if (sql.includes("FROM backlink_project_context_snapshots")) {
              return result([{
                ...input,
                createdAt: new Date("2026-08-05T00:00:00.000Z"),
                createdBy: input.actorId,
              }]);
            }
            if (sql.includes("INSERT INTO backlinks.backlink_")) {
              return result([{ id: values[0] }]);
            }
            return result();
          },
          release() {},
        };
      },
    };

    await expect(
      createProjectContextProjectionCommand(pool, {
        aiProviderEnabled: false,
        gmailSendEnabled: false,
        gmailSyncEnabled: false,
        dataForSeoEnabled: true,
        browserProviderEnabled: false,
      }).project(input),
    ).resolves.toMatchObject({
      state: "replayed",
      snapshotVersion: 4,
      jobScheduled: false,
    });

    const settings = queries.find(({ sql }) =>
      sql.includes("INSERT INTO backlink_project_settings_versions")
    );
    const retention = queries.find(({ sql }) =>
      sql.includes("INSERT INTO backlink_retention_policy_versions")
    );
    const switches = queries.filter(({ sql }) =>
      sql.includes("INSERT INTO backlink_kill_switch_versions")
    );
    expect(settings?.values).toContain(input.websiteProjectId);
    expect(settings?.values[5]).toBe(JSON.stringify(input.targetAudiences));
    expect(settings?.values[6]).toBe(JSON.stringify(input.partnershipGoals));
    expect(settings?.sql).toContain("ORDER BY version DESC");
    expect(settings?.sql).toContain(
      "latest.settings_values, jsonb_build_object",
    );
    expect(settings?.sql).toContain(
      "previous_settings_values IS DISTINCT FROM settings_values",
    );
    expect(retention?.values).toContain(input.websiteProjectId);
    expect(switches).toHaveLength(2);
    expect(switches.map(({ values }) => values.slice(1))).toEqual([
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        "project",
        "backlinks.dataforseo.v1",
        null,
        input.actorId,
      ],
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        "provider",
        "backlinks.dataforseo.v1",
        "dataforseo",
        input.actorId,
      ],
    ]);
    const demand = queries.find(({ sql }) =>
      sql.includes("INSERT INTO backlinks.backlink_recommendation_pool_project_contracts")
    );
    expect(demand).toBeDefined();
    expect(queries.some(({ sql }) =>
      sql.includes("INSERT INTO backlink_recommendation_refills")
      || sql.includes("'backlinks.recommendation-refill.requested.v1'")
    )).toBe(false);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });
});
