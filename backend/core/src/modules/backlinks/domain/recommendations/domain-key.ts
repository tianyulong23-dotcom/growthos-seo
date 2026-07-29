import { parse } from "tldts";

export const recommendationDomainNormalizationVersion = "tldts-7.4.9-v1";

export type RecommendationDomainKey = Readonly<{
  hostnameAscii: string;
  registrableDomain: string;
  normalizationVersion: typeof recommendationDomainNormalizationVersion;
}>;

const schemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

function invalidDomain(): never {
  throw new TypeError("Recommendation domain is not a supported public domain");
}

export function createRecommendationDomainKey(
  rawInput: string,
): RecommendationDomainKey {
  const input = rawInput.trim().normalize("NFC");
  if (input.length === 0) invalidDomain();

  let url: URL;
  try {
    url = new URL(schemePattern.test(input) ? input : `https://${input}`);
  } catch {
    invalidDomain();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    invalidDomain();
  }

  let hostnameAscii = url.hostname.toLowerCase();
  if (hostnameAscii.endsWith("..")) invalidDomain();
  if (hostnameAscii.endsWith(".")) hostnameAscii = hostnameAscii.slice(0, -1);
  if (hostnameAscii.startsWith("www.")) hostnameAscii = hostnameAscii.slice(4);

  const parsed = parse(hostnameAscii, { allowPrivateDomains: true });
  if (
    parsed.isIp === true ||
    parsed.domain === null ||
    (parsed.isIcann !== true && parsed.isPrivate !== true)
  ) {
    invalidDomain();
  }

  return Object.freeze({
    hostnameAscii,
    registrableDomain: parsed.domain,
    normalizationVersion: recommendationDomainNormalizationVersion,
  });
}
