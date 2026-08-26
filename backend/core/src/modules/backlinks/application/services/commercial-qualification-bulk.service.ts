import { createHash } from "node:crypto";

import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";

export type CommercialQualificationMetricScope = "TARGET_MARKET" | "GLOBAL";

export const commercialQualificationBulkEndpoints = Object.freeze({
  traffic:
    "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
  spam: "/v3/backlinks/bulk_spam_score/live",
  rank: "/v3/backlinks/bulk_ranks/live",
});

export type CommercialQualificationBulkCall = Readonly<{
  kind: "traffic" | "spam" | "rank";
  endpoint: string;
  targets: readonly string[];
  body: readonly Readonly<Record<string, unknown>>[];
  requestFingerprint: string;
}>;

export type CommercialQualificationBulkResponse = Readonly<{
  status: "completed" | "partial" | "unknown_charge" | "unavailable";
  body: unknown;
  providerRequestId: string | null;
  costMicros: number;
}>;

export interface CommercialQualificationBulkRuntime {
  execute(
    call: CommercialQualificationBulkCall,
  ): Promise<CommercialQualificationBulkResponse>;
}

type MetricState =
  | "completed"
  | "missing"
  | "unknown_charge"
  | "unavailable";

export type CommercialQualificationBulkRecord = Readonly<{
  canonicalDomain: string;
  trafficOrganicEtv: number | null;
  spamScore: number | null;
  authorityRank: number | null;
  trafficState: MetricState;
  spamState: MetricState;
  rankState: MetricState;
  requestFingerprints: Readonly<{
    traffic: string;
    spam: string;
    rank: string;
  }>;
}>;

export type CommercialQualificationBulkResult = Readonly<{
  state: "completed" | "partial" | "unknown_charge" | "unavailable";
  metricScope: CommercialQualificationMetricScope;
  records: readonly CommercialQualificationBulkRecord[];
  callCount: number;
  costMicros: number;
}>;

type CompletedCall = Readonly<{
  call: CommercialQualificationBulkCall;
  response: CommercialQualificationBulkResponse;
  dispatched: boolean;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter(
        (item): item is Record<string, unknown> => item !== null,
      )
    : [];
}

function responseItems(body: unknown): readonly Record<string, unknown>[] {
  const root = record(body);
  return records(root?.tasks).flatMap((task) =>
    records(task.result).flatMap((result) => records(result.items)));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function canonicalDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return createRecommendationDomainKey(value).registrableDomain;
  } catch {
    return null;
  }
}

function trafficValue(item: Record<string, unknown>): number | null {
  const metrics = record(item.metrics);
  const organic = record(metrics?.organic);
  return finiteNumber(organic?.etv);
}

function parseMetric(
  kind: CommercialQualificationBulkCall["kind"],
  body: unknown,
): ReadonlyMap<string, number> {
  const parsed = new Map<string, number>();
  for (const item of responseItems(body)) {
    const domain = canonicalDomain(item.target);
    const value = kind === "traffic"
      ? trafficValue(item)
      : kind === "spam"
        ? finiteNumber(item.spam_score)
        : finiteNumber(item.rank);
    if (domain !== null && value !== null) parsed.set(domain, value);
  }
  return parsed;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function endpointPath(value: string): string {
  return new URL(value, "https://api.dataforseo.com").pathname;
}

function chunks<T>(items: readonly T[], size: number): readonly T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(items[index] as T);
      }
    },
  ));
  return output;
}

function createCalls(input: Readonly<{
  domains: readonly string[];
  metricScope: CommercialQualificationMetricScope;
  locationCode: number | null;
  languageCode: string | null;
  chunkSize: number;
}>): readonly CommercialQualificationBulkCall[] {
  return chunks(input.domains, input.chunkSize).flatMap((targets) => {
    const trafficBody: Record<string, unknown> = {
      targets,
      item_types: ["organic"],
    };
    if (input.metricScope === "TARGET_MARKET") {
      if (
        input.locationCode === null
        || !Number.isInteger(input.locationCode)
        || input.languageCode === null
        || input.languageCode.trim().length === 0
      ) {
        throw new TypeError(
          "TARGET_MARKET traffic requires location and language codes.",
        );
      }
      trafficBody.location_code = input.locationCode;
      trafficBody.language_code = input.languageCode.trim();
    }
    const specifications = [
      {
        kind: "traffic" as const,
        endpoint: commercialQualificationBulkEndpoints.traffic,
        body: [trafficBody],
      },
      {
        kind: "spam" as const,
        endpoint: commercialQualificationBulkEndpoints.spam,
        body: [{ targets }],
      },
      {
        kind: "rank" as const,
        endpoint: commercialQualificationBulkEndpoints.rank,
        body: [{ targets, rank_scale: "one_hundred" }],
      },
    ];
    return specifications.map((specification) => Object.freeze({
      ...specification,
      targets: Object.freeze([...targets]),
      body: Object.freeze(specification.body),
      requestFingerprint: fingerprint({
        endpoint: specification.endpoint,
        body: specification.body,
      }),
    }));
  });
}

