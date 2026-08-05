import { describe, expect, it } from "vitest";

import {
  buildMetricSnapshot,
  type MetricSnapshot,
  type MetricSnapshotStore,
} from "../../src/modules/backlinks/application/services/metric-snapshot-builder.js";
import {
  backlinkMetricDefinitions,
} from "../../src/modules/backlinks/domain/metrics/definitions.js";

const scope = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
};
const sendDefinition = backlinkMetricDefinitions.find(
  ({ metricKey }) => metricKey === "send_count",
);
const gainedDefinition = backlinkMetricDefinitions.find(
  ({ metricKey }) => metricKey === "gained_placement_count",
);

function createStore(): MetricSnapshotStore & {
  readonly snapshots: MetricSnapshot[];
} {
  const snapshots: MetricSnapshot[] = [];
  return {
    snapshots,
    findLatest: async () => snapshots.at(-1) ?? null,
    append: async (snapshot) => {
      snapshots.push(snapshot);
    },
  };
}

describe("BL-AI-163 Metric Snapshot Builder", () => {
  it("replays deterministically and appends a new version for a late fact", async () => {
    if (sendDefinition === undefined) {
      throw new Error("send_count definition is required.");
    }
    const store = createStore();
    const generatedIds = [
      "018f0000-0000-7000-8000-000000000101",
      "018f0000-0000-7000-8000-000000000102",
    ];
    const facts = [{
      factId: "send-attempt-1",
      sourceName: "backlink_send_attempts",
      contractVersion: "migration-0024",
      occurredAt: new Date("2026-07-28T01:00:00.000Z"),
      payload: { sendIntentId: "send-1", status: "PROVIDER_ACCEPTED" },
    }] as const;
    const input = {
      scope,
      definition: sendDefinition,
      window: {
        start: new Date("2026-07-28T00:00:00.000Z"),
        end: new Date("2026-07-29T00:00:00.000Z"),
        asOf: new Date("2026-07-29T01:00:00.000Z"),
      },
      workspaceTimezone: "Asia/Shanghai",
      dimensions: { market: "CN" },
      facts,
      createdBy: "metrics-worker",
    } as const;
    const dependencies = {
      store,
      newId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => new Date("2026-07-29T02:00:00.000Z"),
      evaluate: ({ facts: sourceFacts }: { facts: typeof facts }) => {
        const sends = new Set(
          sourceFacts.map(({ payload }) => String(payload.sendIntentId)),
        );
        return {
          numerator: sends.size,
          denominator: null,
          value: sends.size,
        };
      },
    };

    const first = await buildMetricSnapshot(input, dependencies);
    const replay = await buildMetricSnapshot(input, dependencies);
    const late = await buildMetricSnapshot({
      ...input,
      facts: [
        ...facts,
        {
          factId: "send-attempt-late",
          sourceName: "backlink_send_attempts",
          contractVersion: "migration-0024",
          occurredAt: new Date("2026-07-28T00:30:00.000Z"),
          payload: {
            sendIntentId: "send-2",
            status: "PROVIDER_ACCEPTED",
          },
        },
      ],
    }, {
      ...dependencies,
      evaluate: ({ facts: sourceFacts }) => {
        const sends = new Set(
          sourceFacts.map(({ payload }) => String(payload.sendIntentId)),
        );
        return {
          numerator: sends.size,
          denominator: null,
          value: sends.size,
        };
      },
    });

    expect(first).toMatchObject({
      status: "created",
      snapshot: {
        snapshotVersion: 1,
        metricKey: "send_count",
        metricDefinitionVersion: "send_count.v1",
        workspaceTimezone: "Asia/Shanghai",
        numerator: 1,
        denominator: null,
        value: 1,
        sourceFactCount: 1,
        sourceFactIds: ["send-attempt-1"],
      },
    });
    expect(replay).toEqual({
      status: "unchanged",
      snapshot: first.snapshot,
    });
    expect(late).toMatchObject({
      status: "created",
      snapshot: {
        snapshotVersion: 2,
        numerator: 2,
        sourceFactCount: 2,
        sourceFactIds: ["send-attempt-late", "send-attempt-1"],
        sourceStartedAt: new Date("2026-07-28T00:30:00.000Z"),
      },
    });
    expect(store.snapshots).toHaveLength(2);
    expect(late.snapshot.inputChecksum).not.toBe(first.snapshot.inputChecksum);
  });

  it("rejects mutable Placement Candidate input for a success KPI", async () => {
    if (gainedDefinition === undefined) {
      throw new Error("gained_placement_count definition is required.");
    }
    const store = createStore();

    await expect(buildMetricSnapshot({
      scope,
      definition: gainedDefinition,
      window: {
        start: new Date("2026-07-28T00:00:00.000Z"),
        end: new Date("2026-07-29T00:00:00.000Z"),
        asOf: new Date("2026-07-29T01:00:00.000Z"),
      },
      workspaceTimezone: "UTC",
      dimensions: {},
      facts: [{
        factId: "candidate-1",
        sourceName: "backlink_placement_candidates",
        contractVersion: "migration-0028",
        occurredAt: new Date("2026-07-28T02:00:00.000Z"),
        payload: { candidateId: "candidate-1" },
      }],
      createdBy: "metrics-worker",
    }, {
      store,
      newId: () => "018f0000-0000-7000-8000-000000000103",
      now: () => new Date("2026-07-29T02:00:00.000Z"),
      evaluate: () => ({ numerator: 1, denominator: null, value: 1 }),
    })).rejects.toThrow(/candidate/i);
    expect(store.snapshots).toEqual([]);
  });
});
