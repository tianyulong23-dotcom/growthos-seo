import type { createSendIntentCommands } from "./send-intent.command.js";
import { createGmailSendReadinessSnapshot } from "../services/send-policy-gate.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";

type Commands = ReturnType<typeof createSendIntentCommands>;
type Input = Parameters<Commands["preflight"]>[0];

// No reservation or send is made here. Each later create still checks the exact
// planned quota revision; concurrent quota changes invalidate the human preview.
export async function preflightSendBatch(commands: Commands, inputs: readonly Input[]) {
  if (
    inputs.length < 1 || inputs.length > 20
    || new Set(inputs.map((item) => item.draftId)).size !== inputs.length
    || new Set(inputs.map((item) => item.gmailConnectionId)).size !== 1
    || inputs.some((item) => item.messagePurpose !== "INITIAL_OUTREACH" || item.followUpIndex !== 0)
  ) {
    throw new BacklinkError({ code: backlinkErrorCodes.invalidRequest, message: "Invalid send batch." });
  }
  const results = [];
  let quota: string | undefined;
  for (const [index, input] of inputs.entries()) {
    const result = await commands.preflight(input);
    const snapshot = result.readinessSnapshot;
    const revision = snapshot.conditions.find((item) => item.code === "QUOTA")?.revision;
    const match = revision?.match(/^(\d+)\/(\d+)$/);
    if (!match || (quota !== undefined && quota !== revision)) {
      throw new BacklinkError({
        code: backlinkErrorCodes.sendReadinessStale,
        message: "Quota changed during batch preview. Preview again.",
      });
    }
    quota = revision;
    const used = Number(match[1]) + index;
    const limit = Number(match[2]);
    if (!Number.isSafeInteger(used) || !Number.isSafeInteger(limit) || used >= limit) {
      throw new BacklinkError({
        code: backlinkErrorCodes.rateLimited, message: "Insufficient quota for this batch.",
      });
    }
    results.push({
      draftId: input.draftId,
      ...result,
      readinessSnapshot: createGmailSendReadinessSnapshot({
        evaluatedAt: new Date(snapshot.evaluatedAt),
        // Serial batches can wait hours. Core still compares every condition at
        // create time; this only extends the exact reviewed snapshot's lifetime.
        ttlSeconds: 24 * 60 * 60,
        conditions: snapshot.conditions.map((item) =>
          item.code === "QUOTA" ? { ...item, revision: `${used}/${limit}` } : item),
      }),
    });
  }
  return results;
}
