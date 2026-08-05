import { describe, expect, it } from "vitest";

import {
  GoogleAuthLibraryClient,
  normalizeGoogleGrantedScopes,
} from "../../src/modules/backlinks/adapters/gmail/google-auth-library-client.js";
import { gmailOAuthScopes } from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";

const redirectUri =
  "http://localhost:7200/api/v1/projects/live001-canary/backlinks/gmail-connections/callback";

describe("Google Auth official client", () => {
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
});
