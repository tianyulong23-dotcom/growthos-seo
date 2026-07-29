import { domainToASCII } from "node:url";
import { SafeFetchError, safeFetchFailureCodes } from "../../ports/safe-fetch.port.js";

export const urlPolicyReasons = {
  invalidUrl: "invalid_url",
  unsupportedScheme: "unsupported_scheme",
  credentialsNotAllowed: "credentials_not_allowed",
  portNotAllowed: "port_not_allowed",
  hostnameNotAllowed: "hostname_not_allowed",
  ambiguousUrl: "ambiguous_url",
} as const;

export type UrlPolicyReason =
  (typeof urlPolicyReasons)[keyof typeof urlPolicyReasons];
type HttpProtocol = "http:" | "https:";
export type ApprovedUrl = Readonly<{
  requestedUrl: string;
  normalizedUrl: string;
  protocol: HttpProtocol;
  hostname: string;
  port: 80 | 443;
}>;

export class UrlPolicyError extends SafeFetchError {
  override readonly requestedUrl: string;
  readonly reason: UrlPolicyReason;
  constructor(requestedUrl: string, reason: UrlPolicyReason) {
    super({
      code: safeFetchFailureCodes.urlBlocked,
      requestedUrl: requestedUrl.trim().slice(0, 2_048) || "invalid-url",
      message: `URL rejected by policy: ${reason}.`,
      retryable: false,
    });
    this.name = "UrlPolicyError";
    this.requestedUrl = requestedUrl;
    this.reason = reason;
  }
}

function reject(requestedUrl: string, reason: UrlPolicyReason): never {
  throw new UrlPolicyError(requestedUrl, reason);
}

function readAuthority(requestedUrl: string): {
  rawHostname: string;
  rawPort: string | undefined;
} {
  const start = requestedUrl.indexOf("://") + 3;
  const suffix = requestedUrl.slice(start);
  const delimiter = suffix.search(/[/?#]/u);
  const authority = delimiter === -1 ? suffix : suffix.slice(0, delimiter);
  if (authority.length === 0) {
    reject(requestedUrl, urlPolicyReasons.hostnameNotAllowed);
  }
  if (authority.includes("@")) {
    reject(requestedUrl, urlPolicyReasons.credentialsNotAllowed);
  }
  if (authority.includes("%")) {
    reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
  }
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) {
      reject(requestedUrl, urlPolicyReasons.hostnameNotAllowed);
    }
    const tail = authority.slice(close + 1);
    if (tail.length === 0) {
      return { rawHostname: authority, rawPort: undefined };
    }
    if (!tail.startsWith(":")) {
      reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
    }
    return {
      rawHostname: authority.slice(0, close + 1),
      rawPort: tail.slice(1),
    };
  }
  const lastColon = authority.lastIndexOf(":");
  if (lastColon === -1) {
    return { rawHostname: authority, rawPort: undefined };
  }
  if (authority.indexOf(":") !== lastColon) {
    reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
  }
  return {
    rawHostname: authority.slice(0, lastColon),
    rawPort: authority.slice(lastColon + 1),
  };
}

function enforceHostname(
  requestedUrl: string,
  rawHostname: string,
  parsedHostname: string,
): void {
  if (rawHostname.length === 0 || rawHostname.endsWith(".")) {
    reject(requestedUrl, urlPolicyReasons.hostnameNotAllowed);
  }
  if (rawHostname.startsWith("[")) {
    return;
  }
  const hostnameAscii = /^[\u0000-\u007f]+$/u.test(rawHostname)
    ? rawHostname.toLowerCase()
    : domainToASCII(rawHostname).toLowerCase();
  if (hostnameAscii.length === 0) {
    reject(requestedUrl, urlPolicyReasons.hostnameNotAllowed);
  }
  if (hostnameAscii !== parsedHostname) {
    reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
  }
  if (
    hostnameAscii.length > 253 ||
    hostnameAscii.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    reject(requestedUrl, urlPolicyReasons.hostnameNotAllowed);
  }
}

export function enforceUrlPolicy(requestedUrl: string): ApprovedUrl {
  if (requestedUrl.length === 0 || requestedUrl.length > 2_048) {
    reject(requestedUrl, urlPolicyReasons.invalidUrl);
  }
  if (/[\u0000-\u0020\u007f\\]/u.test(requestedUrl)) {
    reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(requestedUrl)?.[1]
    ?.toLowerCase();
  if (scheme === undefined) {
    reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
  }
  if (scheme !== "http" && scheme !== "https") {
    reject(requestedUrl, urlPolicyReasons.unsupportedScheme);
  }
  if (!/^https?:\/\//iu.test(requestedUrl)) {
    reject(requestedUrl, urlPolicyReasons.ambiguousUrl);
  }
  const protocol: HttpProtocol = scheme === "https" ? "https:" : "http:";
  const { rawHostname, rawPort } = readAuthority(requestedUrl);
  const allowedPort = protocol === "https:" ? "443" : "80";
  if (rawPort !== undefined && rawPort !== allowedPort) {
    reject(requestedUrl, urlPolicyReasons.portNotAllowed);
  }
  let parsed: URL;
  try {
    parsed = new URL(requestedUrl);
  } catch {
    reject(requestedUrl, urlPolicyReasons.invalidUrl);
  }
  if (parsed.protocol !== protocol || parsed.username || parsed.password) {
    reject(requestedUrl, urlPolicyReasons.credentialsNotAllowed);
  }
  enforceHostname(requestedUrl, rawHostname, parsed.hostname);
  return Object.freeze({
    requestedUrl,
    normalizedUrl: parsed.href,
    protocol,
    hostname: parsed.hostname,
    port: protocol === "https:" ? 443 : 80,
  });
}
