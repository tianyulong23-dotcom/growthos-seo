import { createHash } from "node:crypto";

import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialDiscoverySourceTypes = [
  "EXISTING_HISTORY",
  "BLUEPRINT_SERP_STANDARD_QUEUE",
  "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
  "VERIFIED_COMPETITOR_BACKLINK_GAP",
  "USER_REFERRING_DOMAINS",
  "CURATED_RESOURCE_LIBRARY",
] as const;

export type CommercialDiscoverySourceType =
  (typeof commercialDiscoverySourceTypes)[number];

export const dataForSeoCommercialDiscoveryEndpoints = [
  "/v3/serp/google/organic/task_post",
  "/v3/serp/google/organic/tasks_ready",
  "/v3/serp/google/organic/task_get/advanced",
  "/v3/dataforseo_labs/google/competitors_domain/live",
  "/v3/backlinks/competitors/live",
  "/v3/backlinks/backlinks/live",
  "/v3/backlinks/referring_domains/live",
] as const;

export type DataForSeoCommercialDiscoveryEndpoint =
  (typeof dataForSeoCommercialDiscoveryEndpoints)[number];

type CommercialDiscoveryCandidate = Readonly<{
  canonicalDomain: string;
  discoveryUrls: readonly string[];
  backlinkPageEvidence: readonly CommercialBacklinkPageEvidence[];
  rank: number | null;
  traffic: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  spamScore: number | null;
  countryCode: string | null;
  evidenceRefs: readonly string[];
}>;

export type CommercialBacklinkPageEvidence = Readonly<{
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  linkStatus: "active" | "lost";
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sourceHttpStatus: number | null;
  targetHttpStatus: number | null;
}>;

export type CommercialDiscoveryPlannerLineage = Readonly<{
  blueprintId: string;
  queryId: string;
}>;

export type CommercialDiscoveryCall = Readonly<{
  endpoint: DataForSeoCommercialDiscoveryEndpoint;
  intent: "DISCOVERY";
  sourceType: Exclude<
    CommercialDiscoverySourceType,
    "EXISTING_HISTORY" | "CURATED_RESOURCE_LIBRARY"
  >;
  request: Readonly<Record<string, unknown>>;
  plannerLineage?: CommercialDiscoveryPlannerLineage;
  responseSchemaVersion: string;
  estimatedCostMicros: number;
}>;

export type CommercialDiscoveryArtifact = Readonly<{
  sourceType: CommercialDiscoverySourceType;
  endpoint: DataForSeoCommercialDiscoveryEndpoint | null;
  requestFingerprint: string;
  responseSchemaVersion: string;
  collectedAt: string;
  costMicros: number;
  providerTaskIds: readonly string[];
  candidates: readonly CommercialDiscoveryCandidate[];
  plannerLineage?: CommercialDiscoveryPlannerLineage;
}>;

const plannerLineageRequestField =
  "__growthosDiscoveryPlannerLineage" as const;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertStrictKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${name} has invalid fields`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} has invalid fields`);
  }
}

