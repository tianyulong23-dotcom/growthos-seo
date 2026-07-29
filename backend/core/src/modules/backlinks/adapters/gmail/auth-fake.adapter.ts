import {
  GoogleAuthError,
  googleAuthCallbackInputSchema,
  googleAuthCallbackResultSchema,
  googleAuthFailureRetryability,
  googleAuthRefreshInputSchema,
  googleAuthRefreshResultSchema,
  googleAuthRequestInputSchema,
  googleAuthRequestResultSchema,
  googleAuthRevokeInputSchema,
  googleAuthRevokeResultSchema,
  type GoogleAuthCallbackInput,
  type GoogleAuthCallbackResult,
  type GoogleAuthFailureCode,
  type GoogleAuthOperation,
  type GoogleAuthPort,
  type GoogleAuthRefreshInput,
  type GoogleAuthRefreshResult,
  type GoogleAuthRequestInput,
  type GoogleAuthRequestResult,
  type GoogleAuthRevokeInput,
  type GoogleAuthRevokeResult,
} from "../../ports/google-auth.port.js";

const fixtureScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

const defaultCallbackResult = {
  identity: {
    subject: "google-subject-fixture",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Fixture Owner",
    hostedDomain: "example.test",
  },
  tokens: {
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    tokenType: "Bearer",
    expiresAt: "2026-07-27T04:00:00.000Z",
    grantedScopes: fixtureScopes,
  },
} as const;

const defaultRefreshResult = {
  accessToken: "fake-refreshed-access-token",
  tokenType: "Bearer",
  expiresAt: "2026-07-27T05:00:00.000Z",
  grantedScopes: fixtureScopes,
} as const;

export type FakeGoogleAuthAdapterOptions = Readonly<{
  failures?: Partial<Record<GoogleAuthOperation, GoogleAuthFailureCode>>;
  callbackResult?: GoogleAuthCallbackResult;
  refreshResult?: GoogleAuthRefreshResult;
}>;

export class FakeGoogleAuthAdapter implements GoogleAuthPort {
  readonly #failures: Partial<
    Record<GoogleAuthOperation, GoogleAuthFailureCode>
  >;
  readonly #callbackResult: GoogleAuthCallbackResult;
  readonly #refreshResult: GoogleAuthRefreshResult;
  readonly #calls: Record<GoogleAuthOperation, number> = {
    authorize: 0,
    callback: 0,
    refresh: 0,
    revoke: 0,
  };

  constructor(options: FakeGoogleAuthAdapterOptions = {}) {
    this.#failures = Object.freeze({ ...options.failures });
    this.#callbackResult = googleAuthCallbackResultSchema.parse(
      options.callbackResult ?? defaultCallbackResult,
    );
    this.#refreshResult = googleAuthRefreshResultSchema.parse(
      options.refreshResult ?? defaultRefreshResult,
    );
  }

  get calls(): Readonly<Record<GoogleAuthOperation, number>> {
    return Object.freeze({ ...this.#calls });
  }

  async authorize(
    input: GoogleAuthRequestInput,
  ): Promise<GoogleAuthRequestResult> {
    const parsed = googleAuthRequestInputSchema.parse(input);
    this.#calls.authorize += 1;
    this.failIfConfigured("authorize");

    const url = new URL("https://accounts.google.test/o/oauth2/v2/auth");
    url.searchParams.set("redirect_uri", parsed.redirectUri);
    url.searchParams.set("state", parsed.state);
    url.searchParams.set("code_challenge", parsed.codeChallenge);
    url.searchParams.set(
      "code_challenge_method",
      parsed.codeChallengeMethod,
    );
    for (const scope of parsed.requestedScopes) {
      url.searchParams.append("scope", scope);
    }

    return googleAuthRequestResultSchema.parse({
      authorizationUrl: url.toString(),
    });
  }

  async callback(
    input: GoogleAuthCallbackInput,
  ): Promise<GoogleAuthCallbackResult> {
    googleAuthCallbackInputSchema.parse(input);
    this.#calls.callback += 1;
    this.failIfConfigured("callback");
    return googleAuthCallbackResultSchema.parse(this.#callbackResult);
  }

  async refresh(
    input: GoogleAuthRefreshInput,
  ): Promise<GoogleAuthRefreshResult> {
    googleAuthRefreshInputSchema.parse(input);
    this.#calls.refresh += 1;
    this.failIfConfigured("refresh");
    return googleAuthRefreshResultSchema.parse(this.#refreshResult);
  }

  async revoke(
    input: GoogleAuthRevokeInput,
  ): Promise<GoogleAuthRevokeResult> {
    googleAuthRevokeInputSchema.parse(input);
    this.#calls.revoke += 1;
    this.failIfConfigured("revoke");
    return googleAuthRevokeResultSchema.parse({ revoked: true });
  }

  private failIfConfigured(operation: GoogleAuthOperation): void {
    const code = this.#failures[operation];
    if (code === undefined) return;

    throw new GoogleAuthError({
      operation,
      code,
      retryable: googleAuthFailureRetryability[code],
    });
  }
}
