import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import { FakeGoogleAuthAdapter } from "../../src/modules/backlinks/adapters/gmail/auth-fake.adapter.js";
import {
  GoogleAuthError,
  googleAuthCallbackInputSchema,
  googleAuthCallbackResultSchema,
  googleAuthFailureCodes,
  googleAuthFailureRetryability,
  googleAuthFailureSchema,
  googleAuthRefreshInputSchema,
  googleAuthRefreshResultSchema,
  googleAuthRequestInputSchema,
  googleAuthRequestResultSchema,
  googleAuthRevokeInputSchema,
  googleAuthRevokeResultSchema,
  type GoogleAuthPort,
} from "../../src/modules/backlinks/ports/google-auth.port.js";

const authorizeInput = {
  redirectUri: "https://app.example.com/api/v1/gmail-connections/callback",
  state: "oauth-state",
  codeChallenge: "pkce-challenge",
  codeChallengeMethod: "S256",
  requestedScopes: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.send",
  ],
} as const;

const callbackInput = {
  authorizationCode: "authorization-code-secret",
  codeVerifier: "pkce-verifier-secret",
  redirectUri: authorizeInput.redirectUri,
} as const;

const refreshInput = {
  refreshToken: "refresh-token-secret",
} as const;

const revokeInput = {
  token: "token-to-revoke-secret",
} as const;

describe("BL-AI-101 GoogleAuthPort and Fake OAuth Adapter contract", () => {
  it("supports authorize success without exposing provider DTOs", async () => {
    const port: GoogleAuthPort = new FakeGoogleAuthAdapter();

    const result = await port.authorize(authorizeInput);
    const url = new URL(result.authorizationUrl);

    expect(googleAuthRequestInputSchema.parse(authorizeInput)).toEqual(
      authorizeInput,
    );
    expect(googleAuthRequestResultSchema.parse(result)).toEqual(result);
    expect(url.hostname).toBe("accounts.google.test");
    expect(url.searchParams.get("state")).toBe(authorizeInput.state);
    expect(url.searchParams.get("code_challenge")).toBe(
      authorizeInput.codeChallenge,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.getAll("scope")).toEqual(
      authorizeInput.requestedScopes,
    );
  });

  it("supports callback success with owned identity and token contracts", async () => {
    const adapter = new FakeGoogleAuthAdapter();

    const result = await adapter.callback(callbackInput);

    expect(googleAuthCallbackInputSchema.parse(callbackInput)).toEqual(
      callbackInput,
    );
    expect(googleAuthCallbackResultSchema.parse(result)).toEqual(result);
    expect(result.identity).toEqual({
      subject: "google-subject-fixture",
      email: "owner@example.test",
      emailVerified: true,
      displayName: "Fixture Owner",
      hostedDomain: "example.test",
    });
    expect(result.tokens).toMatchObject({
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      tokenType: "Bearer",
      expiresAt: "2026-07-27T04:00:00.000Z",
      grantedScopes: authorizeInput.requestedScopes,
    });
    expect(adapter.calls).toEqual({
      authorize: 0,
      callback: 1,
      refresh: 0,
      revoke: 0,
    });
    expect(JSON.stringify(adapter)).not.toMatch(
      /authorization-code-secret|pkce-verifier-secret/,
    );
  });

  it("supports refresh success without requiring refresh-token rotation", async () => {
    const adapter = new FakeGoogleAuthAdapter();

    const result = await adapter.refresh(refreshInput);

    expect(googleAuthRefreshInputSchema.parse(refreshInput)).toEqual(
      refreshInput,
    );
    expect(googleAuthRefreshResultSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      accessToken: "fake-refreshed-access-token",
      tokenType: "Bearer",
      expiresAt: "2026-07-27T05:00:00.000Z",
      grantedScopes: authorizeInput.requestedScopes,
    });
    expect(JSON.stringify(adapter)).not.toContain(refreshInput.refreshToken);
  });

  it("supports revoke success with an explicit confirmation result", async () => {
    const adapter = new FakeGoogleAuthAdapter();

    const result = await adapter.revoke(revokeInput);

    expect(googleAuthRevokeInputSchema.parse(revokeInput)).toEqual(revokeInput);
    expect(googleAuthRevokeResultSchema.parse(result)).toEqual({
      revoked: true,
    });
    expect(JSON.stringify(adapter)).not.toContain(revokeInput.token);
  });

  it.each([
    ["authorize", googleAuthFailureCodes.invalidRequest],
    ["callback", googleAuthFailureCodes.authorizationDenied],
    ["refresh", googleAuthFailureCodes.authExpired],
    ["revoke", googleAuthFailureCodes.temporaryFailure],
  ] as const)(
    "exposes the stable %s error contract",
    async (operation, code) => {
      const adapter = new FakeGoogleAuthAdapter({
        failures: { [operation]: code },
      });
      const call = {
        authorize: () => adapter.authorize(authorizeInput),
        callback: () => adapter.callback(callbackInput),
        refresh: () => adapter.refresh(refreshInput),
        revoke: () => adapter.revoke(revokeInput),
      }[operation];

      await expect(call()).rejects.toMatchObject({
        name: "GoogleAuthError",
        operation,
        code,
        retryable: googleAuthFailureRetryability[code],
      });

      try {
        await call();
      } catch (error) {
        expect(error).toBeInstanceOf(GoogleAuthError);
        expect(JSON.stringify(error)).not.toMatch(
          /authorization-code-secret|pkce-verifier-secret|refresh-token-secret|token-to-revoke-secret/,
        );
      }
    },
  );

  it("validates every failure code against fixed retryability", () => {
    for (const [code, retryable] of Object.entries(
      googleAuthFailureRetryability,
    )) {
      const failure = {
        operation: "callback",
        code,
        retryable,
      };

      expect(googleAuthFailureSchema.parse(failure)).toEqual(failure);
      expect(new GoogleAuthError(failure)).toMatchObject({
        operation: "callback",
        code,
        retryable,
      });
    }

    expect(Object.keys(googleAuthFailureRetryability)).toEqual(
      Object.values(googleAuthFailureCodes),
    );
    expect(googleAuthFailureSchema.safeParse({
      operation: "refresh",
      code: googleAuthFailureCodes.authExpired,
      retryable: true,
    }).success).toBe(false);
    expect(googleAuthFailureSchema.safeParse({
      operation: "callback",
      code: "invalid_grant",
      retryable: false,
    }).success).toBe(false);
    expect(googleAuthFailureSchema.safeParse({
      operation: "callback",
      code: googleAuthFailureCodes.permanentFailure,
      retryable: false,
      providerMessage: "authorization_code=secret",
    }).success).toBe(false);
  });

  it("rejects malformed requests and keeps SDK types outside the Port", () => {
    expect(googleAuthRequestInputSchema.safeParse({
      ...authorizeInput,
      requestedScopes: [],
    }).success).toBe(false);
    expect(googleAuthCallbackInputSchema.safeParse({
      ...callbackInput,
      authorizationCode: " ",
    }).success).toBe(false);
    expect(googleAuthRefreshInputSchema.safeParse({
      refreshToken: "",
    }).success).toBe(false);
    expect(googleAuthRevokeInputSchema.safeParse({
      token: "",
    }).success).toBe(false);

    const source = readFileSync(new URL(
      "../../src/modules/backlinks/ports/google-auth.port.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /\bOAuth2Client\b|\bCredentials\b|\bGaxiosError\b|google-auth-library/,
    );
    expectTypeOf(new FakeGoogleAuthAdapter()).toMatchTypeOf<GoogleAuthPort>();
  });
});
