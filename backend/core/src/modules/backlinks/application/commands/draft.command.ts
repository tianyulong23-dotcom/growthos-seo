import { createHash } from "node:crypto";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  DraftEditingRepository,
  DraftGenerationMode,
  DraftGenerationRepository,
} from "../repositories/draft-generation.repository.js";
import type {
  DraftGenerationWorkflowInput,
} from "../workflows/draft-generation-workflow.js";
import { draftDocumentSchema } from "../schemas/draft-document.schema.js";
import {
  draftDocumentToPlainText,
} from "../../domain/drafts/draft-document.js";
import {
  containsInternalDraftMetadataMarker,
} from "../../domain/drafts/evidence-policy.js";
import type { DraftRequest } from "../schemas/draft-request.schema.js";
import { AiDraftError } from "../../ports/ai-draft.port.js";

export type DraftBudgetGate = Readonly<{
  assertAvailable(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    operation: "draft_generation";
  }>): Promise<void>;
}>;

export type DraftGenerationScheduler = Readonly<{
  start(input: DraftGenerationWorkflowInput): Promise<
    Readonly<{ workflowId: string }>
  >;
}>;

type CreateDraftCommand = Readonly<{
  context: ResolvedProjectContext;
  opportunityId: string;
  contactId: string;
  contactVersion: number;
  logicalDraftKey: string;
  idempotencyKey: string;
  request: DraftRequest;
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
  if (message === "DRAFT_PROJECT_CONTEXT_INCOMPLETE") {
    throw new BacklinkError({
      code: backlinkErrorCodes.conflict,
      message:
        "Project marketing context is incomplete. Add a product, promotion topic, and promotion target before generating a Draft.",
      fieldErrors: [{
        field: "projectMarketingContext",
        message:
          "The active project needs products, keywords or topics, and a promotion target.",
      }],
    });
  }
  if (
    message === "DRAFT_PROMOTION_TARGET_INVALID"
    || message === "DRAFT_PROMOTION_TARGET_OUTSIDE_PROJECT"
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message:
        "The promotion target must be a valid HTTP(S) page on this project's website.",
      fieldErrors: [{
        field: "request.promotionTargetUrl",
        message:
          "Use a published page on the current project's domain or one of its subdomains.",
      }],
    });
  }
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
  if (message.includes("Draft Contact")) {
    throw new BacklinkError({
      code: backlinkErrorCodes.conflict,
      message: "The selected Contact is unavailable or has changed.",
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
  generationMode: DraftGenerationMode;
  modelProviderAvailable(): boolean;
  scheduler: DraftGenerationScheduler;
}>) {
  return Object.freeze({
    async create(input: CreateDraftCommand) {
      authorize(input.context);
      if (
        dependencies.generationMode === "MODEL"
        && dependencies.modelProviderAvailable()
      ) {
        try {
          await dependencies.budget.assertAvailable({
            organizationId: input.context.tenant.organizationId,
            workspaceId: input.context.tenant.workspaceId,
            websiteProjectId: input.context.project.websiteProjectId,
            operation: "draft_generation",
          });
        } catch (error) {
          if (!(error instanceof AiDraftError)) {
            throw new BacklinkError({
              code: backlinkErrorCodes.rateLimited,
              message: "Draft generation budget is unavailable.",
              retryable: true,
            });
          }
        }
      }

      const recordedAt = dependencies.now();
      try {
        const evidenceSnapshot = await dependencies.repository
          .prepareEvidenceSnapshot({
            organizationId: input.context.tenant.organizationId,
            workspaceId: input.context.tenant.workspaceId,
            websiteProjectId: input.context.project.websiteProjectId,
            opportunityId: input.opportunityId,
            contactId: input.contactId,
            contactVersion: input.contactVersion,
            snapshotId: dependencies.newId(),
            requestSnapshotId: dependencies.newId(),
            request: input.request,
            actorId: input.context.actor.userId,
            recordedAt,
          });
        const requestHash = digest({
          opportunityId: input.opportunityId,
          contactId: input.contactId,
          contactVersion: input.contactVersion,
          evidenceSnapshotId: evidenceSnapshot.snapshotId,
          requestSnapshotId: evidenceSnapshot.requestSnapshotId,
          request: input.request,
          logicalDraftKey: input.logicalDraftKey,
          promptVersion: dependencies.promptVersion,
          outputSchemaVersion: dependencies.outputSchemaVersion,
          generationMode: dependencies.generationMode,
        });
        const draftId = dependencies.newId();
        const runId = dependencies.newId();
        const versionId = dependencies.newId();
        const job = await dependencies.repository.createJob({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          opportunityId: input.opportunityId,
          contactId: input.contactId,
          contactVersion: input.contactVersion,
          evidenceSnapshotId: evidenceSnapshot.snapshotId,
          requestSnapshotId: evidenceSnapshot.requestSnapshotId,
          draftId,
          runId,
          logicalDraftKey: input.logicalDraftKey,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          promptVersion: dependencies.promptVersion,
          outputSchemaVersion: dependencies.outputSchemaVersion,
          generationMode: dependencies.generationMode,
          actorId: input.context.actor.userId,
          recordedAt,
        });
        const scheduled = await dependencies.scheduler.start({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          runId: job.runId,
          versionId: job.versionId ?? versionId,
          actorId: input.context.actor.userId,
          recordedAt: recordedAt.toISOString(),
          generationMode: dependencies.generationMode,
        });
        return {
          jobId: job.runId,
          draftId: job.draftId,
          status: job.status,
          contactId: input.contactId,
          contactVersion: input.contactVersion,
          evidenceSnapshotId: evidenceSnapshot.snapshotId,
          requestSnapshotId: evidenceSnapshot.requestSnapshotId,
          workflowId: scheduled.workflowId,
          generationMode: dependencies.generationMode,
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
  if (result.state === "invalid_content") {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message:
        "Remove internal evidence metadata before approving this Draft.",
      fieldErrors: [{
        field: "bodyDocument",
        message:
          "Recipient-visible Draft content contains internal evidence metadata.",
      }],
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
      const bodyText = draftDocumentToPlainText(bodyDocument);
      const fieldErrors = [
        ...(containsInternalDraftMetadataMarker(input.subjectText)
          ? [{
              field: "subjectText",
              message:
                "Remove internal evidence metadata from the email subject.",
            }]
          : []),
        ...(containsInternalDraftMetadataMarker(bodyText)
          ? [{
              field: "bodyDocument",
              message:
                "Remove internal evidence metadata from the email body.",
            }]
          : []),
      ];
      if (fieldErrors.length > 0) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message:
            "Recipient-visible draft content cannot contain internal evidence metadata.",
          fieldErrors,
        });
      }
      return requireCompleted(
        await dependencies.repository.saveManualVersion({
          organizationId: input.context.tenant.organizationId,
          workspaceId: input.context.tenant.workspaceId,
          websiteProjectId: input.context.project.websiteProjectId,
          draftId: input.draftId,
          expectedVersion: input.expectedVersion,
          subjectText: input.subjectText,
          bodyText,
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
