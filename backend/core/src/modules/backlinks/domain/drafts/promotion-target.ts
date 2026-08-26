export type DraftPromotionTargetResolution =
  | Readonly<{ state: "resolved"; targetUrl: string }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{ state: "outside_project" }>;

function canonicalHostname(value: string): string | null {
  try {
    const url = new URL(`https://${value.trim()}`);
    if (
      url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
    ) {
      return null;
    }
    return url.hostname.toLowerCase().replace(/\.$/u, "").replace(/^www\./u, "");
  } catch {
    return null;
  }
}

export function resolveDraftPromotionTarget(input: Readonly<{
  canonicalDomain: string;
  configuredTargetUrls: readonly string[];
  requestedTargetUrl?: string;
}>): DraftPromotionTargetResolution {
  const rawTargetUrl = input.requestedTargetUrl ?? input.configuredTargetUrls[0];
  if (rawTargetUrl === undefined || rawTargetUrl.trim() === "") {
    return { state: "missing" };
  }

  const projectHostname = canonicalHostname(input.canonicalDomain);
  if (projectHostname === null || projectHostname === "") {
    return { state: "invalid" };
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawTargetUrl);
  } catch {
    return { state: "invalid" };
  }
  if (
    !["http:", "https:"].includes(targetUrl.protocol)
    || targetUrl.username !== ""
    || targetUrl.password !== ""
    || targetUrl.port !== ""
  ) {
    return { state: "invalid" };
  }

  const targetHostname = targetUrl.hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");
  if (
    targetHostname !== projectHostname
    && !targetHostname.endsWith(`.${projectHostname}`)
  ) {
    return { state: "outside_project" };
  }

  targetUrl.hash = "";
  return { state: "resolved", targetUrl: targetUrl.toString() };
}
