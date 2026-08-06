import { createHash } from "node:crypto";

import { z } from "zod";

import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialDiscoverySourceTypes = [
  "EXISTING_HISTORY",
  "BLUEPRINT_SERP_STANDARD_QUEUE",
  "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
  "VERIFIED_COMPETITOR_BACKLINK_GAP",
  "USER_REFERRING_DOMAINS",
] as const;

export type CommercialDiscoverySourceType =
  (typeof commercialDiscoverySourceTypes)[number];

export const dataForSeoCommercialDiscoveryEndpoints = [
  "/v3/serp/google/organic/task_post",
  "/v3/serp/google/organic/tasks_ready",
  "/v3/serp/google/organic/task_get/advanced",
  "/v3/dataforseo_labs/google/competitors_domain/live",
  "/v3/backlinks/competitors/live",
  "/v3/backlinks/referring_domains/live",
] as const;

export type DataForSeoCommercialDiscoveryEndpoint =
  (typeof dataForSeoCommercialDiscoveryEndpoints)[number];

const endpointSchema = z.enum(dataForSeoCommercialDiscoveryEndpoints);
const sourceTypeSchema = z.enum(commercialDiscoverySourceTypes);
const nonBlank = z.string().trim().min(1).max(2_048);

export const commercialDiscoveryCallSchema = z.object({
  endpoint: endpointSchema,
  intent: z.literal("DISCOVERY"),
  sourceType: sourceTypeSchema.exclude(["EXISTING_HISTORY"]),
  request: z.record(z.string(), z.unknown()),
  responseSchemaVersion: nonBlank,
  estimatedCostMicros: z.number().int().positive().max(100_000_000),
}).strict();

export type CommercialDiscoveryCall = Readonly<
  z.output<typeof commercialDiscoveryCallSchema>
>;

export const commercialDiscoveryArtifactSchema = z.object({
  sourceType: sourceTypeSchema,
  endpoint: endpointSchema.nullable(),
  requestFingerprint: nonBlank,
  responseSchemaVersion: nonBlank,
  collectedAt: z.string().datetime(),
  costMicros: z.number().int().min(0),
  providerTaskIds: z.array(nonBlank).max(100),
  candidates: z.array(z.object({
    canonicalDomain: nonBlank,
    rank: z.number().finite().nullable(),
    backlinkCount: z.number().int().min(0).nullable(),
    referringDomainCount: z.number().int().min(0).nullable(),
    spamScore: z.number().min(0).max(100).nullable(),
    evidenceRefs: z.array(nonBlank).min(1).max(20),
  }).strict()).max(10_000),
}).strict();

export type CommercialDiscoveryArtifact = Readonly<
  z.output<typeof commercialDiscoveryArtifactSchema>
>;

const endpointSources: Readonly<
  Record<
    DataForSeoCommercialDiscoveryEndpoint,
    readonly CommercialDiscoverySourceType[]
  >
