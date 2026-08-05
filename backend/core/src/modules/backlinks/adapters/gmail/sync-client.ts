import { z } from "zod";

import {
  gmailHistoryInputSchema,
  gmailHistoryResultSchema,
  gmailInitialSyncInputSchema,
  gmailInitialSyncResultSchema,
  gmailMessageInputSchema,
  gmailRawMessageSchema,
  gmailWatchInputSchema,
  gmailWatchResultSchema,
  type GmailHistoryInput,
  type GmailHistoryResult,
  type GmailInitialSyncInput,
  type GmailInitialSyncResult,
  type GmailMessageInput,
  type GmailRawMessage,
  type GmailSyncPort,
  type GmailWatchInput,
  type GmailWatchResult,
} from "../../ports/gmail-sync.port.js";

export const gmailSyncClientConfigSchema = z.object({
  enabled: z.boolean().default(false),
  initialQuery: z.string().trim().min(1).max(2_048).optional(),
}).strict();

export const gmailSyncClientAdapterFailureCodes = {
  disabled: "GMAIL_SYNC_CLIENT_DISABLED",
  misconfigured: "GMAIL_SYNC_CLIENT_MISCONFIGURED",
  invalidResponse: "GMAIL_SYNC_CLIENT_INVALID_RESPONSE",
  providerFailure: "GMAIL_SYNC_CLIENT_PROVIDER_FAILURE",
} as const;

export type GmailSyncClientAdapterFailureCode =
  (typeof gmailSyncClientAdapterFailureCodes)[
    keyof typeof gmailSyncClientAdapterFailureCodes
  ];

export class GmailSyncClientAdapterError extends Error {
  readonly code: GmailSyncClientAdapterFailureCode;
  readonly retryable = false;

  constructor(
    code: GmailSyncClientAdapterFailureCode,
    options?: ErrorOptions,
  ) {
    super(`Gmail Sync Client failed with ${code}.`, options);
    this.name = "GmailSyncClientAdapterError";
    this.code = code;
  }
}

export type GmailSyncInitialProviderRequest = Readonly<{
  gmailConnectionId: string;
  userId: "me";
  q: string;
  pageToken?: string;
  maxResults: number;
}>;

export type GmailSyncHistoryProviderRequest = Readonly<{
  gmailConnectionId: string;
  userId: "me";
  startHistoryId: string;
  historyTypes: readonly ["messageAdded"];
  pageToken?: string;
  maxResults: number;
}>;

export type GmailSyncMessageProviderRequest = Readonly<{
  gmailConnectionId: string;
  userId: "me";
  id: string;
  format: "raw";
}>;

export type GmailSyncWatchProviderRequest = Readonly<{
  gmailConnectionId: string;
  userId: "me";
  requestBody: Readonly<{
    topicName: string;
  }>;
}>;

export interface GmailSyncProviderClient {
  listInitial(request: GmailSyncInitialProviderRequest): Promise<unknown>;
  listHistory(request: GmailSyncHistoryProviderRequest): Promise<unknown>;
  getMessage(request: GmailSyncMessageProviderRequest): Promise<unknown>;
  watch(request: GmailSyncWatchProviderRequest): Promise<unknown>;
}

const gmailSyncProviderFailureSchema = z.object({
  kind: z.literal("http_response"),
  httpStatus: z.number().int().min(100).max(599),
}).strict();

export type GmailSyncProviderFailure = Readonly<
  z.output<typeof gmailSyncProviderFailureSchema>
>;

export class GmailSyncProviderError extends Error {
  readonly failure: GmailSyncProviderFailure;

  constructor(failure: GmailSyncProviderFailure, options?: ErrorOptions) {
    const parsed = gmailSyncProviderFailureSchema.parse(failure);
    super(`Gmail Sync provider failed with HTTP ${parsed.httpStatus}.`, options);
    this.name = "GmailSyncProviderError";
    this.failure = Object.freeze(parsed);
  }
}

export type GmailSyncClientAdapterOptions = Readonly<{
  config?: Readonly<{
    enabled?: boolean;
    initialQuery?: string;
  }>;
  client?: GmailSyncProviderClient;
}>;

const providerIdentifierSchema = z.string().trim().min(1).max(255);
const providerHistoryIdSchema = z.string().regex(/^[1-9][0-9]*$/u);
const providerPageTokenSchema = z.string().trim().min(1).max(2_048);
const providerEpochMillisSchema = z.string().regex(/^[0-9]+$/u);
const providerRawBase64UrlSchema = z.string().min(1)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/u);

