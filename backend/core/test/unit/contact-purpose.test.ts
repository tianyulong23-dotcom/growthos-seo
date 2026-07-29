import { describe, expect, it } from "vitest";

import {
  classifyContactPurpose,
  contactPurposeRuleVersion,
  type ContactPurpose,
} from "../../src/modules/backlinks/domain/contacts/contact-purpose.js";

type LabelledCase = Readonly<{
  expected: ContactPurpose;
  email: string;
  mailtoLabel?: string;
  nearbyText?: string;
  pageTitle?: string;
}>;

const labelledCases: readonly LabelledCase[] = [
  { expected: "press", email: "press@example.com" },
  { expected: "press", email: "pr@example.com" },
  { expected: "press", email: "media-relations@example.com" },
  { expected: "press", email: "team@example.com", mailtoLabel: "Public Relations" },
  { expected: "editorial", email: "editor@example.com" },
  { expected: "editorial", email: "editorial@example.com" },
  { expected: "editorial", email: "submissions@example.com" },
  { expected: "partnerships", email: "partnerships@example.com" },
  { expected: "partnerships", email: "partner@example.com" },
  { expected: "partnerships", email: "team@example.com", nearbyText: "Collaboration contact" },
  { expected: "advertising", email: "advertising@example.com" },
  { expected: "advertising", email: "sponsorship@example.com" },
  { expected: "advertising", email: "ads@example.com" },
  { expected: "support", email: "support@example.com" },
  { expected: "support", email: "helpdesk@example.com" },
  { expected: "support", email: "customer-support@example.com" },
  { expected: "general", email: "info@example.com" },
  { expected: "general", email: "hello@example.com" },
  { expected: "general", email: "contact@example.com" },
  { expected: "unknown", email: "legal@example.com" },
  { expected: "unknown", email: "team@example.com" },
  { expected: "unknown", email: "person.name@example.com" },
];

function macroF1(
  rows: readonly Readonly<{ expected: ContactPurpose; actual: ContactPurpose }>[],
): number {
  const labels = [...new Set(rows.map(({ expected }) => expected))];
  return labels.reduce((sum, label) => {
    const truePositive = rows.filter(
      ({ expected, actual }) => expected === label && actual === label,
    ).length;
    const falsePositive = rows.filter(
      ({ expected, actual }) => expected !== label && actual === label,
    ).length;
    const falseNegative = rows.filter(
      ({ expected, actual }) => expected === label && actual !== label,
    ).length;
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    return sum + (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall);
  }, 0) / labels.length;
}

describe("BL-AI-CORR-3C-001 contact purpose correction", () => {
  it("meets the labelled precision and Macro F1 gates with versioned evidence", () => {
    const decisions = labelledCases.map((entry) => ({
      expected: entry.expected,
      decision: classifyContactPurpose({
        email: entry.email,
        source: "mailto",
        ...(entry.mailtoLabel === undefined ? {} : { mailtoLabel: entry.mailtoLabel }),
        ...(entry.nearbyText === undefined ? {} : { nearbyText: entry.nearbyText }),
        ...(entry.pageTitle === undefined ? {} : { pageTitle: entry.pageTitle }),
      }),
    }));
    const highConfidence = decisions.filter(
      ({ decision }) => decision.confidence >= 90,
    );
    const precision = highConfidence.filter(
      ({ expected, decision }) => decision.inferredPurpose === expected,
    ).length / highConfidence.length;
    const f1 = macroF1(decisions.map(({ expected, decision }) => ({
      expected,
      actual: decision.inferredPurpose,
    })));

    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(f1).toBeGreaterThanOrEqual(0.85);
    expect(decisions.every(
      ({ decision }) => decision.ruleVersion === contactPurposeRuleVersion,
    )).toBe(true);
    expect(decisions.filter(
      ({ decision }) => decision.inferredPurpose !== "unknown",
    ).every(({ decision }) =>
      decision.observedRole !== null && decision.evidence.length > 0,
    )).toBe(true);
  });

  it.each([
    "privacy",
    "product",
    "profile",
    "pricing",
    "professional",
    "wordpress",
  ])("never treats the short-token false positive %s as press", (token) => {
    const decision = classifyContactPurpose({
      email: `${token}@example.com`,
      source: "mailto",
      mailtoLabel: token,
      nearbyText: `${token} policy contact`,
      pageTitle: token,
    });

    expect(decision.inferredPurpose).not.toBe("press");
    expect(decision.evidence.some(({ matchedToken }) => matchedToken === "pr")).toBe(false);
  });

  it("allows pr only as an independent token in a high-trust field", () => {
    expect(classifyContactPurpose({
      email: "pr@example.com",
      source: "mailto",
    }).inferredPurpose).toBe("press");
    expect(classifyContactPurpose({
      email: "team@example.com",
      source: "visible_text",
      pageTitle: "PR contact",
    }).inferredPurpose).not.toBe("press");
  });

  it("keeps the elephtv regression general or unknown and never press", () => {
    const decision = classifyContactPurpose({
      email: "info@elephtv.com",
      source: "visible_text",
      nearbyText: "No smart TV, no problem. Stream ElephTV on Android.",
      pageTitle: "No Smart TV? No Problem",
    });

    expect(["general", "unknown"]).toContain(decision.inferredPurpose);
    expect(decision.inferredPurpose).not.toBe("press");
  });
});
