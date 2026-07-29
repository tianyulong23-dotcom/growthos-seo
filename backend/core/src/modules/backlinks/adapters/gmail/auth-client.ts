import { z } from "zod";

import { gmailOAuthScopes } from "../../domain/sending/oauth-attempt.js";
import {
  GoogleAuthError,
  googleAuthCallbackInputSchema,
  googleAuthCallbackResultSchema,
  googleAuthFailureCodes,
  googleAuthFailureRetryability,
  googleAuthRefreshInputSchema,
  googleAuthRefreshResultSchema,
  googleAuthRequestInputSchema,
  googleAuthRequestResultSchema,
  googleAuthRevokeInputSchema,
  googleAuthRevokeResultSchema,
  type GoogleAuthCallbackInput,
  type GoogleAuthCallbackResult,
  type GoogleAuthOperation,
  type GoogleAuthPort,
  type GoogleAuthRefreshInput,
  type GoogleAuthRefreshResult,
  type GoogleAuthRequestInput,
  type GoogleAuthRequestResult,
  type GoogleAuthRevokeInput,
  type GoogleAuthRevokeResult,
} from "../../ports/google-auth.port.js";

const redirectUriSchema = z.url().max(2_048);

export const googleAuthClientConfigSchema = z.object({
  enabled: z.boolean().default(false),
  redirectUris: z.array(redirectUriSchema).max(32).default([]),
}).strict().superRefine((config, context) => {
  if (config.enabled && config.redirectUris.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["redirectUris"],
      message: "At least one redirect URI is required when Google Auth is enabled.",
    });
  }
  if (new Set(config.redirectUris).size !== config.redirectUris.length) {
    context.addIssue({
      code: "custom",
      path: ["redirectUris"],
      message: "Redirect URIs must be unique.",
    });
  }
});

type ParsedGoogleAuthClientConfig = z.output<
  typeof googleAuthClientConfigSchema
>;

export type GoogleAuthClientConfig = Readonly<
  Omit<ParsedGoogleAuthClientConfig, "redirectUris"> & {
    redirectUris: readonly string[];
  }
>;

export interface GoogleAuthClient {
  createAuthorizationUrl(
    input: GoogleAuthRequestInput,
  ): Promise<GoogleAuthRequestResult>;
  exchangeAuthorizationCode(
    input: GoogleAuthCallbackInput,
  ): Promise<GoogleAuthCallbackResult>;
  refreshAccessToken(
    input: GoogleAuthRefreshInput,
  ): Promise<GoogleAuthRefreshResult>;
  revokeToken(input: GoogleAuthRevokeInput): Promise<void>;
}

export type GoogleAuthClientAdapterOptions = Readonly<{
  config?: Readonly<{
    enabled?: boolean;
    redirectUris?: readonly string[];
  }>;
  client?: GoogleAuthClient;
}>;

const fail = (
  operation: GoogleAuthOperation,
  code: typeof googleAuthFailureCodes.invalidRequest
    | typeof googleAuthFailureCodes.permanentFailure,
) => new GoogleAuthError({
  operation,
  code,
  retryable: googleAuthFailureRetryability[code],
});

const hasFixedScopes = (scopes: readonly string[]) => {
  const uniqueScopes = new Set(scopes);
  return uniqueScopes.size === gmailOAuthScopes.length
    && scopes.length === gmailOAuthScopes.length
    && gmailOAuthScopes.every((scope) => uniqueScopes.has(scope));
};

export class GoogleAuthClientAdapter implements GoogleAuthPort {
  readonly #enabled: boolean;
  readonly #redirectUris: ReadonlySet<string>;
  readonly #client: GoogleAuthClient | undefined;

  constructor(options: GoogleAuthClientAdapterOptions = {}) {
    const config = googleAuthClientConfigSchema.parse(options.config ?? {});
    if (config.enabled && options.client === undefined) {
      throw new TypeError(
        "Google Auth client is required when the provider is enabled.",
      );
    }

    this.#enabled = config.enabled;
    this.#redirectUris = new Set(config.redirectUris);
    this.#client = options.client;
  }

  async authorize(
    input: GoogleAuthRequestInput,
  ): Promise<GoogleAuthRequestResult> {
    const operation = "authorize";
    this.assertEnabled(operation);
    const parsed = googleAuthRequestInputSchema.safeParse(input);
    if (!parsed.success) throw fail(operation, googleAuthFailureCodes.invalidRequest);
    this.assertRedirectUri(operation, parsed.data.redirectUri);
    if (!hasFixedScopes(parsed.data.requestedScopes)) {
      throw fail(operation, googleAuthFailureCodes.invalidRequest);
    }

    return this.execute(operation, async (client) =>
      googleAuthRequestResultSchema.parse(
        await client.createAuthorizationUrl({
          ...parsed.data,
          requestedScopes: gmailOAuthScopes,
        }),
      ));
  }

  async callback(
    input: GoogleAuthCallbackInput,
  ): Promise<GoogleAuthCallbackResult> {
    const operation = "callback";
    this.assertEnabled(operation);
    const parsed = googleAuthCallbackInputSchema.safeParse(input);
    if (!parsed.success) throw fail(operation, googleAuthFailureCodes.invalidRequest);
    this.assertRedirectUri(operation, parsed.data.redirectUri);

    return this.execute(operation, async (client) =>
      googleAuthCallbackResultSchema.parse(
        await client.exchangeAuthorizationCode(parsed.data),
      ));
  }

  async refresh(
    input: GoogleAuthRefreshInput,
  ): Promise<GoogleAuthRefreshResult> {
    const operation = "refresh";
    this.assertEnabled(operation);
    const parsed = googleAuthRefreshInputSchema.safeParse(input);
    if (!parsed.success) throw fail(operation, googleAuthFailureCodes.invalidRequest);

    return this.execute(operation, async (client) =>
      googleAuthRefreshResultSchema.parse(
        await client.refreshAccessToken(parsed.data),
      ));
  }

  async revoke(
    input: GoogleAuthRevokeInput,
  ): Promise<GoogleAuthRevokeResult> {
    const operation = "revoke";
    this.assertEnabled(operation);
    const parsed = googleAuthRevokeInputSchema.safeParse(input);
    if (!parsed.success) throw fail(operation, googleAuthFailureCodes.invalidRequest);

    return this.execute(operation, async (client) => {
      await client.revokeToken(parsed.data);
      return googleAuthRevokeResultSchema.parse({ revoked: true });
    });
  }

  private assertEnabled(operation: GoogleAuthOperation): void {
    if (!this.#enabled) {
      throw fail(operation, googleAuthFailureCodes.permanentFailure);
    }
  }

  private assertRedirectUri(
    operation: GoogleAuthOperation,
    redirectUri: string,
  ): void {
    if (!this.#redirectUris.has(redirectUri)) {
      throw fail(operation, googleAuthFailureCodes.invalidRequest);
    }
  }

  private async execute<Result>(
    operation: GoogleAuthOperation,
    action: (client: GoogleAuthClient) => Promise<Result>,
  ): Promise<Result> {
    const client = this.#client;
    if (client === undefined) {
      throw fail(operation, googleAuthFailureCodes.permanentFailure);
    }

    try {
      return await action(client);
    } catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      throw fail(operation, googleAuthFailureCodes.permanentFailure);
    }
  }
}
