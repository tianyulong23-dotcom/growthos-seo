import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(255);
const urlSchema = z.string().trim().url().max(2_048);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const browserFetchEvidenceContractVersion =
  "crawler-browser-fetch-evidence.v1" as const;

export const browserFetchFallbackReasonSchema = z.literal(
  "static_evidence_insufficient",
);

export type BrowserFetchFallbackReason = z.output<
  typeof browserFetchFallbackReasonSchema
>;

export const browserFetchRequestSchema = z.object({
  requestId: identifierSchema,
  workspaceId: identifierSchema,
  websiteProjectId: identifierSchema,
  placementId: identifierSchema,
  sourcePageUrl: urlSchema,
  targetUrl: urlSchema,
  fallbackReason: browserFetchFallbackReasonSchema,
  staticEvidenceSnapshotId: identifierSchema,
  staticEvidenceSnapshotHash: sha256Schema,
  requestedAt: timestampSchema,
}).strict();

export type BrowserFetchRequest = Readonly<
  z.output<typeof browserFetchRequestSchema>
>;

export const browserFetchEvidenceSchema = z.object({
  contractVersion: z.literal(browserFetchEvidenceContractVersion),
  executionMode: z.literal("browser"),
  requestId: identifierSchema,
  sourcePageUrl: urlSchema,
  finalUrl: urlSchema,
  targetUrl: urlSchema,
  evidenceSnapshot: z.record(z.string(), z.unknown()),
  evidenceSnapshotHash: sha256Schema,
  observedAt: timestampSchema,
}).strict();

export type BrowserFetchEvidence = Readonly<
  z.output<typeof browserFetchEvidenceSchema>
>;

export interface BrowserFetchPort {
  fetch(request: BrowserFetchRequest): Promise<BrowserFetchEvidence>;
}

export type BrowserFetchCapabilityResult =
  | Readonly<{ outcome: "disabled" }>
  | Readonly<{ outcome: "fetched"; evidence: BrowserFetchEvidence }>;

export type BrowserFetchCapability = Readonly<{
  readonly enabled: boolean;
  request(request: BrowserFetchRequest): Promise<BrowserFetchCapabilityResult>;
}>;

export type BrowserFetchCapabilityOptions = Readonly<{
  enabled?: boolean;
  browserFetch: BrowserFetchPort;
}>;

export function createBrowserFetchCapability(
  options: BrowserFetchCapabilityOptions,
): BrowserFetchCapability {
  const enabled = options.enabled === true;

  return Object.freeze({
    enabled,
    async request(input: BrowserFetchRequest): Promise<BrowserFetchCapabilityResult> {
      const request = browserFetchRequestSchema.parse(input);
      if (!enabled) return Object.freeze({ outcome: "disabled" as const });

      const evidence = browserFetchEvidenceSchema.parse(
        await options.browserFetch.fetch(request),
      );
      return Object.freeze({ outcome: "fetched" as const, evidence });
    },
  });
}
