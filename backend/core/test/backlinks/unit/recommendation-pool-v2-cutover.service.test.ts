import { describe, expect, it, vi } from "vitest";

import { createRecommendationPoolV2CutoverService } from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-cutover.service.js";
import type {
  RecommendationPoolV2CutoverProject,
  RecommendationPoolV2CutoverProjectFact,
  RecommendationPoolV2CutoverRepository,
  RecommendationPoolV2CutoverRun,
  RecommendationPoolV2CutoverVerification,
} from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-cutover.repository.js";
import { assessLegacyContactTerminalSnapshot } from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-cutover.repository.js";

const project: RecommendationPoolV2CutoverProject = Object.freeze({
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  projectContextSnapshotId: "context-1",
  projectContextSnapshotVersion: 7,
});

const verification = (
  completed: boolean,
): RecommendationPoolV2CutoverVerification =>
  Object.freeze({
    completed,
    eligibleProjectCount: 1,
    v2ActiveProjectCount: completed ? 1 : 0,
    validV2ActiveProjectCount: completed ? 1 : 0,
    activeV1ProjectCount: completed ? 0 : 1,
    migrationBlockedProjectCount: 0,
    invalidV2ActiveProjectCount: 0,
    activeV1GenerationCount: 0,
    activeV1RefillCount: 0,
    activeV1RefillJobCount: 0,
    activeV1OutboxCount: 0,
    activeV1ClaimCount: 0,
    activeV1ProviderRequestCount: 0,
    activeV1ProviderReservationCount: 0,
    activeV1ProviderLeaseCount: 0,
  });

const run = (
  status: RecommendationPoolV2CutoverRun["status"] = "RUNNING",
  id = "run-1",
  mode: RecommendationPoolV2CutoverRun["mode"] = "EXECUTE",
): RecommendationPoolV2CutoverRun =>
  Object.freeze({
    id,
    commandId: "command-1",
    mode,
    status,
    eligibleProjectCount: status === "RUNNING" ? 0 : 1,
    v2ActiveProjectCount: status === "RUNNING" ? 0 : 1,
    inputRequiredProjectCount: 0,
    migrationBlockedProjectCount: 0,
    verification: verification(status === "COMPLETED"),
    startedAt: new Date("2026-08-28T00:00:00.000Z"),
    completedAt:
      status === "RUNNING" ? null : new Date("2026-08-28T00:01:00.000Z"),
  });

const fact = (
  result: RecommendationPoolV2CutoverProjectFact["result"],
): RecommendationPoolV2CutoverProjectFact =>
  Object.freeze({
    ...project,
    phase: "APPLY",
    result,
    reasonCodes:
      result === "INPUT_REQUIRED" ? ["DISCOVERY_INPUTS_REQUIRED"] : [],
    lineage:
      result === "INPUT_REQUIRED"
        ? null
        : {
            generationContractId: "generation-1",
            poolContractVersion: "recommendation-pool.v2",
            recommendationContextVersionId: "context-1",
            visiblePoolGeneration: 1,
            inputPinId: "input-pin-1",
          },
    canonicalBatchCount: result === "INPUT_REQUIRED" ? null : 1,
    availableBatchCount: result === "INPUT_REQUIRED" ? null : 1,
    canonicalItemCount: result === "INPUT_REQUIRED" ? null : 1,
  });

function repository(
  overrides: Partial<RecommendationPoolV2CutoverRepository> = {},
) {
  return {
    startRun: vi.fn(async ({ runId, mode }) => run("RUNNING", runId, mode)),
    listEligibleProjects: vi.fn(async () => [project]),
    listRunFacts: vi.fn(async () => []),
    planProject: vi.fn(async () => fact("READY")),
    executeProject: vi.fn(async () => fact("V2_ACTIVE")),
    recordFact: vi.fn(async () => undefined),
    verifyCutover: vi.fn(async () => verification(true)),
    finishRun: vi.fn(async () => undefined),
    enterMaintenanceReadOnly: vi.fn(async () => undefined),
    ...overrides,
  } satisfies RecommendationPoolV2CutoverRepository;
}

