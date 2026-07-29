import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  plainTextToDraftDocument,
} from "../../domain/drafts/draft-document.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  DraftGenerationRepository,
} from "../repositories/draft-generation.repository.js";
import { draftDocumentSchema } from "../schemas/draft-document.schema.js";

export type DraftQuery = Readonly<{
  getJob(
    context: ResolvedProjectContext,
    runId: string,
  ): Promise<Readonly<{
    id: string;
    draftId: string;
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "REFUSED";
    versionId: string | null;
    lastSuccessfulVersionId: string | null;
  }>>;
  getDraft(
    context: ResolvedProjectContext,
    draftId: string,
  ): Promise<Readonly<{
    id: string;
    opportunityId: string;
    status: "generating" | "draft" | "approved" | "rejected" | "sent";
    draftVersion: number;
    approvedVersionId: string | null;
    currentVersion: Readonly<{
      id: string;
      versionNo: number;
      subjectText: string;
      bodyText: string;
      bodyDocument: ReturnType<typeof draftDocumentSchema.parse>;
      source: "MODEL" | "MANUAL" | "RESTORED";
      createdAt: string;
    }> | null;
  }>>;
}>;

export function createDraftQuery(
  repository: Pick<DraftGenerationRepository, "getJob" | "getDraft">,
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
        return {
          id: job.runId,
          draftId: job.draftId,
          status: job.status,
          versionId: job.versionId,
          lastSuccessfulVersionId: job.lastSuccessfulVersionId,
        };
      } catch {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Draft generation Job was not found in this project.",
        });
      }
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
        status: draft.status,
        draftVersion: draft.draftVersion,
        approvedVersionId: draft.approvedVersionId,
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
