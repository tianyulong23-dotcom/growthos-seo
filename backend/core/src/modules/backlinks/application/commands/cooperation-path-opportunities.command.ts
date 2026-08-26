import { createHash, randomUUID } from "node:crypto";

import type {
  CooperationPathOpportunityCreation,
  CooperationPathOpportunityRepository,
  ManualActionMutation,
} from "../../db/repositories/cooperation-path-opportunity.repository.js";
import {
  allowedManualActionOrigins,
  type ManualActionState,
} from "../../domain/opportunities/cooperation-path.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type CreateCooperationPathOpportunityCommand = Readonly<{
  context: ResolvedProjectContext;
  recommendationId: string;
  cooperationPathFactId: string;
  expectedVersion: number;
  editableContent: string;
  nextAction: string;
  idempotencyKey: string;
  requestId: string;
}>;

export type PatchManualContentCommand = Readonly<{
  context: ResolvedProjectContext;
  opportunityId: string;
  expectedVersion: number;
  editableContent: string;
  nextAction: string;
  idempotencyKey: string;
  requestId: string;
}>;

export type TransitionManualActionCommand = Readonly<{
  context: ResolvedProjectContext;
  opportunityId: string;
  expectedVersion: number;
  toState: ManualActionState;
  nextAction: string;
  evidence: Readonly<Record<string, unknown>>;
  submissionConfirmed: boolean;
  idempotencyKey: string;
  requestId: string;
}>;

export type CreateCooperationPathOpportunityResult =
  CooperationPathOpportunityCreation & Readonly<{ replayed: boolean }>;
export type ManualActionMutationResult =
  ManualActionMutation & Readonly<{ replayed: boolean }>;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const conflict = (message: string) => new BacklinkError({
  code: backlinkErrorCodes.conflict,
  message,
});

function authorize(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) =>
    ["owner", "admin", "member"].includes(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Opportunity write permission is required.",
    });
  }
}

function assertResponse<T>(
  row: Readonly<{ responseBody?: T }>,
): asserts row is Readonly<{ responseBody: T }> {
  if (row.responseBody === undefined) {
    throw conflict("The idempotent command is already in progress.");
  }
}

export function createCooperationPathOpportunityCommands(
  repository: CooperationPathOpportunityRepository,
) {
  return Object.freeze({
    async createFromVerifiedPath(
      input: CreateCooperationPathOpportunityCommand,
    ): Promise<CreateCooperationPathOpportunityResult> {
      authorize(input.context);
      const requestHash = digest({
        recommendationId: input.recommendationId,
        cooperationPathFactId: input.cooperationPathFactId,
        expectedVersion: input.expectedVersion,
        editableContent: input.editableContent,
        nextAction: input.nextAction,
      });
      const row = await repository.createFromVerifiedPath({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        recommendationId: input.recommendationId,
        cooperationPathFactId: input.cooperationPathFactId,
        expectedVersion: input.expectedVersion,
        editableContent: input.editableContent,
        nextAction: input.nextAction,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        requestId: input.requestId,
        idempotencyRecordId: randomUUID(),
        opportunityId: randomUUID(),
        cycleId: randomUUID(),
        manualActionId: randomUUID(),
        manualActionEventId: randomUUID(),
        lifecycleEventId: randomUUID(),
        auditEventId: randomUUID(),
      });
      if (row.requestHash !== requestHash) {
        throw conflict("Idempotency key is already bound to a different request.");
      }
      if (row.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Recommendation was not found.",
        });
      }
      if (row.state === "version_conflict") {
        throw conflict("ExpectedVersion does not match the current recommendation.");
      }
      if (row.state === "path_required") {
        throw conflict(
          "A verified non-email cooperation path with an absolute evidence URL is required.",
        );
      }
      if (row.state === "duplicate") {
        throw conflict("An Opportunity already exists for this domain.");
      }
      assertResponse(row);
      return { ...row.responseBody, replayed: row.state === "replay" };
    },

    async patchManualContent(
      input: PatchManualContentCommand,
    ): Promise<ManualActionMutationResult> {
      authorize(input.context);
      const requestHash = digest({
        opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        editableContent: input.editableContent,
        nextAction: input.nextAction,
      });
      const row = await repository.patchManualContent({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        editableContent: input.editableContent,
        nextAction: input.nextAction,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        requestId: input.requestId,
        idempotencyRecordId: randomUUID(),
        lifecycleEventId: randomUUID(),
        auditEventId: randomUUID(),
      });
      if (row.requestHash !== requestHash) {
        throw conflict("Idempotency key is already bound to a different request.");
      }
      if (row.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Cooperation-path Opportunity was not found.",
        });
      }
      if (row.state === "version_conflict") {
        throw conflict("ExpectedVersion does not match the current manual action.");
      }
      if (row.state === "unchanged") {
        throw conflict("Manual content and next action are unchanged.");
      }
      assertResponse(row);
      return { ...row.responseBody, replayed: row.state === "replay" };
    },

    async transitionManualAction(
      input: TransitionManualActionCommand,
    ): Promise<ManualActionMutationResult> {
      authorize(input.context);
      if (input.toState === "SUBMITTED" && !input.submissionConfirmed) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "Explicit submission confirmation is required.",
          fieldErrors: [{
            field: "submissionConfirmed",
            message: "Confirm that the operator completed the external submission.",
          }],
        });
      }
      const requestHash = digest({
        opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        toState: input.toState,
        nextAction: input.nextAction,
        evidence: input.evidence,
        submissionConfirmed: input.submissionConfirmed,
      });
      const row = await repository.transitionManualAction({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        opportunityId: input.opportunityId,
        expectedVersion: input.expectedVersion,
        toState: input.toState,
        allowedFromStates: allowedManualActionOrigins(input.toState),
        nextAction: input.nextAction,
        evidence: input.evidence,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        requestId: input.requestId,
        idempotencyRecordId: randomUUID(),
        manualActionEventId: randomUUID(),
        lifecycleEventId: randomUUID(),
        auditEventId: randomUUID(),
      });
      if (row.requestHash !== requestHash) {
        throw conflict("Idempotency key is already bound to a different request.");
      }
      if (row.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Cooperation-path Opportunity was not found.",
        });
      }
      if (row.state === "version_conflict") {
        throw conflict("ExpectedVersion does not match the current manual action.");
      }
      if (row.state === "invalid_transition") {
        throw conflict(
          `Invalid manual action transition: ${row.currentState} -> ${input.toState}.`,
        );
      }
      assertResponse(row);
      return { ...row.responseBody, replayed: row.state === "replay" };
    },
  });
}
