import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRecommendationPoolV2GenerationLaunchRepository } from "../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.js";

const input = {
  organizationId: "org", workspaceId: "workspace", websiteProjectId: "project",
  actorId: "actor", generationContractId: "generation",
  seedSnapshotFingerprint: "a".repeat(64), idempotencyKey: "same-launch",
};
function fixture(overrides: Record<string, unknown> = {}) {
  const confirmationHash = createHash("sha256").update(JSON.stringify({
    contract: "recommendation-pool-v2-confirmed-launch.v1",
    organizationId: input.organizationId, workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId, generationContractId: input.generationContractId,
    seedSnapshotFingerprint: input.seedSnapshotFingerprint, idempotencyKey: input.idempotencyKey,
  })).digest("hex");
  const row = {
    generationContractId: "generation", recommendationContextVersionId: "context",
    visiblePoolGeneration: 3, inputPinId: "pin", jobId: "job", workflowId: "workflow",
    jobStatus: "failed", jobStep: "workflow_failed", failureRetryable: "true",
    workflowLaunchIdempotencyHash: confirmationHash, ...overrides,
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('job.status "jobStatus"') ? [row]
      : sql.includes('assignment.seed_fingerprint "seedFingerprint"')
        ? [{ seedFingerprint: "b".repeat(64) }] : [],
    rowCount: 1,
  }));
  return {
    query,
    repository: createRecommendationPoolV2GenerationLaunchRepository({
      connect: async () => ({ query, release() {} }),
    }),
  };
}
describe("confirmed generation recovery", () => {
  it("recovers the same retryable job without new generation or budget", async () => {
    const { repository, query } = fixture();
    expect(await repository.confirmLaunch(input)).toMatchObject({ jobId: "job", replayed: true });
    const updates = query.mock.calls.map(([sql]) => sql).filter(sql => sql.trimStart().startsWith("UPDATE "));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("'previousFailure',error");
    expect(updates[0]).not.toContain("providerBudgetAuthorization");
    expect(updates[0]).not.toContain("DELETE ");
    expect(query).toHaveBeenCalledWith("COMMIT");
  });
  it.each([
    { failureRetryable: "false" },
    { workflowLaunchIdempotencyHash: "different-request" },
    { workflowLaunchIdempotencyHash: null },
  ])("rejects recovery without matching retry authority: %j", async (overrides) => {
    const { repository, query } = fixture(overrides);
    await expect(repository.confirmLaunch(input)).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => sql.trimStart().startsWith("UPDATE "))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
  it.each(["running", "success"])("keeps %s replay read only", async (jobStatus) => {
    const { repository, query } = fixture({ jobStatus });
    await repository.confirmLaunch(input);
    expect(query.mock.calls.some(([sql]) => sql.trimStart().startsWith("UPDATE "))).toBe(false);
  });
});
