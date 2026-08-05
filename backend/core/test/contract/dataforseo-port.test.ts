import { describe, expect, expectTypeOf, it } from "vitest";

import {
  backlinkProviderSnapshotSchema,
  backlinkSnapshotRequestSchema,
  providerCostSchema,
  providerRequestContextSchema,
  referringDomainEvidenceSchema,
  type BacklinkProviderSnapshot,
  type DataForSeoPort,
  type ProviderCost,
  type ProviderRequestContext,
} from "../../src/modules/backlinks/ports/dataforseo.port.js";

const context = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  requestId: "request-1",
  idempotencyKey: "analysis:project-1:profile-1",
  budgetReservationId: "reservation-1",
};

const request = {
  target: "example.com",
  targetType: "domain",
  limit: 100,
} as const;

const snapshot = {
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
} as const;

describe("BL-AI-042 DataForSeoPort contract", () => {
  it("accepts the owned request, cost, evidence, and snapshot DTOs", async () => {
    expect(providerRequestContextSchema.parse(context)).toEqual(context);
    expect(backlinkSnapshotRequestSchema.parse(request)).toEqual(request);
    expect(providerCostSchema.parse({ costMicros: 20_000 })).toEqual({
      costMicros: 20_000,
    });
    expect(referringDomainEvidenceSchema.parse(snapshot.referringDomains[0])).toEqual(
      snapshot.referringDomains[0],
    );
    expect(backlinkProviderSnapshotSchema.parse(snapshot)).toEqual(snapshot);

    expectTypeOf<ProviderRequestContext>().toEqualTypeOf<
      Readonly<typeof context>
    >();
    expectTypeOf<ProviderCost>().toEqualTypeOf<
      Readonly<{ costMicros: number }>
    >();

    const port: DataForSeoPort = {
      fetchBacklinkSnapshot: async (receivedContext, receivedRequest) => {
        expect(receivedContext).toEqual(context);
        expect(receivedRequest).toEqual(request);
        return snapshot;
      },
    };

    await expect(port.fetchBacklinkSnapshot(context, request)).resolves.toEqual(
      snapshot,
    );
    expectTypeOf(snapshot).toMatchTypeOf<BacklinkProviderSnapshot>();
  });

  it("rejects missing, unsafe, and overlong request values", () => {
    expect(
      providerRequestContextSchema.safeParse({
        ...context,
        workspaceId: " ",
      }).success,
    ).toBe(false);
    expect(
      providerRequestContextSchema.safeParse({
        ...context,
        requestId: "x".repeat(256),
      }).success,
    ).toBe(false);
    expect(
      backlinkSnapshotRequestSchema.safeParse({
        ...request,
        limit: 0,
      }).success,
    ).toBe(false);
    expect(
      backlinkSnapshotRequestSchema.safeParse({
        ...request,
        target: "x".repeat(2_049),
      }).success,
    ).toBe(false);
    expect(providerCostSchema.safeParse({ costMicros: -1 }).success).toBe(false);
  });

  it("rejects unknown and vendor-shaped fields", () => {
    expect(
      providerRequestContextSchema.safeParse({
        ...context,
        endpoint: "/v3/backlinks/referring_domains/live",
      }).success,
    ).toBe(false);
    expect(
      referringDomainEvidenceSchema.safeParse({
        ...snapshot.referringDomains[0],
        referring_domains: 3,
      }).success,
    ).toBe(false);
    expect(
      backlinkProviderSnapshotSchema.safeParse({
        ...snapshot,
        task_cost: 0.02,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed snapshot metadata and evidence", () => {
    expect(
      backlinkProviderSnapshotSchema.safeParse({
        ...snapshot,
        completedAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
    expect(
      backlinkProviderSnapshotSchema.safeParse({
        ...snapshot,
        payloadHash: "not-a-sha256",
      }).success,
    ).toBe(false);
    expect(
      referringDomainEvidenceSchema.safeParse({
        ...snapshot.referringDomains[0],
        spamScore: 101,
      }).success,
    ).toBe(false);
    expect(
      referringDomainEvidenceSchema.safeParse({
        ...snapshot.referringDomains[0],
        countryCode: "usa",
      }).success,
    ).toBe(false);
  });
});
