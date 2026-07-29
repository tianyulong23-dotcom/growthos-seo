import { describe, expect, it, vi } from "vitest";

import {
  evaluateGmailSendPolicy,
  gmailSendPolicyBlockCodes,
  gmailSendPolicyVersion,
  runAfterGmailSendPolicyGate,
  type GmailSendPolicyInput,
} from "../../src/modules/backlinks/application/services/send-policy-gate.js";

const allowedInput = (): GmailSendPolicyInput => ({
  evaluatedAt: "2026-07-27T08:00:00.000Z",
  draft: {
    status: "approved",
    approvedVersionId: "version-1",
    requestedVersionId: "version-1",
  },
  suppression: {
    suppressed: false,
  },
  connection: {
    connectionStatus: "CONNECTED",
    sendAvailability: "AVAILABLE",
  },
  quota: {
    status: "RESERVED",
    eligibleAt: "2026-07-27T07:59:00.000Z",
    expiresAt: "2026-07-27T08:30:00.000Z",
  },
  killSwitches: {
    GLOBAL: false,
    ORGANIZATION: false,
    WORKSPACE: false,
    WEBSITE_PROJECT: false,
    GMAIL_SEND: false,
  },
  cooldownUntil: null,
});

describe("BL-AI-111 Gmail send policy gate", () => {
  it("allows an approved and fully eligible send operation", async () => {
    const operation = vi.fn(async () => "provider-accepted");

    await expect(
      runAfterGmailSendPolicyGate(allowedInput(), operation),
    ).resolves.toBe("provider-accepted");
    expect(operation).toHaveBeenCalledTimes(1);

    expect(evaluateGmailSendPolicy(allowedInput())).toEqual({
      policyVersion: gmailSendPolicyVersion,
      evaluatedAt: "2026-07-27T08:00:00.000Z",
      allowed: true,
      blockCodes: [],
      activeKillSwitchScopes: [],
      retryAt: null,
    });
  });

  it("blocks every required policy failure before invoking the operation", async () => {
    const cases: readonly Readonly<{
      name: string;
      code: string;
      input: GmailSendPolicyInput;
    }>[] = [
      {
        name: "unapproved draft",
        code: gmailSendPolicyBlockCodes.draftNotApproved,
        input: {
          ...allowedInput(),
          draft: {
            status: "draft",
            approvedVersionId: null,
            requestedVersionId: "version-1",
          },
        },
      },
      {
        name: "suppressed recipient",
        code: gmailSendPolicyBlockCodes.recipientSuppressed,
        input: {
          ...allowedInput(),
          suppression: { suppressed: true },
        },
      },
      {
        name: "disconnected Gmail account",
        code: gmailSendPolicyBlockCodes.connectionUnavailable,
        input: {
          ...allowedInput(),
          connection: {
            connectionStatus: "DISCONNECTED",
            sendAvailability: "PAUSED",
          },
        },
      },
      {
        name: "exhausted daily quota",
        code: gmailSendPolicyBlockCodes.dailyQuotaExceeded,
        input: {
          ...allowedInput(),
          quota: {
            status: "EXCEEDED",
            retryAt: "2026-07-28T08:00:00.000Z",
          },
        },
      },
      {
        name: "active Kill Switch",
        code: gmailSendPolicyBlockCodes.killSwitchActive,
        input: {
          ...allowedInput(),
          killSwitches: {
            ...allowedInput().killSwitches,
            GMAIL_SEND: true,
          },
        },
      },
      {
        name: "active cooldown",
        code: gmailSendPolicyBlockCodes.cooldownActive,
        input: {
          ...allowedInput(),
          cooldownUntil: "2026-07-27T08:05:00.000Z",
        },
      },
    ];

    for (const testCase of cases) {
      const operation = vi.fn(async () => "must-not-run");

      await expect(
        runAfterGmailSendPolicyGate(testCase.input, operation),
        testCase.name,
      ).rejects.toMatchObject({
        code: "GMAIL_SEND_POLICY_BLOCKED",
        decision: {
          allowed: false,
          blockCodes: [testCase.code],
        },
      });
      expect(operation, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("reports all blockers in a stable policy order", () => {
    const decision = evaluateGmailSendPolicy({
      ...allowedInput(),
      draft: {
        status: "approved",
        approvedVersionId: "version-1",
        requestedVersionId: "version-2",
      },
      suppression: { suppressed: true },
      connection: {
        connectionStatus: "REAUTH_REQUIRED",
        sendAvailability: "PAUSED",
      },
      quota: {
        status: "EXCEEDED",
        retryAt: "2026-07-28T08:00:00.000Z",
      },
      killSwitches: {
        ...allowedInput().killSwitches,
        GLOBAL: true,
        GMAIL_SEND: true,
      },
      cooldownUntil: "2026-07-27T08:05:00.000Z",
    });

    expect(decision).toEqual({
      policyVersion: gmailSendPolicyVersion,
      evaluatedAt: "2026-07-27T08:00:00.000Z",
      allowed: false,
      blockCodes: [
        gmailSendPolicyBlockCodes.draftNotApproved,
        gmailSendPolicyBlockCodes.recipientSuppressed,
        gmailSendPolicyBlockCodes.connectionUnavailable,
        gmailSendPolicyBlockCodes.dailyQuotaExceeded,
        gmailSendPolicyBlockCodes.killSwitchActive,
        gmailSendPolicyBlockCodes.cooldownActive,
      ],
      activeKillSwitchScopes: ["GLOBAL", "GMAIL_SEND"],
      retryAt: "2026-07-28T08:00:00.000Z",
    });
  });

  it("treats an ineligible reservation as cooldown and an expired one as quota exhaustion", () => {
    expect(
      evaluateGmailSendPolicy({
        ...allowedInput(),
        quota: {
          status: "RESERVED",
          eligibleAt: "2026-07-27T08:01:00.000Z",
          expiresAt: "2026-07-27T08:30:00.000Z",
        },
      }),
    ).toMatchObject({
      blockCodes: [gmailSendPolicyBlockCodes.cooldownActive],
      retryAt: "2026-07-27T08:01:00.000Z",
    });

    expect(
      evaluateGmailSendPolicy({
        ...allowedInput(),
        quota: {
          status: "RESERVED",
          eligibleAt: "2026-07-27T07:00:00.000Z",
          expiresAt: "2026-07-27T08:00:00.000Z",
        },
      }),
    ).toMatchObject({
      blockCodes: [gmailSendPolicyBlockCodes.dailyQuotaExceeded],
    });
  });

  it("rejects malformed timestamps and invalid reservation chronology", () => {
    expect(() =>
      evaluateGmailSendPolicy({
        ...allowedInput(),
        evaluatedAt: "not-a-timestamp",
      }),
    ).toThrow(TypeError);

    expect(() =>
      evaluateGmailSendPolicy({
        ...allowedInput(),
        quota: {
          status: "RESERVED",
          eligibleAt: "2026-07-27T09:00:00.000Z",
          expiresAt: "2026-07-27T08:00:00.000Z",
        },
      }),
    ).toThrow(TypeError);
  });

  it("fails closed when required policy evidence is incomplete", async () => {
    const operation = vi.fn(async () => "must-not-run");
    const input = {
      ...allowedInput(),
      killSwitches: {
        ...allowedInput().killSwitches,
        GMAIL_SEND: undefined,
      },
    } as unknown as GmailSendPolicyInput;

    await expect(
      runAfterGmailSendPolicyGate(input, operation),
    ).rejects.toThrow(TypeError);
    expect(operation).not.toHaveBeenCalled();
  });
});
