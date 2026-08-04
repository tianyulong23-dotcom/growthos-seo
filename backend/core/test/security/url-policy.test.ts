import { describe, expect, it } from "vitest";
import {
  enforceUrlPolicy,
  UrlPolicyError,
  type UrlPolicyReason,
} from "../../src/modules/backlinks/adapters/http/url-policy.js";
import { safeFetchFailureCodes } from "../../src/modules/backlinks/ports/safe-fetch.port.js";

describe("BL-AI-066 URL policy", () => {
  it.each([
    [
      "https://Example.COM:443/contact?source=seo#team",
      "https://example.com/contact?source=seo#team",
      "https:",
      "example.com",
      443,
    ],
    ["http://example.com:80/", "http://example.com/", "http:", "example.com", 80],
    ["https://8.8.8.8/", "https://8.8.8.8/", "https:", "8.8.8.8", 443],
    [
      "https://[2001:4860:4860::8888]/",
      "https://[2001:4860:4860::8888]/",
      "https:",
      "[2001:4860:4860::8888]",
      443,
    ],
  ] as const)(
    "accepts and normalizes %s",
    (requestedUrl, normalizedUrl, protocol, hostname, port) => {
      const decision = enforceUrlPolicy(requestedUrl);
      expect(decision).toEqual({
        requestedUrl,
        normalizedUrl,
        protocol,
        hostname,
        port,
      });
      expect(Object.isFrozen(decision)).toBe(true);
    },
  );

  it.each([
    ["ftp://example.com/", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["javascript://example.com/alert(1)", "unsupported_scheme"],
    ["", "invalid_url"],
    [`https://example.com/${"x".repeat(2_048)}`, "invalid_url"],
    ["https:example.com", "ambiguous_url"],
    ["//example.com/path", "ambiguous_url"],
    [" https://example.com/", "ambiguous_url"],
    ["https://example.com/\n", "ambiguous_url"],
    ["https:\\\\example.com\\contact", "ambiguous_url"],
    ["https://%65xample.com/", "ambiguous_url"],
    ["http://2130706433/", "ambiguous_url"],
    ["http://0177.0.0.1/", "ambiguous_url"],
    ["http://0x7f000001/", "ambiguous_url"],
    ["https://user:pass@example.com/", "credentials_not_allowed"],
    ["https://example.com@evil.test/", "credentials_not_allowed"],
    ["https://example.com:8443/", "port_not_allowed"],
    ["https://example.com:80/", "port_not_allowed"],
    ["http://example.com:443/", "port_not_allowed"],
    ["https://example.com:0443/", "port_not_allowed"],
    ["https://example.com:/", "port_not_allowed"],
    ["https://example..com/", "hostname_not_allowed"],
    ["https://-example.com/", "hostname_not_allowed"],
    ["https://example-.com/", "hostname_not_allowed"],
    ["https://example_com/", "hostname_not_allowed"],
    ["https://example.com./", "hostname_not_allowed"],
  ] satisfies readonly (readonly [string, UrlPolicyReason])[])(
    "rejects %s as %s",
    (requestedUrl, reason) => {
      expect(() => enforceUrlPolicy(requestedUrl)).toThrowError(
        expect.objectContaining({
          name: "UrlPolicyError",
          code: safeFetchFailureCodes.urlBlocked,
          requestedUrl,
          reason,
          retryable: false,
        }),
      );
      expect(() => enforceUrlPolicy(requestedUrl)).toThrow(UrlPolicyError);
    },
  );
});
