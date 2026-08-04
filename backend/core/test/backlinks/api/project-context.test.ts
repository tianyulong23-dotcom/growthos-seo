import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createActorContext,
  createProjectContext,
  createTenantContext,
  type ActorContext,
  type ProjectContext,
  type TenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import type {
  ProjectContextPort,
  ResolvedProjectContext,
} from "../../../src/modules/backlinks/ports/project-context.port.js";

const actor = createActorContext({
  userId: "user-1",
  sessionId: "session-1",
  roles: ["member"],
});
const tenant = createTenantContext({
  organizationId: "org-1",
  workspaceId: "workspace-1",
});
const project = createProjectContext({
  websiteProjectId: "project-1",
  canonicalDomain: "example.com",
  locale: "en-US",
  countryCode: "US",
  profileVersionId: "profile-version-1",
  promotionTargetVersionId: "target-version-1",
});

describe("backlinks request contexts", () => {
  it("exposes the locked read-only context types", () => {
    expectTypeOf<ActorContext>().toEqualTypeOf<{
      readonly userId: string;
      readonly sessionId: string;
      readonly roles: readonly string[];
    }>();
    expectTypeOf<TenantContext>().toEqualTypeOf<{
      readonly organizationId: string;
      readonly workspaceId: string;
    }>();
    expectTypeOf<ProjectContext>().toEqualTypeOf<{
      readonly websiteProjectId: string;
      readonly canonicalDomain: string;
      readonly locale: string;
      readonly countryCode: string;
      readonly profileVersionId: string;
      readonly promotionTargetVersionId: string;
    }>();
  });

  it("supports a read-only ProjectContextPort resolver", async () => {
    const resolved: ResolvedProjectContext = { actor, tenant, project };
    const port: ProjectContextPort = {
      resolve: async ({ websiteProjectKey }) => {
        expect(websiteProjectKey).toBe("project-key");
        return resolved;
      },
    };

    await expect(
      port.resolve({ actor, websiteProjectKey: "project-key" }),
    ).resolves.toEqual(resolved);
    expect(Object.keys(port)).toEqual(["resolve"]);
  });

  it.each([
    ["actor user", () => createActorContext({ ...actor, userId: "" })],
    ["actor session", () => createActorContext({ ...actor, sessionId: " " })],
    [
      "tenant organization",
      () => createTenantContext({ ...tenant, organizationId: "" }),
    ],
    [
      "tenant workspace",
      () => createTenantContext({ ...tenant, workspaceId: " " }),
    ],
    [
      "project",
      () => createProjectContext({ ...project, websiteProjectId: "" }),
    ],
    [
      "profile version",
      () => createProjectContext({ ...project, profileVersionId: " " }),
    ],
    [
      "promotion target version",
      () =>
        createProjectContext({ ...project, promotionTargetVersionId: "" }),
    ],
  ])("rejects an empty %s ID", (_name, createContext) => {
    expect(createContext).toThrow(TypeError);
  });
});
