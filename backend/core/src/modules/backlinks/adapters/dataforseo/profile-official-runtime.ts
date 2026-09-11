import { createRequire } from "node:module";
import { archiveDataForSeoFetch } from "../../../provider-archive/capture-fetch.js";

import {
  DataForSeoRuntimeError,
  type DataForSeoRuntimeFailureKind,
} from "./error-mapper.js";

const baseUrl = "https://api.dataforseo.com";
const summaryEndpoint = "/v3/backlinks/summary/live";
const inventoryEndpoint = "/v3/backlinks/backlinks/live";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface OfficialResponse {
  toJSON(): unknown;
}

interface OfficialBacklinksApi {
  summaryLive(request: readonly [unknown]): Promise<OfficialResponse | null>;
  backlinksLive(request: readonly [unknown]): Promise<OfficialResponse | null>;
}

interface OfficialSdk {
  BacklinksApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => OfficialBacklinksApi;
  BacklinksSummaryLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksBacklinksLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
}

type JsonRecord = Readonly<Record<string, unknown>>;

export type DataForSeoProfileSummary = Readonly<{
  providerTaskId: string | null;
  schemaVersion: string;
  costMicros: number;
  totalBacklinks: number | null;
  referringDomains: number | null;
  dofollow: number | null;
  nofollow: number | null;
  sponsored: number | null;
  ugc: number | null;
  distributions: Readonly<{
    countries: JsonRecord;
    tlds: JsonRecord;
    linkTypes: JsonRecord;
    attributes: JsonRecord;
  }>;
  raw: unknown;
}>;

export type DataForSeoProfileInventoryItem = Readonly<{
  providerIdentity: string;
  sourceDomain: string | null;
  sourceUrl: string;
  targetUrl: string;
  anchor: string;
  rel: readonly string[];
  isNew: boolean;
  isLost: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  rank: number | null;
  spamScore: number | null;
  countryCode: string | null;
  tld: string | null;
  languageCode: string | null;
  sourceHttpStatus: number | null;
  targetHttpStatus: number | null;
  redirectUrl: string | null;
}>;

export type DataForSeoProfileInventoryPage = Readonly<{
  providerTaskId: string | null;
  schemaVersion: string;
  costMicros: number;
  totalCount: number | null;
  pulledCount: number;
  nextCursor: string | null;
  items: readonly DataForSeoProfileInventoryItem[];
  raw: unknown;
}>;

export type OfficialDataForSeoProfileRuntime = Readonly<{
  fetchSummary(input: Readonly<{
    canonicalDomain: string;
    requestTag: string;
  }>): Promise<DataForSeoProfileSummary>;
  fetchInventoryPage(input: Readonly<{
    canonicalDomain: string;
    requestTag: string;
    limit: number;
    searchAfterToken: string | null;
  }>): Promise<DataForSeoProfileInventoryPage>;
}>;

const require = createRequire(import.meta.url);
const {
  BacklinksApi,
  BacklinksSummaryLiveRequestInfo,
  BacklinksBacklinksLiveRequestInfo,
} = require("dataforseo-client") as OfficialSdk;

const record = (value: unknown): JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const booleanValue = (value: unknown): boolean => value === true;

const costMicros = (value: unknown): number =>
  Math.max(0, Math.round((numberValue(value) ?? 0) * 1_000_000));

function responseTask(value: unknown): Readonly<{
  task: JsonRecord;
  result: JsonRecord;
}> {
  const root = record(value);
  const task = record(array(root.tasks)[0]);
  const result = record(array(task.result)[0]);
  if (Object.keys(task).length === 0 || Object.keys(result).length === 0) {
    throw new DataForSeoRuntimeError({
      kind: "malformed_response",
      requestDispatched: true,
    });
  }
  return { task, result };
}

function statusFailureKind(statusCode: number): DataForSeoRuntimeFailureKind {
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode === 402) return "balance";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 400 && statusCode < 500) return "invalid_request";
  return "server_error";
}

function asJson(response: OfficialResponse): unknown {
  return JSON.parse(JSON.stringify(response.toJSON())) as unknown;
}

function attributes(item: JsonRecord): readonly string[] {
  const values = array(item.attributes)
    .filter((value): value is string => typeof value === "string");
  if (booleanValue(item.dofollow) && !values.includes("dofollow")) {
    return Object.freeze([...values, "dofollow"]);
  }
  if (!booleanValue(item.dofollow) && !values.includes("nofollow")) {
    return Object.freeze([...values, "nofollow"]);
  }
  return Object.freeze(values);
}

function normalizeInventoryItem(
  itemValue: unknown,
): DataForSeoProfileInventoryItem | null {
  const item = record(itemValue);
  const sourceUrl = stringValue(item.url_from);
  const targetUrl = stringValue(item.url_to);
  if (sourceUrl === null || targetUrl === null) return null;
  return Object.freeze({
    providerIdentity: [
      stringValue(item.type) ?? "backlink",
      sourceUrl,
      targetUrl,
    ].join(":"),
    sourceDomain: stringValue(item.domain_from),
    sourceUrl,
    targetUrl,
    anchor: stringValue(item.anchor) ?? "",
    rel: attributes(item),
    isNew: booleanValue(item.is_new),
    isLost: booleanValue(item.is_lost),
    firstSeenAt: stringValue(item.first_seen),
    lastSeenAt: stringValue(item.last_seen),
    rank: numberValue(item.domain_from_rank) ?? numberValue(item.rank),
    spamScore:
      numberValue(item.backlink_spam_score) ?? numberValue(item.spam_score),
    countryCode: stringValue(item.domain_from_country),
    tld: stringValue(item.tld_from),
    languageCode: stringValue(item.page_from_language),
    sourceHttpStatus: numberValue(item.page_from_status_code),
    targetHttpStatus: numberValue(item.url_to_status_code),
    redirectUrl: stringValue(item.url_to_redirect_target),
  });
}

