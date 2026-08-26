import { describe, expect, it } from "vitest";

import type { GmailConnectionView } from "../../src/modules/backlinks/application/gmail-connection.gateway.js";
import {
  evaluateGmailReadiness,
  type GmailReadinessFacts,
} from "../../src/modules/backlinks/application/services/gmail-readiness.js";
import { gmailOAuthScopes } from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";

const connection: GmailConnectionView = {
  connectionId: "018f0000-0000-7000-8000-000000000020",
  version: 1,
  primaryEmail: "owner@example.com",
  displayName: "Example Owner",
  hostedDomain: "example.com",
  grantedScopes: gmailOAuthScopes,
  connectionStatus: "CONNECTED",
  sendAvailability: "AVAILABLE",
  mailSyncCapability: true,
  tokenExpiresAt: "2026-08-18T03:00:00.000Z",
  connectedAt: "2026-08-18T01:00:00.000Z",
};

const readyFacts = (): GmailReadinessFacts => ({
  connection,
  projectBindingActive: true,
  verifiedSendIdentity: true,
  secretResolvable: true,
  sendRuntimeEnabled: true,
  syncRuntimeEnabled: true,
  workerAvailable: true,
  sendContext: {
    approvedSnapshotCurrent: true,
    suppressionClear: true,
    quotaAvailable: true,
  },
  syncStatus: {
    state: "POLLING",
    killSwitchOpen: true,
    cursorPresent: true,
  },
});

describe("Phase 8 Gmail readiness projection", () => {
  it("requires every current send and sync prerequisite", () => {
    const result = evaluateGmailReadiness(
      readyFacts(),
      "2026-08-18T02:00:00.000Z",
    );

    expect(result).toEqual({
      evaluatedAt: "2026-08-18T02:00:00.000Z",
      connection: { state: "CONNECTED", ready: true },
      send: { state: "SEND_READY", ready: true },
      sync: { state: "SYNC_READY", ready: true },
      blockers: [],
      primaryBlocker: null,
    });
  });

  it("does not claim send readiness without a draft and recipient context", () => {
    const result = evaluateGmailReadiness({
      ...readyFacts(),
      sendContext: null,
    });

    expect(result.send).toEqual({
      state: "WAITING_FOR_SEND_CONTEXT",
      ready: false,
    });
    expect(result.primaryBlocker).toMatchObject({
      code: "SEND_CONTEXT_REQUIRED",
      owner: "USER",
      retrySafe: true,
      recoveryAction: "OPEN_APPROVED_DRAFT",
    });
  });

  it.each([
    "GOOGLE_AUTH_TEMPORARY_FAILURE",
    "GOOGLE_AUTH_RATE_LIMITED",
  ] as const)(
    "does not report an account with refresh failure %s as connected-ready",
    (recentErrorCategory) => {
      const result = evaluateGmailReadiness({
        ...readyFacts(),
        connection: {
          ...connection,
          recentErrorCategory,
        },
      });

      expect(result.connection.ready).toBe(false);
      expect(result.primaryBlocker).toMatchObject({
        code: "GMAIL_TOKEN_REFRESH_FAILED",
        owner: "SYSTEM",
        retrySafe: true,
        recoveryAction: "REFRESH_GMAIL_READINESS",
      });
    },
  );

  it("treats waiting for the first accepted send as healthy sync readiness", () => {
    const result = evaluateGmailReadiness({
      ...readyFacts(),
      syncStatus: {
        state: "WAITING_FOR_ACCEPTED_SEND",
        killSwitchOpen: true,
        cursorPresent: false,
      },
    });

    expect(result.sync).toEqual({
      state: "WAITING_FOR_ACCEPTED_SEND",
      ready: true,
    });
    expect(result.blockers).toEqual([]);
  });

  it.each([
    {
      name: "project binding",
      facts: { projectBindingActive: false },
      code: "PROJECT_BINDING_MISSING",
      action: "REPAIR_PROJECT_BINDING",
      capabilities: ["SEND", "SYNC"],
    },
    {
      name: "secret resolution",
      facts: { secretResolvable: false },
      code: "GMAIL_SECRET_UNRESOLVABLE",
      action: "REPAIR_GMAIL_SECRET",
      capabilities: ["SEND", "SYNC"],
    },
    {
      name: "worker availability",
      facts: { workerAvailable: false },
      code: "GMAIL_WORKER_UNAVAILABLE",
      action: "START_GMAIL_WORKER",
      capabilities: ["SEND", "SYNC"],
    },
  ])(
    "blocks both send and sync when $name is unavailable",
    ({ facts, code, action, capabilities }) => {
      const result = evaluateGmailReadiness({
        ...readyFacts(),
        ...facts,
        sendContext: null,
        syncStatus: null,
      });

      expect(result.send.ready).toBe(false);
      expect(result.sync.ready).toBe(false);
      expect(result.blockers.filter((item) => item.code === code)).toEqual(
        capabilities.map((capability) => expect.objectContaining({
          capability,
          recoveryAction: action,
        })),
      );
      expect(result.blockers).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SEND_CONTEXT_REQUIRED" }),
        expect.objectContaining({ code: "GMAIL_SYNC_STATUS_UNAVAILABLE" }),
      ]));
    },
  );

  it.each([
    ["CONNECTING", "GMAIL_OAUTH_CONNECTING", "COMPLETE_GMAIL_OAUTH"],
    ["REAUTH_REQUIRED", "GMAIL_REAUTH_REQUIRED", "REAUTHORIZE_GMAIL"],
    ["TOKEN_REVOKED", "GMAIL_TOKEN_REVOKED", "REAUTHORIZE_GMAIL"],
    ["DISCONNECTED", "GMAIL_DISCONNECTED", "CONNECT_GMAIL"],
  ] as const)(
    "maps %s to its primary recovery action",
    (connectionStatus, code, recoveryAction) => {
      const result = evaluateGmailReadiness({
        ...readyFacts(),
        connection: {
          ...connection,
          connectionStatus,
        },
      });

      expect(result.connection.ready).toBe(false);
      expect(result.primaryBlocker).toMatchObject({
        code,
        recoveryAction,
      });
    },
  );

  it("requires a durable cursor after polling starts", () => {
    const result = evaluateGmailReadiness({
      ...readyFacts(),
      syncStatus: {
        state: "POLLING",
        killSwitchOpen: true,
        cursorPresent: false,
      },
    });

    expect(result.sync).toEqual({ state: "BLOCKED", ready: false });
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "GMAIL_SYNC_CURSOR_MISSING",
      owner: "SYSTEM",
      retrySafe: true,
      recoveryAction: "REPAIR_GMAIL_SYNC_CURSOR",
    }));
  });
});
