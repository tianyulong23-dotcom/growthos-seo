import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  plainTextToDraftDocument,
} from "../../domain/drafts/draft-document.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  DraftGenerationJob,
  DraftGenerationRepository,
  DraftInputSnapshot,
} from "../repositories/draft-generation.repository.js";
import type {
  DraftFreshness,
} from "../read-models/draft-freshness.js";
import { draftDocumentSchema } from "../schemas/draft-document.schema.js";
import type { DraftRequest } from "../schemas/draft-request.schema.js";

const draftJobDeadlineMs = 60_000;

type DraftJobView = Readonly<{
  id: string;
  draftId: string;
  status:
    | "QUEUED"
    | "RUNNING"
    | "RETRY_SCHEDULED"
    | "SUCCEEDED"
    | "FAILED"
    | "REFUSED";
  contactId: string | null;
  contactVersion: number | null;
  requestSnapshotId: string | null;
  request: DraftRequest | null;
  generator: "AI" | "TEMPLATE_FALLBACK" | null;
  versionId: string | null;
  lastSuccessfulVersionId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string;
  queueWaitMs: number | null;
  latencyMs: number | null;
  persistenceLatencyMs: number | null;
  attemptCount: number;
  lastErrorCategory: string | null;
  diagnosticCode: string | null;
  readiness:
    | "QUEUED"
    | "GENERATING"
    | "RETRYING"
    | "AI_DRAFT_READY"
    | "BASIC_DRAFT_READY"
    | "POLICY_BLOCKED"
    | "BUDGET_BLOCKED"
    | "FAILED";
  fallbackReason: string | null;
}>;

export type DraftQuery = Readonly<{
  getJob(
    context: ResolvedProjectContext,
    runId: string,
  ): Promise<DraftJobView>;
  findLatestJob(
    context: ResolvedProjectContext,
    opportunityId: string,
    logicalDraftKey: string,
  ): Promise<DraftJobView | null>;
  getDraft(
    context: ResolvedProjectContext,
    draftId: string,
  ): Promise<Readonly<{
    id: string;
    opportunityId: string;
    contactId: string | null;
    contactVersion: number | null;
    status: "generating" | "draft" | "approved" | "rejected" | "sent";
    draftVersion: number;
    approvedVersionId: string | null;
    inputSnapshot: DraftInputSnapshot | null;
    freshness: DraftFreshness;
    currentVersion: Readonly<{
      id: string;
      versionNo: number;
      subjectText: string;
      bodyText: string;
      bodyDocument: ReturnType<typeof draftDocumentSchema.parse>;
      source: "MODEL" | "TEMPLATE_FALLBACK" | "MANUAL" | "RESTORED";
      readiness:
        | "AI_DRAFT_READY"
        | "BASIC_DRAFT_READY"
        | "EDITED_DRAFT_READY";
      fallbackReason: string | null;
      createdAt: string;
    }> | null;
  }>>;
}>;

const toJobView = (job: DraftGenerationJob): DraftJobView => ({
  id: job.runId,
  draftId: job.draftId,
  status: job.status,
  contactId: job.contactId,
  contactVersion: job.contactVersion,
  requestSnapshotId: job.requestSnapshotId,
  request: job.request,
  generator: job.generator,
  versionId: job.versionId,
  lastSuccessfulVersionId: job.lastSuccessfulVersionId,
  queuedAt: job.queuedAt.toISOString(),
  startedAt: job.startedAt?.toISOString() ?? null,
  finishedAt: job.finishedAt?.toISOString() ?? null,
  deadlineAt: new Date(
    job.queuedAt.getTime() + draftJobDeadlineMs,
  ).toISOString(),
  queueWaitMs: job.startedAt === null
    ? null
    : Math.max(0, job.startedAt.getTime() - job.queuedAt.getTime()),
  latencyMs: job.latencyMs,
  persistenceLatencyMs: job.persistenceLatencyMs,
  attemptCount: job.attemptCount,
  lastErrorCategory: job.lastErrorCategory,
  diagnosticCode: job.diagnosticCode,
  readiness: job.readiness,
  fallbackReason: job.fallbackReason,
});

export function createDraftQuery(
  repository: Pick<
    DraftGenerationRepository,
    "getJob" | "findLatestJob" | "getDraft"
  >,
): DraftQuery {
  return Object.freeze({
    async getJob(context, runId) {
      try {
        const job = await repository.getJob({
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          runId,
        });
        return toJobView(job);
      } catch {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Draft generation Job was not found in this project.",
        });
      }
    },
    async findLatestJob(context, opportunityId, logicalDraftKey) {
      const job = await repository.findLatestJob({
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        opportunityId,
        logicalDraftKey,
      });
      return job === null ? null : toJobView(job);
    },
    async getDraft(context, draftId) {
      let draft;
      try {
        draft = await repository.getDraft({
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          draftId,
        });
      } catch {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Draft was not found in this project.",
        });
      }
      return {
        id: draft.draftId,
        opportunityId: draft.opportunityId,
        contactId: draft.contactId,
        contactVersion: draft.contactVersion,
        status: draft.status,
        draftVersion: draft.draftVersion,
        approvedVersionId: draft.approvedVersionId,
        inputSnapshot: draft.inputSnapshot ?? null,
        freshness: draft.freshness ?? {
          state: "UNKNOWN",
          staleReasons: [],
          unknownReason: "SNAPSHOT_CONTEXT_INCOMPLETE",
          regenerateRequired: false,
          manualEditsPreserved: true,
        },
        currentVersion: draft.currentVersion === null
          ? null
          : {
              ...draft.currentVersion,
              bodyDocument: draft.currentVersion.bodyDocument === null
                ? plainTextToDraftDocument(draft.currentVersion.bodyText)
                : draftDocumentSchema.parse(
                    draft.currentVersion.bodyDocument,
                  ),
            },
      };
    },
  });
}
