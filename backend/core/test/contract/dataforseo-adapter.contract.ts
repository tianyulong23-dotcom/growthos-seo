import { describe, expect, it } from "vitest";

import type {
  BacklinkProviderSnapshot,
  BacklinkSnapshotRequest,
  DataForSeoPort,
  ProviderRequestContext,
} from "../../src/modules/backlinks/ports/dataforseo.port.js";

export type DataForSeoContractOutcome =
  | "success"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "malformed";

type ContractCall = Readonly<{
  context: ProviderRequestContext;
  request: BacklinkSnapshotRequest;
}>;

type ContractSubject = Readonly<{
  port: DataForSeoPort;
  calls: () => readonly ContractCall[];
}>;

export type DataForSeoContractHarness = Readonly<{
  create: (
    outcome: DataForSeoContractOutcome,
    snapshot: BacklinkProviderSnapshot,
  ) => ContractSubject;
  classifyFailure: (error: unknown) =>
    | Readonly<{
        outcome: Exclude<DataForSeoContractOutcome, "success">;
        statusCode: number | undefined;
      }>
    | undefined;
}>;

const context: ProviderRequestContext = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  requestId: "request-1",
  idempotencyKey: "analysis:project-1:profile-1",
  budgetReservationId: "reservation-1",
};

const request: BacklinkSnapshotRequest = {
  target: "example.com",
  targetType: "domain",
  limit: 100,
};

const snapshot: BacklinkProviderSnapshot = {
  provider: "dataforseo",
  schemaVersion: "backlinks.v1",
  requestedAt: "2026-07-22T08:00:00.000Z",
  completedAt: "2026-07-22T08:00:01.000Z",
  costMicros: 20_000,
  payloadHash: "a".repeat(64),
  referringDomains: [
    {
      domain: "publisher.example",
      backlinkCount: 3,
      rank: 72,
      spamScore: 4,
      countryCode: "US",
    },
  ],
};

export function describeDataForSeoPortContract(
  name: string,
  harness: DataForSeoContractHarness,
): void {
  describe(name, () => {
    it("returns the normalized snapshot and records one call", async () => {
      const subject = harness.create("success", snapshot);

      await expect(
        subject.port.fetchBacklinkSnapshot(context, request),
      ).resolves.toEqual(snapshot);
      expect(subject.calls()).toEqual([{ context, request }]);
    });

    it.each([
      ["rate_limited", 429],
      ["server_error", 503],
      ["timeout", undefined],
      ["malformed", undefined],
    ] as const)("exposes the %s failure without retrying", async (outcome, statusCode) => {
      const subject = harness.create(outcome, snapshot);
      let failure: unknown;

      try {
        await subject.port.fetchBacklinkSnapshot(context, request);
      } catch (error) {
        failure = error;
      }

      expect(harness.classifyFailure(failure)).toEqual({ outcome, statusCode });
      expect(subject.calls()).toEqual([{ context, request }]);
    });
  });
}