function member<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
  name: string,
): Values[number] {
  if (
    typeof value !== "string" ||
    !(values as readonly string[]).includes(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value as Values[number];
}

function nonBlank(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function integerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function nullableFinite(
  value: unknown,
  name: string,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function nonBlankList(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    value.map((item, index) => nonBlank(item, `${name}[${index}]`)),
  );
}

function parsePlannerLineage(
  value: unknown,
  name: string,
): CommercialDiscoveryPlannerLineage {
  const input = record(value, name);
  assertStrictKeys(input, ["blueprintId", "queryId"], name);
  return Object.freeze({
    blueprintId: nonBlank(input.blueprintId, `${name}.blueprintId`),
    queryId: nonBlank(input.queryId, `${name}.queryId`),
  });
}

function parseCommercialDiscoveryCall(value: unknown): CommercialDiscoveryCall {
  const input = record(value, "commercialDiscoveryCall");
  const requiredKeys = [
    "endpoint",
    "intent",
    "sourceType",
    "request",
    "responseSchemaVersion",
    "estimatedCostMicros",
  ] as const;
  assertAllowedKeys(
    input,
    [
      ...requiredKeys,
      "plannerLineage",
    ],
    "commercialDiscoveryCall",
  );
  if (requiredKeys.some((key) => !(key in input))) {
    throw new TypeError("commercialDiscoveryCall has invalid fields");
  }
  const sourceType = member(
    commercialDiscoverySourceTypes,
    input.sourceType,
    "sourceType",
  );
  if (
    sourceType === "EXISTING_HISTORY" ||
    sourceType === "CURATED_RESOURCE_LIBRARY"
  ) {
    throw new TypeError("sourceType is invalid");
  }
  if (input.intent !== "DISCOVERY") throw new TypeError("intent is invalid");
  return Object.freeze({
    endpoint: member(
      dataForSeoCommercialDiscoveryEndpoints,
      input.endpoint,
      "endpoint",
    ),
    intent: "DISCOVERY",
    sourceType,
    request: Object.freeze({ ...record(input.request, "request") }),
    ...(input.plannerLineage === undefined
      ? {}
      : {
          plannerLineage: parsePlannerLineage(
            input.plannerLineage,
            "plannerLineage",
          ),
        }),
    responseSchemaVersion: nonBlank(
      input.responseSchemaVersion,
      "responseSchemaVersion",
    ),
    estimatedCostMicros: integerInRange(
      input.estimatedCostMicros,
      "estimatedCostMicros",
      1,
      100_000_000,
    ),
  });
}

function parseCommercialDiscoveryArtifact(
  value: unknown,
): CommercialDiscoveryArtifact {
  const input = record(value, "commercialDiscoveryArtifact");
  const requiredKeys = [
    "sourceType",
    "endpoint",
    "requestFingerprint",
    "responseSchemaVersion",
    "collectedAt",
    "costMicros",
    "providerTaskIds",
    "candidates",
  ] as const;
  assertAllowedKeys(
    input,
    [
      ...requiredKeys,
      "plannerLineage",
    ],
    "commercialDiscoveryArtifact",
  );
  if (requiredKeys.some((key) => !(key in input))) {
    throw new TypeError("commercialDiscoveryArtifact has invalid fields");
  }
  if (
    typeof input.collectedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(input.collectedAt) ||
    !Number.isFinite(Date.parse(input.collectedAt))
  ) {
    throw new TypeError("collectedAt is invalid");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > 10_000) {
    throw new TypeError("candidates is invalid");
  }
  const candidates = input.candidates.map((value, index) => {
    const candidate = record(value, `candidates[${index}]`);
    assertAllowedKeys(
      candidate,
      [
        "canonicalDomain",
        "discoveryUrls",
        "backlinkPageEvidence",
        "rank",
        "traffic",
        "backlinkCount",
        "referringDomainCount",
        "spamScore",
        "countryCode",
        "evidenceRefs",
      ],
      `candidates[${index}]`,
    );
    return Object.freeze({
      canonicalDomain: nonBlank(
        candidate.canonicalDomain,
        `candidates[${index}].canonicalDomain`,
      ),
      discoveryUrls:
        candidate.discoveryUrls === undefined
          ? Object.freeze([])
          : nonBlankList(
              candidate.discoveryUrls,
              `candidates[${index}].discoveryUrls`,
              0,
              20,
            ),
      backlinkPageEvidence:
        candidate.backlinkPageEvidence === undefined
          ? Object.freeze([])
          : parseBacklinkPageEvidence(
              candidate.backlinkPageEvidence,
              `candidates[${index}].backlinkPageEvidence`,
            ),
      rank: nullableFinite(candidate.rank, `candidates[${index}].rank`),
      traffic:
        candidate.traffic === undefined
          ? null
          : nullableFinite(
              candidate.traffic,
              `candidates[${index}].traffic`,
              0,
            ),
      backlinkCount:
        candidate.backlinkCount === null
          ? null
          : integerInRange(
              candidate.backlinkCount,
              `candidates[${index}].backlinkCount`,
              0,
            ),
      referringDomainCount:
        candidate.referringDomainCount === null
          ? null
          : integerInRange(
              candidate.referringDomainCount,
              `candidates[${index}].referringDomainCount`,
              0,
            ),
      spamScore: nullableFinite(
        candidate.spamScore,
        `candidates[${index}].spamScore`,
        0,
        100,
      ),
      countryCode:
        candidate.countryCode === undefined || candidate.countryCode === null
          ? null
          : nonBlank(
              candidate.countryCode,
              `candidates[${index}].countryCode`,
            ).toUpperCase(),
      evidenceRefs: nonBlankList(
        candidate.evidenceRefs,
        `candidates[${index}].evidenceRefs`,
        1,
        20,
      ),
    });
  });
  return Object.freeze({
    sourceType: member(
      commercialDiscoverySourceTypes,
      input.sourceType,
      "sourceType",
    ),
    endpoint:
      input.endpoint === null
        ? null
        : member(
            dataForSeoCommercialDiscoveryEndpoints,
            input.endpoint,
            "endpoint",
          ),
    requestFingerprint: nonBlank(
      input.requestFingerprint,
      "requestFingerprint",
    ),
    responseSchemaVersion: nonBlank(
      input.responseSchemaVersion,
      "responseSchemaVersion",
    ),
    collectedAt: input.collectedAt,
    costMicros: integerInRange(input.costMicros, "costMicros", 0),
    providerTaskIds: nonBlankList(
      input.providerTaskIds,
      "providerTaskIds",
      0,
      100,
    ),
    candidates: Object.freeze(candidates),
    ...(input.plannerLineage === undefined
      ? {}
      : {
          plannerLineage: parsePlannerLineage(
            input.plannerLineage,
            "plannerLineage",
          ),
        }),
  });
}

export const commercialDiscoveryCallSchema = Object.freeze({
  parse: parseCommercialDiscoveryCall,
});

export const commercialDiscoveryArtifactSchema = Object.freeze({
  parse: parseCommercialDiscoveryArtifact,
});

export function serializeCommercialDiscoveryRequestPayload(
  call: CommercialDiscoveryCall,
): Readonly<Record<string, unknown>> {
  const parsed = commercialDiscoveryCallSchema.parse(call);
  return Object.freeze({
    ...parsed.request,
    ...(parsed.plannerLineage === undefined
      ? {}
      : { [plannerLineageRequestField]: parsed.plannerLineage }),
  });
}

export function parseCommercialDiscoveryRequestPayload(
  value: unknown,
): Readonly<{
  request: Readonly<Record<string, unknown>>;
  plannerLineage?: CommercialDiscoveryPlannerLineage;
}> {
  const persisted = record(value, "commercialDiscoveryRequestPayload");
  const {
    [plannerLineageRequestField]: rawPlannerLineage,
    ...request
  } = persisted;
  return Object.freeze({
    request: Object.freeze(request),
    ...(rawPlannerLineage === undefined
      ? {}
      : {
          plannerLineage: parsePlannerLineage(
            rawPlannerLineage,
            "plannerLineage",
          ),
        }),
  });
}

const endpointSources: Readonly<
  Record<
    DataForSeoCommercialDiscoveryEndpoint,
    readonly CommercialDiscoverySourceType[]
  >
> = Object.freeze({
  "/v3/serp/google/organic/task_post": ["BLUEPRINT_SERP_STANDARD_QUEUE"],
  "/v3/serp/google/organic/tasks_ready": ["BLUEPRINT_SERP_STANDARD_QUEUE"],
  "/v3/serp/google/organic/task_get/advanced": [
    "BLUEPRINT_SERP_STANDARD_QUEUE",
  ],
  "/v3/dataforseo_labs/google/competitors_domain/live": [
    "VERIFIED_COMPETITOR_BACKLINK_GAP",
  ],
  "/v3/backlinks/competitors/live": ["VERIFIED_COMPETITOR_BACKLINK_GAP"],
  "/v3/backlinks/backlinks/live": [
    "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
  ],
  "/v3/backlinks/referring_domains/live": [
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

export function assertCommercialDiscoveryCallAllowed(
  input: Readonly<{
    call: CommercialDiscoveryCall;
    endpointAllowlist: readonly string[];
  }>,
): CommercialDiscoveryCall {
  const call = commercialDiscoveryCallSchema.parse(input.call);
  if (!endpointSources[call.endpoint].includes(call.sourceType)) {
    throw new Error("DATAFORSEO_COMMERCIAL_SOURCE_ENDPOINT_MISMATCH");
  }
  const allowed = new Set(
    input.endpointAllowlist.map((value) => {
      try {
        return new URL(value).pathname;
      } catch {
        return value;
      }
    }),
  );
  if (!allowed.has(call.endpoint)) {
    throw new Error("DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED");
  }
  return Object.freeze(call);
}

export function createCommercialDiscoveryPlan(
  input: Readonly<{
    blueprintId?: string;
    searchQueries: readonly string[];
    verifiedCompetitorDomains: readonly string[];
    userDomain: string;
    locationCode: string | number;
    languageCode: string;
    endpointAllowlist: readonly string[];
    estimatedCostMicros: number;
    remainingBudgetMicros: number;
  }>,
): readonly CommercialDiscoveryCall[] {
  if (
    !Number.isInteger(input.estimatedCostMicros) ||
    input.estimatedCostMicros <= 0 ||
    !Number.isInteger(input.remainingBudgetMicros) ||
    input.remainingBudgetMicros < 0
  ) {
    throw new TypeError("Commercial discovery budget is invalid");
  }
  const userDomain = createRecommendationDomainKey(
    input.userDomain,
  ).registrableDomain;
  const competitors = [
    ...new Set(
      input.verifiedCompetitorDomains.map(
        (value) => createRecommendationDomainKey(value).registrableDomain,
      ),
    ),
  ].filter((value) => value !== userDomain);
  const queries = [
    ...new Set(
      input.searchQueries.map((value) => value.trim()).filter(Boolean),
    ),
  ].slice(0, 20);
  const blueprintId = input.blueprintId === undefined
    ? null
    : nonBlank(input.blueprintId, "blueprintId");
  const serpCandidates = queries.map<CommercialDiscoveryCall>((query) => ({
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
      ...(blueprintId === null
        ? {}
        : {
            plannerLineage: Object.freeze({
              blueprintId,
              queryId: createHash("sha256")
                .update(`${blueprintId}\0${query}`, "utf8")
                .digest("hex"),
            }),
          }),
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v2",
      estimatedCostMicros: input.estimatedCostMicros,
    }));
  const competitorBacklinkCandidates =
    competitors.map<CommercialDiscoveryCall>((competitor) => ({
      endpoint: "/v3/backlinks/backlinks/live",
      intent: "DISCOVERY",
      sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
      request: {
        target: competitor,
        mode: "one_per_domain",
        backlinks_status_type: "live",
        include_subdomains: true,
        include_indirect_links: false,
        exclude_internal_backlinks: true,
        rank_scale: "one_hundred",
        limit: 100,
      },
      responseSchemaVersion:
        "dataforseo.backlinks-page-evidence-commercial.v1",
      estimatedCostMicros: input.estimatedCostMicros,
    }));
  const userReferringDomainCandidates: CommercialDiscoveryCall[] = [{
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
  }];

  const allowedCandidates = [
    serpCandidates,
    competitorBacklinkCandidates,
    userReferringDomainCandidates,
  ].map((bucket) =>
    bucket.flatMap((candidate) => {
      try {
        return [
          assertCommercialDiscoveryCallAllowed({
            call: candidate,
            endpointAllowlist: input.endpointAllowlist,
          }),
        ];
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED"
        ) {
          return [];
        }
        throw error;
      }
    })
  );
  const [allowedSerpCandidates = [], ...supplementalBuckets] =
    allowedCandidates;
  const calls: CommercialDiscoveryCall[] = [];
  let reserved = 0;
  const reserve = (candidate: CommercialDiscoveryCall | undefined): void => {
    if (
      candidate === undefined ||
      reserved + candidate.estimatedCostMicros > input.remainingBudgetMicros
    ) {
      return;
    }
    calls.push(candidate);
    reserved += candidate.estimatedCostMicros;
  };
  for (const candidate of allowedSerpCandidates) {
    reserve(candidate);
  }
  for (const bucket of supplementalBuckets) {
    reserve(bucket[0]);
  }
  for (
    let bucketIndex = 1;
    supplementalBuckets.some((bucket) => bucketIndex < bucket.length);
    bucketIndex += 1
  ) {
    for (const bucket of supplementalBuckets) {
      reserve(bucket[bucketIndex]);
    }
  }
  return Object.freeze(calls);
}

export function createCommercialCompetitorSeedPlan(
  input: Readonly<{
    userDomain: string;
    locationCode: string | number;
    languageCode: string;
    endpointAllowlist: readonly string[];
    estimatedCostMicros: number;
    remainingBudgetMicros: number;
  }>,
): readonly CommercialDiscoveryCall[] {
  if (
    !Number.isInteger(input.estimatedCostMicros) ||
    input.estimatedCostMicros <= 0 ||
    !Number.isInteger(input.remainingBudgetMicros) ||
    input.remainingBudgetMicros < 0
  ) {
    throw new TypeError("Commercial discovery budget is invalid");
  }
  if (input.remainingBudgetMicros < input.estimatedCostMicros) {
    return Object.freeze([]);
  }
  const call: CommercialDiscoveryCall = {
    endpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
    intent: "DISCOVERY",
    sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
    request: {
      target: createRecommendationDomainKey(input.userDomain)
        .registrableDomain,
      location_code: Number(input.locationCode),
      language_code: input.languageCode,
      limit: 100,
    },
    responseSchemaVersion: "dataforseo.labs-competitors-domain.v1",
    estimatedCostMicros: input.estimatedCostMicros,
  };
  try {
    return Object.freeze([
      assertCommercialDiscoveryCallAllowed({
        call,
        endpointAllowlist: input.endpointAllowlist,
      }),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED"
    ) {
      return Object.freeze([]);
    }
    throw error;
  }
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

function nestedMetric(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.values(value as Record<string, unknown>).reduce<number | null>(
    (maximum, entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return maximum;
      }
      const candidate = finiteNumber((entry as Record<string, unknown>)[key]);
      return candidate === null
        ? maximum
        : Math.max(maximum ?? candidate, candidate);
    },
    null,
  );
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

function discoveryUrlFrom(
  value: unknown,
  canonicalDomain: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (
      createRecommendationDomainKey(url.hostname).registrableDomain !==
      canonicalDomain
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function nullableTimestamp(value: unknown, name: string): string | null {
  if (value === null) return null;
  const parsed = timestamp(value);
  if (parsed === null) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function nullableHttpStatus(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return integerInRange(value, name, 100, 599);
}

function parseBacklinkPageEvidence(
  value: unknown,
  name: string,
): readonly CommercialBacklinkPageEvidence[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(value.map((raw, index) => {
    const item = record(raw, `${name}[${index}]`);
    assertStrictKeys(
      item,
      [
        "sourceUrl",
        "targetUrl",
        "anchorText",
        "linkStatus",
        "firstSeenAt",
        "lastSeenAt",
        "sourceHttpStatus",
        "targetHttpStatus",
      ],
      `${name}[${index}]`,
    );
    const sourceUrl = httpUrl(item.sourceUrl);
    const targetUrl = httpUrl(item.targetUrl);
    if (sourceUrl === null || targetUrl === null) {
      throw new TypeError(`${name}[${index}] has invalid URLs`);
    }
    return Object.freeze({
      sourceUrl,
      targetUrl,
      anchorText:
        item.anchorText === null
          ? null
          : nonBlank(item.anchorText, `${name}[${index}].anchorText`),
      linkStatus: member(
        ["active", "lost"] as const,
        item.linkStatus,
        `${name}[${index}].linkStatus`,
      ),
      firstSeenAt: nullableTimestamp(
        item.firstSeenAt,
        `${name}[${index}].firstSeenAt`,
      ),
      lastSeenAt: nullableTimestamp(
        item.lastSeenAt,
        `${name}[${index}].lastSeenAt`,
      ),
      sourceHttpStatus: nullableHttpStatus(
        item.sourceHttpStatus,
        `${name}[${index}].sourceHttpStatus`,
      ),
      targetHttpStatus: nullableHttpStatus(
        item.targetHttpStatus,
        `${name}[${index}].targetHttpStatus`,
      ),
    });
  }));
}

function resultItems(response: DataForSeoTask): readonly DataForSeoTask[] {
  return objects(response.tasks).flatMap((task) =>
    objects(task.result).flatMap((result) => [
      ...objects(result.items),
      ...objects(result.competitors),
      ...objects(result.referring_domains),
    ]),
  );
}

export function normalizeCommercialDiscoveryResponse(
  input: Readonly<{
    call: CommercialDiscoveryCall;
    response: unknown;
    collectedAt: string;
  }>,
): CommercialDiscoveryArtifact {
  const call = commercialDiscoveryCallSchema.parse(input.call);
  const response = record(input.response, "response");
  const requestFingerprint = fingerprintCommercialDiscoveryCall(call);
  const tasks = objects(response.tasks);
  const taskIds = tasks.flatMap((task) =>
    typeof task.id === "string" && task.id.trim().length > 0
      ? [task.id.trim()]
      : [],
  );
  const costMicros = Math.max(
    0,
    Math.round(
      tasks.reduce((sum, task) => sum + (finiteNumber(task.cost) ?? 0), 0) *
        1_000_000,
    ),
  );
  const byDomain = new Map<
    string,
    {
      rank: number | null;
      traffic: number | null;
      backlinkCount: number | null;
      referringDomainCount: number | null;
      spamScore: number | null;
      countryCode: string | null;
      discoveryUrls: Set<string>;
      backlinkPageEvidence: Map<string, CommercialBacklinkPageEvidence>;
    }
  >();
  for (const item of resultItems(response)) {
    const pageEvidenceEndpoint =
      call.endpoint === "/v3/backlinks/backlinks/live";
    const domain = domainFrom(
      pageEvidenceEndpoint
        ? item.domain_from ?? item.url_from
        : item.domain ?? item.target ?? item.url ?? item.source_url,
    );
    if (domain === null) continue;
    const sourceUrl = pageEvidenceEndpoint ? httpUrl(item.url_from) : null;
    const targetUrl = pageEvidenceEndpoint ? httpUrl(item.url_to) : null;
    const linkStatus: CommercialBacklinkPageEvidence["linkStatus"] =
      item.is_lost === true ? "lost" : "active";
    const pageEvidence =
      sourceUrl === null || targetUrl === null
        ? null
        : Object.freeze({
            sourceUrl,
            targetUrl,
            anchorText:
              typeof item.anchor === "string" && item.anchor.trim().length > 0
                ? item.anchor.trim()
                : null,
            linkStatus,
            firstSeenAt: timestamp(item.first_seen),
            lastSeenAt: timestamp(item.last_seen),
            sourceHttpStatus: nullableHttpStatus(
              item.page_from_status_code,
              "page_from_status_code",
            ),
            targetHttpStatus: nullableHttpStatus(
              item.url_to_status_code,
              "url_to_status_code",
            ),
          });
    const candidate = {
      rank: finiteNumber(
        item.domain_from_rank ?? item.rank ?? item.domain_rank,
      ),
      traffic:
        finiteNumber(
          item.organic_etv ??
            item.etv ??
            item.estimated_traffic ??
            item.traffic,
        ) ?? nestedMetric(item.full_domain_metrics, "etv"),
      backlinkCount:
        integer(item.backlinks ?? item.backlink_count) ??
        (call.endpoint.startsWith("/v3/backlinks/")
          ? integer(item.count)
          : null),
      referringDomainCount: integer(
        item.referring_domains ?? item.referring_domains_count,
      ),
      spamScore: finiteNumber(item.spam_score ?? item.backlink_spam_score),
      countryCode:
        typeof (
          item.domain_from_country ?? item.country_code ?? item.country
        ) === "string"
          ? String(
              item.domain_from_country ?? item.country_code ?? item.country,
            )
              .trim()
              .toUpperCase()
          : null,
      discoveryUrls: new Set(
        [
          item.url,
          item.source_url,
          item.target_url,
          item.url_from,
        ].flatMap((value) => {
          const url = discoveryUrlFrom(value, domain);
          return url === null ? [] : [url];
        }),
      ),
      backlinkPageEvidence: new Map(
        pageEvidence === null
          ? []
          : [[
              [
                pageEvidence.sourceUrl,
                pageEvidence.targetUrl,
                pageEvidence.anchorText ?? "",
                pageEvidence.firstSeenAt ?? "",
                pageEvidence.lastSeenAt ?? "",
              ].join("\0"),
              pageEvidence,
            ]],
      ),
    };
    const previous = byDomain.get(domain);
    if (previous === undefined) {
      byDomain.set(domain, candidate);
      continue;
    }
    candidate.discoveryUrls.forEach((url) => previous.discoveryUrls.add(url));
    candidate.backlinkPageEvidence.forEach((evidence, key) =>
      previous.backlinkPageEvidence.set(key, evidence)
    );
    if ((candidate.rank ?? -1) > (previous.rank ?? -1)) {
      byDomain.set(domain, {
        ...candidate,
        discoveryUrls: previous.discoveryUrls,
        backlinkPageEvidence: previous.backlinkPageEvidence,
      });
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
    ...(call.plannerLineage === undefined
      ? {}
      : { plannerLineage: call.plannerLineage }),
    candidates: [...byDomain.entries()]
      .map(([canonicalDomain, item]) => ({
        canonicalDomain,
        rank: item.rank,
        traffic: item.traffic,
        backlinkCount: item.backlinkCount,
        referringDomainCount: item.referringDomainCount,
        spamScore: item.spamScore,
        countryCode: item.countryCode,
        discoveryUrls: [...item.discoveryUrls].sort(),
        backlinkPageEvidence: [...item.backlinkPageEvidence.values()].sort(
          (left, right) =>
            left.sourceUrl.localeCompare(right.sourceUrl, "en") ||
            left.targetUrl.localeCompare(right.targetUrl, "en"),
        ),
        evidenceRefs: [
          `dataforseo:${call.endpoint}:${requestFingerprint}:${canonicalDomain}`,
        ],
      })),
  });
}

export function extractCommercialCompetitorSeeds(
  input: Readonly<{
    artifacts: readonly CommercialDiscoveryArtifact[];
    userDomain: string;
    excludedDomains: readonly string[];
    maximumSeeds?: number;
  }>,
): readonly string[] {
  const excluded = new Set([
    createRecommendationDomainKey(input.userDomain).registrableDomain,
    ...input.excludedDomains.map(
      (value) => createRecommendationDomainKey(value).registrableDomain,
    ),
  ]);
  const seeds = input.artifacts
    .map(commercialDiscoveryArtifactSchema.parse)
    .filter(
      ({ sourceType }) => sourceType === "VERIFIED_COMPETITOR_BACKLINK_GAP",
    )
    .flatMap(({ candidates }) => candidates)
    .map(
      ({ canonicalDomain }) =>
        createRecommendationDomainKey(canonicalDomain).registrableDomain,
    )
    .filter((domain) => !excluded.has(domain));
  return Object.freeze(
    [...new Set(seeds)].slice(0, input.maximumSeeds ?? 3),
  );
}

export function mergeCommercialDiscoveryArtifacts(
  input: Readonly<{
    artifacts: readonly CommercialDiscoveryArtifact[];
    userDomain: string;
    excludedDomains: readonly string[];
  }>,
): readonly Readonly<{
  canonicalDomain: string;
  discoveryUrls: readonly string[];
  sourceTypes: readonly CommercialDiscoverySourceType[];
  evidenceRefs: readonly string[];
  rank: number | null;
  traffic: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  spamScore: number | null;
  countryCode: string | null;
  backlinkPageEvidence: readonly CommercialBacklinkPageEvidence[];
}>[] {
  const excluded = new Set([
    createRecommendationDomainKey(input.userDomain).registrableDomain,
    ...input.excludedDomains.map(
      (value) => createRecommendationDomainKey(value).registrableDomain,
    ),
  ]);
  const merged = new Map<
    string,
    {
      sourceTypes: Set<CommercialDiscoverySourceType>;
      evidenceRefs: Set<string>;
      discoveryUrls: Set<string>;
      backlinkPageEvidence: Map<string, CommercialBacklinkPageEvidence>;
      rank: number | null;
      traffic: number | null;
      backlinkCount: number | null;
      referringDomainCount: number | null;
      spamScore: number | null;
      countryCode: string | null;
    }
  >();
  const sourceOrder: CommercialDiscoverySourceType[] = [];
  for (const rawArtifact of input.artifacts) {
    const artifact = commercialDiscoveryArtifactSchema.parse(rawArtifact);
    if (artifact.sourceType === "VERIFIED_COMPETITOR_BACKLINK_GAP") {
      continue;
    }
    if (
      artifact.sourceType !== "USER_REFERRING_DOMAINS" &&
      !sourceOrder.includes(artifact.sourceType)
    ) {
      sourceOrder.push(artifact.sourceType);
    }
    for (const candidate of artifact.candidates) {
      if (
        artifact.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS" &&
        candidate.backlinkPageEvidence.length > 0 &&
        !candidate.backlinkPageEvidence.some(
          ({ linkStatus }) => linkStatus === "active",
        )
      ) {
        continue;
      }
      const domain = createRecommendationDomainKey(
        candidate.canonicalDomain,
      ).registrableDomain;
      if (excluded.has(domain)) continue;
      const item = merged.get(domain) ?? {
        sourceTypes: new Set<CommercialDiscoverySourceType>(),
        evidenceRefs: new Set<string>(),
        discoveryUrls: new Set<string>(),
        backlinkPageEvidence:
          new Map<string, CommercialBacklinkPageEvidence>(),
        rank: null,
        traffic: null,
        backlinkCount: null,
        referringDomainCount: null,
        spamScore: null,
        countryCode: null,
      };
      item.sourceTypes.add(artifact.sourceType);
      candidate.evidenceRefs.forEach((ref) => item.evidenceRefs.add(ref));
      candidate.discoveryUrls.forEach((url) => item.discoveryUrls.add(url));
      candidate.backlinkPageEvidence.forEach((evidence) => {
        const key = [
          evidence.sourceUrl,
          evidence.targetUrl,
          evidence.anchorText ?? "",
          evidence.firstSeenAt ?? "",
          evidence.lastSeenAt ?? "",
        ].join("\0");
        item.backlinkPageEvidence.set(key, evidence);
      });
      item.rank = Math.max(item.rank ?? -1, candidate.rank ?? -1);
      item.traffic = Math.max(item.traffic ?? -1, candidate.traffic ?? -1);
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
      item.countryCode ??= candidate.countryCode;
      merged.set(domain, item);
    }
  }
  const candidates = [...merged.entries()]
    .filter(([, item]) =>
      [...item.sourceTypes].some(
        (sourceType) => sourceType !== "USER_REFERRING_DOMAINS",
      ),
    )
    .map(([canonicalDomain, item]) =>
      Object.freeze({
        canonicalDomain,
        discoveryUrls: Object.freeze([...item.discoveryUrls].sort()),
        sourceTypes: Object.freeze([...item.sourceTypes].sort()),
        evidenceRefs: Object.freeze([...item.evidenceRefs].sort()),
        rank: item.rank === -1 ? null : item.rank,
        traffic: item.traffic === -1 ? null : item.traffic,
        backlinkCount: item.backlinkCount === -1 ? null : item.backlinkCount,
        referringDomainCount:
          item.referringDomainCount === -1 ? null : item.referringDomainCount,
        spamScore: item.spamScore === -1 ? null : item.spamScore,
        countryCode: item.countryCode,
        backlinkPageEvidence: Object.freeze(
          [...item.backlinkPageEvidence.values()].sort(
            (left, right) =>
              left.sourceUrl.localeCompare(right.sourceUrl, "en") ||
              left.targetUrl.localeCompare(right.targetUrl, "en"),
          ),
        ),
      }),
    );
  const buckets = sourceOrder.map((sourceType) =>
    candidates
      .filter(({ sourceTypes }) => sourceTypes.includes(sourceType))
      .sort(
        (left, right) =>
          (right.rank ?? -1) - (left.rank ?? -1) ||
          left.canonicalDomain.localeCompare(right.canonicalDomain, "en"),
      )
  );
  const ordered: typeof candidates = [];
  const selected = new Set<string>();
  for (
    let index = 0;
    buckets.some((bucket) => index < bucket.length);
    index += 1
  ) {
    for (const bucket of buckets) {
      const candidate = bucket[index];
      if (
        candidate !== undefined &&
        !selected.has(candidate.canonicalDomain)
      ) {
        selected.add(candidate.canonicalDomain);
        ordered.push(candidate);
      }
    }
  }
  return Object.freeze(ordered);
}
