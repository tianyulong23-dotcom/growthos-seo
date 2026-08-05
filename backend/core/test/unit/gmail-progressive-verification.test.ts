import { describe, expect, it } from "vitest";

import {
  createGmailProgressiveVerification,
  evaluateGmailProgressiveVerification,
  gmailProgressiveVerificationLevels,
  gmailProgressiveVerificationReasonCodes,
} from "../../src/modules/backlinks/domain/sending/progressive-verification.js";

const signals = (
  overrides: Partial<
    Parameters<typeof createGmailProgressiveVerification>[0]
  > = {},
) => ({
  connectedAt: "2026-07-01T00:00:00.000Z",
  evaluatedAt: "2026-07-01T00:00:00.000Z",
  acceptedSendCount: 0,
  recentAttemptCount: 0,
  recentAnomalyCount: 0,
  reputationScore: null,
  ...overrides,
});

describe("BL-AI-110 Gmail progressive verification", () => {
  it("starts a connection at the conservative new-connection profile", () => {
    const decision = createGmailProgressiveVerification(signals());

    expect(decision).toMatchObject({
      state: {
        level: gmailProgressiveVerificationLevels.newConnection,
        enteredAt: "2026-07-01T00:00:00.000Z",
        evaluatedAt: "2026-07-01T00:00:00.000Z",
      },
      profile: {
        rolling24HourSendLimit: 5,
        minimumIntervalSeconds: 300,
        bulkSendingAllowed: false,
        automatedSendingAllowed: false,
      },
      anomalyRate: 0,
      reasons: [gmailProgressiveVerificationReasonCodes.newConnection],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.state)).toBe(true);
    expect(Object.isFrozen(decision.profile)).toBe(true);
  });

  it("advances at most one level even when evidence meets the standard threshold", () => {
    const created = createGmailProgressiveVerification(signals());
    const matureSignals = signals({
      evaluatedAt: "2026-07-24T00:00:00.000Z",
      acceptedSendCount: 80,
      recentAttemptCount: 50,
      recentAnomalyCount: 0,
      reputationScore: 95,
    });

    const firstEvaluation = evaluateGmailProgressiveVerification(
      created.state,
      matureSignals,
    );
    expect(firstEvaluation.state.level).toBe(
      gmailProgressiveVerificationLevels.reputationBuilding,
    );
    expect(firstEvaluation.profile.rolling24HourSendLimit).toBe(20);

    const secondEvaluation = evaluateGmailProgressiveVerification(
      firstEvaluation.state,
      {
        ...matureSignals,
        evaluatedAt: "2026-07-24T00:01:00.000Z",
      },
    );
    expect(secondEvaluation.state.level).toBe(
      gmailProgressiveVerificationLevels.standard,
    );
    expect(secondEvaluation.profile).toMatchObject({
      rolling24HourSendLimit: 50,
      minimumIntervalSeconds: 60,
    });
  });

  it("applies stricter levels for low reputation and anomalous activity", () => {
    const created = createGmailProgressiveVerification(signals());
    const building = evaluateGmailProgressiveVerification(
      created.state,
      signals({
        evaluatedAt: "2026-07-08T00:00:00.000Z",
        acceptedSendCount: 20,
        recentAttemptCount: 20,
        recentAnomalyCount: 0,
        reputationScore: 80,
      }),
    );
    const standard = evaluateGmailProgressiveVerification(
      building.state,
      signals({
        evaluatedAt: "2026-07-24T00:00:00.000Z",
        acceptedSendCount: 60,
        recentAttemptCount: 50,
        recentAnomalyCount: 0,
        reputationScore: 90,
      }),
    );
    expect(standard.state.level).toBe(
      gmailProgressiveVerificationLevels.standard,
    );

    const lowReputation = evaluateGmailProgressiveVerification(
      standard.state,
      signals({
        evaluatedAt: "2026-07-24T01:00:00.000Z",
        acceptedSendCount: 60,
        recentAttemptCount: 50,
        recentAnomalyCount: 0,
        reputationScore: 65,
      }),
    );
    expect(lowReputation.state.level).toBe(
      gmailProgressiveVerificationLevels.reputationBuilding,
    );
    expect(lowReputation.reasons).toContain(
      gmailProgressiveVerificationReasonCodes.lowReputation,
    );

    const highAnomalyRate = evaluateGmailProgressiveVerification(
      lowReputation.state,
      signals({
        evaluatedAt: "2026-07-24T02:00:00.000Z",
        acceptedSendCount: 60,
        recentAttemptCount: 10,
        recentAnomalyCount: 1,
        reputationScore: 90,
      }),
    );
    expect(highAnomalyRate.state.level).toBe(
      gmailProgressiveVerificationLevels.restricted,
    );
    expect(highAnomalyRate.profile).toMatchObject({
      rolling24HourSendLimit: 1,
      minimumIntervalSeconds: 900,
    });
  });

  it("recovers from restriction only after cooldown and only to new-connection level", () => {
    const restricted = createGmailProgressiveVerification(
      signals({
        recentAttemptCount: 10,
        recentAnomalyCount: 2,
        reputationScore: 90,
      }),
    );

    const earlyRecovery = evaluateGmailProgressiveVerification(
      restricted.state,
      signals({
        evaluatedAt: "2026-07-07T23:59:59.000Z",
        acceptedSendCount: 80,
        recentAttemptCount: 50,
        recentAnomalyCount: 0,
        reputationScore: 95,
      }),
    );
    expect(earlyRecovery.state.level).toBe(
      gmailProgressiveVerificationLevels.restricted,
    );
    expect(earlyRecovery.reasons).toEqual([
      gmailProgressiveVerificationReasonCodes.restrictionCooldown,
    ]);

    const recovered = evaluateGmailProgressiveVerification(
      earlyRecovery.state,
      signals({
        evaluatedAt: "2026-07-08T00:00:00.000Z",
        acceptedSendCount: 80,
        recentAttemptCount: 50,
        recentAnomalyCount: 0,
        reputationScore: 95,
      }),
    );
    expect(recovered.state.level).toBe(
      gmailProgressiveVerificationLevels.newConnection,
    );
    expect(recovered.reasons).toEqual([
      gmailProgressiveVerificationReasonCodes.recoveredToNewConnection,
    ]);
  });

  it("rejects malformed evidence and chronology", () => {
    expect(() =>
      createGmailProgressiveVerification(
        signals({ recentAttemptCount: 1, recentAnomalyCount: 2 }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGmailProgressiveVerification(signals({ reputationScore: 101 })),
    ).toThrow(TypeError);

    const created = createGmailProgressiveVerification(signals());
    expect(() =>
      evaluateGmailProgressiveVerification(
        created.state,
        signals({ evaluatedAt: "2026-06-30T23:59:59.000Z" }),
      ),
    ).toThrow(TypeError);
  });
});
