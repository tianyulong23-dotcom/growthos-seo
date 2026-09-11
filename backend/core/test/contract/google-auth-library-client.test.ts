import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoogleAuthLibraryClient,
  mapGoogleAuthLibraryError,
  normalizeGoogleGrantedScopes,
} from "../../src/modules/backlinks/adapters/gmail/google-auth-library-client.js";
import { gmailOAuthScopes } from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import {
  googleAuthFailureCodes,
} from "../../src/modules/backlinks/ports/google-auth.port.js";

const redirectUri =
  "http://localhost:7200/api/v1/backlinks/gmail-connections/callback";

describe("Google Auth official client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates an offline consent URL with exact redirect, scopes, state, and PKCE", async () => {
    const client = new GoogleAuthLibraryClient({
      clientId: "canary.apps.googleusercontent.com",
      clientSecret: "not-a-real-secret",
    });
    const result = await client.createAuthorizationUrl({
      redirectUri,
      state: "state-value",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256",
      requestedScopes: gmailOAuthScopes,
    });
    const url = new URL(result.authorizationUrl);

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      gmailOAuthScopes,
    );
  });

  it("does not block authorization URL generation on token endpoint connectivity", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    );
    const client = new GoogleAuthLibraryClient({
      clientId: "canary.apps.googleusercontent.com",
      clientSecret: "not-a-real-secret",
    });

    const result = await client.createAuthorizationUrl({
      redirectUri,
      state: "state-value",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256",
      requestedScopes: gmailOAuthScopes,
    });

    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects missing client credentials before any network operation", () => {
    expect(() => new GoogleAuthLibraryClient({
      clientId: "",
      clientSecret: "secret",
    })).toThrow("Google OAuth client credentials are required.");
  });

  it("canonicalizes Google userinfo aliases before persistence", () => {
    expect(normalizeGoogleGrantedScopes([
      "email",
      "profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "openid",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ])).toEqual(gmailOAuthScopes);
  });

  it.each([
    [
      { code: "ETIMEDOUT" },
      googleAuthFailureCodes.temporaryFailure,
      true,
    ],
    [
      { response: { status: 429, data: {} } },
      googleAuthFailureCodes.rateLimited,
      true,
    ],
    [
      { response: { status: 503, data: {} } },
      googleAuthFailureCodes.temporaryFailure,
      true,
    ],
    [
      {
        response: {
          status: 400,
          data: { error: "invalid_grant" },
        },
      },
      googleAuthFailureCodes.authExpired,
      false,
    ],
  ] as const)(
    "maps provider failure to %s retry semantics",
    (error, code, retryable) => {
      expect(mapGoogleAuthLibraryError("refresh", error)).toMatchObject({
        operation: "refresh",
        code,
        retryable,
      });
    },
  );

  it("preserves safe transport diagnostics for token refresh failures", () => {
    expect(
      mapGoogleAuthLibraryError("refresh", {
        code: "ETIMEDOUT",
        response: {
          status: 503,
          headers: { "x-request-id": "google-request-1" },
          data: {},
        },
      }),
    ).toMatchObject({
      operation: "refresh",
      code: googleAuthFailureCodes.temporaryFailure,
      retryable: true,
      transportCode: "ETIMEDOUT",
      httpStatus: 503,
      providerRequestId: "google-request-1",
    });
  });
});
