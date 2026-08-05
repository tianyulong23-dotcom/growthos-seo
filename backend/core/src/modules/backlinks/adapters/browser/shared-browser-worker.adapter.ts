import { z } from "zod";

import type { SafeFetchResult } from "../../ports/safe-fetch.port.js";

const responseSchema = z.object({
  html: z.string(),
  finalUrl: z.string().url(),
  fetchedAt: z.string().datetime({ offset: true }),
  evidence: z.object({
    version: z.literal("crawler.evidence.v1"),
    outcome: z.enum(["completed", "partial"]),
    pages: z.array(z.object({
      requestedUrl: z.string().url(),
      finalUrl: z.string().url(),
      rendered: z.literal(true),
      renderMode: z.literal("browser"),
      fetchedAt: z.string().datetime({ offset: true }),
    }).passthrough()).min(1),
  }).passthrough(),
}).strict();

export interface SharedBrowserWorkerPort {
  render(input: Readonly<{
    url: string;
    taskType: "contact_enrichment" | "backlink_validation";
    requestId: string;
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    actorId: string;
  }>): Promise<SafeFetchResult>;
}

export function createSharedBrowserWorkerAdapter(options: Readonly<{
  endpoint: string;
  timeoutMs: number;
}>): SharedBrowserWorkerPort {
  const endpoint = new URL("/render", options.endpoint).toString();
  return Object.freeze({
    async render(
      input: Parameters<SharedBrowserWorkerPort["render"]>[0],
    ) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: "crawler.evidence.request.v1",
            requestId: input.requestId,
            taskType: input.taskType,
            tenant: {
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
            },
            project: { websiteProjectId: input.websiteProjectId },
            target: { urls: [input.url] },
            requestedBy: {
              moduleId: "backlinks",
              actorId: input.actorId,
            },
            requestedAt: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`SHARED_BROWSER_WORKER_HTTP_${response.status}`);
        }
        const parsed = responseSchema.parse(await response.json());
        return Object.freeze({
          requestedUrl: input.url,
          finalUrl: parsed.finalUrl,
          status: 200,
          contentType: "text/html; charset=utf-8",
          xRobotsTag: null,
          body: new TextEncoder().encode(parsed.html),
          redirectChain: Object.freeze(
            parsed.finalUrl === input.url ? [] : [parsed.finalUrl],
          ),
          resolvedIps: Object.freeze([]),
          fetchedAt: parsed.fetchedAt,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
