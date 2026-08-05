import { createRequire } from "node:module";

import type {
  BacklinkSnapshotRequest,
} from "../../ports/dataforseo.port.js";
import type {
  DataForSeoClientRuntimeFactory,
} from "./client.js";
import {
  DataForSeoRuntimeError,
  type DataForSeoRuntimeFailureKind,
} from "./error-mapper.js";

const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
const REFERRING_DOMAINS_LIVE_ENDPOINT =
  `${DATAFORSEO_BASE_URL}/v3/backlinks/referring_domains/live`;

interface OfficialResponse {
  toJSON(): unknown;
}

interface OfficialBacklinksApi {
  referringDomainsLive(
    request: readonly [unknown],
  ): Promise<OfficialResponse | null>;
}

interface OfficialSdk {
  BacklinksApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => OfficialBacklinksApi;
  BacklinksReferringDomainsLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const require = createRequire(import.meta.url);
const {
  BacklinksApi,
  BacklinksReferringDomainsLiveRequestInfo,
} = require("dataforseo-client") as OfficialSdk;

function statusFailureKind(statusCode: number): DataForSeoRuntimeFailureKind {
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode === 402) return "balance";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 400 && statusCode < 500) return "invalid_request";
  return "server_error";
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as Readonly<Record<string, unknown>>).status;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

function normalizeJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("DataForSEO response is not JSON serializable");
  }
  return JSON.parse(serialized) as unknown;
}

function buildRequest(
  request: BacklinkSnapshotRequest,
): unknown {
  return new BacklinksReferringDomainsLiveRequestInfo({
    target: request.target,
    limit: request.limit,
    backlinks_status_type: "live",
    order_by: ["rank,desc"],
    include_subdomains: request.targetType === "domain",
    include_indirect_links: false,
    exclude_internal_backlinks: true,
    rank_scale: "one_hundred",
  });
}

export function createOfficialDataForSeoRuntimeFactory(
  fetchImplementation: FetchImplementation = globalThis.fetch,
): DataForSeoClientRuntimeFactory {
  return ({ credentials, timeoutMs }) => ({
    async fetchBacklinkSnapshot(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let requestDispatched = false;
      let responseStatus: number | undefined;
      const authenticatedFetch: FetchImplementation = async (input, init) => {
        if (String(input) !== REFERRING_DOMAINS_LIVE_ENDPOINT) {
          throw new DataForSeoRuntimeError({
            kind: "invalid_request",
            requestDispatched: false,
          });
        }
        const headers = new Headers(init?.headers);
        headers.set(
          "authorization",
          `Basic ${Buffer.from(
            `${credentials.login}:${credentials.password}`,
            "utf8",
          ).toString("base64")}`,
        );
        requestDispatched = true;
        const response = await fetchImplementation(input, {
          ...init,
          headers,
          signal: controller.signal,
        });
        responseStatus = response.status;
        return response;
      };
      const api = new BacklinksApi(DATAFORSEO_BASE_URL, {
        fetch: authenticatedFetch,
      });

      try {
        const response = await api.referringDomainsLive([
          buildRequest(request),
        ]);
        if (response === null) {
          throw new DataForSeoRuntimeError({
            kind: "malformed_response",
            requestDispatched,
            statusCode: responseStatus,
          });
        }
        return normalizeJson(response.toJSON());
      } catch (error) {
        if (error instanceof DataForSeoRuntimeError) throw error;
        const statusCode = errorStatus(error) ?? responseStatus;
        if (controller.signal.aborted) {
          throw new DataForSeoRuntimeError({
            kind: "timeout",
            requestDispatched,
            statusCode,
          }, error);
        }
        if (statusCode !== undefined && statusCode >= 400) {
          throw new DataForSeoRuntimeError({
            kind: statusFailureKind(statusCode),
            requestDispatched,
            statusCode,
          }, error);
        }
        throw new DataForSeoRuntimeError({
          kind: error instanceof SyntaxError || error instanceof TypeError
            ? "malformed_response"
            : "network",
          requestDispatched,
          statusCode,
        }, error);
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
