import { describe, expect, it } from "vitest";

import {
  canReplaceFailedSendIntent,
} from "../../src/modules/backlinks/application/services/send-resubmission-policy.js";

const verifiedNotSent = {
  intentStatus: "FAILED_FINAL",
  attemptStatus: "FAILED_RETRYABLE",
  errorCode: "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND",
  providerMessageId: null,
  providerThreadId: null,
};

describe("Send resubmission policy", () => {
  it("allows a fresh Intent after Gmail proves the RFC Message-ID is absent", () => {
    expect(canReplaceFailedSendIntent(verifiedNotSent)).toBe(true);
  });

  it("allows a fresh Intent after token refresh failed before provider submission", () => {
    expect(canReplaceFailedSendIntent({
      ...verifiedNotSent,
      attemptStatus: "FAILED_FINAL",
      errorCode: "GMAIL_SEND_TOKEN_REFRESH_FAILED",
    })).toBe(true);
  });

  it.each([
    ["unknown provider result", {
      ...verifiedNotSent,
      attemptStatus: "DELIVERY_UNKNOWN",
      errorCode: "GMAIL_SEND_AMBIGUOUS_RESULT",
    }],
    ["accepted provider result", {
      ...verifiedNotSent,
      intentStatus: "PROVIDER_ACCEPTED",
      attemptStatus: "PROVIDER_ACCEPTED",
      providerMessageId: "gmail-message-1",
    }],
    ["unclassified terminal failure", {
      ...verifiedNotSent,
      errorCode: "GMAIL_SEND_FAILED",
    }],
  ])("blocks %s", (_name, evidence) => {
    expect(canReplaceFailedSendIntent(evidence)).toBe(false);
  });
});
