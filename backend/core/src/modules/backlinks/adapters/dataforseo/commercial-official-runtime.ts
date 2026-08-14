import { createRequire } from "node:module";

import {
  assertCommercialDiscoveryCallAllowed,
  type CommercialDiscoveryCall,
} from "../../domain/recommendations/commercial-discovery-source.js";
import {
  DataForSeoRuntimeError,
  mapDataForSeoProviderError,
  type DataForSeoRuntimeFailureKind,
} from "./error-mapper.js";

const baseUrl = "https://api.dataforseo.com";
const taskGetPrefix =
  "/v3/serp/google/organic/task_get/advanced/";

interface OfficialResponse {
  toJSON(): unknown;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface OfficialSdk {
  SerpApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => {
    googleOrganicTaskPost(body: readonly unknown[]):
      Promise<OfficialResponse | null>;
    googleOrganicTasksReady(): Promise<OfficialResponse | null>;
    googleOrganicTaskGetAdvanced(id: string):
      Promise<OfficialResponse | null>;
  };
  DataforseoLabsApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => {
    googleCompetitorsDomainLive(body: readonly unknown[]):
      Promise<OfficialResponse | null>;
  };
  BacklinksApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => {
    competitorsLive(body: readonly unknown[]):
      Promise<OfficialResponse | null>;
    referringDomainsLive(body: readonly unknown[]):
      Promise<OfficialResponse | null>;
  };
  SerpGoogleOrganicTaskPostRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  DataforseoLabsGoogleCompetitorsDomainLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksCompetitorsLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksReferringDomainsLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
}

const require = createRequire(import.meta.url);
const {
  SerpApi,
  DataforseoLabsApi,
  BacklinksApi,
  SerpGoogleOrganicTaskPostRequestInfo,
  DataforseoLabsGoogleCompetitorsDomainLiveRequestInfo,
  BacklinksCompetitorsLiveRequestInfo,
  BacklinksReferringDomainsLiveRequestInfo,
} = require("dataforseo-client") as OfficialSdk;

function statusFailureKind(status: number): DataForSeoRuntimeFailureKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "balance";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "server_error";
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as Readonly<Record<string, unknown>>).status;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

function normalizeJson(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("DataForSEO response is not JSON serializable");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("DataForSEO response must be an object");
  }
  return parsed as Record<string, unknown>;
}

function tasks(value: unknown): readonly Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const raw = (value as Readonly<Record<string, unknown>>).tasks;
  return Array.isArray(raw)
    ? raw.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    : [];
}

function firstTaskId(value: unknown): string | null {
  for (const task of tasks(value)) {
    if (typeof task.id === "string" && task.id.trim().length > 0) {
      return task.id.trim();
    }
  }
  return null;
}

function taskStatusCode(
  value: unknown,
  taskId: string,
): number | null {
  for (const task of tasks(value)) {
    if (task.id !== taskId) continue;
    return typeof task.status_code === "number"
        && Number.isInteger(task.status_code)
      ? task.status_code
      : null;
  }
  return null;
}

function readyTaskIds(value: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const task of tasks(value)) {
    const result = Array.isArray(task.result) ? task.result : [];
    for (const item of result) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const id = (item as Readonly<Record<string, unknown>>).id;
      if (typeof id === "string" && id.trim().length > 0) ids.add(id.trim());
    }
  }
  return ids;
}

function allowedPath(
  rawUrl: string,
  endpointAllowlist: readonly string[],
): boolean {
  const url = new URL(rawUrl);
  const paths = new Set(endpointAllowlist.map((value) => new URL(value).pathname));
  if (paths.has(url.pathname)) return true;
  return url.pathname.startsWith(taskGetPrefix)
    && paths.has("/v3/serp/google/organic/task_get/advanced");
}

export type CommercialDataForSeoCredentials = Readonly<{
  login: string;
  password: string;
}>;

export type CommercialDataForSeoExecutionHooks = Readonly<{
  onProviderTaskAccepted?(taskId: string): Promise<void> | void;
}>;

export type CommercialDataForSeoRuntime = Readonly<{
  execute(
    call: CommercialDiscoveryCall,
    hooks?: CommercialDataForSeoExecutionHooks,
  ): Promise<Record<string, unknown>>;
  recoverAcceptedTask?(
    call: CommercialDiscoveryCall,
    providerTaskId: string,
  ): Promise<Record<string, unknown>>;
}>;

