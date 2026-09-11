import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecommendationPoolV2Activities } from "../../src/modules/backlinks/activities/recommendation-pool-v2.activity.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), facts: vi.fn(), finalize: vi.fn(), record: vi.fn(),
  query: vi.fn(), release: vi.fn(),
}));
vi.mock("../../src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.js", () => ({
  createRecommendationPoolV2Repository: () => ({
    loadGeneration: mocks.load, finalizeGeneration: mocks.finalize,
  }),
}));
vi.mock("../../src/modules/backlinks/db/repositories/recommendation-pool-v2-timing.repository.js", () => ({
  createRecommendationPoolV2TimingRepository: () => ({ record: mocks.record }),
}));
vi.mock("../../src/modules/backlinks/db/repositories/recommendation-hybrid-supply.repository.js", () => ({
  createRecommendationHybridSupplyRepository: () => ({ load: mocks.facts }),
}));

const input = {
  organizationId: "org", workspaceId: "workspace", websiteProjectId: "project",
  generationContractId: "generation", recommendationContextVersionId: "context",
  visiblePoolGeneration: 2, inputPinId: "pin", jobId: "job", workflowId: "workflow",
  actorId: "actor", rounds: [],
};
const finalization = {
  effectiveUniqueCandidateCount: 200, discoveryTerminalReason: "SAFE_SUPPLY_REACHED",
  totalSettledCostMicros: 0, batches: [],
};
function setup() {
  const supply = vi.fn().mockResolvedValue({ status: "MATCHED", admittedCount: 200 });
  const prepare = vi.fn().mockResolvedValue(supply);
  const activities = createRecommendationPoolV2Activities({
    pool: { connect: async () => ({ query: mocks.query, release: mocks.release }) },
    discoveryRoundExecutor: vi.fn(),
    contactEnrichmentOptions: {},
    prepareResourceSupply: prepare,
  });
  return { activities, supply, prepare };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ status: "ready" });
  mocks.facts.mockResolvedValue({ admittedCount: 0, discoveryStarted: false });
  mocks.finalize.mockResolvedValue(finalization);
  mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("hybrid supply activity compatibility", () => {
  it("retains first-generation discovery and recorded completed activity results", async () => {
    const { activities, prepare } = setup();
    expect(await activities.loadGeneration({ ...input, visiblePoolGeneration: 1 }))
      .toEqual({ status: "ready" });
    mocks.load.mockResolvedValue({ status: "already_completed", finalization });
    expect(await activities.loadGeneration(input)).toEqual({ status: "already_completed", finalization });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses library supply before paid discovery in a new later generation", async () => {
    const { activities, prepare } = setup();
    expect(await activities.loadGeneration(input)).toEqual({ status: "already_completed", finalization });
    expect(prepare).toHaveBeenCalledOnce();
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({
      totalSettledCostMicros: 0, rounds: [], hardCandidateLimit: 1000,
    }));
  });

  it.each([
    { admittedCount: 50, discoveryStarted: true },
    { admittedCount: 0, discoveryStarted: true },
    { admittedCount: 5, discoveryStarted: false },
  ])("preserves resumed discovery and its costs: %j", async (facts) => {
    mocks.facts.mockResolvedValue(facts);
    const { activities, prepare } = setup();
    expect(await activities.loadGeneration(input)).toEqual({ status: "ready" });
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("rolls back partial library admission before bounded discovery resumes", async () => {
    const { activities, supply } = setup();
    supply.mockResolvedValue({ status: "MATCHED", admittedCount: 50 });
    expect(await activities.loadGeneration(input)).toEqual({ status: "ready" });
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("does not disguise a library failure as exhaustion or paid fallback", async () => {
    const { activities, supply } = setup();
    supply.mockResolvedValue({ status: "BLOCKED", admittedCount: 0, reason: "LIBRARY_UNAVAILABLE" });
    await expect(activities.loadGeneration(input)).rejects.toThrow("LIBRARY_UNAVAILABLE");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