export function createOfficialDataForSeoProfileRuntime(options: Readonly<{
  credentials: Readonly<{ login: string; password: string }>;
  endpointAllowlist: readonly string[];
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
}>): OfficialDataForSeoProfileRuntime {
  const allowlist = new Set(options.endpointAllowlist.map((endpoint) => {
    try {
      return new URL(endpoint).pathname;
    } catch {
      return endpoint;
    }
  }));
  const fetchImplementation = archiveDataForSeoFetch(
    options.fetchImplementation ?? globalThis.fetch, "backlinks-profile",
  );

  const call = async (
    endpoint: string,
    execute: (api: OfficialBacklinksApi) => Promise<OfficialResponse | null>,
  ): Promise<unknown> => {
    if (!allowlist.has(endpoint)) {
      throw new Error("DATAFORSEO_ENDPOINT_NOT_ALLOWLISTED");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let dispatched = false;
    let responseStatus: number | undefined;
    const authenticatedFetch: FetchImplementation = async (input, init) => {
      if (String(input) !== `${baseUrl}${endpoint}`) {
        throw new DataForSeoRuntimeError({
          kind: "invalid_request",
          requestDispatched: false,
        });
      }
      const headers = new Headers(init?.headers);
      headers.set(
        "authorization",
        `Basic ${Buffer.from(
          `${options.credentials.login}:${options.credentials.password}`,
          "utf8",
        ).toString("base64")}`,
      );
      dispatched = true;
      const response = await fetchImplementation(input, {
        ...init,
        headers,
        signal: controller.signal,
      });
      responseStatus = response.status;
      return response;
    };
    try {
      const response = await execute(new BacklinksApi(baseUrl, {
        fetch: authenticatedFetch,
      }));
      if (response === null) {
        throw new DataForSeoRuntimeError({
          kind: "malformed_response",
          requestDispatched: dispatched,
          statusCode: responseStatus,
        });
      }
      return asJson(response);
    } catch (error) {
      if (error instanceof DataForSeoRuntimeError) throw error;
      if (controller.signal.aborted) {
        throw new DataForSeoRuntimeError({
          kind: "timeout",
          requestDispatched: dispatched,
          statusCode: responseStatus,
        }, error);
      }
      if (responseStatus !== undefined && responseStatus >= 400) {
        throw new DataForSeoRuntimeError({
          kind: statusFailureKind(responseStatus),
          requestDispatched: dispatched,
          statusCode: responseStatus,
        }, error);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  return Object.freeze({
    async fetchSummary(input) {
      const raw = await call(
        summaryEndpoint,
        (api) => api.summaryLive([
          new BacklinksSummaryLiveRequestInfo({
            target: input.canonicalDomain,
            include_subdomains: true,
            include_indirect_links: false,
            exclude_internal_backlinks: true,
            internal_list_limit: 100,
            backlinks_status_type: "all",
            rank_scale: "one_hundred",
            tag: input.requestTag,
          }),
        ]),
      );
      const { task, result } = responseTask(raw);
      const rel = record(result.referring_links_attributes);
      return Object.freeze({
        providerTaskId: stringValue(task.id),
        schemaVersion: stringValue(record(raw).version)
          ?? "dataforseo.backlinks-profile.v1",
        costMicros: costMicros(task.cost),
        totalBacklinks: numberValue(result.backlinks),
        referringDomains: numberValue(result.referring_domains),
        dofollow: numberValue(rel.dofollow),
        nofollow: numberValue(rel.nofollow),
        sponsored: numberValue(rel.sponsored),
        ugc: numberValue(rel.ugc),
        distributions: Object.freeze({
          countries: record(result.referring_links_countries),
          tlds: record(result.referring_links_tld),
          linkTypes: record(result.referring_links_types),
          attributes: rel,
        }),
        raw,
      });
    },

    async fetchInventoryPage(input) {
      const raw = await call(
        inventoryEndpoint,
        (api) => api.backlinksLive([
          new BacklinksBacklinksLiveRequestInfo({
            target: input.canonicalDomain,
            mode: "as_is",
            order_by: ["rank,desc"],
            limit: input.limit,
            ...(input.searchAfterToken === null
              ? {}
              : { search_after_token: input.searchAfterToken }),
            backlinks_status_type: "all",
            include_subdomains: true,
            include_indirect_links: false,
            exclude_internal_backlinks: true,
            rank_scale: "one_hundred",
            tag: input.requestTag,
          }),
        ]),
      );
      const { task, result } = responseTask(raw);
      const items = array(result.items)
        .map(normalizeInventoryItem)
        .filter((item): item is DataForSeoProfileInventoryItem => item !== null);
      return Object.freeze({
        providerTaskId: stringValue(task.id),
        schemaVersion: stringValue(record(raw).version)
          ?? "dataforseo.backlinks-profile.v1",
        costMicros: costMicros(task.cost),
        totalCount: numberValue(result.total_count),
        pulledCount: items.length,
        nextCursor: stringValue(result.search_after_token),
        items: Object.freeze(items),
        raw,
      });
    },
  });
}