const providerMessageReferenceSchema = z.object({
  id: z.unknown(),
  threadId: z.unknown(),
}).passthrough();

const initialProviderResponseSchema = z.object({
  historyId: z.unknown(),
  messages: z.array(providerMessageReferenceSchema).max(500).optional(),
  nextPageToken: z.unknown().optional(),
}).passthrough();

const historyProviderResponseSchema = z.object({
  historyId: z.unknown(),
  history: z.array(z.object({
    id: z.unknown(),
    messagesAdded: z.array(z.object({
      message: providerMessageReferenceSchema,
    }).passthrough()).max(500).optional(),
  }).passthrough()).max(500).optional(),
  nextPageToken: z.unknown().optional(),
}).passthrough();

const rawMessageProviderResponseSchema = z.object({
  id: z.unknown(),
  threadId: z.unknown(),
  historyId: z.unknown(),
  internalDate: z.unknown(),
  sizeEstimate: z.unknown(),
  raw: z.unknown(),
}).passthrough();

const watchProviderResponseSchema = z.object({
  historyId: z.unknown(),
  expiration: z.unknown(),
}).passthrough();

const fail = (
  code: GmailSyncClientAdapterFailureCode,
  cause?: unknown,
) => new GmailSyncClientAdapterError(
  code,
  cause === undefined ? undefined : { cause },
);

const parseProviderResponse = <Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw fail(
      gmailSyncClientAdapterFailureCodes.invalidResponse,
      parsed.error,
    );
  }
  return parsed.data;
};

const parseOptionalPageToken = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  return parseProviderResponse(providerPageTokenSchema, value);
};

const parseEpochMillis = (value: unknown): string => {
  const text = parseProviderResponse(providerEpochMillisSchema, value);
  const milliseconds = Number(text);
  if (!Number.isSafeInteger(milliseconds)) {
    throw fail(gmailSyncClientAdapterFailureCodes.invalidResponse);
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw fail(gmailSyncClientAdapterFailureCodes.invalidResponse);
  }
  return date.toISOString();
};

