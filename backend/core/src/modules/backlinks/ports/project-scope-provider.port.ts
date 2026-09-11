import type {
  BacklinkTenantContext,
} from "../db/tenant-transaction.js";

export const projectScopeLanes = [
  "project-analysis",
  "recommendation-refill",
  "recommendation-pool-v2",
  "contact-enrichment",
  "draft-generation",
  "gmail-sync",
  "backlink-profile",
  "placement-monitoring",
] as const;

export type ProjectScopeLane = (typeof projectScopeLanes)[number];

export type ActiveProjectScope = BacklinkTenantContext & Readonly<{
  projectContextSnapshotId: string;
  projectContextSnapshotVersion: number;
}>;

export type ProjectScopePage = Readonly<{
  scopes: readonly ActiveProjectScope[];
  nextCursor: string | null;
}>;

export type ProjectScopeProvider = Readonly<{
  listActiveProjectScopes(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    lane: ProjectScopeLane;
    cursor: string | null;
    limit: number;
  }>): Promise<ProjectScopePage>;
}>;
