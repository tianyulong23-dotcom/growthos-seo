import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { chromium, type Browser, type Page } from "playwright";

export const workerCapabilities = [
  "render-page",
  "capture-dom",
  "capture-screenshot",
] as const;

export type WorkerCapability = (typeof workerCapabilities)[number];

export type BrowserRenderRequest = Readonly<{
  version: "crawler.evidence.request.v1";
  requestId: string;
  taskType: "contact_enrichment" | "backlink_validation";
  tenant: Readonly<{
    organizationId: string;
    workspaceId: string;
  }>;
  project: Readonly<{ websiteProjectId: string }>;
  target: Readonly<{ urls: readonly [string] }>;
  requestedBy: Readonly<{
    moduleId: "backlinks";
    actorId: string;
  }>;
  requestedAt: string;
}>;

export type BrowserRenderResponse = Readonly<{
  html: string;
  finalUrl: string;
  fetchedAt: string;
  evidence: Readonly<{
    version: "crawler.evidence.v1";
    policyVersion: "browser-worker-public-http.v1";
    evidenceId: string;
    requestId: string;
    taskType: "contact_enrichment" | "backlink_validation";
    runId: string;
    outcome: "completed" | "partial";
    collectedAt: string;
    pages: readonly Readonly<{
      requestedUrl: string;
      finalUrl: string;
      rendered: true;
      renderMode: "browser";
      fetchedAt: string;
    }>[];
    backlinkObservations: readonly [];
    contactObservations: readonly [];
  }>;
}>;

const systemChromeCandidates = [
  process.env.BROWSER_SYSTEM_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((value): value is string => Boolean(value?.trim()));

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first === 0;
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb");
}

async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("BROWSER_TARGET_PROTOCOL_FORBIDDEN");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
  ) {
    throw new Error("BROWSER_TARGET_PRIVATE_NETWORK_FORBIDDEN");
  }
  const addresses = isIP(hostname) === 0
    ? await lookup(hostname, { all: true, verbatim: true })
    : [{ address: hostname }];
  if (
    addresses.length === 0
    || addresses.some(({ address }) =>
      isIP(address) === 4 ? privateIpv4(address) : privateIpv6(address)
    )
  ) {
    throw new Error("BROWSER_TARGET_PRIVATE_NETWORK_FORBIDDEN");
  }
  return url;
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    let lastError = error;
    for (const executablePath of systemChromeCandidates) {
      try {
        return await chromium.launch({ headless: true, executablePath });
      } catch (candidateError) {
        lastError = candidateError;
      }
    }
    throw lastError;
  }
}

async function protectPage(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    try {
      await assertPublicUrl(route.request().url());
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

export async function renderPublicPage(
  input: BrowserRenderRequest,
  options: Readonly<{ timeoutMs: number; maxHtmlBytes: number }>,
): Promise<BrowserRenderResponse> {
  const requestedUrl = (await assertPublicUrl(input.target.urls[0])).toString();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await protectPage(page);
    await page.goto(requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(options.timeoutMs, 5_000),
    }).catch(() => undefined);
    const finalUrl = (await assertPublicUrl(page.url())).toString();
    const html = await page.content();
    if (Buffer.byteLength(html, "utf8") > options.maxHtmlBytes) {
      throw new Error("BROWSER_RENDERED_HTML_TOO_LARGE");
    }
    const fetchedAt = new Date().toISOString();
    return {
      html,
      finalUrl,
      fetchedAt,
      evidence: {
        version: "crawler.evidence.v1",
        policyVersion: "browser-worker-public-http.v1",
        evidenceId: randomUUID(),
        requestId: input.requestId,
        taskType: input.taskType,
        runId: randomUUID(),
        outcome: "completed",
        collectedAt: fetchedAt,
        pages: [{
          requestedUrl,
          finalUrl,
          rendered: true,
          renderMode: "browser",
          fetchedAt,
        }],
        backlinkObservations: [],
        contactObservations: [],
      },
    };
  } finally {
    await browser.close();
  }
}
