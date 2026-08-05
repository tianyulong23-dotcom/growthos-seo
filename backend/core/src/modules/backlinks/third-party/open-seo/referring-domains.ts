import { z } from "zod";

const safeCountSchema =
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const costUsdSchema =
  z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 1_000_000);
const pathSchema = z.array(z.string().trim().min(1)).min(1).max(16);
const responseSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string().optional(),
  tasks_count: safeCountSchema.optional(),
  tasks: z.array(z.unknown()).optional(),
}).passthrough();
const taskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string().optional(),
  path: pathSchema,
  cost: costUsdSchema,
  result_count: safeCountSchema.nullable().optional(),
  result: z.array(z.unknown()).optional(),
  data: z.unknown().optional(),
}).passthrough();
const countryCountsSchema =
  z.record(z.string().regex(/^[A-Z]{2}$/), safeCountSchema);
const referringDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  backlinks: safeCountSchema,
  rank: z.number().finite().nonnegative().nullable().optional(),
  backlinks_spam_score: z.number().finite().min(0).max(100).nullable().optional(),
  referring_links_countries: countryCountsSchema.optional(),
}).passthrough();

export type OpenSeoTaskBilling = Readonly<{
  path: readonly string[]; costMicros: number;
}>;

export class OpenSeoChargedTaskError extends Error {
  constructor(
    message: string,
    readonly billing: OpenSeoTaskBilling,
    readonly isInvalidField = false,
  ) {
    super(message);
    this.name = "OpenSeoChargedTaskError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function billing(costUsd: number, path: readonly string[]): OpenSeoTaskBilling {
  const costMicros = Math.round(costUsd * 1_000_000);
  if (!Number.isSafeInteger(costMicros))
    throw new TypeError("OpenSEO task cost cannot be represented in micros");
  return { path, costMicros };
}

const invalidFieldPattern = /Invalid Field:\s*'([^']+)'/i;
function chargedFailureMessage(
  message: string,
  data: unknown,
): readonly [string, boolean] {
  const field = message.match(invalidFieldPattern)?.[1];
  if (field === undefined) return [message, false];
  if (!isRecord(data) || data[field] === undefined) return [message, true];
  return [`${message} (sent ${field}=${JSON.stringify(data[field])})`, true];
}

function countryCode(
  counts: Readonly<Record<string, number>> | undefined,
): string | null {
  const codes = counts === undefined ? [] : Object.keys(counts);
  return codes.length === 1 ? (codes[0] ?? null) : null;
}

export function parseOpenSeoReferringDomains(
  raw: unknown,
) {
  const response = responseSchema.parse(raw);
  if (response.status_code !== 20_000)
    throw new TypeError(
      response.status_message ?? "OpenSEO DataForSEO response failed",
    );
  const tasks = z.tuple([taskSchema]).parse(response.tasks);
  if (
    response.tasks_count !== undefined &&
    response.tasks_count !== tasks.length
  )
    throw new TypeError("OpenSEO tasks_count must match tasks length");
  const task = tasks[0];
  const taskBilling = billing(task.cost, task.path);
  if (task.status_code !== 20_000) {
    const message = task.status_message ?? "OpenSEO DataForSEO task failed";
    if (task.status_code === 40_501 && message.toLowerCase().includes("no search results")) {
      return { kind: "empty", billing: taskBilling, items: [] };
    }
    const [failureMessage, isInvalidField] =
      chargedFailureMessage(message, task.data);
    throw new OpenSeoChargedTaskError(
      failureMessage,
      taskBilling,
      isInvalidField,
    );
  }
  const firstResult = task.result?.[0];
  const rawItems = isRecord(firstResult) ? firstResult.items : undefined;
  const items = z.array(referringDomainSchema).parse(rawItems ?? []);
  return {
    kind: "success",
    billing: taskBilling,
    items: items.map((item) => ({
      domain: item.domain,
      backlinkCount: item.backlinks,
      rank: item.rank ?? null,
      spamScore: item.backlinks_spam_score ?? null,
      countryCode: countryCode(item.referring_links_countries),
    })),
  };
}