describe("recommendation pool V2 cutover service", () => {
  it.each([
    ["eligible", "PUBLIC_EMAIL_FOUND"],
    ["manual_review", "CONTACT_FORM_ONLY"],
    ["manual_review", "LOGIN_REQUIRED"],
    ["manual_review", "CAPTCHA_OR_BOT_CHALLENGE"],
    ["manual_review", "ROBOTS_DISALLOWED"],
    ["manual_review", "ACCESS_DENIED"],
    ["manual_review", "MANUAL_REVIEW_REQUIRED"],
    ["manual_review", "COMPLETED_PARTIAL"],
    ["ineligible", "NO_PUBLIC_EMAIL"],
    ["ineligible", "SITE_UNREACHABLE"],
    ["ineligible", "UNSUPPORTED_CONTENT"],
  ])(
    "accepts the persisted terminal contact snapshot %s/%s",
    (decision, reasonCode) => {
      expect(
        assessLegacyContactTerminalSnapshot({
          decision,
          reasonCode,
        }),
      ).toBe("TERMINAL");
    },
  );

  it.each([
    ["pending", "CONTACT_PENDING", "CONTACT_PENDING"],
    ["pending", "CONTACT_NOT_EVALUATED", "CONTACT_PENDING"],
    ["eligible", "CONTACT_PENDING", "CONTACT_PENDING"],
    ["eligible", "NO_PUBLIC_EMAIL", "INVALID_TERMINAL_SNAPSHOT"],
    ["manual_review", "PUBLIC_EMAIL_FOUND", "INVALID_TERMINAL_SNAPSHOT"],
    ["ineligible", "COMPLETED_PARTIAL", "INVALID_TERMINAL_SNAPSHOT"],
    ["unknown", "PUBLIC_EMAIL_FOUND", "INVALID_TERMINAL_SNAPSHOT"],
  ])(
    "fails closed for the legacy contact snapshot %s/%s",
    (decision, reasonCode, expected) => {
      expect(
        assessLegacyContactTerminalSnapshot({
          decision,
          reasonCode,
        }),
      ).toBe(expected);
    },
  );

  it("executes every eligible project without activating the Phase 9 global freeze", async () => {
    const target = repository();
    const service = createRecommendationPoolV2CutoverService(target, {
      idFactory: () => "generated-id",
      now: () => new Date("2026-08-28T00:02:00.000Z"),
    });

    const outcome = await service.run({
      commandId: "command-1",
      mode: "EXECUTE",
      actor: "cutover-test",
    });

    expect(outcome.status).toBe("COMPLETED");
    expect(target.executeProject).toHaveBeenCalledWith({
      project,
      actor: "cutover-test",
      observedAt: new Date("2026-08-28T00:02:00.000Z"),
    });
    expect(target.recordFact).toHaveBeenCalledOnce();
    expect(target.verifyCutover).toHaveBeenCalledOnce();
    expect(target.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "generated-id",
        status: "COMPLETED",
        eligibleProjectCount: 1,
        v2ActiveProjectCount: 1,
        inputRequiredProjectCount: 0,
        migrationBlockedProjectCount: 0,
      }),
    );
  });

  it("persists INPUT_REQUIRED without freezing V1 writes", async () => {
    const target = repository({
      executeProject: vi.fn(async () => fact("INPUT_REQUIRED")),
      verifyCutover: vi.fn(async () => verification(false)),
    });
    const service = createRecommendationPoolV2CutoverService(target, {
      idFactory: () => "generated-id",
    });

    const outcome = await service.run({
      commandId: "command-1",
      mode: "EXECUTE",
      actor: "cutover-test",
    });

    expect(outcome.status).toBe("INPUT_REQUIRED");
    expect(target.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "INPUT_REQUIRED" }),
    );
  });

  it("verifies without enumerating or mutating project facts", async () => {
    const target = repository();
    const service = createRecommendationPoolV2CutoverService(target, {
      idFactory: () => "verify-run",
      now: () => new Date("2026-08-28T00:04:00.000Z"),
    });

    const outcome = await service.run({
      commandId: "verify-command",
      mode: "VERIFY",
      actor: "cutover-test",
    });

    expect(outcome).toMatchObject({
      runId: "verify-run",
      mode: "VERIFY",
      status: "COMPLETED",
      facts: [],
    });
    expect(target.listEligibleProjects).not.toHaveBeenCalled();
    expect(target.planProject).not.toHaveBeenCalled();
    expect(target.executeProject).not.toHaveBeenCalled();
    expect(target.recordFact).not.toHaveBeenCalled();
    expect(target.verifyCutover).toHaveBeenCalledOnce();
    expect(target.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "verify-run",
        status: "COMPLETED",
        eligibleProjectCount: 1,
        v2ActiveProjectCount: 1,
        inputRequiredProjectCount: 0,
        migrationBlockedProjectCount: 0,
      }),
    );
  });

  it("returns a completed command idempotently without re-enumerating projects", async () => {
    const persistedFact = fact("ALREADY_V2_ACTIVE");
    const target = repository({
      startRun: vi.fn(async () => run("COMPLETED")),
      listRunFacts: vi.fn(async () => [persistedFact]),
    });
    const service = createRecommendationPoolV2CutoverService(target);

    const outcome = await service.run({
      commandId: "command-1",
      mode: "EXECUTE",
      actor: "cutover-test",
    });

    expect(outcome).toMatchObject({
      runId: "run-1",
      status: "COMPLETED",
      facts: [persistedFact],
    });
    expect(target.listEligibleProjects).not.toHaveBeenCalled();
    expect(target.executeProject).not.toHaveBeenCalled();
    expect(target.finishRun).not.toHaveBeenCalled();
  });

  it("does not execute a concurrent command owned by another run id", async () => {
    const target = repository({
      startRun: vi.fn(async () => run()),
    });
    const service = createRecommendationPoolV2CutoverService(target, {
      idFactory: () => "different-proposed-run",
    });

    const outcome = await service.run({
      commandId: "command-1",
      mode: "EXECUTE",
      actor: "cutover-test",
    });

    expect(outcome).toMatchObject({
      runId: "run-1",
      status: "RUNNING",
    });
    expect(target.listEligibleProjects).not.toHaveBeenCalled();
    expect(target.executeProject).not.toHaveBeenCalled();
  });

  it("allows rollback only through V2 maintenance read-only", async () => {
    const target = repository();
    const service = createRecommendationPoolV2CutoverService(target, {
      now: () => new Date("2026-08-28T00:03:00.000Z"),
    });

    await service.enterMaintenanceReadOnly({
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      actor: "cutover-test",
      reasonCodes: ["EMERGENCY_MAINTENANCE"],
    });

    expect(target.enterMaintenanceReadOnly).toHaveBeenCalledWith({
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      actor: "cutover-test",
      reasonCodes: ["EMERGENCY_MAINTENANCE"],
      observedAt: new Date("2026-08-28T00:03:00.000Z"),
    });
  });
});
