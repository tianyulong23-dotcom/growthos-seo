import { createHash } from "node:crypto";
import { z } from "zod";
import {
  backlinkProviderSnapshotSchema,
  type BacklinkProviderSnapshot,
} from "../../ports/dataforseo.port.js";

const safeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const costUsdSchema = z.number().finite().nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 1_000_000);
const countryCountsSchema = z.record(
  z.union([z.literal(""), z.string().regex(/^[A-Z]{2}$/)]),
  safeCountSchema,
);
const referringDomainItemSchema = z
  .object({
    type: z.literal("backlinks_referring_domain"),
    domain: z.string().trim().min(1).max(253),
    rank: z.number().finite().nonnegative().nullable().optional(),
    backlinks: safeCountSchema,
    backlinks_spam_score: z.number().finite().min(0).max(100).nullable().optional(),
    referring_links_countries: countryCountsSchema.optional(),
  })
  .passthrough();

function addMismatchIssue(
  context: z.core.$RefinementCtx<unknown>,
  path: string,
  message: string,
): void {
  context.addIssue({ code: "custom", path: [path], message });
}

const referringDomainsResultSchema = z
  .object({
    target: z.string().trim().min(1).max(2_048),
    total_count: safeCountSchema,
    items_count: safeCountSchema,
    items: z.array(referringDomainItemSchema).max(1_000),
  })
  .passthrough()
  .superRefine((result, context) => {
    if (result.items_count !== result.items.length) {
      addMismatchIssue(context, "items_count", "items_count must match items length");
    }
    if (result.total_count < result.items_count) {
      addMismatchIssue(
        context,
        "total_count",
        "total_count cannot be smaller than items_count",
      );
    }
  });
const dataForSeoTaskSchema = z
  .object({
    status_code: z.literal(20_000),
    cost: costUsdSchema,
    result_count: safeCountSchema,
    path: z.tuple([
      z.literal("v3"), z.literal("backlinks"),
      z.literal("referring_domains"), z.literal("live"),
    ]),
    result: z.array(referringDomainsResultSchema).length(1),
  })
  .passthrough()
  .superRefine((task, context) => {
    if (task.result_count !== task.result.length) {
      addMismatchIssue(context, "result_count", "result_count must match result length");
    }
  });
export const dataForSeoBacklinkEnvelopeSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    status_code: z.literal(20_000),
    cost: costUsdSchema,
    tasks_count: safeCountSchema,
    tasks_error: z.literal(0),
    tasks: z.array(dataForSeoTaskSchema).length(1),
  })
  .passthrough()
  .superRefine((envelope, context) => {
    if (envelope.tasks_count !== envelope.tasks.length) {
      addMismatchIssue(context, "tasks_count", "tasks_count must match tasks length");
    }
    if (envelope.tasks[0]?.cost !== envelope.cost) {
      addMismatchIssue(context, "cost", "envelope cost must match its single task cost");
    }
  });
const timestampSchema = z.string().datetime({ offset: true });
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("DataForSEO envelope must contain JSON values");
  }
  return serialized;
}
function toCountryCode(
  counts: Readonly<Record<string, number>> | undefined,
): string | null {
  const codes = counts === undefined
    ? []
    : Object.keys(counts).filter((code) => /^[A-Z]{2}$/.test(code));
  return codes.length === 1 ? (codes[0] ?? null) : null;
}
export function mapDataForSeoBacklinkSnapshot(input: Readonly<{
  raw: unknown;
  requestedAt: string;
  completedAt: string;
}>): BacklinkProviderSnapshot {
  const requestedAt = timestampSchema.parse(input.requestedAt);
  const completedAt = timestampSchema.parse(input.completedAt);
  const envelope = dataForSeoBacklinkEnvelopeSchema.parse(input.raw);
  const task = envelope.tasks[0];
  const result = task?.result[0];
  if (result === undefined) {
    throw new TypeError("DataForSEO envelope is missing its validated result");
  }
  return backlinkProviderSnapshotSchema.parse({
    provider: "dataforseo",
    schemaVersion: "dataforseo.backlinks-referring-domains.v1",
    requestedAt,
    completedAt,
    costMicros: Math.round(envelope.cost * 1_000_000),
    payloadHash: createHash("sha256")
      .update(stableJson(input.raw))
      .digest("hex"),
    referringDomains: result.items.map((item) => ({
      domain: item.domain,
      backlinkCount: item.backlinks,
      rank: item.rank ?? null,
      spamScore: item.backlinks_spam_score ?? null,
      countryCode: toCountryCode(item.referring_links_countries),
    })),
  });
}
