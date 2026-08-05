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
  correlationId: "correlation-project-governance",
  snapshotId: "018f0000-0000-7000-8000-000000000004",
  snapshotVersion: 4,
  projectStatus: "ACTIVE",
  canonicalDomain: "awolvision.com",
  locale: "en-US",
  countryCode: "US",
  profileVersionId: "018f0000-0000-7000-8000-000000000005",
  promotionTargetVersionId: "018f0000-0000-7000-8000-000000000006",
  products: ["Home cinema projector"],
  keywords: ["home cinema"],
  targetUrls: ["https://awolvision.com/"],
  inputComplete: true,
  jobId: "018f0000-0000-7000-8000-000000000007",
  outboxEventId: "018f0000-0000-7000-8000-000000000008",
};

describe("Website Project runtime governance projection", () => {
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
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });
});
