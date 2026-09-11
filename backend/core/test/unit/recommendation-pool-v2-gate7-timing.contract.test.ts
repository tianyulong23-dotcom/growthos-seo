import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createRecommendationPoolV2TimingRepository,
  createRecommendationFeedObserver,
  recommendationPoolV2TimingEventTypes,
} from "../../src/modules/backlinks/db/repositories/recommendation-pool-v2-timing.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const expectedEventTypes = [
  "COMMAND_ACCEPTED",
  "WORKFLOW_SCHEDULED",
  "WORKFLOW_STARTED",
  "SEED_SNAPSHOT_LOADED",
  "REQUEST_PLAN_CREATED",
  "PROVIDER_REQUEST_QUEUED",
  "PROVIDER_REQUEST_STARTED",
  "PROVIDER_REQUEST_COMPLETED",
  "PROVIDER_OUTCOME_PERSISTED",
  "CANDIDATE_NORMALIZATION_STARTED",
  "CANDIDATE_NORMALIZATION_COMPLETED",
  "CANDIDATE_ADMISSION_STARTED",
  "CANDIDATE_ADMISSION_COMPLETED",
  "METRIC_ENRICHMENT_STARTED",
  "METRIC_ENRICHMENT_COMPLETED",
  "CONTACT_ENRICHMENT_STARTED",
  "CONTACT_ENRICHMENT_COMPLETED",
  "BATCH_PREPARED",
  "PUBLICATION_COMMITTED",
  "FRONTEND_STATE_FIRST_OBSERVED",
] as const;

describe("recommendation pool V2 Gate 7 timing contract", () => {
  const context = {
    actor: createActorContext({ userId: "actor-1", sessionId: "session-1", roles: ["member"] }),
    tenant: createTenantContext({ organizationId: "org-1", workspaceId: "workspace-1" }),
    project: createProjectContext({
      websiteProjectId: "project-1", canonicalDomain: "project.example",
      locale: "en-US", countryCode: "US", profileVersionId: "profile-1",
      promotionTargetVersionId: "promotion-1",
    }),
  };

  it("resolves native job authority server-side and deduplicates actor/state without backdating", async () => {
    const query = vi.fn<(sql: string, values?: readonly unknown[]) =>
      Promise<{ rows: { id: string }[]; rowCount: number }>>(async () => ({
      rows: [{ id: "server-job" }], rowCount: 1,
    }));
    const release = vi.fn();
    const observe = createRecommendationFeedObserver({
      connect: async () => ({ query, release }),
    });
    const observation = {
      generationContractId: "generation-1",
      observedState: "SUCCESS|PATHS_EXHAUSTED|COMPLETED|AVAILABLE",
      clientObservedAt: "2026-09-07T00:00:00.000Z",
    };
    await observe(context, observation);
    await observe(context, { ...observation, clientObservedAt: "2026-09-08T00:00:00.000Z" });
    const writes = query.mock.calls.filter(([sql]) => sql.includes("WITH lineage"));
    expect(writes).toHaveLength(2);
    expect(writes[0][1]?.slice(0, 8)).toEqual([
      "org-1", "workspace-1", "project-1", "generation-1", "server-job",
      "FRONTEND_STATE_FIRST_OBSERVED",
      `frontend:actor-1:${observation.observedState}`, "actor-1",
    ]);
    expect(writes[1][1]?.[6]).toBe(writes[0][1]?.[6]);
    expect(writes[0][0]).not.toMatch(/occurred_at\s*[,=]/);
    expect(JSON.parse(String(writes[0][1]?.[13]))).toMatchObject({
      clockSource: "UNTRUSTED_CLIENT",
    });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("rolls back an out-of-scope native generation without a timing write", async () => {
    const query = vi.fn<(sql: string, values?: readonly unknown[]) =>
      Promise<{ rows: { id: string }[]; rowCount: number }>>(async () => ({
      rows: [], rowCount: 0,
    }));
    const release = vi.fn();
    const observe = createRecommendationFeedObserver({
      connect: async () => ({ query, release }),
    });
    await expect(observe(context, {
      generationContractId: "other-generation",
      observedState: "RUNNING|IN_PROGRESS|PENDING|PENDING",
      clientObservedAt: "2026-09-08T00:00:00.000Z",
    })).rejects.toThrow("Native generation not found");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => sql.includes("WITH lineage"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("declares the complete durable timing vocabulary", () => {
    expect(recommendationPoolV2TimingEventTypes).toEqual(expectedEventTypes);

    const migration = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/migrations/0092_backlink_recommendation_pool_v2_timing.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const eventType of expectedEventTypes) {
      expect(migration).toContain(`'${eventType}'`);
    }
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("backlink_reject_pool_v2_timing_mutation");
  });

  it("records an idempotent event against exact job and generation lineage", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "event-1" }],
      rowCount: 1,
    }));
    const repository = createRecommendationPoolV2TimingRepository({ query });

    await repository.record({
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      generationContractId: "generation-1",
      jobId: "job-1",
      actorId: "actor-1",
      eventType: "WORKFLOW_STARTED",
      idempotencyKey: "workflow-started",
      observedState: "RUNNING",
      details: { source: "temporal_activity" },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "backlink_recommendation_pool_v2_timing_events",
      ),
      expect.arrayContaining([
        "organization-1",
        "workspace-1",
        "project-1",
        "generation-1",
        "job-1",
        "WORKFLOW_STARTED",
        "workflow-started",
      ]),
    );
  });

  it("marks the Gate 5 workflow branch behind a Temporal patch boundary", () => {
    const workflow = readFileSync(
      new URL(
        "../../src/modules/backlinks/workflows/definitions/recommendation-pool-v2.workflow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(workflow).toContain("patched(");
    expect(workflow).toContain(
      "backlinks-recommendation-pool-v2-terminal-semantics-v2",
    );
    expect(workflow).toContain("terminalSemanticsVersion");
  });
});
