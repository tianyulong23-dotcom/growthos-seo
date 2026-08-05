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

export interface ProjectContextPort {
  resolve(
    request: ResolveProjectContextRequest,
  ): Promise<ResolvedProjectContext>;
}
