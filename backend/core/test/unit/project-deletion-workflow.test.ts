import { describe, expect, it } from "vitest";

import {
  createProjectDeletionWorkflow,
  type ProjectDeletionRun,
} from "../../src/modules/backlinks/application/workflows/project-deletion.workflow.js";

describe("BL-AI-174 resumable Project Deletion Workflow", () => {
  it("stops Jobs, revokes Tokens, batches deletes, and resumes from the persisted checkpoint", async () => {
    let run: ProjectDeletionRun = {
      id: "deletion-174",
      organizationId: "organization-174",
      workspaceId: "workspace-174",
      websiteProjectId: "project-174",
      phase: "requested",
      factCursor: null,
      objectCursor: null,
      version: 1,
      completedAt: null,
    };
    const calls: string[] = [];
    let interrupt = true;
    const workflow = createProjectDeletionWorkflow({
      repository: {
        get: async () => run,
        saveCheckpoint: async (input) => {
          run = {
            ...run,
            ...input.patch,
            version: run.version + 1,
          };
          return run;
        },
      },
      jobs: {
        stopProjectJobs: async () => {
          calls.push("stop-jobs");
        },
      },
      tokens: {
        revokeProjectTokens: async () => {
          calls.push("revoke-tokens");
        },
      },
      facts: {
        deleteBatch: async ({ cursor }) => {
          calls.push(`facts:${cursor ?? "start"}`);
          if (interrupt) {
            interrupt = false;
            throw new Error("simulated worker interruption");
          }
          return cursor === null
            ? { nextCursor: "facts-2", done: false }
            : { nextCursor: null, done: true };
        },
      },
      storage: {
        deleteBatch: async ({ cursor }) => {
          calls.push(`objects:${cursor ?? "start"}`);
          return { nextCursor: null, done: true };
        },
      },
      now: () => new Date("2026-07-29T05:00:00.000Z"),
    });

    await expect(workflow.resume("deletion-174")).rejects.toThrow(
      /interruption/i,
    );
    expect(run.phase).toBe("tokens_revoked");

    const completed = await workflow.resume("deletion-174");
    expect(completed).toMatchObject({
      phase: "completed",
      completedAt: new Date("2026-07-29T05:00:00.000Z"),
    });
    expect(calls).toEqual([
      "stop-jobs",
      "revoke-tokens",
      "facts:start",
      "facts:start",
      "facts:facts-2",
      "objects:start",
    ]);
  });
});
