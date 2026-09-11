import { createRequire } from "node:module";
import { archiveDataForSeoFetch } from "../../../provider-archive/capture-fetch.js";

import {
  assertCommercialDiscoveryCallAllowed,
  fingerprintCommercialDiscoveryCall,
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
    idList(body: readonly unknown[]):
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
    backlinksLive(body: readonly unknown[]):
      Promise<OfficialResponse | null>;
    referringDomainsLive(body: readonly unknown[]):
      Promise<OfficialResponse | null>;
  };
  SerpGoogleOrganicTaskPostRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  SerpIdListRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  DataforseoLabsGoogleCompetitorsDomainLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksCompetitorsLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksBacklinksLiveRequestInfo: new (
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
  SerpIdListRequestInfo,
  DataforseoLabsGoogleCompetitorsDomainLiveRequestInfo,
  BacklinksCompetitorsLiveRequestInfo,
  BacklinksBacklinksLiveRequestInfo,
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

function unexpectedFailureKind(
  error: unknown,
  responseStatus: number | undefined,
): DataForSeoRuntimeFailureKind {
  if (
    error instanceof SyntaxError
    || (error instanceof TypeError && responseStatus !== undefined)
  ) {
    return "malformed_response";
  }
  return "network";
}

function retryableAcceptedTaskRetrievalFailure(
  error: unknown,
  responseStatus: number | undefined,
): boolean {
  if (error instanceof DataForSeoRuntimeError) {
    return error.kind === "network"
      || error.kind === "server_error"
      || error.kind === "rate_limited";
  }
  const status = errorStatus(error) ?? responseStatus;
  return status === undefined
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
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

type AcceptedTaskState = "ready" | "pending" | "failed" | "malformed";

function acceptedTaskState(
  value: unknown,
  taskId: string,
): AcceptedTaskState {
  const statusCode = taskStatusCode(value, taskId);
  if (statusCode === null) return "malformed";
  if (statusCode === 20000) return "ready";
  if (statusCode === 40601 || statusCode === 40602) return "pending";
  return "failed";
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

function providerTaskTag(call: CommercialDiscoveryCall): string {
  return `growthos:${fingerprintCommercialDiscoveryCall(call)}`;
}

function dataForSeoDateTime(value: Date): string {
  return value.toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/u, " +00:00");
}

function objectContains(
  value: unknown,
  expected: unknown,
): boolean {
  if (
    typeof expected !== "object"
    || expected === null
    || Array.isArray(expected)
  ) {
    return Object.is(value, expected);
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return false;
  }
  const actual = value as Readonly<Record<string, unknown>>;
  return Object.entries(expected).every(([key, nested]) =>
    key in actual && objectContains(actual[key], nested)
  );
}

function taskListResults(
  value: unknown,
): readonly Record<string, unknown>[] {
  const allTasks = tasks(value);
  if (
    allTasks.length !== 1
    || allTasks[0]?.status_code !== 20000
    || !Array.isArray(allTasks[0].result)
  ) {
    throw new TypeError("DataForSEO task list response is malformed");
  }
  return allTasks[0].result.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function isMatchingSerpTask(
  item: Readonly<Record<string, unknown>>,
  call: CommercialDiscoveryCall,
): boolean {
  if (typeof item.id !== "string" || item.id.trim().length === 0) {
    return false;
  }
  if (typeof item.url !== "string") return false;
  let pathname: string;
  try {
    pathname = new URL(item.url).pathname;
  } catch {
    return false;
  }
  if (pathname !== "/v3/serp/google/organic/task_post") return false;
  if (
    typeof item.metadata !== "object"
    || item.metadata === null
    || Array.isArray(item.metadata)
  ) {
    return false;
  }
  const metadata = item.metadata as Readonly<Record<string, unknown>>;
  const expectedTag = providerTaskTag(call);
  if (metadata.tag === expectedTag) return true;
  return metadata.tag === undefined && objectContains(metadata, call.request);
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

export type CommercialDataForSeoDispatchReconciliation = Readonly<
  | { status: "accepted"; providerTaskId: string }
  | { status: "not_found" }
  | { status: "pending" }
  | { status: "ambiguous" }
>;

export type CommercialDataForSeoRuntime = Readonly<{
  execute(
    call: CommercialDiscoveryCall,
    hooks?: CommercialDataForSeoExecutionHooks,
  ): Promise<Record<string, unknown>>;
  recoverAcceptedTask?(
    call: CommercialDiscoveryCall,
    providerTaskId: string,
  ): Promise<Record<string, unknown>>;
  reconcileDispatchedTask?(
    call: CommercialDiscoveryCall,
    input: Readonly<{
      dispatchedAt: Date;
      reconciledAt: Date;
    }>,
  ): Promise<CommercialDataForSeoDispatchReconciliation>;
}>;

export function createCommercialOfficialDataForSeoRuntime(input: Readonly<{
  credentials: CommercialDataForSeoCredentials;
  endpointAllowlist: readonly string[];
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  sleep?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  maximumPollIntervalMs?: number;
}>): CommercialDataForSeoRuntime {
  const fetchImplementation = archiveDataForSeoFetch(
    input.fetchImplementation ?? globalThis.fetch, "backlinks-discovery",
  );
  const sleep = input.sleep
    ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollAttempts = input.pollAttempts ?? 600;
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  const maximumPollIntervalMs = Math.max(
    pollIntervalMs,
    input.maximumPollIntervalMs ?? 5_000,
  );

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
          const request = Object.freeze({
            ...call.request,
            tag: providerTaskTag(call),
          });
          const posted = requireResponse(await serp.googleOrganicTaskPost([
            new SerpGoogleOrganicTaskPostRequestInfo(request),
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
        if (call.endpoint === "/v3/backlinks/backlinks/live") {
          return requireResponse(await backlinks.backlinksLive([
            new BacklinksBacklinksLiveRequestInfo(call.request),
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
          kind: unexpectedFailureKind(error, responseStatus),
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
        const waitBeforeNextAttempt = async (attempt: number) => {
          const backoffMs = Math.min(
            maximumPollIntervalMs,
            pollIntervalMs * (2 ** Math.min(attempt, 30)),
          );
          await sleep(backoffMs);
          if (controller.signal.aborted) {
            throw new DataForSeoRuntimeError({
              kind: "timeout",
              requestDispatched,
              statusCode: responseStatus,
            });
          }
        };
        for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
          try {
            responseStatus = undefined;
            requestDispatched = true;
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
            responseStatus = response.status;
            if (!response.ok) {
              throw new DataForSeoRuntimeError({
                kind: statusFailureKind(response.status),
                requestDispatched,
                statusCode: response.status,
              });
            }
            const recovered = normalizeJson(await response.json());
            const state = acceptedTaskState(recovered, providerTaskId);
            if (state === "ready") return recovered;
            if (state === "malformed") {
              throw new DataForSeoRuntimeError({
                kind: "malformed_response",
                requestDispatched,
                statusCode: responseStatus,
              });
            }
            if (state === "failed") {
              throw new DataForSeoRuntimeError({
                kind: "server_error",
                requestDispatched,
                statusCode: responseStatus,
              });
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            if (
              attempt + 1 >= pollAttempts
              || !retryableAcceptedTaskRetrievalFailure(
                error,
                responseStatus,
              )
            ) {
              throw error;
            }
          }
          if (attempt + 1 < pollAttempts) {
            await waitBeforeNextAttempt(attempt);
          }
        }
        throw new DataForSeoRuntimeError({
          kind: "timeout",
          requestDispatched,
          statusCode: responseStatus,
        });
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
          kind: unexpectedFailureKind(error, responseStatus),
          requestDispatched,
          statusCode,
        }, error));
      } finally {
        clearTimeout(timeout);
      }
    },

    async reconcileDispatchedTask(rawCall, reconciliation) {
      const call = assertCommercialDiscoveryCallAllowed({
        call: rawCall,
        endpointAllowlist: input.endpointAllowlist,
      });
      if (
        call.endpoint !== "/v3/serp/google/organic/task_post"
        || !Number.isFinite(reconciliation.dispatchedAt.getTime())
        || !Number.isFinite(reconciliation.reconciledAt.getTime())
        || reconciliation.reconciledAt < reconciliation.dispatchedAt
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

      try {
        const serp = new SerpApi(baseUrl, { fetch: authenticatedFetch });
        const response = await serp.idList([
          new SerpIdListRequestInfo({
            datetime_from: dataForSeoDateTime(new Date(
              reconciliation.dispatchedAt.getTime() - 5 * 60_000,
            )),
            datetime_to: dataForSeoDateTime(reconciliation.reconciledAt),
            limit: 1_000,
            offset: 0,
            sort: "desc",
            include_metadata: true,
          }),
        ]);
        if (response === null) {
          throw new DataForSeoRuntimeError({
            kind: "malformed_response",
            requestDispatched,
            statusCode: responseStatus,
          });
        }
        const matches = taskListResults(normalizeJson(response.toJSON()))
          .filter((item) => isMatchingSerpTask(item, call));
        const taskIds = [...new Set(matches.map((item) =>
          String(item.id).trim()
        ))];
        if (taskIds.length === 1) {
          const providerTaskId = taskIds[0];
          if (providerTaskId === undefined) {
            throw new TypeError("DataForSEO task list response is malformed");
          }
          return Object.freeze({
            status: "accepted" as const,
            providerTaskId,
          });
        }
        if (taskIds.length > 1) {
          return Object.freeze({ status: "ambiguous" as const });
        }
        if (
          reconciliation.reconciledAt.getTime()
          - reconciliation.dispatchedAt.getTime()
          < 120_000
        ) {
          return Object.freeze({ status: "pending" as const });
        }
        return Object.freeze({ status: "not_found" as const });
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
          kind: unexpectedFailureKind(error, responseStatus),
          requestDispatched,
          statusCode,
        }, error));
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
