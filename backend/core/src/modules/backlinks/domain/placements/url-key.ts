import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";

import { parse } from "tldts";

export const placementUrlNormalizationVersion =
  "whatwg-url-tldts-7.4.9-sha256-v1";
export const placementTargetSiteKeyRuleVersion =
  "tldts-7.4.9-private-suffix-v1";

export type PlacementUrlKey = Readonly<{
  rawUrl: string;
  normalizedUrl: string;
  normalizedUrlHash: string;
  hostnameAscii: string;
  targetSiteKey: string;
  normalizationVersion: typeof placementUrlNormalizationVersion;
  targetSiteKeyRuleVersion: typeof placementTargetSiteKeyRuleVersion;
}>;

export type PlacementRedirectEvidence = Readonly<{
  requested: PlacementUrlKey;
  final: PlacementUrlKey;
  identityChanged: boolean;
}>;

const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;

function invalidUrl(): never {
  throw new TypeError("Placement URL is not a supported public HTTP(S) URL");
}

function normalizeHostname(url: URL): string {
  const parsedHostname = url.hostname.toLowerCase();
  if (parsedHostname.endsWith("..")) invalidUrl();

  const withoutTrailingDot = parsedHostname.endsWith(".")
    ? parsedHostname.slice(0, -1)
    : parsedHostname;
  const hostnameAscii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (hostnameAscii.length === 0) invalidUrl();

  return hostnameAscii;
}

export function createPlacementUrlKey(rawUrl: string): PlacementUrlKey {
  if (
    rawUrl.length === 0 ||
    rawUrl.trim() !== rawUrl ||
    controlCharacterPattern.test(rawUrl)
  ) {
    invalidUrl();
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    invalidUrl();
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    invalidUrl();
  }

  const hostnameAscii = normalizeHostname(url);
  const domain = parse(hostnameAscii, { allowPrivateDomains: true });
  if (
    domain.isIp === true ||
    domain.domain === null ||
    (domain.isIcann !== true && domain.isPrivate !== true)
  ) {
    invalidUrl();
  }

  url.hostname = hostnameAscii;
  url.hash = "";
  const normalizedUrl = url.href;

  return Object.freeze({
    rawUrl,
    normalizedUrl,
    normalizedUrlHash: createHash("sha256")
      .update(normalizedUrl, "utf8")
      .digest("hex"),
    hostnameAscii,
    targetSiteKey: domain.domain,
    normalizationVersion: placementUrlNormalizationVersion,
    targetSiteKeyRuleVersion: placementTargetSiteKeyRuleVersion,
  });
}

export function createPlacementRedirectEvidence(
  requestedUrl: string,
  finalUrl: string,
): PlacementRedirectEvidence {
  const requested = createPlacementUrlKey(requestedUrl);
  const final = createPlacementUrlKey(finalUrl);

  return Object.freeze({
    requested,
    final,
    identityChanged:
      requested.normalizedUrlHash !== final.normalizedUrlHash,
  });
}
