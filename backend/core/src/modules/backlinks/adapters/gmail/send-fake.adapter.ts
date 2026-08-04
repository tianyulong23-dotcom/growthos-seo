import { z } from "zod";

import {
  gmailSendCommandSchema,
  gmailSendFailureCodes,
  gmailSendResultSchema,
  type GmailSendCommand,
  type GmailSendPort,
  type GmailSendResult,
} from "../../ports/gmail-send.port.js";

const providerIdentifierSchema = z.string().trim().min(1).max(255);

export const fakeGmailSendScenarioSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    providerMessageId: providerIdentifierSchema.optional(),
    providerThreadId: providerIdentifierSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("rate_limited"),
    retryAfterSeconds: z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(),
  z.object({
    kind: z.literal("server_failure"),
    httpStatus: z.number().int().min(500).max(599),
  }).strict(),
  z.object({
    kind: z.literal("timeout"),
  }).strict(),
  z.object({
    kind: z.literal("ambiguous"),
  }).strict(),
  z.object({
    kind: z.literal("bounce"),
    bounceClass: z.enum(["hard", "soft"]),
    diagnosticCode: z.string().trim().min(1).max(255),
  }).strict(),
]);

export type FakeGmailSendScenario = Readonly<
  z.output<typeof fakeGmailSendScenarioSchema>
>;

export const fakeGmailDeliveryFactSchema = z.object({
  kind: z.literal("bounce"),
  providerMessageId: providerIdentifierSchema,
  providerThreadId: providerIdentifierSchema.optional(),
  bounceClass: z.enum(["hard", "soft"]),
  diagnosticCode: z.string().trim().min(1).max(255),
}).strict();

export type FakeGmailDeliveryFact = Readonly<
  z.output<typeof fakeGmailDeliveryFactSchema>
>;

export type FakeGmailSendAdapterOptions = Readonly<{
  scenario?: FakeGmailSendScenario;
}>;

const acceptedResult = (
  callNumber: number,
  providerMessageId?: string,
  providerThreadId?: string,
): GmailSendResult => gmailSendResultSchema.parse({
  kind: "accepted",
  providerMessageId: providerMessageId ?? `fake-gmail-message-${callNumber}`,
  providerThreadId: providerThreadId
    ?? `fake-gmail-thread-${callNumber}`,
});

export class FakeGmailSendAdapter implements GmailSendPort {
  readonly #scenario: FakeGmailSendScenario;
  readonly #deliveryFacts: FakeGmailDeliveryFact[] = [];
  #calls = 0;

  constructor(options: FakeGmailSendAdapterOptions = {}) {
    this.#scenario = fakeGmailSendScenarioSchema.parse(
      options.scenario ?? { kind: "success" },
    );
  }

  get calls(): number {
    return this.#calls;
  }

  get deliveryFacts(): readonly FakeGmailDeliveryFact[] {
    return Object.freeze(this.#deliveryFacts.map((fact) =>
      Object.freeze({ ...fact })
    ));
  }

  async send(command: GmailSendCommand): Promise<GmailSendResult> {
    gmailSendCommandSchema.parse(command);
    this.#calls += 1;

    switch (this.#scenario.kind) {
      case "success":
        return acceptedResult(
          this.#calls,
          this.#scenario.providerMessageId,
          this.#scenario.providerThreadId,
        );
      case "rate_limited":
        return gmailSendResultSchema.parse({
          kind: "definitely_not_sent",
          code: gmailSendFailureCodes.rateLimited,
          retryable: true,
          retryAfterSeconds: this.#scenario.retryAfterSeconds,
        });
      case "server_failure":
        return gmailSendResultSchema.parse({
          kind: "acceptance_unknown",
          code: gmailSendFailureCodes.provider5xx,
        });
      case "timeout":
        return gmailSendResultSchema.parse({
          kind: "acceptance_unknown",
          code: gmailSendFailureCodes.timeout,
        });
      case "ambiguous":
        return gmailSendResultSchema.parse({
          kind: "acceptance_unknown",
          code: gmailSendFailureCodes.ambiguous,
        });
      case "bounce": {
        const result = acceptedResult(this.#calls);
        if (result.kind !== "accepted") {
          throw new TypeError("Fake accepted result is invalid.");
        }
        this.#deliveryFacts.push(fakeGmailDeliveryFactSchema.parse({
          kind: "bounce",
          providerMessageId: result.providerMessageId,
          providerThreadId: result.providerThreadId,
          bounceClass: this.#scenario.bounceClass,
          diagnosticCode: this.#scenario.diagnosticCode,
        }));
        return result;
      }
    }
  }
}
