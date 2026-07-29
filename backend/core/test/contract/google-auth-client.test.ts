import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  GoogleAuthClientAdapter,
  googleAuthClientConfigSchema,
  type GoogleAuthClient,
} from "../../src/modules/backlinks/adapters/gmail/auth-client.js";
import { gmailOAuthScopes } from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import {
  googleAuthFailureCodes,
  type GoogleAuthCallbackInput,
  type GoogleAuthCallbackResult,
  type GoogleAuthRefreshInput,
  type GoogleAuthRefreshResult,
  type GoogleAuthRequestInput,
  type GoogleAuthRequestResult,
  type GoogleAuthRevokeInput,
} from "../../src/modules/backlinks/ports/google-auth.port.js";

const redirectUri =
  "https://app.example.com/api/v1/gmail-connections/callback";

const authorizeInput: GoogleAuthRequestInput = {
  redirectUri,
  state: "oauth-state",
  codeChallenge: "pkce-challenge",
  codeChallengeMethod: "S256",
  requestedScopes: gmailOAuthScopes,
};

const callbackInput: GoogleAuthCallbackInput = {
  authorizationCode: "authorization-code-secret",
  codeVerifier: "pkce-verifier-secret",
  redirectUri,
};

const refreshInput: GoogleAuthRefreshInput = {
  refreshToken: "refresh-token-secret",
};

const revokeInput: GoogleAuthRevokeInput = {
  token: "token-to-revoke-secret",
};

const authorizationResult: GoogleAuthRequestResult = {
  authorizationUrl: "https://accounts.google.test/o/oauth2/v2/auth",
};

const callbackResult: GoogleAuthCallbackResult = {
  identity: {
    subject: "google-subject-fixture",
    email: "owner@example.test",
    emailVerified: true,
  },
  tokens: {
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    tokenType: "Bearer",
    expiresAt: "2026-07-27T04:00:00.000Z",
    grantedScopes: gmailOAuthScopes,
  },
};

const refreshResult: GoogleAuthRefreshResult = {
  accessToken: "fake-refreshed-access-token",
  tokenType: "Bearer",
  expiresAt: "2026-07-27T05:00:00.000Z",
  grantedScopes: gmailOAuthScopes,
};

const createClient = () => {
  const createAuthorizationUrl = vi.fn(
    async (input: GoogleAuthRequestInput) => {
      void input;
      return authorizationResult;
    },
  );
  const exchangeAuthorizationCode = vi.fn(
    async (input: GoogleAuthCallbackInput) => {
      void input;
      return callbackResult;
    },
  );
  const refreshAccessToken = vi.fn(
    async (input: GoogleAuthRefreshInput) => {
      void input;
      return refreshResult;
    },
  );
  const revokeToken = vi.fn(
    async (input: GoogleAuthRevokeInput) => {
      void input;
    },
  );
  const client: GoogleAuthClient = {
    createAuthorizationUrl,
    exchangeAuthorizationCode,
    refreshAccessToken,
    revokeToken,
  };

  return {
    client,
    createAuthorizationUrl,
    exchangeAuthorizationCode,
    refreshAccessToken,
    revokeToken,
  };
};

const createEnabledAdapter = (client: GoogleAuthClient) =>
  new GoogleAuthClientAdapter({
    client,
    config: {
      enabled: true,
      redirectUris: [redirectUri],
    },
  });