> = Object.freeze({
  "/v3/serp/google/organic/task_post":
    ["BLUEPRINT_SERP_STANDARD_QUEUE"],
  "/v3/serp/google/organic/tasks_ready":
    ["BLUEPRINT_SERP_STANDARD_QUEUE"],
  "/v3/serp/google/organic/task_get/advanced":
    ["BLUEPRINT_SERP_STANDARD_QUEUE"],
  "/v3/dataforseo_labs/google/competitors_domain/live":
    ["VERIFIED_COMPETITOR_BACKLINK_GAP"],
  "/v3/backlinks/competitors/live":
    ["VERIFIED_COMPETITOR_BACKLINK_GAP"],
  "/v3/backlinks/referring_domains/live":
    [
      "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
      "USER_REFERRING_DOMAINS",
    ],
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintCommercialDiscoveryCall(
  call: CommercialDiscoveryCall,
): string {
  const parsed = commercialDiscoveryCallSchema.parse(call);
  return createHash("sha256").update(stableJson(parsed)).digest("hex");
}

export function assertCommercialDiscoveryCallAllowed(input: Readonly<{
  call: CommercialDiscoveryCall;
  endpointAllowlist: readonly string[];
}>): CommercialDiscoveryCall {
  const call = commercialDiscoveryCallSchema.parse(input.call);
  if (!endpointSources[call.endpoint].includes(call.sourceType)) {
    throw new Error("DATAFORSEO_COMMERCIAL_SOURCE_ENDPOINT_MISMATCH");
  }
  const allowed = new Set(input.endpointAllowlist.map((value) => {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }));
  if (!allowed.has(call.endpoint)) {
    throw new Error("DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED");
  }
  return Object.freeze(call);
}

export function createCommercialDiscoveryPlan(input: Readonly<{
  searchQueries: readonly string[];
  verifiedCompetitorDomains: readonly string[];
  userDomain: string;
  locationCode: string | number;
  languageCode: string;
  endpointAllowlist: readonly string[];
  estimatedCostMicros: number;
  remainingBudgetMicros: number;
}>): readonly CommercialDiscoveryCall[] {
  if (
    !Number.isInteger(input.estimatedCostMicros)
    || input.estimatedCostMicros <= 0
    || !Number.isInteger(input.remainingBudgetMicros)
    || input.remainingBudgetMicros < 0
  ) {
    throw new TypeError("Commercial discovery budget is invalid");
  }
  const userDomain =
    createRecommendationDomainKey(input.userDomain).registrableDomain;
  const competitors = [...new Set(input.verifiedCompetitorDomains.map(
    (value) => createRecommendationDomainKey(value).registrableDomain,
  ))].filter((value) => value !== userDomain).sort();
  const queries = [...new Set(input.searchQueries.map(
    (value) => value.trim(),
  ).filter(Boolean))].slice(0, 20);
  const candidates: CommercialDiscoveryCall[] = [];

  for (const query of queries) {
    candidates.push({
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: query,
        location_code: Number(input.locationCode),
        language_code: input.languageCode,
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v1",
      estimatedCostMicros: input.estimatedCostMicros,
    });
  }
  for (const competitor of competitors) {
    candidates.push({
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
      request: {
        target: competitor,
        include_subdomains: true,
        exclude_internal_backlinks: true,
        limit: 100,
      },
      responseSchemaVersion:
        "dataforseo.backlinks-referring-domains-commercial.v1",
      estimatedCostMicros: input.estimatedCostMicros,
    });
  }
  if (competitors.length > 0) {
    candidates.push({
      endpoint: "/v3/backlinks/competitors/live",
      intent: "DISCOVERY",
      sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
      request: {
        target: userDomain,
        exclude_large_domains: true,
        exclude_internal_backlinks: true,
        limit: 100,
        rank_scale: "one_hundred",
      },
      responseSchemaVersion: "dataforseo.backlinks-competitors.v1",
      estimatedCostMicros: input.estimatedCostMicros,
    });
  }
  candidates.push({
    endpoint: "/v3/backlinks/referring_domains/live",
    intent: "DISCOVERY",
    sourceType: "USER_REFERRING_DOMAINS",
    request: {
      target: userDomain,
      include_subdomains: true,
      exclude_internal_backlinks: true,
      limit: 100,
    },
    responseSchemaVersion:
      "dataforseo.backlinks-referring-domains-commercial.v1",
    estimatedCostMicros: input.estimatedCostMicros,
  });

  const calls: CommercialDiscoveryCall[] = [];
  let reserved = 0;
  for (const candidate of candidates) {
    try {
      const allowed = assertCommercialDiscoveryCallAllowed({
        call: candidate,
        endpointAllowlist: input.endpointAllowlist,
      });
      if (
        reserved + allowed.estimatedCostMicros
        > input.remainingBudgetMicros
      ) {
        continue;
      }
      calls.push(allowed);
      reserved += allowed.estimatedCostMicros;
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED"
      ) {
        continue;
      }
      throw error;
    }
  }
  return Object.freeze(calls);
}

type DataForSeoTask = Readonly<Record<string, unknown>>;

function objects(value: unknown): readonly DataForSeoTask[] {
  return Array.isArray(value)
    ? value.filter(
      (item): item is DataForSeoTask =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    : [];
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.trunc(number));
}

function domainFrom(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return createRecommendationDomainKey(value).registrableDomain;
  } catch {
    try {
      return createRecommendationDomainKey(new URL(value).hostname)
        .registrableDomain;
    } catch {
      return null;
    }
  }
}

function resultItems(response: DataForSeoTask): readonly DataForSeoTask[] {
  return objects(response.tasks).flatMap((task) =>
    objects(task.result).flatMap((result) => [
      ...objects(result.items),
      ...objects(result.competitors),
      ...objects(result.referring_domains),
    ])
  );
}

