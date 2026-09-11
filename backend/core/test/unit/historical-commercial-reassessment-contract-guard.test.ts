import { describe, expect, it } from "vitest";

import {
  runHistoricalCommercialReassessment,
} from "../../src/modules/backlinks/application/services/historical-commercial-reassessment.service.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const scope = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000092",
  workspaceId: "20000000-0000-4000-8000-000000000092",
  websiteProjectId: "30000000-0000-4000-8000-000000000092",
});

function queryResult(
  rows: Record<string, unknown>[] = [],
): BacklinkTransactionQueryResult {
  return { rows, rowCount: rows.length };
}

function blockedPool(projectContract: Readonly<Record<string, unknown>>): {
  pool: BacklinkTenantPool;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    async query(text: string): Promise<BacklinkTransactionQueryResult> {
      queries.push(text);
      if (
        text.includes(
          "recommendation_pool_contract_guard:project_writes",
        )
      ) {
        return queryResult([projectContract]);
      }
      if (
        text === "BEGIN"
        || text === "COMMIT"
        || text === "ROLLBACK"
        || text.includes("SELECT set_config(")
      ) {
        return queryResult();
      }
      throw new Error("UNEXPECTED_HISTORICAL_REASSESSMENT_SIDE_EFFECT");
    },
    release() {},
  };
  return {
    pool: { connect: async () => client },
    queries,
  };
}

describe("historical commercial reassessment contract guard", () => {
  it.each([
    [
      "V2",
      {
        poolContractVersion: "recommendation-pool.v2",
        migrationState: "V2_ACTIVE",
        v1WritesFrozen: false,
      },
    ],
    [
      "frozen",
      {
        poolContractVersion: "recommendation-pool.v1",
        migrationState: "V1_ACTIVE",
        v1WritesFrozen: true,
      },
    ],
  ] as const)(
    "blocks %s apply before candidate, policy, contact, or outbox access",
    async (_label, projectContract) => {
      const blocked = blockedPool(projectContract);

      await expect(runHistoricalCommercialReassessment({
        pool: blocked.pool,
        scopes: [scope],
        mode: "apply",
        actorId: "contract-guard-test",
        now: new Date("2026-08-28T00:00:00.000Z"),
        contactOptions: {
          maxPages: 1,
          maxDepth: 0,
          maxAttempts: 1,
          browserAllowed: false,
        },
      })).rejects.toThrow(
        "BACKLINK_RECOMMENDATION_POOL_CONTRACT_NOT_APPLICABLE",
      );

      expect(blocked.queries.filter((sql) =>
        sql.includes(
          "recommendation_pool_contract_guard:project_writes",
        )
      )).toHaveLength(1);
      expect(blocked.queries.some((sql) =>
        sql.includes("backlink_commercial_candidates")
        || sql.includes("backlink_commercial_inventory_policies")
        || sql.includes("backlink_contact_enrichment_jobs")
        || sql.includes("backlink_outbox_events")
      )).toBe(false);
    },
  );
});
