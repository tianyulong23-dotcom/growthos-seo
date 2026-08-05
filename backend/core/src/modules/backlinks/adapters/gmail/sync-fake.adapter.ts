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

const defaultRawMessage = gmailRawMessageSchema.parse({
  providerMessageId: "fake-gmail-message-1",
  providerThreadId: "fake-gmail-thread-1",
  historyId: "101",
  receivedAt: "2026-07-28T00:00:00.000Z",
  rawBase64Url: Buffer.from(
    "MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nFake reply.",
  ).toString("base64url"),
  estimatedSizeBytes: 64,
});

const defaultInitialResult = gmailInitialSyncResultSchema.parse({
  snapshotHistoryId: "100",
  messages: [{
    providerMessageId: defaultRawMessage.providerMessageId,
    providerThreadId: defaultRawMessage.providerThreadId,
  }],
});

const defaultHistoryResult = gmailHistoryResultSchema.parse({
  kind: "page",
  latestHistoryId: defaultRawMessage.historyId,
  messages: [{
    providerMessageId: defaultRawMessage.providerMessageId,
    providerThreadId: defaultRawMessage.providerThreadId,
    historyId: defaultRawMessage.historyId,
  }],
});

const defaultWatchResult = gmailWatchResultSchema.parse({
  historyId: "102",
  expiresAt: "2026-08-04T00:00:00.000Z",
});

export type FakeGmailSyncAdapterOptions = Readonly<{
  initialResult?: GmailInitialSyncResult;
  historyResult?: GmailHistoryResult;
  messages?: readonly GmailRawMessage[];
  watchResult?: GmailWatchResult;
}>;

export type FakeGmailSyncCalls = Readonly<{
  initial: readonly GmailInitialSyncInput[];
  history: readonly GmailHistoryInput[];
  message: readonly GmailMessageInput[];
  watch: readonly GmailWatchInput[];
}>;

export class FakeGmailSyncAdapter implements GmailSyncPort {
  readonly #initialResult: GmailInitialSyncResult;
  readonly #historyResult: GmailHistoryResult;
  readonly #messages: ReadonlyMap<string, GmailRawMessage>;
  readonly #watchResult: GmailWatchResult;
  readonly #initialCalls: GmailInitialSyncInput[] = [];
  readonly #historyCalls: GmailHistoryInput[] = [];
  readonly #messageCalls: GmailMessageInput[] = [];
  readonly #watchCalls: GmailWatchInput[] = [];

  constructor(options: FakeGmailSyncAdapterOptions = {}) {
    this.#initialResult = gmailInitialSyncResultSchema.parse(
      options.initialResult ?? defaultInitialResult,
    );
    this.#historyResult = gmailHistoryResultSchema.parse(
      options.historyResult ?? defaultHistoryResult,
    );
    const messages = options.messages ?? [defaultRawMessage];
    this.#messages = new Map(messages.map((message) => {
      const parsed = gmailRawMessageSchema.parse(message);
      return [parsed.providerMessageId, parsed] as const;
    }));
    this.#watchResult = gmailWatchResultSchema.parse(
      options.watchResult ?? defaultWatchResult,
    );
  }

  get calls(): FakeGmailSyncCalls {
    return Object.freeze({
      initial: Object.freeze([...this.#initialCalls]),
      history: Object.freeze([...this.#historyCalls]),
      message: Object.freeze([...this.#messageCalls]),
      watch: Object.freeze([...this.#watchCalls]),
    });
  }

  async listInitialMessages(
    input: GmailInitialSyncInput,
  ): Promise<GmailInitialSyncResult> {
    const parsed = gmailInitialSyncInputSchema.parse(input);
    this.#initialCalls.push(Object.freeze({ ...parsed }));
    return gmailInitialSyncResultSchema.parse(this.#initialResult);
  }

  async listHistory(input: GmailHistoryInput): Promise<GmailHistoryResult> {
    const parsed = gmailHistoryInputSchema.parse(input);
    this.#historyCalls.push(Object.freeze({ ...parsed }));
    return gmailHistoryResultSchema.parse(this.#historyResult);
  }

  async getMessage(input: GmailMessageInput): Promise<GmailRawMessage> {
    const parsed = gmailMessageInputSchema.parse(input);
    this.#messageCalls.push(Object.freeze({ ...parsed }));
    const message = this.#messages.get(parsed.providerMessageId);
    if (message === undefined) {
      throw new Error(
        `Fake Gmail message ${parsed.providerMessageId} is not configured.`,
      );
    }
    return gmailRawMessageSchema.parse(message);
  }

  async watch(input: GmailWatchInput): Promise<GmailWatchResult> {
    const parsed = gmailWatchInputSchema.parse(input);
    this.#watchCalls.push(Object.freeze({ ...parsed }));
    return gmailWatchResultSchema.parse(this.#watchResult);
  }
}
