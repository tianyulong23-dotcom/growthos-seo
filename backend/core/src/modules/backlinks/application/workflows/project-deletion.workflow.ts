export type ProjectDeletionPhase =
  | "requested"
  | "jobs_stopped"
  | "tokens_revoked"
  | "facts_deleting"
  | "objects_deleting"
  | "completed";

export type ProjectDeletionRun = Readonly<{
  id: string;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  phase: ProjectDeletionPhase;
  factCursor: string | null;
  objectCursor: string | null;
  version: number;
  completedAt: Date | null;
}>;

type BatchResult = Readonly<{
  nextCursor: string | null;
  done: boolean;
}>;

export function createProjectDeletionWorkflow(dependencies: Readonly<{
  repository: Readonly<{
    get(deletionId: string): Promise<ProjectDeletionRun | null>;
    saveCheckpoint(input: Readonly<{
      deletionId: string;
      expectedVersion: number;
      patch: Partial<Omit<ProjectDeletionRun, "id" | "version">>;
    }>): Promise<ProjectDeletionRun>;
  }>;
  jobs: Readonly<{
    stopProjectJobs(run: ProjectDeletionRun): Promise<void>;
  }>;
  tokens: Readonly<{
    revokeProjectTokens(run: ProjectDeletionRun): Promise<void>;
  }>;
  facts: Readonly<{
    deleteBatch(input: Readonly<{
      run: ProjectDeletionRun;
      cursor: string | null;
    }>): Promise<BatchResult>;
  }>;
  storage: Readonly<{
    deleteBatch(input: Readonly<{
      run: ProjectDeletionRun;
      cursor: string | null;
    }>): Promise<BatchResult>;
  }>;
  now(): Date;
}>) {
  const save = (
    run: ProjectDeletionRun,
    patch: Partial<Omit<ProjectDeletionRun, "id" | "version">>,
  ) => dependencies.repository.saveCheckpoint({
    deletionId: run.id,
    expectedVersion: run.version,
    patch,
  });

  return {
    async resume(deletionId: string): Promise<ProjectDeletionRun> {
      let run = await dependencies.repository.get(deletionId);
      if (run === null) {
        throw new Error("Project deletion run was not found.");
      }
      if (run.phase === "completed") {
        return run;
      }
      if (run.phase === "requested") {
        await dependencies.jobs.stopProjectJobs(run);
        run = await save(run, { phase: "jobs_stopped" });
      }
      if (run.phase === "jobs_stopped") {
        await dependencies.tokens.revokeProjectTokens(run);
        run = await save(run, { phase: "tokens_revoked" });
      }
      if (run.phase === "tokens_revoked" || run.phase === "facts_deleting") {
        let cursor = run.factCursor;
        for (;;) {
          const batch = await dependencies.facts.deleteBatch({ run, cursor });
          if (batch.done) {
            run = await save(run, {
              phase: "objects_deleting",
              factCursor: null,
            });
            break;
          }
          cursor = batch.nextCursor;
          run = await save(run, {
            phase: "facts_deleting",
            factCursor: cursor,
          });
        }
      }
      if (run.phase === "objects_deleting") {
        let cursor = run.objectCursor;
        for (;;) {
          const batch = await dependencies.storage.deleteBatch({ run, cursor });
          if (batch.done) {
            return save(run, {
              phase: "completed",
              objectCursor: null,
              completedAt: dependencies.now(),
            });
          }
          cursor = batch.nextCursor;
          run = await save(run, { objectCursor: cursor });
        }
      }
      return run;
    },
  };
}
