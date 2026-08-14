import { createHash, randomUUID } from "node:crypto";
import type { OpportunityRepository,
  OpportunityCreation, OpportunityManagementPatch, OpportunityTransition
} from "../../db/repositories/opportunity.repository.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import { canTransitionOpportunityBusinessStage, opportunityBusinessStages,
  type OpportunityBusinessStage, type OpportunityManagementStatus
} from "../../domain/opportunities/opportunity-state.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type CreateOpportunityCommand = Readonly<{
  context: ResolvedProjectContext; recommendationId: string;
  contactCandidateId: string; expectedVersion: number;
  idempotencyKey: string; requestId: string;
}>;
export type CreateOpportunityResult = OpportunityCreation &
  Readonly<{ replayed: boolean }>;
export type TransitionOpportunityCommand = Readonly<{
  context: ResolvedProjectContext; opportunityId: string; expectedVersion: number;
  toBusinessStage: OpportunityBusinessStage; reason: string;
  idempotencyKey: string; requestId: string;
}>;
export type TransitionOpportunityResult = OpportunityTransition &
  Readonly<{ replayed: boolean }>;
export type PatchOpportunityManagementCommand = Readonly<{
  context: ResolvedProjectContext; opportunityId: string; expectedVersion: number;
  managementStatus: OpportunityManagementStatus; reason: string;
  idempotencyKey: string; requestId: string;
}>;
export type PatchOpportunityManagementResult = OpportunityManagementPatch &
  Readonly<{ replayed: boolean }>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new BacklinkError({
  code: backlinkErrorCodes.conflict, message,
});
const authorize = (input: ResolvedProjectContext) => {
  if (!input.actor.roles.some((role) => ["owner", "admin", "member"].includes(role)))
    throw new BacklinkError({ code: backlinkErrorCodes.accessDenied,
      message: "Opportunity write permission is required." });
};

export function createOpportunityCommands(repository: OpportunityRepository) {
  return Object.freeze({
    async createFromRecommendation(
      input: CreateOpportunityCommand,
    ): Promise<CreateOpportunityResult> {
      authorize(input.context);
      const requestHash = digest({ recommendationId: input.recommendationId,
        contactCandidateId: input.contactCandidateId,
        expectedVersion: input.expectedVersion });
      const row = await repository.createFromRecommendation({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId, recommendationId: input.recommendationId,
        contactCandidateId: input.contactCandidateId,
        expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey,
        requestHash, requestId: input.requestId, idempotencyRecordId: randomUUID(),
        opportunityId: randomUUID(), cycleId: randomUUID(),
        lifecycleEventId: randomUUID(), auditEventId: randomUUID(),
        contactId: randomUUID(),
      });
      if (row.requestHash !== requestHash)
        throw conflict("Idempotency key is already bound to a different request.");
      if (row.state === "not_found")
        throw new BacklinkError({ code: backlinkErrorCodes.notFound,
          message: "Recommendation was not found." });
      if (row.state === "version_conflict")
        throw conflict("ExpectedVersion does not match the current recommendation.");
      if (row.state === "contact_required")
        throw conflict(
          "The selected public contact is no longer eligible for this recommendation.",
        );
      if (row.state === "duplicate")
        throw conflict("An Opportunity already exists for this domain.");
      if (row.responseBody === undefined)
        throw conflict("The idempotent command is already in progress.");
      return { ...row.responseBody, replayed: row.state === "replay" };
    },
    async transitionBusinessStage(
      input: TransitionOpportunityCommand,
    ): Promise<TransitionOpportunityResult> {
      authorize(input.context);
      const requestHash = digest({ opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        toBusinessStage: input.toBusinessStage, reason: input.reason });
      const allowedFromStages = opportunityBusinessStages.filter((stage) =>
        canTransitionOpportunityBusinessStage(stage, input.toBusinessStage));
      const row = await repository.transitionBusinessStage({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId, opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        toBusinessStage: input.toBusinessStage, allowedFromStages, reason: input.reason,
        idempotencyKey: input.idempotencyKey, requestHash, requestId: input.requestId,
        idempotencyRecordId: randomUUID(), lifecycleEventId: randomUUID(),
        auditEventId: randomUUID(),
      });
      if (row.requestHash !== requestHash)
        throw conflict("Idempotency key is already bound to a different request.");
      if (row.state === "not_found")
        throw new BacklinkError({ code: backlinkErrorCodes.notFound,
          message: "Opportunity was not found." });
      if (row.state === "version_conflict")
        throw conflict("ExpectedVersion does not match the current Opportunity.");
      if (row.state === "invalid_transition")
        throw conflict(`Invalid Opportunity transition: ${row.currentStage} -> ${input.toBusinessStage}.`);
      if (row.responseBody === undefined)
        throw conflict("The idempotent command is already in progress.");
      return { ...row.responseBody, replayed: row.state === "replay" };
    },
    async patchManagement(
      input: PatchOpportunityManagementCommand,
    ): Promise<PatchOpportunityManagementResult> {
      authorize(input.context);
      const requestHash = digest({ opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        managementStatus: input.managementStatus, reason: input.reason });
      const row = await repository.patchManagement({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId, opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        managementStatus: input.managementStatus, reason: input.reason,
        idempotencyKey: input.idempotencyKey, requestHash, requestId: input.requestId,
        idempotencyRecordId: randomUUID(), lifecycleEventId: randomUUID(),
        auditEventId: randomUUID(),
      });
      if (row.requestHash !== requestHash)
        throw conflict("Idempotency key is already bound to a different request.");
      if (row.state === "not_found")
        throw new BacklinkError({ code: backlinkErrorCodes.notFound,
          message: "Opportunity was not found." });
      if (row.state === "version_conflict")
        throw conflict("ExpectedVersion does not match the current Opportunity.");
      if (row.state === "unchanged")
        throw conflict(`Opportunity management status is already ${input.managementStatus}.`);
      if (row.responseBody === undefined)
        throw conflict("The idempotent command is already in progress.");
      return { ...row.responseBody, replayed: row.state === "replay" };
    },
  });
}
