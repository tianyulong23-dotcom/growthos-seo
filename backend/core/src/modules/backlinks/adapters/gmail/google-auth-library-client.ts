import {
  CodeChallengeMethod,
  OAuth2Client,
  type Credentials,
} from "google-auth-library";

import { gmailOAuthScopes } from "../../domain/sending/oauth-attempt.js";
import type { GoogleAuthClient } from "./auth-client.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
  googleAuthFailureRetryability,
  type GoogleAuthCallbackInput,
  type GoogleAuthCallbackResult,
  type GoogleAuthOperation,
  type GoogleAuthRefreshInput,
  type GoogleAuthRefreshResult,
  type GoogleAuthRequestInput,
  type GoogleAuthRequestResult,
  type GoogleAuthRevokeInput,
} from "../../ports/google-auth.port.js";

export type GoogleAuthLibraryClientOptions = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

const fail = (
  operation: GoogleAuthOperation,
  code: keyof typeof googleAuthFailureRetryability,
  error?: unknown,
) => new GoogleAuthError({
  operation,
  code,
  retryable: googleAuthFailureRetryability[code],
  ...providerMetadata(error),
}, error === undefined ? undefined : { cause: error });

const providerMetadata = (
  error: unknown,
): Readonly<{ httpStatus?: number; providerRequestId?: string }> => {
  if (typeof error !== "object" || error === null) return {};
  const response = "response" in error
    && typeof error.response === "object"
    && error.response !== null
    ? error.response as Record<string, unknown>
    : undefined;
  const headers = response !== undefined
    && typeof response.headers === "object"
    && response.headers !== null
    ? response.headers as Record<string, unknown>
    : undefined;
  const status = response?.status;
  const requestId = headers?.["x-request-id"]
    ?? headers?.["x-guploader-uploadid"];
  return {
    ...(typeof status === "number" ? { httpStatus: status } : {}),
    ...(typeof requestId === "string" && requestId.length > 0
      ? { providerRequestId: requestId }
      : {}),
  };
};

const providerErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }
  const response = error.response;
  if (typeof response !== "object" || response === null || !("data" in response)) {
    return undefined;
  }
  const data = response.data;
  if (typeof data !== "object" || data === null || !("error" in data)) {
    return undefined;
  }
  return typeof data.error === "string" ? data.error : undefined;
};

const transientTransportCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
]);

const transportCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
};

const googleScopeAliases = new Map([
  ["https://www.googleapis.com/auth/userinfo.email", "email"],
  ["https://www.googleapis.com/auth/userinfo.profile", "profile"],
]);

export const normalizeGoogleGrantedScopes = (
  scopes: readonly string[],
): readonly string[] => {
  const approvedOrder = new Map(
    gmailOAuthScopes.map((scope, index) => [scope, index]),
  );
  const normalized = [
    ...new Set(scopes.map((scope) => googleScopeAliases.get(scope) ?? scope)),
  ];
  normalized.sort((left, right) => {
    const leftOrder = approvedOrder.get(left);
    const rightOrder = approvedOrder.get(right);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (leftOrder ?? Number.MAX_SAFE_INTEGER)
        - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
  return Object.freeze(normalized);
};

export const mapGoogleAuthLibraryError = (
  operation: GoogleAuthOperation,
  error: unknown,
): GoogleAuthError => {
  if (error instanceof GoogleAuthError) return error;
  const metadata = providerMetadata(error);
  const providerCode = providerErrorCode(error);
  if (metadata.httpStatus === 429) {
    return fail(operation, googleAuthFailureCodes.rateLimited, error);
  }
  if (
    metadata.httpStatus === 408
    || (metadata.httpStatus !== undefined && metadata.httpStatus >= 500)
    || transientTransportCodes.has(transportCode(error) ?? "")
  ) {
    return fail(operation, googleAuthFailureCodes.temporaryFailure, error);
  }
  if (providerCode === "access_denied") {
    return fail(operation, googleAuthFailureCodes.authorizationDenied, error);
  }
  if (providerCode === "invalid_grant") {
    return fail(operation, googleAuthFailureCodes.authExpired, error);
  }
  if (metadata.httpStatus === 400) {
    return fail(operation, googleAuthFailureCodes.invalidRequest, error);
  }
  return fail(operation, googleAuthFailureCodes.permanentFailure, error);
};

const requireText = (
  value: string | null | undefined,
  operation: GoogleAuthOperation,
): string => {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw fail(operation, googleAuthFailureCodes.permanentFailure);
  }
  return value;
};

const tokenSet = async (
  client: OAuth2Client,
  credentials: Credentials,
  operation: "callback" | "refresh",
  requireRefreshToken: boolean,
): Promise<GoogleAuthRefreshResult> => {
  const accessToken = requireText(credentials.access_token, operation);
  const expiryDate = credentials.expiry_date;
  if (
    typeof expiryDate !== "number"
    || !Number.isSafeInteger(expiryDate)
    || expiryDate <= Date.now()
  ) {
    throw fail(operation, googleAuthFailureCodes.permanentFailure);
  }
  const tokenInfo = await client.getTokenInfo(accessToken);
  const refreshToken = credentials.refresh_token ?? undefined;
  if (requireRefreshToken && refreshToken === undefined) {
    throw fail(operation, googleAuthFailureCodes.authorizationDenied);
  }
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    tokenType: "Bearer",
    expiresAt: new Date(expiryDate).toISOString(),
    grantedScopes: normalizeGoogleGrantedScopes(tokenInfo.scopes),
  };
};