const mapInitialResponse = (value: unknown): GmailInitialSyncResult => {
  const response = parseProviderResponse(initialProviderResponseSchema, value);
  const messages = (response.messages ?? []).map((message) => ({
    providerMessageId: parseProviderResponse(
      providerIdentifierSchema,
      message.id,
    ),
    providerThreadId: parseProviderResponse(
      providerIdentifierSchema,
      message.threadId,
    ),
  }));
  const nextPageToken = parseOptionalPageToken(response.nextPageToken);

  return parseProviderResponse(gmailInitialSyncResultSchema, {
    snapshotHistoryId: parseProviderResponse(
      providerHistoryIdSchema,
      response.historyId,
    ),
    messages,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
};

const mapHistoryResponse = (value: unknown): GmailHistoryResult => {
  const response = parseProviderResponse(historyProviderResponseSchema, value);
  const messages = new Map<string, {
    providerMessageId: string;
    providerThreadId: string;
    historyId: string;
  }>();

  for (const history of response.history ?? []) {
    const historyId = parseProviderResponse(
      providerHistoryIdSchema,
      history.id,
    );
    for (const added of history.messagesAdded ?? []) {
      const providerMessageId = parseProviderResponse(
        providerIdentifierSchema,
        added.message.id,
      );
      messages.set(providerMessageId, {
        providerMessageId,
        providerThreadId: parseProviderResponse(
          providerIdentifierSchema,
          added.message.threadId,
        ),
        historyId,
      });
    }
  }

  const nextPageToken = parseOptionalPageToken(response.nextPageToken);
  return parseProviderResponse(gmailHistoryResultSchema, {
    kind: "page",
    latestHistoryId: parseProviderResponse(
      providerHistoryIdSchema,
      response.historyId,
    ),
    messages: [...messages.values()],
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
};

const mapRawMessageResponse = (value: unknown): GmailRawMessage => {
  const response = parseProviderResponse(
    rawMessageProviderResponseSchema,
    value,
  );
  const raw = parseProviderResponse(providerRawBase64UrlSchema, response.raw)
    .replace(/=+$/u, "");

  return parseProviderResponse(gmailRawMessageSchema, {
    providerMessageId: parseProviderResponse(
      providerIdentifierSchema,
      response.id,
    ),
    providerThreadId: parseProviderResponse(
      providerIdentifierSchema,
      response.threadId,
    ),
    historyId: parseProviderResponse(
      providerHistoryIdSchema,
      response.historyId,
    ),
    receivedAt: parseEpochMillis(response.internalDate),
    rawBase64Url: raw,
    estimatedSizeBytes: parseProviderResponse(
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      response.sizeEstimate,
    ),
  });
};

const mapWatchResponse = (value: unknown): GmailWatchResult => {
  const response = parseProviderResponse(watchProviderResponseSchema, value);
  return parseProviderResponse(gmailWatchResultSchema, {
    historyId: parseProviderResponse(
      providerHistoryIdSchema,
      response.historyId,
    ),
    expiresAt: parseEpochMillis(response.expiration),
  });
};

export class GmailSyncClientAdapter implements GmailSyncPort {
  readonly #enabled: boolean;
  readonly #initialQuery: string | undefined;
  readonly #client: GmailSyncProviderClient | undefined;

  constructor(options: GmailSyncClientAdapterOptions = {}) {
    const config = gmailSyncClientConfigSchema.parse(options.config ?? {});
    if (config.enabled && options.client === undefined) {
      throw fail(gmailSyncClientAdapterFailureCodes.misconfigured);
    }
    this.#enabled = config.enabled;
    this.#initialQuery = config.initialQuery;
    this.#client = options.client;
  }

  async listInitialMessages(
    input: GmailInitialSyncInput,
  ): Promise<GmailInitialSyncResult> {
    this.assertEnabled();
    const parsed = gmailInitialSyncInputSchema.parse(input);
    const receivedAfterSeconds = Math.floor(
      Date.parse(parsed.receivedAfter) / 1_000,
    );

    return this.execute(
      (client) => client.listInitial({
        gmailConnectionId: parsed.gmailConnectionId,
        userId: "me",
        q: [
          `after:${receivedAfterSeconds}`,
          this.#initialQuery,
        ].filter((value): value is string => value !== undefined).join(" "),
        ...(parsed.pageToken === undefined
          ? {}
          : { pageToken: parsed.pageToken }),
        maxResults: parsed.pageSize,
      }),
      mapInitialResponse,
    );
  }

  async listHistory(input: GmailHistoryInput): Promise<GmailHistoryResult> {
    this.assertEnabled();
    const parsed = gmailHistoryInputSchema.parse(input);

    return this.execute(
      (client) => client.listHistory({
        gmailConnectionId: parsed.gmailConnectionId,
        userId: "me",
        startHistoryId: parsed.startHistoryId,
        historyTypes: ["messageAdded"],
        ...(parsed.pageToken === undefined
          ? {}
          : { pageToken: parsed.pageToken }),
        maxResults: parsed.pageSize,
      }),
      mapHistoryResponse,
      (error) => error.failure.httpStatus === 404
        ? gmailHistoryResultSchema.parse({
          kind: "history_expired",
          startHistoryId: parsed.startHistoryId,
        })
        : undefined,
    );
  }

  async getMessage(input: GmailMessageInput): Promise<GmailRawMessage> {
    this.assertEnabled();
    const parsed = gmailMessageInputSchema.parse(input);
    return this.execute(
      (client) => client.getMessage({
        gmailConnectionId: parsed.gmailConnectionId,
        userId: "me",
        id: parsed.providerMessageId,
        format: "raw",
      }),
      mapRawMessageResponse,
    );
  }

  async watch(input: GmailWatchInput): Promise<GmailWatchResult> {
    this.assertEnabled();
    const parsed = gmailWatchInputSchema.parse(input);
    return this.execute(
      (client) => client.watch({
        gmailConnectionId: parsed.gmailConnectionId,
        userId: "me",
        requestBody: {
          topicName: parsed.topicName,
        },
      }),
      mapWatchResponse,
    );
  }

  private assertEnabled(): void {
    if (!this.#enabled) {
      throw fail(gmailSyncClientAdapterFailureCodes.disabled);
    }
  }

  private async execute<Result>(
    action: (client: GmailSyncProviderClient) => Promise<unknown>,
    mapResponse: (value: unknown) => Result,
    handleProviderError?: (
      error: GmailSyncProviderError,
    ) => Result | undefined,
  ): Promise<Result> {
    const client = this.#client;
    if (client === undefined) {
      throw fail(gmailSyncClientAdapterFailureCodes.misconfigured);
    }

    try {
      return mapResponse(await action(client));
    } catch (error) {
      if (error instanceof GmailSyncClientAdapterError) throw error;
      if (error instanceof GmailSyncProviderError) {
        const handled = handleProviderError?.(error);
        if (handled !== undefined) return handled;
      }
      throw fail(gmailSyncClientAdapterFailureCodes.providerFailure, error);
    }
  }
}