export function normalizeCommercialDiscoveryResponse(input: Readonly<{
  call: CommercialDiscoveryCall;
  response: unknown;
  collectedAt: string;
}>): CommercialDiscoveryArtifact {
  const call = commercialDiscoveryCallSchema.parse(input.call);
  const response = z.record(z.string(), z.unknown()).parse(input.response);
  const requestFingerprint = fingerprintCommercialDiscoveryCall(call);
  const tasks = objects(response.tasks);
  const taskIds = tasks.flatMap((task) =>
    typeof task.id === "string" && task.id.trim().length > 0
      ? [task.id.trim()]
      : []
  );
  const costMicros = Math.max(0, Math.round(
    tasks.reduce((sum, task) => sum + (finiteNumber(task.cost) ?? 0), 0)
      * 1_000_000,
  ));
  const byDomain = new Map<string, {
    rank: number | null;
    backlinkCount: number | null;
    referringDomainCount: number | null;
    spamScore: number | null;
  }>();
  for (const item of resultItems(response)) {
    const domain = domainFrom(
      item.domain ?? item.target ?? item.url ?? item.source_url,
    );
    if (domain === null) continue;
    const candidate = {
      rank: finiteNumber(item.rank ?? item.domain_rank),
      backlinkCount: integer(
        item.backlinks ?? item.backlink_count ?? item.count,
      ),
      referringDomainCount: integer(
        item.referring_domains ?? item.referring_domains_count,
      ),
      spamScore: finiteNumber(item.spam_score),
    };
    const previous = byDomain.get(domain);
    if (
      previous === undefined
      || (candidate.rank ?? -1) > (previous.rank ?? -1)
    ) {
      byDomain.set(domain, candidate);
    }
  }
  return commercialDiscoveryArtifactSchema.parse({
    sourceType: call.sourceType,
    endpoint: call.endpoint,
    requestFingerprint,
    responseSchemaVersion: call.responseSchemaVersion,
    collectedAt: input.collectedAt,
    costMicros,
    providerTaskIds: taskIds,
    candidates: [...byDomain.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([canonicalDomain, item]) => ({
        canonicalDomain,
        ...item,
        evidenceRefs: [
          `dataforseo:${call.endpoint}:${requestFingerprint}:${canonicalDomain}`,
        ],
      })),
  });
}

export function mergeCommercialDiscoveryArtifacts(input: Readonly<{
  artifacts: readonly CommercialDiscoveryArtifact[];
  userDomain: string;
  excludedDomains: readonly string[];
}>): readonly Readonly<{
  canonicalDomain: string;
  sourceTypes: readonly CommercialDiscoverySourceType[];
  evidenceRefs: readonly string[];
  rank: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  spamScore: number | null;
}>[] {
  const excluded = new Set([
    createRecommendationDomainKey(input.userDomain).registrableDomain,
    ...input.excludedDomains.map(
      (value) => createRecommendationDomainKey(value).registrableDomain,
    ),
  ]);
  const merged = new Map<string, {
    sourceTypes: Set<CommercialDiscoverySourceType>;
    evidenceRefs: Set<string>;
    rank: number | null;
    backlinkCount: number | null;
    referringDomainCount: number | null;
    spamScore: number | null;
  }>();
  for (const rawArtifact of input.artifacts) {
    const artifact = commercialDiscoveryArtifactSchema.parse(rawArtifact);
    for (const candidate of artifact.candidates) {
      const domain =
        createRecommendationDomainKey(candidate.canonicalDomain)
          .registrableDomain;
      if (excluded.has(domain)) continue;
      const item = merged.get(domain) ?? {
        sourceTypes: new Set<CommercialDiscoverySourceType>(),
        evidenceRefs: new Set<string>(),
        rank: null,
        backlinkCount: null,
        referringDomainCount: null,
        spamScore: null,
      };
      item.sourceTypes.add(artifact.sourceType);
      candidate.evidenceRefs.forEach((ref) => item.evidenceRefs.add(ref));
      item.rank = Math.max(item.rank ?? -1, candidate.rank ?? -1);
      item.backlinkCount = Math.max(
        item.backlinkCount ?? -1,
        candidate.backlinkCount ?? -1,
      );
      item.referringDomainCount = Math.max(
        item.referringDomainCount ?? -1,
        candidate.referringDomainCount ?? -1,
      );
      item.spamScore = Math.max(
        item.spamScore ?? -1,
        candidate.spamScore ?? -1,
      );
      merged.set(domain, item);
    }
  }
  return Object.freeze([...merged.entries()]
    .filter(([, item]) =>
      [...item.sourceTypes].some(
        (sourceType) => sourceType !== "USER_REFERRING_DOMAINS",
      )
    )
    .map(([canonicalDomain, item]) => Object.freeze({
      canonicalDomain,
      sourceTypes: Object.freeze([...item.sourceTypes].sort()),
      evidenceRefs: Object.freeze([...item.evidenceRefs].sort()),
      rank: item.rank === -1 ? null : item.rank,
      backlinkCount: item.backlinkCount === -1
        ? null : item.backlinkCount,
      referringDomainCount: item.referringDomainCount === -1
        ? null : item.referringDomainCount,
      spamScore: item.spamScore === -1 ? null : item.spamScore,
    }))
    .sort((left, right) =>
      (right.rank ?? -1) - (left.rank ?? -1)
      || left.canonicalDomain.localeCompare(right.canonicalDomain, "en")
    ));
}
