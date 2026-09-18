import type {
  ActorContext,
  ProjectContext,
  TenantContext,
} from "../domain/context/index.js";

export type ResolveProjectContextRequest = Readonly<{
  actor: ActorContext;
  websiteProjectKey: string;
}>;

export type ResolvedProjectContext = Readonly<{
  actor: ActorContext;
  tenant: TenantContext;
  project: ProjectContext;
}>;

// Mailbox ownership does not require recommendation or promotion metadata.
export type ResolvedMailboxContext = Readonly<{
  actor: ActorContext;
  tenant: TenantContext;
  project: Pick<ProjectContext, "websiteProjectId">;
}>;

export interface ProjectContextPort {
  resolve(
    request: ResolveProjectContextRequest,
  ): Promise<ResolvedProjectContext>;
}
