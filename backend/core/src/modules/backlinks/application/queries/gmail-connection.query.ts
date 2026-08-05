import type {
  GmailConnectionReader,
  GmailConnectionView,
} from "../gmail-connection.gateway.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

type GmailConnectionQueryDependencies = Readonly<{
  reader: GmailConnectionReader;
}>;

const connectionRoles = new Set(["owner", "admin", "member"]);

function authorize(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) => connectionRoles.has(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Gmail connection permission is required.",
    });
  }
}

export function createGmailConnectionQuery(
  dependencies: GmailConnectionQueryDependencies,
) {
  return {
    async getStatus(
      context: ResolvedProjectContext,
    ): Promise<GmailConnectionView | null> {
      authorize(context);
      return dependencies.reader.findVisibleConnection(context);
    },
  };
}
