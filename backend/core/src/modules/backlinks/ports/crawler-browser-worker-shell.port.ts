import { z } from "zod";

const blockedAddressScopes = [
  "loopback",
  "private",
  "link_local",
  "unique_local",
  "multicast",
  "unspecified",
  "reserved",
] as const;

const networkPolicySchema = z.object({
  allowedProtocols: z.tuple([z.literal("http:"), z.literal("https:")]),
  enforceOnRedirects: z.literal(true),
  blockedAddressScopes: z.tuple([
    z.literal(blockedAddressScopes[0]),
    z.literal(blockedAddressScopes[1]),
    z.literal(blockedAddressScopes[2]),
    z.literal(blockedAddressScopes[3]),
    z.literal(blockedAddressScopes[4]),
    z.literal(blockedAddressScopes[5]),
    z.literal(blockedAddressScopes[6]),
  ]),
}).strict();

export const browserWorkerShellConfigSchema = z.object({
  enabled: z.boolean(),
  startOnBoot: z.literal(false),
  sharedCrawlerEvidenceContract: z.literal("crawler.evidence.v1"),
  resourceLimits: z.object({
    maxConcurrentJobs: z.literal(1),
    maxMemoryMiB: z.literal(512),
    navigationTimeoutMs: z.literal(30_000),
  }).strict(),
  networkPolicy: networkPolicySchema,
  downloadsEnabled: z.literal(false),
}).strict();

export type BrowserWorkerShellConfig = Readonly<
  z.output<typeof browserWorkerShellConfigSchema>
>;

export type BrowserWorkerShell = Readonly<{
  kind: "shared_crawler_browser_fallback";
  config: BrowserWorkerShellConfig;
}>;

export type BrowserWorkerShellOptions = Readonly<{
  enabled?: boolean;
}>;

/**
 * Describes the shared Crawler Browser fallback boundary without starting,
 * registering, or owning a Browser Worker in Backlinks.
 */
export function createBrowserWorkerShell(
  options: BrowserWorkerShellOptions = {},
): BrowserWorkerShell {
  const config = browserWorkerShellConfigSchema.parse({
    enabled: options.enabled === true,
    startOnBoot: false,
    sharedCrawlerEvidenceContract: "crawler.evidence.v1",
    resourceLimits: {
      maxConcurrentJobs: 1,
      maxMemoryMiB: 512,
      navigationTimeoutMs: 30_000,
    },
    networkPolicy: {
      allowedProtocols: ["http:", "https:"],
      enforceOnRedirects: true,
      blockedAddressScopes,
    },
    downloadsEnabled: false,
  });

  return Object.freeze({
    kind: "shared_crawler_browser_fallback" as const,
    config: Object.freeze(config),
  });
}