describe("BL-AI-102 Google Auth Real Adapter shell", () => {
  it("defaults the provider off and never invokes the injected client", async () => {
    const fake = createClient();
    const adapter = new GoogleAuthClientAdapter({ client: fake.client });

    await expect(adapter.authorize(authorizeInput)).rejects.toMatchObject({
      operation: "authorize",
      code: googleAuthFailureCodes.permanentFailure,
      retryable: false,
    });
    await expect(adapter.callback(callbackInput)).rejects.toMatchObject({
      operation: "callback",
      code: googleAuthFailureCodes.permanentFailure,
      retryable: false,
    });
    await expect(adapter.refresh(refreshInput)).rejects.toMatchObject({
      operation: "refresh",
      code: googleAuthFailureCodes.permanentFailure,
      retryable: false,
    });
    await expect(adapter.revoke(revokeInput)).rejects.toMatchObject({
      operation: "revoke",
      code: googleAuthFailureCodes.permanentFailure,
      retryable: false,
    });

    expect(fake.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(fake.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(fake.refreshAccessToken).not.toHaveBeenCalled();
    expect(fake.revokeToken).not.toHaveBeenCalled();
  });

  it("uses the fixed minimal V1A Scope set in canonical order", async () => {
    const fake = createClient();
    const adapter = createEnabledAdapter(fake.client);

    await expect(adapter.authorize({
      ...authorizeInput,
      requestedScopes: [...gmailOAuthScopes].reverse(),
    })).resolves.toEqual(authorizationResult);

    expect(fake.createAuthorizationUrl).toHaveBeenCalledOnce();
    expect(fake.createAuthorizationUrl).toHaveBeenCalledWith({
      ...authorizeInput,
      requestedScopes: gmailOAuthScopes,
    });
  });

  it.each([
    ["missing", gmailOAuthScopes.slice(0, -1)],
    ["extra", [...gmailOAuthScopes, "https://www.googleapis.com/auth/gmail.readonly"]],
    ["duplicate", [...gmailOAuthScopes.slice(0, -1), "openid"]],
  ])("rejects a %s Scope set before invoking the client", async (
    _case,
    requestedScopes,
  ) => {
    const fake = createClient();
    const adapter = createEnabledAdapter(fake.client);

    await expect(adapter.authorize({
      ...authorizeInput,
      requestedScopes,
    })).rejects.toMatchObject({
      operation: "authorize",
      code: googleAuthFailureCodes.invalidRequest,
      retryable: false,
    });
    expect(fake.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("requires an exact allowlisted redirect URI for authorize and callback", async () => {
    const fake = createClient();
    const adapter = createEnabledAdapter(fake.client);
    const unlistedRedirectUri = `${redirectUri}/`;

    await expect(adapter.authorize({
      ...authorizeInput,
      redirectUri: unlistedRedirectUri,
    })).rejects.toMatchObject({
      operation: "authorize",
      code: googleAuthFailureCodes.invalidRequest,
    });
    await expect(adapter.callback({
      ...callbackInput,
      redirectUri: unlistedRedirectUri,
    })).rejects.toMatchObject({
      operation: "callback",
      code: googleAuthFailureCodes.invalidRequest,
    });

    expect(fake.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(fake.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("delegates callback, refresh, and revoke through owned contracts", async () => {
    const fake = createClient();
    const adapter = createEnabledAdapter(fake.client);

    await expect(adapter.callback(callbackInput)).resolves.toEqual(
      callbackResult,
    );
    await expect(adapter.refresh(refreshInput)).resolves.toEqual(refreshResult);
    await expect(adapter.revoke(revokeInput)).resolves.toEqual({
      revoked: true,
    });

    expect(fake.exchangeAuthorizationCode).toHaveBeenCalledWith(callbackInput);
    expect(fake.refreshAccessToken).toHaveBeenCalledWith(refreshInput);
    expect(fake.revokeToken).toHaveBeenCalledWith(revokeInput);
    expect(JSON.stringify(adapter)).not.toMatch(
      /authorization-code-secret|pkce-verifier-secret|refresh-token-secret|token-to-revoke-secret/,
    );
  });

  it("validates local configuration and contains no SDK or network client", () => {
    expect(googleAuthClientConfigSchema.parse({})).toEqual({
      enabled: false,
      redirectUris: [],
    });
    expect(googleAuthClientConfigSchema.safeParse({
      enabled: true,
      redirectUris: [],
    }).success).toBe(false);
    expect(googleAuthClientConfigSchema.safeParse({
      enabled: true,
      redirectUris: [redirectUri, redirectUri],
    }).success).toBe(false);

    const source = readFileSync(new URL(
      "../../src/modules/backlinks/adapters/gmail/auth-client.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /\bfetch\s*\(|\bOAuth2Client\b|\bCredentials\b|\bGaxiosError\b|google-auth-library/,
    );
  });
});
