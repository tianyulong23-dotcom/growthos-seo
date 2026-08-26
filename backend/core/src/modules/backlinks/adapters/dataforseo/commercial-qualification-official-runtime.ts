import { createRequire } from "node:module";

import {
  commercialQualificationBulkEndpoints,
  type CommercialQualificationBulkCall,
  type CommercialQualificationBulkResponse,
  type CommercialQualificationBulkRuntime,
} from "../../application/services/commercial-qualification-bulk.service.js";
import {
  DataForSeoRuntimeError,
  mapDataForSeoProviderError,
  type DataForSeoRuntimeFailureKind,
} from "./error-mapper.js";

const baseUrl = "https://api.dataforseo.com";

interface OfficialResponse {
  toJSON(): unknown;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface OfficialSdk {
  DataforseoLabsApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => {
    googleBulkTrafficEstimationLive(
      body: readonly unknown[],
    ): Promise<OfficialResponse | null>;
  };
  BacklinksApi: new (
    basePath: string,
    configuration: { readonly fetch: FetchImplementation },
  ) => {
    bulkSpamScoreLive(
      body: readonly unknown[],
    ): Promise<OfficialResponse | null>;
    bulkRanksLive(
      body: readonly unknown[],
    ): Promise<OfficialResponse | null>;
  };
  DataforseoLabsGoogleBulkTrafficEstimationLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksBulkSpamScoreLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
  BacklinksBulkRanksLiveRequestInfo: new (
    data: Readonly<Record<string, unknown>>,
  ) => unknown;
}

const require = createRequire(import.meta.url);
const {
  DataforseoLabsApi,
  BacklinksApi,
  DataforseoLabsGoogleBulkTrafficEstimationLiveRequestInfo,
  BacklinksBulkSpamScoreLiveRequestInfo,
  BacklinksBulkRanksLiveRequestInfo,
} = require("dataforseo-client") as OfficialSdk;

function endpointPath(value: string): string {
  return new URL(value, baseUrl).pathname;
}

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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tasks(
  value: Readonly<Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  return Array.isArray(value.tasks)
    ? value.tasks.map(record).filter(
        (item): item is Record<string, unknown> => item !== null,
      )
    : [];
}

function finiteCostMicros(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000)
    : 0;
}

function normalizeResponse(
  value: OfficialResponse | null,
  requestDispatched: boolean,
  statusCode: number | undefined,
): CommercialQualificationBulkResponse {
  if (value === null) {
    throw new DataForSeoRuntimeError({
      kind: "malformed_response",
      requestDispatched,
      statusCode,
    });
  }
  const serialized = JSON.stringify(value.toJSON());
  const parsed = serialized === undefined ? null : record(JSON.parse(serialized));
  if (parsed === null) {
    throw new DataForSeoRuntimeError({
      kind: "malformed_response",
      requestDispatched,
      statusCode,
    });
  }
  const responseTasks = tasks(parsed);
  if (responseTasks.length === 0) {
    throw new DataForSeoRuntimeError({
      kind: "malformed_response",
      requestDispatched,
      statusCode,
    });
  }
  const completedCount = responseTasks.filter(
    (task) => task.status_code === 20000,
  ).length;
  const providerRequestId = responseTasks.find(
    (task) => typeof task.id === "string" && task.id.trim().length > 0,
  )?.id;
  const taskCostMicros = responseTasks.reduce(
    (sum, task) => sum + finiteCostMicros(task.cost),
    0,
  );
  return Object.freeze({
    status: completedCount === responseTasks.length
      ? "completed"
      : completedCount > 0
        ? "partial"
        : "unavailable",
    body: parsed,
    providerRequestId: typeof providerRequestId === "string"
      ? providerRequestId.trim()
      : null,
    costMicros: taskCostMicros > 0
      ? taskCostMicros
      : finiteCostMicros(parsed.cost),
  });
}

