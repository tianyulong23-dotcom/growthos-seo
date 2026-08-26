import { describe, expect, it } from "vitest";

import {
  planNegotiationFactDecision,
  type NegotiationFactVersion,
} from "../../src/modules/backlinks/application/services/negotiation-facts.service.js";

const source = Object.freeze({
  id: "018f0000-0000-7000-8000-000000000151",
  inboundMessageId: "018f0000-0000-7000-8000-000000000152",
  opportunityId: "018f0000-0000-7000-8000-000000000153",
  factKey: "commercial.price",
  factVersion: 2,
  factType: "PRICE",
  rawValue: "$400",
  normalizedValue: { currency: "USD", amount: 400 },
  factAuthority: "INFERRED",
  reviewStatus: "PENDING",
  extractorType: "RULE",
  extractorVersion: "negotiation-rule-v1",
  confidenceScore: 0.8,
  evidenceText: "Our placement fee is $400.",
  evidenceStart: 21,
  evidenceEnd: 25,
  supersedesFactVersionId: null,
  decidedBy: null,
  decidedAt: null,
  schemaVersion: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  createdBy: "gmail-sync",
} satisfies NegotiationFactVersion);

const idSequence = (...ids: string[]) => {
  let index = 0;
  return () => ids[index++] ?? "unexpected-id";
};

describe("Phase 10 negotiation fact decision planner", () => {
  it.each([
    ["CONFIRM", "CONFIRMED"],
    ["REJECT", "REJECTED"],
  ] as const)("appends one immutable version for %s", (decision, reviewStatus) => {
    const result = planNegotiationFactDecision({
      source,
      decision,
      newId: idSequence("018f0000-0000-7000-8000-000000000154"),
    });

    expect(result).toEqual([{
      id: "018f0000-0000-7000-8000-000000000154",
      factVersion: 3,
      factType: "PRICE",
      rawValue: "$400",
      normalizedValue: { currency: "USD", amount: 400 },
      reviewStatus,
      supersedesFactVersionId: null,
    }]);
    expect(source.reviewStatus).toBe("PENDING");
  });

  it("corrects by superseding the source and appending a confirmed value", () => {
    const result = planNegotiationFactDecision({
      source,
      decision: "CORRECT",
      correction: {
        factType: "PRICE",
        rawValue: "ZAR 7,500",
        normalizedValue: { currency: "ZAR", amount: 7_500 },
      },
      newId: idSequence(
        "018f0000-0000-7000-8000-000000000155",
        "018f0000-0000-7000-8000-000000000156",
      ),
    });

    expect(result).toEqual([{
      id: "018f0000-0000-7000-8000-000000000155",
      factVersion: 3,
      factType: "PRICE",
      rawValue: "$400",
      normalizedValue: { currency: "USD", amount: 400 },
      reviewStatus: "SUPERSEDED",
      supersedesFactVersionId: source.id,
    }, {
      id: "018f0000-0000-7000-8000-000000000156",
      factVersion: 4,
      factType: "PRICE",
      rawValue: "ZAR 7,500",
      normalizedValue: { currency: "ZAR", amount: 7_500 },
      reviewStatus: "CONFIRMED",
      supersedesFactVersionId: null,
    }]);
  });

  it("requires an explicit correction payload", () => {
    expect(() => planNegotiationFactDecision({
      source,
      decision: "CORRECT",
      newId: idSequence("018f0000-0000-7000-8000-000000000157"),
    })).toThrow("Negotiation fact correction is required.");
  });
});
