import { describe, expect, it } from "vitest";

import {
  browserWorkerShellConfigSchema,
  createBrowserWorkerShell,
} from "../../src/modules/backlinks/ports/crawler-browser-worker-shell.port.js";

describe("BL-AI-156 Browser Worker shell", () => {
  it("defaults to a non-starting shared Crawler shell with bounded resources", () => {
    const shell = createBrowserWorkerShell();

    expect(shell).toEqual({
      kind: "shared_crawler_browser_fallback",
      config: {
        enabled: false,
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
          blockedAddressScopes: [
            "loopback",
            "private",
            "link_local",
            "unique_local",
            "multicast",
            "unspecified",
            "reserved",
          ],
        },
        downloadsEnabled: false,
      },
    });
    expect("start" in shell).toBe(false);
  });

  it("allows explicit capability enablement without allowing boot-time startup", () => {
    const shell = createBrowserWorkerShell({ enabled: true });

    expect(shell.config.enabled).toBe(true);
    expect(shell.config.startOnBoot).toBe(false);
  });

  it("rejects configurations that relax private-network blocking or downloads", () => {
    const shell = createBrowserWorkerShell();

    expect(() =>
      browserWorkerShellConfigSchema.parse({
        ...shell.config,
        downloadsEnabled: true,
      }),
    ).toThrow();
    expect(() =>
      browserWorkerShellConfigSchema.parse({
        ...shell.config,
        networkPolicy: {
          ...shell.config.networkPolicy,
          blockedAddressScopes: ["loopback"],
        },
      }),
    ).toThrow();
  });
});
