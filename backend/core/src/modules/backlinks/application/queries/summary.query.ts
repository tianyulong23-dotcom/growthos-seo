import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type EmptyBacklinkSummary = Readonly<Record<string, never>>;

export type SummaryQuery = Readonly<{
  getSummary(
    context: ResolvedProjectContext,
  ): Promise<EmptyBacklinkSummary>;
}>;

const emptySummary: EmptyBacklinkSummary = Object.freeze({});

export function createEmptySummaryQuery(): SummaryQuery {
  return Object.freeze({
    getSummary: async () => emptySummary,
  });
}
