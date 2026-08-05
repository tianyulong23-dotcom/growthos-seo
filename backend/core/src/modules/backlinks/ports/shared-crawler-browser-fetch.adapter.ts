import { createHash } from "node:crypto";

import { z } from "zod";

import {
  browserFetchEvidenceSchema,
  browserFetchRequestSchema,
  type BrowserFetchEvidence,
  type BrowserFetchPort,
  type BrowserFetchRequest,
} from "./crawler-browser-fetch.port.js";

const identifierSchema = z.string().trim().min(1).max(200);
const urlSchema = z.string().trim().url().max(2_048);
const timestampSchema = z.string().datetime({ offset: true });

const crawlerEvidenceSchema = z.object({
  version: z.literal("crawler.evidence.v1"),
  policyVersion: identifierSchema,
  evidenceId: identifierSchema,
  requestId: identifierSchema,
  taskType: z.literal("backlink_validation"),
  runId: identifierSchema,
  outcome: z.enum(["completed", "partial", "failed", "cancelled"]),
  collectedAt: timestampSchema,
  pages: z.array(z.object({
    requestedUrl: urlSchema,
    finalUrl: urlSchema,
    rendered: z.boolean(),
    renderMode: z.enum(["", "static", "browser"]),
    fetchedAt: timestampSchema,
  }).passthrough()),
  backlinkObservations: z.array(z.object({
    sourceUrl: urlSchema,
    targetUrl: urlSchema,
    renderMode: z.enum(["", "static", "browser"]),
    observedAt: timestampSchema,
  }).passthrough()),
}).passthrough();

export type SharedCrawlerEvidenceRequest = Readonly<{
  version: "crawler.evidence.request.v1";
  requestId: string;
  taskType: "backlink_validation";
  tenant: Readonly<{ organizationId: string; workspaceId: string }>;
  project: Readonly<{ websiteProjectId: string; websiteProjectKey: string }>;
  target: Readonly<{
    urls: readonly string[];
    expectedLinks: readonly string[];
  }>;
  options: Readonly<{
    maxPages: 1;
    scope: "directory";
    rendering: "all";
    collectPageSpeedEvidence: false;
    collectDuplicateContentEvidence: false;
  }>;
  requestedBy: Readonly<{
    moduleId: "backlinks";
    actorId: string;
    correlationId: string;
  }>;
  requestedAt: string;
}>;

export interface SharedCrawlerEvidencePort {
  collect(
    request: SharedCrawlerEvidenceRequest,
  ): Promise<unknown>;
}

export type SharedCrawlerBrowserContext = Readonly<{
  organizationId: string;
  websiteProjectKey: string;
  actorId: string;
  correlationId: string;
}>;

export interface SharedCrawlerBrowserContextResolver {
  resolve(
    request: BrowserFetchRequest,
  ): Promise<SharedCrawlerBrowserContext>;
}

export type SharedCrawlerBrowserFetchOptions = Readonly<{
  enabled?: boolean;
  contextResolver: SharedCrawlerBrowserContextResolver;
  crawlerEvidence: SharedCrawlerEvidencePort;
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function evidenceHash(snapshot: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)), "utf8")
    .digest("hex");
}

export function createSharedCrawlerBrowserFetchPort(
  options: SharedCrawlerBrowserFetchOptions,
): BrowserFetchPort {
  const enabled = options.enabled === true;

  return Object.freeze({
    async fetch(input: BrowserFetchRequest): Promise<BrowserFetchEvidence> {
      const request = browserFetchRequestSchema.parse(input);
      if (!enabled) {
        throw new Error("SHARED_CRAWLER_BROWSER_FALLBACK_DISABLED");
      }
      const context = await options.contextResolver.resolve(request);
      const evidence = crawlerEvidenceSchema.parse(
        await options.crawlerEvidence.collect({
          version: "crawler.evidence.request.v1",
          requestId: request.requestId,
          taskType: "backlink_validation",
          tenant: {
            organizationId: identifierSchema.parse(context.organizationId),
            workspaceId: request.workspaceId,
          },
          project: {
            websiteProjectId: request.websiteProjectId,
            websiteProjectKey: identifierSchema.parse(context.websiteProjectKey),
          },
          target: {
            urls: [request.sourcePageUrl],
            expectedLinks: [request.targetUrl],
          },
          options: {
            maxPages: 1,
            scope: "directory",
            rendering: "all",
            collectPageSpeedEvidence: false,
            collectDuplicateContentEvidence: false,
          },
          requestedBy: {
            moduleId: "backlinks",
            actorId: identifierSchema.parse(context.actorId),
            correlationId: identifierSchema.parse(context.correlationId),
          },
          requestedAt: request.requestedAt,
        }),
      );
      const page = evidence.pages.find(
        (candidate) => candidate.requestedUrl === request.sourcePageUrl,
      );
      if (page === undefined || page.renderMode !== "browser") {
        throw new Error("SHARED_CRAWLER_BROWSER_EVIDENCE_INVALID");
      }
      const snapshot = {
        crawlerEvidenceId: evidence.evidenceId,
        crawlerRunId: evidence.runId,
        crawlerPolicyVersion: evidence.policyVersion,
        crawlerOutcome: evidence.outcome,
        page,
        backlinkObservations: evidence.backlinkObservations.filter(
          (observation) =>
            observation.sourceUrl === request.sourcePageUrl
            && observation.targetUrl === request.targetUrl,
        ),
        staticEvidenceSnapshotId: request.staticEvidenceSnapshotId,
        staticEvidenceSnapshotHash: request.staticEvidenceSnapshotHash,
      };
      return browserFetchEvidenceSchema.parse({
        contractVersion: "crawler-browser-fetch-evidence.v1",
        executionMode: "browser",
        requestId: request.requestId,
        sourcePageUrl: request.sourcePageUrl,
        finalUrl: page.finalUrl,
        targetUrl: request.targetUrl,
        evidenceSnapshot: snapshot,
        evidenceSnapshotHash: evidenceHash(snapshot),
        observedAt: page.fetchedAt,
      });
    },
  });
}
