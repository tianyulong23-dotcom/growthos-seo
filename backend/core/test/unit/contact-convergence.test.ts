import { describe, expect, it } from "vitest";

import {
  classifyContactConvergence,
  isTransientContactHttpStatus,
  shouldAttemptContactBrowserFallback,
  type ContactConvergenceSignals,
} from "../../src/modules/backlinks/domain/contacts/contact-convergence.js";

const signals = (
  overrides: Partial<ContactConvergenceSignals> = {},
): ContactConvergenceSignals => ({
  contactForm: false,
  loginRequired: false,
  challenge: false,
  accessDenied: false,
  robotsDisallowed: 0,
  unsupportedContent: 0,
  transportFailures: 0,
  parsedPages: 1,
  ...overrides,
});

const classify = (
  overrides: Partial<Parameters<typeof classifyContactConvergence>[0]> = {},
) => classifyContactConvergence({
  eligibleCount: 0,
  candidateCount: 0,
  failures: 0,
  retryableFailures: 0,
  attemptCount: 1,
  maxAttempts: 3,
  pagesVisited: 1,
  browserUsed: false,
  signals: signals(),
  ...overrides,
});

describe("LOCAL-PRODUCT-037 contact convergence", () => {
  it("publishes only an eligible public email outcome", () => {
    expect(classify({
      eligibleCount: 1,
      candidateCount: 1,
    })).toMatchObject({
      status: "completed",
      retry: false,
      terminalReasonCode: "PUBLIC_EMAIL_FOUND",
      method: "static",
    });
  });

  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [401, false],
    [403, false],
    [404, false],
  ])("classifies HTTP %s retryability", (status, expected) => {
    expect(isTransientContactHttpStatus(status)).toBe(expected);
  });

  it.each([
    [403, false, true],
    [429, false, true],
    [503, true, true],
    [401, false, false],
    [404, false, false],
  ])(
    "decides browser fallback for HTTP %s with challenge=%s",
    (status, challenge, expected) => {
      expect(shouldAttemptContactBrowserFallback({
        browserAuthorized: true,
        browserAttempted: false,
        status,
        challenge,
      })).toBe(expected);
    },
  );

  it("does not repeat or bypass an unauthorized browser fallback", () => {
    expect(shouldAttemptContactBrowserFallback({
      browserAuthorized: false,
      browserAttempted: false,
      status: 403,
      challenge: true,
    })).toBe(false);
    expect(shouldAttemptContactBrowserFallback({
      browserAuthorized: true,
      browserAttempted: true,
      status: 429,
      challenge: false,
    })).toBe(false);
  });

  it("keeps temporary transport and browser-unavailable failures recoverable", () => {
    expect(classify({
      failures: 1,
      retryableFailures: 1,
      pagesVisited: 0,
      signals: signals({ transportFailures: 1, parsedPages: 0 }),
    })).toMatchObject({
      status: "retry_scheduled",
      retry: true,
      terminalReasonCode: null,
    });
  });

  it.each([
    ["CONTACT_FORM_ONLY", signals({ contactForm: true })],
    ["CAPTCHA_OR_BOT_CHALLENGE", signals({ challenge: true })],
    ["LOGIN_REQUIRED", signals({ loginRequired: true })],
    ["ACCESS_DENIED", signals({ accessDenied: true })],
    [
      "ROBOTS_DISALLOWED",
      signals({ robotsDisallowed: 1, parsedPages: 0 }),
    ],
    [
      "UNSUPPORTED_CONTENT",
      signals({ unsupportedContent: 1, parsedPages: 0 }),
    ],
  ] as const)("classifies terminal contact outcome %s", (
    terminalReasonCode,
    terminalSignals,
  ) => {
    expect(classify({
      pagesVisited: terminalReasonCode === "ROBOTS_DISALLOWED" ? 0 : 1,
      signals: terminalSignals,
    })).toMatchObject({
      retry: false,
      terminalReasonCode,
    });
  });

  it("terminates an exhausted transient failure without inventing an email", () => {
    expect(classify({
      failures: 2,
      retryableFailures: 2,
      attemptCount: 3,
      maxAttempts: 3,
      pagesVisited: 0,
      signals: signals({ transportFailures: 2, parsedPages: 0 }),
    })).toMatchObject({
      status: "partially_completed",
      retry: false,
      terminalReasonCode: "SITE_UNREACHABLE",
      lastErrorCategory: "SITE_UNREACHABLE",
    });
  });

  it("classifies no public evidence as a terminal no-contact outcome", () => {
    expect(classify()).toMatchObject({
      status: "no_contact_found",
      retry: false,
      terminalReasonCode: "NO_PUBLIC_EMAIL",
    });
  });
});