export function createCommercialOfficialDataForSeoRuntime(input: Readonly<{
  credentials: CommercialDataForSeoCredentials;
  endpointAllowlist: readonly string[];
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  sleep?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
}>): CommercialDataForSeoRuntime {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const sleep = input.sleep
    ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollAttempts = input.pollAttempts ?? 600;
  const pollIntervalMs = input.pollIntervalMs ?? 500;

  return Object.freeze({
    async execute(rawCall, hooks) {
      const call = assertCommercialDiscoveryCallAllowed({
        call: rawCall,
        endpointAllowlist: input.endpointAllowlist,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      let requestDispatched = false;
      let responseStatus: number | undefined;
      const authenticatedFetch: FetchImplementation = async (request, init) => {
        const url = String(request);
        if (!allowedPath(url, input.endpointAllowlist)) {
          throw new DataForSeoRuntimeError({
            kind: "invalid_request",
            requestDispatched: false,
          });
        }
        const headers = new Headers(init?.headers);
        headers.set(
          "authorization",
          `Basic ${Buffer.from(
            `${input.credentials.login}:${input.credentials.password}`,
            "utf8",
          ).toString("base64")}`,
        );
        requestDispatched = true;
        const response = await fetchImplementation(request, {
          ...init,
          headers,
          signal: controller.signal,
        });
        responseStatus = response.status;
        return response;
      };
      const serp = new SerpApi(baseUrl, { fetch: authenticatedFetch });
      const labs = new DataforseoLabsApi(baseUrl, {
        fetch: authenticatedFetch,
      });
      const backlinks = new BacklinksApi(baseUrl, {
        fetch: authenticatedFetch,
      });
      const requireResponse = (value: OfficialResponse | null) => {
        if (value === null) {
          throw new DataForSeoRuntimeError({
            kind: "malformed_response",
            requestDispatched,
            statusCode: responseStatus,
          });
        }
        return normalizeJson(value.toJSON());
      };

      try {
        if (call.endpoint === "/v3/serp/google/organic/task_post") {
          const posted = requireResponse(await serp.googleOrganicTaskPost([
            new SerpGoogleOrganicTaskPostRequestInfo(call.request),
          ]));
          const taskId = firstTaskId(posted);
          if (taskId === null) {
            throw new DataForSeoRuntimeError({
              kind: "malformed_response",
              requestDispatched,
              statusCode: responseStatus,
            });
          }
          if (taskStatusCode(posted, taskId) !== 20100) {
            throw new DataForSeoRuntimeError({
              kind: "invalid_request",
              requestDispatched,
              statusCode: responseStatus,
            });
          }
          await hooks?.onProviderTaskAccepted?.(taskId);
          for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
            if (attempt > 0) await sleep(pollIntervalMs);
            const ready = requireResponse(await serp.googleOrganicTasksReady());
            if (!readyTaskIds(ready).has(taskId)) continue;
            return requireResponse(
              await serp.googleOrganicTaskGetAdvanced(taskId),
            );
          }
          throw new DataForSeoRuntimeError({
            kind: "timeout",
            requestDispatched,
            statusCode: responseStatus,
          });
        }
        if (
          call.endpoint
          === "/v3/dataforseo_labs/google/competitors_domain/live"
        ) {
          return requireResponse(await labs.googleCompetitorsDomainLive([
            new DataforseoLabsGoogleCompetitorsDomainLiveRequestInfo(
              call.request,
            ),
          ]));
        }
        if (call.endpoint === "/v3/backlinks/competitors/live") {
          return requireResponse(await backlinks.competitorsLive([
            new BacklinksCompetitorsLiveRequestInfo(call.request),
          ]));
        }
        return requireResponse(await backlinks.referringDomainsLive([
          new BacklinksReferringDomainsLiveRequestInfo(call.request),
        ]));
      } catch (error) {
        if (error instanceof DataForSeoRuntimeError) {
          throw mapDataForSeoProviderError(error);
        }
        const statusCode = errorStatus(error) ?? responseStatus;
        if (controller.signal.aborted) {
          throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
            kind: "timeout",
            requestDispatched,
            statusCode,
          }, error));
        }
        if (statusCode !== undefined && statusCode >= 400) {
          throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
            kind: statusFailureKind(statusCode),
            requestDispatched,
            statusCode,
          }, error));
        }
        throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
          kind: error instanceof SyntaxError || error instanceof TypeError
            ? "malformed_response"
            : "network",
          requestDispatched,
          statusCode,
        }, error));
      } finally {
        clearTimeout(timeout);
      }
    },

    async recoverAcceptedTask(rawCall, rawProviderTaskId) {
      const call = assertCommercialDiscoveryCallAllowed({
        call: rawCall,
        endpointAllowlist: input.endpointAllowlist,
      });
      const providerTaskId = rawProviderTaskId.trim();
      if (
        call.endpoint !== "/v3/serp/google/organic/task_post"
        || !/^[A-Za-z0-9-]{1,128}$/u.test(providerTaskId)
      ) {
        throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
          kind: "invalid_request",
          requestDispatched: false,
        }));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      let requestDispatched = false;
      let responseStatus: number | undefined;
      try {
        const url = `${baseUrl}${taskGetPrefix}${providerTaskId}`;
        if (!allowedPath(url, input.endpointAllowlist)) {
          throw new DataForSeoRuntimeError({
            kind: "invalid_request",
            requestDispatched: false,
          });
        }
        const response = await fetchImplementation(url, {
          method: "GET",
          headers: {
            authorization: `Basic ${Buffer.from(
              `${input.credentials.login}:${input.credentials.password}`,
              "utf8",
            ).toString("base64")}`,
          },
          signal: controller.signal,
        });
        requestDispatched = true;
        responseStatus = response.status;
        if (!response.ok) {
          throw new DataForSeoRuntimeError({
            kind: statusFailureKind(response.status),
            requestDispatched,
            statusCode: response.status,
          });
        }
        const recovered = normalizeJson(await response.json());
        if (taskStatusCode(recovered, providerTaskId) !== 20000) {
          throw new DataForSeoRuntimeError({
            kind: "malformed_response",
            requestDispatched,
            statusCode: responseStatus,
          });
        }
        return recovered;
      } catch (error) {
        if (error instanceof DataForSeoRuntimeError) {
          throw mapDataForSeoProviderError(error);
        }
        const statusCode = errorStatus(error) ?? responseStatus;
        if (controller.signal.aborted) {
          throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
            kind: "timeout",
            requestDispatched,
            statusCode,
          }, error));
        }
        if (statusCode !== undefined && statusCode >= 400) {
          throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
            kind: statusFailureKind(statusCode),
            requestDispatched,
            statusCode,
          }, error));
        }
        throw mapDataForSeoProviderError(new DataForSeoRuntimeError({
          kind: error instanceof SyntaxError || error instanceof TypeError
            ? "malformed_response"
            : "network",
          requestDispatched,
          statusCode,
        }, error));
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
