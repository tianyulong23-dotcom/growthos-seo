import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type {
  ConfirmReplyMatchInput,
  ReplyMatchRepository,
  UnbindReplyMatchInput,
} from "../services/reply-match.repository.js";

type ConfirmReplyMatchCommand = Readonly<{
  context: ResolvedProjectContext;
  inboundMessageId: string;
  candidateId: string;
  expectedMatchStatus: "CANDIDATES_READY";
  requestId: string;
  reason: string;
}>;

type UnbindReplyMatchCommand = Readonly<{
  context: ResolvedProjectContext;
  inboundMessageId: string;
  expectedMatchStatus: "MATCH_CONFIRMED";
  requestId: string;
  reason: string;
}>;

const authorize = (context: ResolvedProjectContext): void => {
  if (!context.actor.roles.some((role) =>
    ["owner", "admin", "member"].includes(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Reply Match confirmation permission is required.",
    });
  }
};

const scope = (context: ResolvedProjectContext) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
});

export function createReplyMatchCommands(
  dependencies: Readonly<{ repository: ReplyMatchRepository }>,
) {
  return Object.freeze({
    async listCandidates(
      context: ResolvedProjectContext,
      inboundMessageId: string,
    ) {
      const result = await dependencies.repository.listCandidates({
        ...scope(context),
        inboundMessageId,
      });
      if (result.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Inbound Reply was not found in this project.",
        });
      }
      return result;
    },

    async confirm(input: ConfirmReplyMatchCommand) {
      authorize(input.context);
      const repositoryInput: ConfirmReplyMatchInput = {
        ...scope(input.context),
        inboundMessageId: input.inboundMessageId,
        candidateId: input.candidateId,
        expectedMatchStatus: input.expectedMatchStatus,
        actorId: input.context.actor.userId,
        requestId: input.requestId,
        reason: input.reason,
      };
      const result = await dependencies.repository.confirmCandidate(
        repositoryInput,
      );
      if (result.state === "confirmed") return result;
      if (result.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Reply Match candidate was not found in this project.",
        });
      }
      if (result.state === "conflict") {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message:
            "Reply Match candidate no longer has the expected confirmable state.",
        });
      }
      throw new Error("Reply Match confirmation returned an invalid state.");
    },

    async unbind(input: UnbindReplyMatchCommand) {
      authorize(input.context);
      const repositoryInput: UnbindReplyMatchInput = {
        ...scope(input.context),
        inboundMessageId: input.inboundMessageId,
        expectedMatchStatus: input.expectedMatchStatus,
        actorId: input.context.actor.userId,
        requestId: input.requestId,
        reason: input.reason,
      };
      const result = await dependencies.repository.unbindCandidate(
        repositoryInput,
      );
      if (result.state === "unbound") return result;
      if (result.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Inbound Reply was not found in this project.",
        });
      }
      if (result.state === "conflict") {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Reply Match no longer has the expected bound state.",
        });
      }
      throw new Error("Reply Match unbind returned an invalid state.");
    },
  });
}
