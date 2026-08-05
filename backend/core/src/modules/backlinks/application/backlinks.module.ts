import type { ProjectContextPort } from "../ports/project-context.port.js";

export type BacklinksModule<TQueries extends object = object> = Readonly<{
  projectContext: ProjectContextPort;
  queries: Readonly<TQueries>;
}>;

export function createBacklinksModule<TQueries extends object>(
  dependencies: Readonly<{
    projectContext: ProjectContextPort;
    queries: TQueries;
  }>,
): BacklinksModule<TQueries> {
  return Object.freeze({
    projectContext: dependencies.projectContext,
    queries: dependencies.queries,
  });
}