function responseState(
  response: CommercialQualificationBulkResponse,
  hasValue: boolean,
): MetricState {
  if (response.status === "unknown_charge") return "unknown_charge";
  if (response.status === "unavailable") return "unavailable";
  return hasValue ? "completed" : "missing";
}

function overallState(
  calls: readonly CompletedCall[],
  recordsByDomain: readonly CommercialQualificationBulkRecord[],
): CommercialQualificationBulkResult["state"] {
  if (calls.some(({ response }) => response.status === "unknown_charge")) {
    return "unknown_charge";
  }
  if (calls.every(({ response }) => response.status === "unavailable")) {
    return "unavailable";
  }
  return recordsByDomain.every((item) =>
    item.trafficState === "completed"
    && item.spamState === "completed"
    && item.rankState === "completed")
    ? "completed"
    : "partial";
}

export async function collectCommercialQualificationBulkMetrics(
  input: Readonly<{
    domains: readonly string[];
    metricScope: CommercialQualificationMetricScope;
    locationCode: number | null;
    languageCode: string | null;
    endpointAllowlist: readonly string[];
    chunkSize?: number;
    concurrency?: number;
    runtime: CommercialQualificationBulkRuntime;
  }>,
): Promise<CommercialQualificationBulkResult> {
  const chunkSize = input.chunkSize ?? 1_000;
  const concurrency = input.concurrency ?? 2;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_000) {
    throw new TypeError("Bulk qualification chunkSize must be from 1 to 1000.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TypeError("Bulk qualification concurrency must be from 1 to 8.");
  }
  const domains = [...new Set(input.domains.map((value) =>
    createRecommendationDomainKey(value).registrableDomain))].sort();
  const calls = createCalls({
    domains,
    metricScope: input.metricScope,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    chunkSize,
  });
  const allowlist = new Set(input.endpointAllowlist.map(endpointPath));
  for (const call of calls) {
    if (!allowlist.has(endpointPath(call.endpoint))) {
      throw new Error(`Bulk qualification endpoint is not allowlisted: ${
        call.endpoint
      }`);
    }
  }
  let terminalResponseObserved = false;
  const completedCalls = await mapConcurrent(
    calls,
    concurrency,
    async (call): Promise<CompletedCall> => {
      if (terminalResponseObserved) {
        return {
          call,
          response: {
            status: "unavailable",
            body: null,
            providerRequestId: null,
            costMicros: 0,
          },
          dispatched: false,
        };
      }
      const response = await input.runtime.execute(call);
      if (
        response.status === "unknown_charge"
        || response.status === "unavailable"
      ) {
        terminalResponseObserved = true;
      }
      return { call, response, dispatched: true };
    },
  );
  const values = {
    traffic: new Map<string, number>(),
    spam: new Map<string, number>(),
    rank: new Map<string, number>(),
  };
  const callByDomain = new Map<
    string,
    Partial<Record<CommercialQualificationBulkCall["kind"], CompletedCall>>
  >();
  for (const completed of completedCalls) {
    for (const [domain, value] of parseMetric(
      completed.call.kind,
      completed.response.body,
    )) {
      values[completed.call.kind].set(domain, value);
    }
    for (const domain of completed.call.targets) {
      callByDomain.set(domain, {
        ...callByDomain.get(domain),
        [completed.call.kind]: completed,
      });
    }
  }
  const output = domains.map((domain): CommercialQualificationBulkRecord => {
    const domainCalls = callByDomain.get(domain);
    const traffic = domainCalls?.traffic;
    const spam = domainCalls?.spam;
    const rank = domainCalls?.rank;
    if (traffic === undefined || spam === undefined || rank === undefined) {
      throw new Error("Bulk qualification call coverage is incomplete.");
    }
    return Object.freeze({
      canonicalDomain: domain,
      trafficOrganicEtv: values.traffic.get(domain) ?? null,
      spamScore: values.spam.get(domain) ?? null,
      authorityRank: values.rank.get(domain) ?? null,
      trafficState: responseState(
        traffic.response,
        values.traffic.has(domain),
      ),
      spamState: responseState(spam.response, values.spam.has(domain)),
      rankState: responseState(rank.response, values.rank.has(domain)),
      requestFingerprints: Object.freeze({
        traffic: traffic.call.requestFingerprint,
        spam: spam.call.requestFingerprint,
        rank: rank.call.requestFingerprint,
      }),
    });
  });
  return Object.freeze({
    state: overallState(completedCalls, output),
    metricScope: input.metricScope,
    records: Object.freeze(output),
    callCount: completedCalls.filter(({ dispatched }) => dispatched).length,
    costMicros: completedCalls.reduce(
      (sum, item) => sum + item.response.costMicros,
      0,
    ),
  });
}