export class GoogleAuthLibraryClient implements GoogleAuthClient {
  readonly #clientId: string;
  readonly #clientSecret: string;

  constructor(options: GoogleAuthLibraryClientOptions) {
    if (
      options.clientId.trim().length === 0
      || options.clientSecret.trim().length === 0
    ) {
      throw new TypeError("Google OAuth client credentials are required.");
    }
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
  }

  async createAuthorizationUrl(
    input: GoogleAuthRequestInput,
  ): Promise<GoogleAuthRequestResult> {
    try {
      const client = this.client(input.redirectUri);
      return {
        authorizationUrl: client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: false,
          scope: [...input.requestedScopes],
          state: input.state,
          code_challenge: input.codeChallenge,
          code_challenge_method: CodeChallengeMethod.S256,
        }),
      };
    } catch (error) {
      throw mapGoogleAuthLibraryError("authorize", error);
    }
  }

  async exchangeAuthorizationCode(
    input: GoogleAuthCallbackInput,
  ): Promise<GoogleAuthCallbackResult> {
    try {
      const client = this.client(input.redirectUri);
      const { tokens } = await client.getToken({
        code: input.authorizationCode,
        codeVerifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      });
      const idToken = requireText(tokens.id_token, "callback");
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.#clientId,
      });
      const payload = ticket.getPayload();
      if (
        payload === undefined
        || payload.sub.length === 0
        || typeof payload.email !== "string"
      ) {
        throw fail("callback", googleAuthFailureCodes.permanentFailure);
      }
      return {
        identity: {
          subject: payload.sub,
          email: payload.email,
          emailVerified: payload.email_verified === true,
          ...(typeof payload.name === "string" && payload.name.length > 0
            ? { displayName: payload.name }
            : {}),
          ...(typeof payload.hd === "string" && payload.hd.length > 0
            ? { hostedDomain: payload.hd }
            : {}),
        },
        tokens: await tokenSet(client, tokens, "callback", true),
      };
    } catch (error) {
      throw mapGoogleAuthLibraryError("callback", error);
    }
  }

  async refreshAccessToken(
    input: GoogleAuthRefreshInput,
  ): Promise<GoogleAuthRefreshResult> {
    try {
      const client = this.client();
      client.setCredentials({ refresh_token: input.refreshToken });
      const { credentials } = await client.refreshAccessToken();
      return tokenSet(client, credentials, "refresh", false);
    } catch (error) {
      throw mapGoogleAuthLibraryError("refresh", error);
    }
  }

  async revokeToken(input: GoogleAuthRevokeInput): Promise<void> {
    try {
      await this.client().revokeToken(input.token);
    } catch (error) {
      throw mapGoogleAuthLibraryError("revoke", error);
    }
  }

  private client(redirectUri?: string): OAuth2Client {
    return new OAuth2Client({
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
      ...(redirectUri === undefined ? {} : { redirectUri }),
    });
  }
}
