import { describe, expect, it } from "vitest";

import {
  runReportRevisionWorkflow,
  type ReportRevision,
  type ReportRevisionStore,
} from "../../src/modules/backlinks/application/workflows/report-revision.workflow.js";

const scope = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
};
const existing: ReportRevision = {
  id: "018f0000-0000-7000-8000-000000000201",
  ...scope,
  reportKey: "weekly-performance",
  revision: 1,
  inputSnapshotIds: [
    "018f0000-0000-7000-8000-000000000101",
  ],
  metricDefinitionVersions: { send_count: "send_count.v1" },
  querySpec: { grain: "day" },
  payload: { title: "Previous report" },
  sourceStartedAt: new Date("2026-07-21T00:00:00.000Z"),
  sourceEndedAt: new Date("2026-07-28T00:00:00.000Z"),
  sourceWatermarkAt: new Date("2026-07-28T00:00:00.000Z"),
  sourceWatermarkId: "fact-1",
  inputChecksum: "a".repeat(64),
  resultChecksum: "b".repeat(64),
  generatedAt: new Date("2026-07-28T01:00:00.000Z"),
  createdBy: "report-worker",
};

function createStore(): ReportRevisionStore & {
  readonly publications: ReportRevision[];
} {
  const publications = [existing];
  return {
    publications,
    loadSnapshots: async () => [{
      id: "018f0000-0000-7000-8000-000000000102",
      ...scope,
      metricKey: "send_count",
      metricDefinitionVersion: "send_count.v1",
      sourceStartedAt: new Date("2026-07-28T00:00:00.000Z"),
      sourceEndedAt: new Date("2026-07-29T00:00:00.000Z"),
      sourceWatermarkAt: new Date("2026-07-29T00:00:00.000Z"),
      sourceWatermarkId: "fact-2",
      resultChecksum: "c".repeat(64),
      value: 3,
    }],
    getPublished: async () => publications.at(-1) ?? null,
    publish: async (revision) => {
      publications.push(revision);
      return revision;
    },
  };
}

describe("BL-AI-165 Report Revision workflow", () => {
  it("does not replace the last published report when generation fails", async () => {
    const store = createStore();

    await expect(runReportRevisionWorkflow({
      scope,
      reportKey: "weekly-performance",
      inputSnapshotIds: [
        "018f0000-0000-7000-8000-000000000102",
      ],
      querySpec: { grain: "day" },
      createdBy: "report-worker",
    }, {
      store,
      generator: {
        generate: async () => {
          throw new Error("template failed");
        },
      },
      newId: () => "018f0000-0000-7000-8000-000000000202",
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    })).rejects.toThrow("template failed");

    expect(store.publications).toEqual([existing]);
  });

  it("publishes an immutable next revision with explicit Snapshot inputs", async () => {
    const store = createStore();

    const revision = await runReportRevisionWorkflow({
      scope,
      reportKey: "weekly-performance",
      inputSnapshotIds: [
        "018f0000-0000-7000-8000-000000000102",
      ],
      querySpec: { grain: "day", timezone: "Asia/Shanghai" },
      createdBy: "report-worker",
    }, {
      store,
      generator: {
        generate: async ({ snapshots }) => ({
          title: "Weekly performance",
          metrics: snapshots.map(({ metricKey, value }) => ({
            metricKey,
            value,
          })),
        }),
      },
      newId: () => "018f0000-0000-7000-8000-000000000202",
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    });

    expect(revision).toMatchObject({
      id: "018f0000-0000-7000-8000-000000000202",
      reportKey: "weekly-performance",
      revision: 2,
      inputSnapshotIds: [
        "018f0000-0000-7000-8000-000000000102",
      ],
      metricDefinitionVersions: { send_count: "send_count.v1" },
      payload: {
        title: "Weekly performance",
        metrics: [{ metricKey: "send_count", value: 3 }],
      },
      sourceWatermarkId: "fact-2",
    });
    expect(revision.inputChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(revision.resultChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.publications).toHaveLength(2);
  });
});
