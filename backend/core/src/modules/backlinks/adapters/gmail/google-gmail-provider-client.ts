import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";

import {
  GmailSendProviderError,
  type GmailSendProviderClient,
  type GmailSendProviderRequest,
} from "./send-client.js";
import {
  GmailSyncProviderError,
  type GmailSyncHistoryProviderRequest,
  type GmailSyncInitialProviderRequest,
  type GmailSyncMessageProviderRequest,
  type GmailSyncProviderClient,
  type GmailSyncWatchProviderRequest,
} from "./sync-client.js";

export type GoogleGmailAccessTokenResolver =
  (gmailConnectionId: string) => Promise<string>;

type GoogleGmailProviderClientOptions = Readonly<{
  resolveAccessToken: GoogleGmailAccessTokenResolver;
  createClient?: (accessToken: string) => gmail_v1.Gmail;
}>;

const httpStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const response = "response" in error
    && typeof error.response === "object"
    && error.response !== null
    ? error.response as Record<string, unknown>
    : undefined;
  const status = response?.status;
  return typeof status === "number" ? status : undefined;
};

const retryAfterSeconds = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }
  const response = error.response;
  if (
    typeof response !== "object"
    || response === null
    || !("headers" in response)
    || typeof response.headers !== "object"
    || response.headers === null
  ) {
    return undefined;
  }
  const value = (response.headers as Record<string, unknown>)["retry-after"];
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number"
      && Number.isSafeInteger(parsed)
      && parsed >= 0
    ? parsed
    : undefined;
};

const providerReason = (
  error: unknown,
): "rate_limit" | "quota" | "scope" | "domain_policy" | undefined => {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }
  const response = error.response;
  if (
    typeof response !== "object"
    || response === null
    || !("data" in response)
    || typeof response.data !== "object"
    || response.data === null
  ) {
    return undefined;
  }
  const data = response.data as Record<string, unknown>;
  const errorBody = typeof data.error === "object" && data.error !== null
    ? data.error as Record<string, unknown>
    : undefined;
  const errors = Array.isArray(errorBody?.errors) ? errorBody.errors : [];
  const reason = errors
    .map((value) => typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).reason
      : undefined)
    .find((value): value is string => typeof value === "string");
  if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
    return "rate_limit";
  }
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
    return "quota";
  }
  if (reason === "insufficientPermissions") {
    return "scope";
  }
  if (reason === "domainPolicy") {
    return "domain_policy";
  }
  return undefined;
};

const isTimeout = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT";
};

const defaultCreateClient = (accessToken: string): gmail_v1.Gmail => {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  return gmail({ version: "v1", auth });
};

export class GoogleGmailProviderClient
implements GmailSendProviderClient, GmailSyncProviderClient {
  readonly #resolveAccessToken: GoogleGmailAccessTokenResolver;
  readonly #createClient: (accessToken: string) => gmail_v1.Gmail;

  constructor(options: GoogleGmailProviderClientOptions) {
    this.#resolveAccessToken = options.resolveAccessToken;
    this.#createClient = options.createClient ?? defaultCreateClient;
  }

  async send(request: GmailSendProviderRequest): Promise<unknown> {
    let client: gmail_v1.Gmail;
    try {
      client = await this.client(request.gmailConnectionId);
    } catch {
      throw new GmailSendProviderError({
        kind: "transport",
        requestDispatched: false,
      });
    }

    try {
      const response = await client.users.messages.send({
        userId: request.userId,
        requestBody: request.requestBody,
      });
      return {
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      const status = httpStatus(error);
      if (status !== undefined) {
        throw new GmailSendProviderError({
          kind: "http_response",
          httpStatus: status,
          ...(providerReason(error) === undefined
            ? {}
            : { reason: providerReason(error) }),
          ...(retryAfterSeconds(error) === undefined
            ? {}
            : { retryAfterSeconds: retryAfterSeconds(error) }),
        });
      }
      throw new GmailSendProviderError({
        kind: isTimeout(error) ? "timeout" : "transport",
        requestDispatched: true,
      });
    }
  }

  async listInitial(
    request: GmailSyncInitialProviderRequest,
  ): Promise<unknown> {
    return this.syncRequest(request.gmailConnectionId, async (client) => {
      const response = await client.users.messages.list({
        userId: request.userId,
        q: request.q,
        maxResults: request.maxResults,
        ...(request.pageToken === undefined
          ? {}
          : { pageToken: request.pageToken }),
      });
      const profile = await client.users.getProfile({
        userId: request.userId,
      });
      return {
        ...response.data,
        historyId: profile.data.historyId,
      };
    });
  }

  async listHistory(
    request: GmailSyncHistoryProviderRequest,
  ): Promise<unknown> {
    return this.syncRequest(request.gmailConnectionId, async (client) => {
      const response = await client.users.history.list({
        userId: request.userId,
        startHistoryId: request.startHistoryId,
        historyTypes: [...request.historyTypes],
        maxResults: request.maxResults,
        ...(request.pageToken === undefined
          ? {}
          : { pageToken: request.pageToken }),
      });
      return response.data;
    });
  }

  async getMessage(
    request: GmailSyncMessageProviderRequest,
  ): Promise<unknown> {
    return this.syncRequest(request.gmailConnectionId, async (client) => {
      const response = await client.users.messages.get({
        userId: request.userId,
        id: request.id,
        format: request.format,
      });
      return response.data;
    });
  }

  async watch(request: GmailSyncWatchProviderRequest): Promise<unknown> {
    return this.syncRequest(request.gmailConnectionId, async (client) => {
      const response = await client.users.watch({
        userId: request.userId,
        requestBody: request.requestBody,
      });
      return response.data;
    });
  }

  private async client(connectionId: string): Promise<gmail_v1.Gmail> {
    return this.#createClient(await this.#resolveAccessToken(connectionId));
  }

  private async syncRequest(
    connectionId: string,
    operation: (client: gmail_v1.Gmail) => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await operation(await this.client(connectionId));
    } catch (error) {
      const status = httpStatus(error);
      throw new GmailSyncProviderError({
        kind: "http_response",
        httpStatus: status ?? 503,
      });
    }
  }
}
