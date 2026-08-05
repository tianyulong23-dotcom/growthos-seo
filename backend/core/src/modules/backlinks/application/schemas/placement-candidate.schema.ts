import { z } from "zod";

export const placementCandidateSourceTypes = [
  "manual",
  "dataforseo",
  "crawler_discovery",
  "search_discovery",
  "import",
] as const;

const nonBlank = z.string().trim().min(1);
const evidencePayloadSchema = z
  .record(z.string().min(1).max(100), z.json())
  .refine((value) => Object.keys(value).length > 0, {
    message: "Evidence payload must not be empty.",
  });

export const placementCandidateEvidenceSchema = z.object({
  contractVersion: nonBlank.max(100),
  schemaVersion: z.number().int().positive(),
  evidenceId: nonBlank.max(255),
  observedAt: z.string().datetime({ offset: true }),
  sourceRef: nonBlank.max(2_048),
  payload: evidencePayloadSchema,
}).strict();

export const createPlacementCandidateBodySchema = z.object({
  sourceType: z.enum(placementCandidateSourceTypes),
  sourceExternalId: nonBlank.max(500).optional(),
  sourcePageUrl: nonBlank.max(2_048).optional(),
  targetUrl: nonBlank.max(2_048),
  evidence: placementCandidateEvidenceSchema,
}).strict();

export type CreatePlacementCandidateBody = z.output<
  typeof createPlacementCandidateBodySchema
>;
export type PlacementCandidateDiscoveryEvidence = z.output<
  typeof placementCandidateEvidenceSchema
>;
