import {
  backlinkProviderSnapshotSchema,
  backlinkSnapshotRequestSchema,
  providerRequestContextSchema,
  type BacklinkProviderSnapshot,
  type BacklinkSnapshotRequest,
  type DataForSeoPort,
  type ProviderRequestContext,
} from "../../ports/dataforseo.port.js";

export type FakeDataForSeoOutcome =
  | "success"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "malformed";

type FakeDataForSeoFailureOutcome = Exclude<
  FakeDataForSeoOutcome,
  "success"
>;

export type FakeDataForSeoCall = Readonly<{
  context: ProviderRequestContext;
  request: BacklinkSnapshotRequest;
}>;

export type FakeDataForSeoPlan = Readonly<{
  outcome: FakeDataForSeoOutcome;
  snapshot: unknown;
}>;

export class FakeDataForSeoError extends Error {
  readonly outcome: FakeDataForSeoFailureOutcome;
  readonly statusCode: 429 | 503 | undefined;

  constructor(
    outcome: FakeDataForSeoFailureOutcome,
    message: string,
    statusCode?: 429 | 503,
  ) {
    super(message);
    this.name = "FakeDataForSeoError";
    this.outcome = outcome;
    this.statusCode = statusCode;
  }
}

export class FakeDataForSeoAdapter implements DataForSeoPort {
  readonly #calls: FakeDataForSeoCall[] = [];

  constructor(private readonly plan: FakeDataForSeoPlan) {}

  get calls(): readonly FakeDataForSeoCall[] {
    return Object.freeze([...this.#calls]);
  }

  async fetchBacklinkSnapshot(
    context: ProviderRequestContext,
    request: BacklinkSnapshotRequest,
  ): Promise<BacklinkProviderSnapshot> {
    const parsedContext = providerRequestContextSchema.parse(context);
    const parsedRequest = backlinkSnapshotRequestSchema.parse(request);

    this.#calls.push(
      Object.freeze({
        context: Object.freeze(parsedContext),
        request: Object.freeze(parsedRequest),
      }),
    );

    switch (this.plan.outcome) {
      case "success":
        return backlinkProviderSnapshotSchema.parse(this.plan.snapshot);
      case "rate_limited":
        throw new FakeDataForSeoError(
          "rate_limited",
          "Fake DataForSEO rate limit",
          429,
        );
      case "server_error":
        throw new FakeDataForSeoError(
          "server_error",
          "Fake DataForSEO server error",
          503,
        );
      case "timeout":
        throw new FakeDataForSeoError(
          "timeout",
          "Fake DataForSEO request timed out",
        );
      case "malformed": {
        const parsed = backlinkProviderSnapshotSchema.safeParse(
          this.plan.snapshot,
        );
        const detail = parsed.success
          ? "fixture unexpectedly matched the snapshot schema"
          : "fixture failed snapshot schema validation";

        throw new FakeDataForSeoError(
          "malformed",
          `Fake DataForSEO malformed response: ${detail}`,
        );
      }
    }
  }
}
