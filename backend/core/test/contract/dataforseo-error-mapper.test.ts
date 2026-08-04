import { describe, expect, it } from "vitest";

import {
  DataForSeoProviderError,
  DataForSeoRuntimeError,
  mapDataForSeoProviderError,
} from "../../src/modules/backlinks/adapters/dataforseo/error-mapper.js";

describe("DataForSEO provider error mapper", () => {
  it.each([
    ["authentication", true, "DATAFORSEO_AUTHENTICATION_FAILED", "failed", false, 401],
    ["balance", true, "DATAFORSEO_BALANCE_EXHAUSTED", "failed", false, 402],
    ["invalid_request", true, "DATAFORSEO_INVALID_REQUEST", "failed", false, 400],
    ["rate_limited", true, "DATAFORSEO_RATE_LIMITED", "failed", false, 429],
    ["timeout", true, "DATAFORSEO_RESULT_UNKNOWN", "unknown_charge", true, undefined],
    ["network", true, "DATAFORSEO_RESULT_UNKNOWN", "unknown_charge", true, undefined],
    ["server_error", true, "DATAFORSEO_RESULT_UNKNOWN", "unknown_charge", true, 503],
    ["malformed_response", true, "DATAFORSEO_RESULT_UNKNOWN", "unknown_charge", true, undefined],
    ["network", false, "DATAFORSEO_UNAVAILABLE", "failed", false, undefined],
  ] as const)(
    "classifies %s with dispatched=%s",
    (kind, requestDispatched, code, providerRequestStatus, reconciliationRequired, statusCode) => {
    const error = mapDataForSeoProviderError(
      new DataForSeoRuntimeError({
        kind,
        requestDispatched,
        statusCode,
      }),
    );

    expect(error).toBeInstanceOf(DataForSeoProviderError);
    expect(error).toMatchObject({
      code,
      providerRequestStatus,
      reconciliationRequired,
      retryable: false,
      statusCode,
    });
    },
  );

  it("treats an unclassified runtime failure as an unknown charge", () => {
    const sensitiveMessage = "credential=fixture-sensitive-value";
    const error = mapDataForSeoProviderError(new Error(sensitiveMessage));

    expect(error).toMatchObject({
      code: "DATAFORSEO_RESULT_UNKNOWN",
      providerRequestStatus: "unknown_charge",
      reconciliationRequired: true,
      retryable: false,
    });
    expect(String(error)).not.toContain(sensitiveMessage);
  });
});
