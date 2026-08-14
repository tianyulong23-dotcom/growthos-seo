import { describe, expect, it, vi } from "vitest";

import {
  runProjectScopedLane,
} from "../../src/modules/backlinks/application/services/project-scope-scheduler.js";
import type {
  ActiveProjectScope,
  ProjectScopeProvider,
} from "../../src/modules/backlinks/ports/project-scope-provider.port.js";

const organizationId = "10000000-0000-4000-8000-000000000014";
const workspaceId = "20000000-0000-4000-8000-000000000014";

function scope(sequence: number): ActiveProjectScope {
  const suffix = String(sequence).padStart(12, "0");
  return {
    organizationId,
    workspaceId,
    websiteProjectId: `30000000-0000-4000-8000-${suffix}`,
    projectContextSnapshotId: `40000000-0000-4000-8000-${suffix}`,
    projectContextSnapshotVersion: 1,
  };
}

describe("project scope scheduler", () => {
  it("pages deterministically and isolates one project failure", async () => {
    const firstScope = scope(1);
    const secondScope = scope(2);
    const thirdScope = scope(3);
    const scopes = [firstScope, secondScope, thirdScope];
    const listActiveProjectScopes = vi.fn<
      ProjectScopeProvider["listActiveProjectScopes"]
    >(async (input) => {
      if (input.cursor === null) {
        return {
          scopes: [firstScope, secondScope],
          nextCursor: secondScope.websiteProjectId,
        };
      }
      return { scopes: [thirdScope], nextCursor: null };
    });
    const visited: string[] = [];
    const failures: string[] = [];

    await expect(runProjectScopedLane({
      provider: { listActiveProjectScopes },
      organizationId,
      workspaceId,
      lane: "contact-enrichment",
      pageLimit: 2,
      async run(projectScope) {
        visited.push(projectScope.websiteProjectId);
        if (projectScope.websiteProjectId === secondScope.websiteProjectId) {
          throw new Error("PROJECT_TWO_FAILED");
        }
      },
      onProjectError(projectScope) {
        failures.push(projectScope.websiteProjectId);
      },
    })).resolves.toEqual({ visited: 3, completed: 2, failed: 1 });

    expect(visited).toEqual(scopes.map(({ websiteProjectId }) => websiteProjectId));
    expect(failures).toEqual([secondScope.websiteProjectId]);
    expect(listActiveProjectScopes).toHaveBeenNthCalledWith(1, {
      organizationId,
      workspaceId,
      lane: "contact-enrichment",
      cursor: null,
      limit: 2,
    });
    expect(listActiveProjectScopes).toHaveBeenNthCalledWith(2, {
      organizationId,
      workspaceId,
      lane: "contact-enrichment",
      cursor: secondScope.websiteProjectId,
      limit: 2,
    });
  });

  it("rejects a repeated provider cursor", async () => {
    const projectScope = scope(1);
    const provider: ProjectScopeProvider = {
      async listActiveProjectScopes() {
        return {
          scopes: [projectScope],
          nextCursor: projectScope.websiteProjectId,
        };
      },
    };

    await expect(runProjectScopedLane({
      provider,
      organizationId,
      workspaceId,
      lane: "placement-monitoring",
      pageLimit: 1,
      run: async () => undefined,
    })).rejects.toThrow("BACKLINK_PROJECT_SCOPE_CURSOR_REPEATED");
  });
});