function assertCallAllowed(
  call: CommercialQualificationBulkCall,
  endpointAllowlist: readonly string[],
): void {
  const expectedEndpoint = commercialQualificationBulkEndpoints[call.kind];
  if (endpointPath(call.endpoint) !== expectedEndpoint) {
    throw new DataForSeoRuntimeError({
      kind: "invalid_request",
      requestDispatched: false,
    });
  }
  const allowedPaths = new Set(endpointAllowlist.map(endpointPath));
  if (!allowedPaths.has(expectedEndpoint)) {
    throw new DataForSeoRuntimeError({
      kind: "invalid_request",
      requestDispatched: false,
    });
  }
}

export function createCommercialQualificationOfficialRuntime(
  input: Readonly<{
    credentials: Readonly<{ login: string; password: string }>;
    endpointAllowlist: readonly string[];
    timeoutMs: number;
    fetchImplementation?: FetchImplementation;
  }>,
): CommercialQualificationBulkRuntime {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;

  return Object.freeze({
    async execute(
      call: CommercialQualificationBulkCall,
    ): Promise<CommercialQualificationBulkResponse> {
      assertCallAllowed(call, input.endpointAllowlist);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      let requestDispatched = false;
      let responseStatus: number | undefined;
      const authenticatedFetch: FetchImplementation = async (request, init) => {
        const requestPath = endpointPath(String(request));
        const allowedPaths = new Set(input.endpointAllowlist.map(endpointPath));
        if (!allowedPaths.has(requestPath)) {
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
      const labs = new DataforseoLabsApi(baseUrl, {
        fetch: authenticatedFetch,
      });
      const backlinks = new BacklinksApi(baseUrl, {
        fetch: authenticatedFetch,
      });

      try {
        if (call.kind === "traffic") {
          return normalizeResponse(
            await labs.googleBulkTrafficEstimationLive(call.body.map(
              (item: Readonly<Record<string, unknown>>) =>
                new DataforseoLabsGoogleBulkTrafficEstimationLiveRequestInfo(
                  item,
                ),
            )),
            requestDispatched,
            responseStatus,
          );
        }
        if (call.kind === "spam") {
          return normalizeResponse(
            await backlinks.bulkSpamScoreLive(call.body.map(
              (item: Readonly<Record<string, unknown>>) =>
                new BacklinksBulkSpamScoreLiveRequestInfo(item),
            )),
            requestDispatched,
            responseStatus,
          );
        }
        return normalizeResponse(
          await backlinks.bulkRanksLive(call.body.map(
            (item: Readonly<Record<string, unknown>>) =>
              new BacklinksBulkRanksLiveRequestInfo(item),
          )),
          requestDispatched,
          responseStatus,
        );
      } catch (error) {
        const mapped = error instanceof DataForSeoRuntimeError
          ? mapDataForSeoProviderError(error)
          : (() => {
              const statusCode = errorStatus(error) ?? responseStatus;
              if (controller.signal.aborted) {
                return mapDataForSeoProviderError(new DataForSeoRuntimeError({
                  kind: "timeout",
                  requestDispatched,
                  statusCode,
                }, error));
              }
              if (statusCode !== undefined && statusCode >= 400) {
                return mapDataForSeoProviderError(new DataForSeoRuntimeError({
                  kind: statusFailureKind(statusCode),
                  requestDispatched,
                  statusCode,
                }, error));
              }
              return mapDataForSeoProviderError(new DataForSeoRuntimeError({
                kind: error instanceof SyntaxError || error instanceof TypeError
                  ? "malformed_response"
                  : "network",
                requestDispatched,
                statusCode,
              }, error));
            })();
        return Object.freeze({
          status: mapped.providerRequestStatus === "unknown_charge"
            ? "unknown_charge"
            : "unavailable",
          body: null,
          providerRequestId: null,
          costMicros: mapped.costMicros ?? 0,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
