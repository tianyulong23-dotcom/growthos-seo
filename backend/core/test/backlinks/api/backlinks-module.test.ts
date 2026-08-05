import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  createBacklinksModule,
  type BacklinksModule,
} from "../../../src/modules/backlinks/application/backlinks.module.js";
import type {
  ProjectContextPort,
  ResolvedProjectContext,
} from "../../../src/modules/backlinks/ports/project-context.port.js";

const resolvedContext: ResolvedProjectContext = {
  actor: createActorContext({
    userId: "user-1",
    sessionId: "session-1",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: "org-1",
    workspaceId: "workspace-1",
  }),
  project: createProjectContext({
    websiteProjectId: "project-1",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-version-1",
    promotionTargetVersionId: "target-version-1",
  }),
};

describe("BacklinksModule", () => {
  it("is constructed from fake ports and queries only", async () => {
    const projectContext: ProjectContextPort = {
      resolve: async () => resolvedContext,
    };
    const queries = {
      getProjectId: (context: ResolvedProjectContext) =>
        context.project.websiteProjectId,
    };

    const module = createBacklinksModule({ projectContext, queries });

    expect(Object.keys(module)).toEqual(["projectContext", "queries"]);
    expect(Object.isFrozen(module)).toBe(true);
    expect(module.projectContext).toBe(projectContext);
    expect(module.queries).toBe(queries);
    await expect(
      module.projectContext.resolve({
        actor: resolvedContext.actor,
        websiteProjectKey: "project-key",
      }),
    ).resolves.toBe(resolvedContext);
    expect(module.queries.getProjectId(resolvedContext)).toBe("project-1");
  });

  it("preserves the concrete query contract", () => {
    const projectContext: ProjectContextPort = {
      resolve: async () => resolvedContext,
    };
    const queries = { count: () => 0 };
    const module: BacklinksModule<typeof queries> = createBacklinksModule({
      projectContext,
      queries,
    });

    expectTypeOf(module.projectContext).toEqualTypeOf<ProjectContextPort>();
    expectTypeOf(module.queries).toEqualTypeOf<Readonly<typeof queries>>();
  });
});
