import { describe, expect, it } from "vitest";

import {
  arbitrateRecommendationRefillFailure,
  assertRecommendationRefillProviderExecutionCurrent,
  completeRecommendationRefillSupersession,
  requestRecommendationRefillSupersession,
} from "../../src/modules/backlinks/application/services/recommendation-refill-supersession.service.js";
import type {
  BacklinkTransactionClient,
} from "../../src/modules/backlinks/db/tenant-transaction.js";
import type {
  RecommendationRefillSupersessionSignal,
} from "../../src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.js";

const scope = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000091",
  workspaceId: "20000000-0000-4000-8000-000000000091",
  websiteProjectId: "30000000-0000-4000-8000-000000000091",
});
const contextVersionId = "40000000-0000-4000-8000-000000000091";
const jobId = "50000000-0000-4000-8000-000000000091";
const now = new Date("2026-08-28T00:00:00.000Z");
const signal: RecommendationRefillSupersessionSignal = Object.freeze({
  contractVersion: 1,
  ...scope,
  jobId,
  workflowId: "backlinks:recommendation-refill:guard-test",
  oldContext: Object.freeze({
    contextVersionId,
    snapshotVersion: 1,
    profileVersionId: "profile-v1",
    promotionTargetVersionId: "target-v1",
    generationInputFingerprint: "generation-v1",
  }),
  authoritativeContext: Object.freeze({
    contextVersionId: "40000000-0000-4000-8000-000000000092",
    snapshotVersion: 2,
    profileVersionId: "profile-v2",
    promotionTargetVersionId: "target-v2",
    generationInputFingerprint: "generation-v2",
  }),
  actorId: "contract-guard-test",
  correlationId: "contract-guard-test",
  requestId: "contract-guard-test",
  idempotencyKey: "recommendation-refill.supersede:guard-test",
  lifecycleEventId: "60000000-0000-4000-8000-000000000091",
  auditEventId: "70000000-0000-4000-8000-000000000091",
});

function blockedClient(projectContract: Readonly<Record<string, unknown>>): {
  client: BacklinkTransactionClient;
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    client: {
      async query(text) {
        queries.push(text);
        if (
          text.includes(
            "recommendation_pool_contract_guard:project_writes",
          )
        ) {
          return { rows: [projectContract], rowCount: 1 };
        }
        throw new Error("UNEXPECTED_REFILL_SIDE_EFFECT");
      },
    },
  };
}

describe("recommendation refill supersession contract guard", () => {
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
    "blocks every %s entry before the first refill side effect",
    async (_label, projectContract) => {
      const entries = [
        (client: BacklinkTransactionClient) =>
          requestRecommendationRefillSupersession(client, {
            signal,
            now,
            integrityHash: "a".repeat(64),
          }),
        (client: BacklinkTransactionClient) =>
          completeRecommendationRefillSupersession(client, {
            signal,
            now,
            integrityHash: "b".repeat(64),
          }),
        (client: BacklinkTransactionClient) =>
          assertRecommendationRefillProviderExecutionCurrent(client, {
            ...scope,
            jobId,
            recommendationContextVersionId: contextVersionId,
          }),
        (client: BacklinkTransactionClient) =>
          arbitrateRecommendationRefillFailure(client, {
            ...scope,
            recommendationContextVersionId: contextVersionId,
            jobId,
            errorCode: "PROVIDER_UNAVAILABLE",
            rootCause: "PROVIDER_UNAVAILABLE",
            recovery: "RETRY",
            diagnosticId: "contract-guard-test",
            message: "provider unavailable",
            actorId: "contract-guard-test",
            now,
            integrityHash: "c".repeat(64),
          }),
      ];

      for (const entry of entries) {
        const blocked = blockedClient(projectContract);
        await expect(entry(blocked.client)).rejects.toThrow(
          "BACKLINK_RECOMMENDATION_POOL_CONTRACT_NOT_APPLICABLE",
        );
        expect(blocked.queries).toHaveLength(1);
        expect(blocked.queries[0]).toContain(
          "recommendation_pool_contract_guard:project_writes",
        );
      }
    },
  );
});
