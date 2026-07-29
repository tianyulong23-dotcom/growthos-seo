import { createHash } from "node:crypto";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  DraftEditingRepository,
  DraftGenerationRepository,
} from "../repositories/draft-generation.repository.js";
import { draftDocumentSchema } from "../schemas/draft-document.schema.js";
import {
  draftDocumentToPlainText,
} from "../../domain/drafts/draft-document.js";

export type DraftBudgetGate = Readonly<{
  assertAvailable(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    operation: "draft_generation";
  }>): Promise<void>;
}>;

type CreateDraftCommand = Readonly<{
  context: ResolvedProjectContext;
  opportunityId: string;
  evidenceSnapshotId: string;
  logicalDraftKey: string;
  idempotencyKey: string;
}>;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const authorize = (context: ResolvedProjectContext): void => {
  if (!context.actor.roles.some((role) =>
    ["owner", "admin", "member"].includes(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Draft write permission is required.",
    });
  }
};

const mapRepositoryError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : "";
  if (message === "Idempotency key payload mismatch.") {
    throw new BacklinkError({
      code: backlinkErrorCodes.conflict,
      message: "Idempotency key is already bound to a different request.",
    });
  }
  if (message.includes("outside") || message.includes("not found")) {
    throw new BacklinkError({
      code: backlinkErrorCodes.notFound,
      message: "Draft resource was not found in this project.",
    });
  }
  throw error;
};

export function createDraftCommands(dependencies: Readonly<{
  repository: DraftGenerationRepository;
  budget: DraftBudgetGate;
  newId(): string;
  now(): Date;
  promptVersion: string;
  outputSchemaVersion: string;
}>) {
  return Object.freeze({
    async create(input: CreateDraftCommand) {
      authorize(input.context);
      try {
        await dependencies.budget.assertAvailable({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          operation: "draft_generation",
        });
      } catch {
        throw new BacklinkError({
          code: backlinkErrorCodes.rateLimited,
          message: "Draft generation budget is unavailable.",
          retryable: true,
        });
      }

      const requestHash = digest({
        opportunityId: input.opportunityId,
        evidenceSnapshotId: input.evidenceSnapshotId,
        logicalDraftKey: input.logicalDraftKey,
        promptVersion: dependencies.promptVersion,
        outputSchemaVersion: dependencies.outputSchemaVersion,
      });
      const draftId = dependencies.newId();
      const runId = dependencies.newId();
      try {
        const job = await dependencies.repository.createJob({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          opportunityId: input.opportunityId,
          evidenceSnapshotId: input.evidenceSnapshotId,
          draftId,
          runId,
          logicalDraftKey: input.logicalDraftKey,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          promptVersion: dependencies.promptVersion,
          outputSchemaVersion: dependencies.outputSchemaVersion,
          actorId: input.context.actor.userId,
          recordedAt: dependencies.now(),
        });
        return {
          jobId: job.runId,
          draftId: job.draftId,
          status: job.status,
          replayed: job.runId !== runId,
        };
      } catch (error) {
        return mapRepositoryError(error);
      }
    },
  });
}

const requireCompleted = (
  result: Awaited<ReturnType<DraftEditingRepository["approve"]>>,
) => {
  if (result.state === "not_found") {
    throw new BacklinkError({
      code: backlinkErrorCodes.notFound,
      message: "Draft was not found in this project.",
    });
  }
  if (result.state === "version_conflict") {
    throw new BacklinkError({
      code: backlinkErrorCodes.conflict,
      message: "ExpectedVersion does not match the current Draft.",
    });
  }
  return {
    draftId: result.draftId,
    versionId: result.versionId,
    draftVersion: result.draftVersion,
    status: result.status,
  };
};

export function createDraftEditingCommands(dependencies: Readonly<{
  repository: DraftEditingRepository;
  newId(): string;
  now(): Date;
}>) {
  return Object.freeze({
    async saveManualVersion(input: Readonly<{
      context: ResolvedProjectContext;
      draftId: string;
      expectedVersion: number;
      subjectText: string;
      bodyDocument: unknown;
    }>) {
      authorize(input.context);
      const bodyDocument = draftDocumentSchema.parse(input.bodyDocument);
      return requireCompleted(
        await dependencies.repository.saveManualVersion({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          draftId: input.draftId,
          expectedVersion: input.expectedVersion,
          subjectText: input.subjectText,
          bodyText: draftDocumentToPlainText(bodyDocument),
          bodyDocument,
          versionId: dependencies.newId(),
          actorId: input.context.actor.userId,
          recordedAt: dependencies.now(),
        }),
      );
    },

    async approve(input: Readonly<{
      context: ResolvedProjectContext;
      draftId: string;
      expectedVersion: number;
    }>) {
      authorize(input.context);
      return requireCompleted(
        await dependencies.repository.approve({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          draftId: input.draftId,
          expectedVersion: input.expectedVersion,
          actorId: input.context.actor.userId,
          recordedAt: dependencies.now(),
        }),
      );
    },
  });
}
