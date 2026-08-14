import { describe, expect, it } from "vitest";

import {
  calculateGmailPollingRetryDelaySeconds,
  classifyGmailPollingSyncError,
  createGmailPollingSyncCapabilityPausedResult,
  gmailPollingMaximumRetryDelaySeconds,
  isGmailPollingSyncCapabilityPausedResult,
} from "../../src/modules/backlinks/application/workflows/gmail-polling-sync-workflow.js";
import {
  calculateGmailTokenHealthRetryDelaySeconds,
  gmailTokenHealthMaximumRetryDelaySeconds,
} from "../../src/modules/backlinks/runtime/production-runtime.js";

describe("Gmail polling retry policy", () => {
  it.each([
    ["GMAIL_SYNC_NETWORK_TIMEOUT", "NETWORK_TIMEOUT"],
    ["GMAIL_SYNC_RATE_LIMITED", "RATE_LIMITED"],
    ["GMAIL_SYNC_PROVIDER_5XX", "GOOGLE_5XX"],
    ["GMAIL_SYNC_AUTHENTICATION_FAILED", "AUTHENTICATION_FAILED"],
    ["GMAIL_SYNC_FORBIDDEN", "FORBIDDEN"],
    ["GMAIL_SYNC_TRANSPORT_FAILURE", "TRANSPORT_FAILURE"],
    ["unclassified", "UNKNOWN"],
  ] as const)("classifies %s as %s", (message, category) => {
    expect(classifyGmailPollingSyncError(new Error(message))).toBe(category);
  });

  it("uses capped exponential backoff for retryable sync failures", () => {
    expect(calculateGmailPollingRetryDelaySeconds(
      60,
      1,
      "NETWORK_TIMEOUT",
    )).toBe(60);
    expect(calculateGmailPollingRetryDelaySeconds(
      60,
      2,
      "RATE_LIMITED",
    )).toBe(120);
    expect(calculateGmailPollingRetryDelaySeconds(
      60,
      3,
      "GOOGLE_5XX",
    )).toBe(240);
    expect(calculateGmailPollingRetryDelaySeconds(
      60,
      20,
      "TRANSPORT_FAILURE",
    )).toBe(gmailPollingMaximumRetryDelaySeconds);
  });

  it("keeps account token-health retries independent and capped", () => {
    expect(calculateGmailTokenHealthRetryDelaySeconds(1)).toBe(60);
    expect(calculateGmailTokenHealthRetryDelaySeconds(2)).toBe(120);
    expect(calculateGmailTokenHealthRetryDelaySeconds(3)).toBe(240);
    expect(calculateGmailTokenHealthRetryDelaySeconds(20)).toBe(
      gmailTokenHealthMaximumRetryDelaySeconds,
    );
  });

  it("represents disabled Gmail Sync as a non-successful paused cycle", () => {
    const result = createGmailPollingSyncCapabilityPausedResult({
      workflowId: "gmail-sync:connection-1",
    });

    expect(isGmailPollingSyncCapabilityPausedResult(result)).toBe(true);
    expect(result).toMatchObject({
      workflowId: "gmail-sync:connection-1",
      initialOutcome: "CAPABILITY_PAUSED",
      incrementalOutcome: "CAPABILITY_PAUSED",
      rawMessagesPersisted: 0,
      messagesProjected: 0,
    });
  });
});
