import type {
  ActiveProjectScope,
  ProjectScopeLane,
  ProjectScopeProvider,
} from "../../ports/project-scope-provider.port.js";

export type ProjectScopeScheduleOutcome = Readonly<{
  visited: number;
  completed: number;
  failed: number;
}>;

export async function runProjectScopedLane(options: Readonly<{
  provider: ProjectScopeProvider;
  organizationId: string;
  workspaceId: string;
  lane: ProjectScopeLane;
  pageLimit: number;
  run(scope: ActiveProjectScope): Promise<void>;
  onProjectError?(
    scope: ActiveProjectScope,
    error: unknown,
  ): void | Promise<void>;
}>): Promise<ProjectScopeScheduleOutcome> {
  let cursor: string | null = null;
  let visited = 0;
  let completed = 0;
  let failed = 0;
  const seenCursors = new Set<string>();

  do {
    const page = await options.provider.listActiveProjectScopes({
      organizationId: options.organizationId,
      workspaceId: options.workspaceId,
      lane: options.lane,
      cursor,
      limit: options.pageLimit,
    });
    for (const scope of page.scopes) {
      visited += 1;
      try {
        await options.run(scope);
        completed += 1;
      } catch (error) {
        failed += 1;
        await options.onProjectError?.(scope, error);
      }
    }
    if (page.nextCursor === null) break;
    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      throw new Error("BACKLINK_PROJECT_SCOPE_CURSOR_REPEATED");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);

  return Object.freeze({ visited, completed, failed });
}
