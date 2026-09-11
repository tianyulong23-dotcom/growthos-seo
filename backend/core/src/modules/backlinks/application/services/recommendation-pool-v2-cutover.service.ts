import { randomUUID } from "node:crypto";

import type {
  RecommendationPoolV2CutoverMode,
  RecommendationPoolV2CutoverProjectFact,
  RecommendationPoolV2CutoverRepository,
  RecommendationPoolV2CutoverRun,
  RecommendationPoolV2CutoverVerification,
} from "../../db/repositories/recommendation-pool-v2-cutover.repository.js";

export type RecommendationPoolV2CutoverCommand = Readonly<{
  commandId: string;
  mode: RecommendationPoolV2CutoverMode;
  actor: string;
}>;

export type RecommendationPoolV2CutoverOutcome = Readonly<{
  runId: string;
  commandId: string;
  mode: RecommendationPoolV2CutoverMode;
  status: RecommendationPoolV2CutoverRun["status"];
  facts: readonly RecommendationPoolV2CutoverProjectFact[];
  verification:
    RecommendationPoolV2CutoverVerification | Readonly<Record<string, unknown>>;
}>;

export type RecommendationPoolV2CutoverService = Readonly<{
  run(
    command: RecommendationPoolV2CutoverCommand,
  ): Promise<RecommendationPoolV2CutoverOutcome>;
  enterMaintenanceReadOnly(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      actor: string;
      reasonCodes: readonly string[];
    }>,
  ): Promise<void>;
}>;

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} is required.`);
  }
  return normalized;
}

function statusForFacts(
  mode: RecommendationPoolV2CutoverMode,
  facts: readonly RecommendationPoolV2CutoverProjectFact[],
  verification: RecommendationPoolV2CutoverVerification,
): Exclude<RecommendationPoolV2CutoverRun["status"], "RUNNING"> {
  if (facts.some(({ result }) => result === "MIGRATION_BLOCKED")) {
    return "MIGRATION_BLOCKED";
  }
  if (facts.some(({ result }) => result === "INPUT_REQUIRED")) {
    return "INPUT_REQUIRED";
  }
  if (mode === "VERIFY") {
    return verification.completed ? "COMPLETED" : "MIGRATION_BLOCKED";
  }
  if (mode === "EXECUTE" && verification.completed) {
    return "COMPLETED";
  }
  return "PLANNED";
}

export function createRecommendationPoolV2CutoverService(
  repository: RecommendationPoolV2CutoverRepository,
  dependencies: Readonly<{
    idFactory?: () => string;
    now?: () => Date;
  }> = {},
): RecommendationPoolV2CutoverService {
  const idFactory = dependencies.idFactory ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async run(command) {
      const normalized = Object.freeze({
        commandId: required(command.commandId, "Cutover command id"),
        mode: command.mode,
        actor: required(command.actor, "Cutover actor"),
      });
      if (!["PLAN", "EXECUTE", "VERIFY"].includes(normalized.mode)) {
        throw new TypeError("Cutover mode must be PLAN, EXECUTE, or VERIFY.");
      }
      const proposedRunId = idFactory();
      const run = await repository.startRun({
        runId: proposedRunId,
        ...normalized,
      });
      if (run.id !== proposedRunId || run.status !== "RUNNING") {
        return Object.freeze({
          runId: run.id,
          commandId: run.commandId,
          mode: run.mode,
          status: run.status,
          facts: await repository.listRunFacts(run.id),
          verification: run.verification,
        });
      }

      const projects =
        normalized.mode === "VERIFY"
          ? Object.freeze([])
          : await repository.listEligibleProjects();
      const facts: RecommendationPoolV2CutoverProjectFact[] = [];
      for (const project of projects) {
        const observedAt = now();
        const fact =
          normalized.mode === "PLAN"
            ? await repository.planProject(project)
            : await repository.executeProject({
                project,
                actor: normalized.actor,
                observedAt,
              });
        await repository.recordFact({
          id: idFactory(),
          runId: run.id,
          fact,
          actor: normalized.actor,
          observedAt,
        });
        facts.push(fact);
      }

      const verification = await repository.verifyCutover();
      const status = statusForFacts(normalized.mode, facts, verification);
      const v2ActiveProjectCount =
        normalized.mode === "VERIFY"
          ? verification.v2ActiveProjectCount
          : facts.filter(
              ({ result }) =>
                result === "V2_ACTIVE" || result === "ALREADY_V2_ACTIVE",
            ).length;
      const inputRequiredProjectCount = facts.filter(
        ({ result }) => result === "INPUT_REQUIRED",
      ).length;
      const migrationBlockedProjectCount =
        normalized.mode === "VERIFY"
          ? verification.migrationBlockedProjectCount
          : facts.filter(({ result }) => result === "MIGRATION_BLOCKED").length;
      await repository.finishRun({
        runId: run.id,
        status,
        eligibleProjectCount:
          normalized.mode === "VERIFY"
            ? verification.eligibleProjectCount
            : projects.length,
        v2ActiveProjectCount,
        inputRequiredProjectCount,
        migrationBlockedProjectCount,
        verification,
        actor: normalized.actor,
        completedAt: now(),
      });
      return Object.freeze({
        runId: run.id,
        commandId: normalized.commandId,
        mode: normalized.mode,
        status,
        facts: Object.freeze(facts),
        verification,
      });
    },
    async enterMaintenanceReadOnly(input) {
      const reasonCodes = input.reasonCodes.map((reasonCode) =>
        required(reasonCode, "Maintenance reason code"),
      );
      if (reasonCodes.length === 0) {
        throw new TypeError("Maintenance reason codes are required.");
      }
      await repository.enterMaintenanceReadOnly({
        organizationId: required(input.organizationId, "Organization id"),
        workspaceId: required(input.workspaceId, "Workspace id"),
        websiteProjectId: required(
          input.websiteProjectId,
          "Website project id",
        ),
        actor: required(input.actor, "Maintenance actor"),
        reasonCodes,
        observedAt: now(),
      });
    },
  });
}
