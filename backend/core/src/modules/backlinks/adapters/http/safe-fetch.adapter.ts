import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  SafeFetchError, safeFetchFailureCodes, safeFetchFailureRetryability,
  safeFetchRequestSchema, type SafeFetchFailureCode, type SafeFetchPort, type SafeFetchRequest,
  type SafeFetchResult,
} from "../../ports/safe-fetch.port.js";
import {
  enforceNetworkPolicy, resolveHostname, type HostnameResolver, type ResolvedAddress,
} from "./network-policy.js";
import { enforceUrlPolicy, type ApprovedUrl } from "./url-policy.js";
export type SafeHttpTransportRequest = Readonly<{
  url: ApprovedUrl; address: ResolvedAddress; signal: AbortSignal }>;
export type SafeHttpResponse = Readonly<{
  status: number;
  contentType: string | undefined;
  contentLength: number | undefined;
  location: string | undefined;
  xRobotsTag: string | undefined;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}>;
export type SafeHttpTransport = (request: SafeHttpTransportRequest) => Promise<SafeHttpResponse>;
export type SafeFetchAdapterOptions = Readonly<{
  timeoutMs: number; resolver?: HostnameResolver;
  transport?: SafeHttpTransport; clock?: () => string }>;
const redirects = new Set([301, 302, 303, 307, 308]);
const allowedTypes = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
]);
function fail(url: string, code: SafeFetchFailureCode, cause?: unknown) {
  return new SafeFetchError({
    code, requestedUrl: url, message: `SafeFetch failed with ${code}.`,
    retryable: safeFetchFailureRetryability[code],
  }, cause === undefined ? undefined : { cause });
}
function header(
  response: IncomingMessage,
  name: "content-type" | "location" | "x-robots-tag",
) {
  const value = response.headers[name];
  return typeof value === "string" ? value : undefined;
}
export const nodeHttpTransport: SafeHttpTransport = ({ url, address, signal }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url.normalizedUrl);
    const options: RequestOptions = {
      hostname: address.address, port: url.port, method: "GET", signal,
      path: `${target.pathname}${target.search}`,
      headers: {
        accept:
          "text/html, application/xhtml+xml, application/xml, text/xml, text/plain;q=0.9",
        "accept-encoding": "identity", host: target.host,
        "user-agent": "GrowthOS-SafeFetch/1.0",
      },
    };
    const receive = (response: IncomingMessage) => {
      if (response.statusCode === undefined) {
        response.destroy(); reject(new Error("Missing HTTP status.")); return;
      }
      const length = response.headers["content-length"];
      resolve({
        status: response.statusCode, contentType: header(response, "content-type"),
        contentLength: typeof length === "string" && /^\d+$/u.test(length)
          ? Number(length) : undefined,
        location: header(response, "location"),
        xRobotsTag: header(response, "x-robots-tag"),
        body: response,
        close: () => response.destroy(),
      });
    };
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const outgoing = url.protocol === "https:"
      ? httpsRequest(
        isIP(hostname) === 0 ? { ...options, servername: hostname } : options,
        receive,
      )
      : httpRequest(options, receive);
    outgoing.once("error", reject);
    outgoing.end();
  });
export class SafeFetchAdapter implements SafeFetchPort {
  readonly #timeoutMs: number;
  readonly #resolver: HostnameResolver;
  readonly #transport: SafeHttpTransport;
  readonly #clock: () => string;
  constructor(options: SafeFetchAdapterOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive integer.");
    }
    this.#timeoutMs = options.timeoutMs;
    this.#resolver = options.resolver ?? resolveHostname;
    this.#transport = options.transport ?? nodeHttpTransport;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }
  async fetch(request: SafeFetchRequest): Promise<SafeFetchResult> {
    const parsed = safeFetchRequestSchema.safeParse(request);
    const requestedUrl = typeof request.url === "string"
      ? request.url.trim().slice(0, 2_048) || "invalid-url" : "invalid-url";
    if (!parsed.success) throw fail(requestedUrl, safeFetchFailureCodes.invalidRequest);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(fail(requestedUrl, safeFetchFailureCodes.timeout));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([this.#execute(parsed.data, controller.signal), timeout]);
    } catch (cause) {
      if (cause instanceof SafeFetchError) throw cause;
      throw fail(requestedUrl, safeFetchFailureCodes.transportFailed, cause);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async #execute(request: SafeFetchRequest, signal: AbortSignal) {
    let url = enforceUrlPolicy(request.url);
    const redirectChain: string[] = [];
    const resolvedIps: string[] = [];
    while (true) {
      const network = await enforceNetworkPolicy(url, this.#resolver);
      const address = network.addresses[0];
      if (address === undefined) throw fail(request.url, safeFetchFailureCodes.networkBlocked);
      resolvedIps.push(address.address);
      const response = await this.#transport({ url, address, signal });
      if (redirects.has(response.status)) {
        response.close();
        if (redirectChain.length >= request.maxRedirects) {
          throw fail(request.url, safeFetchFailureCodes.redirectLimitExceeded);
        }
        if (response.location === undefined) {
          throw fail(request.url, safeFetchFailureCodes.transportFailed);
        }
        url = enforceUrlPolicy(new URL(response.location, url.normalizedUrl).href);
        redirectChain.push(url.normalizedUrl);
        continue;
      }
      const contentType = response.contentType?.trim();
      const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType === undefined || mediaType === undefined ||
          !allowedTypes.has(mediaType)) {
        response.close();
        throw fail(request.url, safeFetchFailureCodes.unsupportedContentType);
      }
      if (response.contentLength !== undefined &&
          response.contentLength > request.maxBytes) {
        response.close();
        throw fail(request.url, safeFetchFailureCodes.responseTooLarge);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > request.maxBytes) {
          response.close();
          throw fail(request.url, safeFetchFailureCodes.responseTooLarge);
        }
        chunks.push(chunk);
      }
      return Object.freeze({
        requestedUrl: request.url, finalUrl: url.normalizedUrl,
        status: response.status, contentType,
        xRobotsTag: response.xRobotsTag ?? null,
        body: Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)),
        redirectChain: Object.freeze(redirectChain),
        resolvedIps: Object.freeze(resolvedIps), fetchedAt: this.#clock(),
      });
    }
  }
}
