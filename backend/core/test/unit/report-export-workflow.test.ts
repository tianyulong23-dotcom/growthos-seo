import { describe, expect, it } from "vitest";

import {
  createReportExportWorkflow,
  type ReportExportRecord,
  type ReportExportRepository,
} from "../../src/modules/backlinks/application/workflows/report-export.workflow.js";

const scope = {
  organizationId: "organization-169",
  workspaceId: "workspace-169",
  websiteProjectId: "project-169",
};

describe("BL-AI-169 asynchronous Report Export Workflow", () => {
  it("queues without rendering, stores a private object reference, and expires access", async () => {
    const records = new Map<string, ReportExportRecord>();
    let renderCalls = 0;
    const repository: ReportExportRepository = {
      create: async (record) => {
        records.set(record.id, record);
      },
      get: async (requestedScope, exportId) => {
        const record = records.get(exportId);
        return record?.websiteProjectId === requestedScope.websiteProjectId
          ? record
          : null;
      },
      claim: async (requestedScope, exportId) => {
        const record = records.get(exportId);
        if (
          record === undefined
          || record.websiteProjectId !== requestedScope.websiteProjectId
          || record.status !== "queued"
        ) {
          return null;
        }
        const running = { ...record, status: "running" as const };
        records.set(exportId, running);
        return running;
      },
      complete: async (input) => {
        const record = records.get(input.exportId);
        if (record === undefined) throw new Error("missing export");
        const completed: ReportExportRecord = {
          ...record,
          status: "completed",
          objectReference: input.objectReference,
          completedAt: input.completedAt,
          expiresAt: input.expiresAt,
          failureCode: null,
        };
        records.set(input.exportId, completed);
        return completed;
      },
      fail: async (input) => {
        const record = records.get(input.exportId);
        if (record === undefined) throw new Error("missing export");
        const failed: ReportExportRecord = {
          ...record,
          status: "failed",
          completedAt: input.failedAt,
          failureCode: input.failureCode,
        };
        records.set(input.exportId, failed);
        return failed;
      },
    };
    let currentTime = new Date("2026-07-29T01:00:00.000Z");
    const queued: string[] = [];
    const workflow = createReportExportWorkflow({
      repository,
      queue: {
        enqueue: async ({ exportId }) => {
          queued.push(exportId);
        },
      },
      renderers: {
        csv: {
          render: async () => {
            renderCalls += 1;
            return {
              body: Uint8Array.from([1, 2, 3]),
              contentType: "text/csv",
              filename: "weekly.csv",
            };
          },
        },
      },
      storage: {
        putPrivate: async () => ({
          objectKey: "backlinks/project-169/exports/export-169.csv",
          contentType: "text/csv",
          contentLength: 3,
          sha256: "a".repeat(64),
          storagePolicyVersion: "private-export.v1",
        }),
        authorizeDownload: async () => ({
          url: "https://objects.example/signed/export-169",
          expiresAt: new Date("2026-07-29T01:10:00.000Z"),
        }),
      },
      access: {
        canRead: ({ record, actorId }) =>
          record.requestedBy === actorId,
      },
      newId: () => "export-169",
      now: () => currentTime,
      expiryMilliseconds: 60 * 60 * 1000,
    });

    const requested = await workflow.request({
      scope,
      reportKey: "weekly-performance",
      reportRevisionId: "revision-169",
      format: "csv",
      requestedBy: "user-169",
      correlationId: "correlation-169",
    });

    expect(requested.status).toBe("queued");
    expect(queued).toEqual(["export-169"]);
    expect(renderCalls).toBe(0);

    const completed = await workflow.run({
      scope,
      exportId: "export-169",
    });
    expect(completed).toMatchObject({
      status: "completed",
      objectReference: {
        objectKey: "backlinks/project-169/exports/export-169.csv",
        storagePolicyVersion: "private-export.v1",
      },
      expiresAt: new Date("2026-07-29T02:00:00.000Z"),
    });
    expect(renderCalls).toBe(1);

    expect(await workflow.authorizeDownload({
      scope,
      exportId: "export-169",
      actorId: "user-169",
    })).toMatchObject({
      url: "https://objects.example/signed/export-169",
    });
    await expect(workflow.authorizeDownload({
      scope,
      exportId: "export-169",
      actorId: "foreign-user",
    })).rejects.toMatchObject({ code: "BACKLINK_ACCESS_DENIED" });

    currentTime = new Date("2026-07-29T02:00:00.000Z");
    expect(await workflow.get({
      scope,
      exportId: "export-169",
      actorId: "user-169",
    })).toMatchObject({ status: "expired" });
    await expect(workflow.authorizeDownload({
      scope,
      exportId: "export-169",
      actorId: "user-169",
    })).rejects.toMatchObject({ code: "BACKLINK_NOT_FOUND" });
  });
});
