import { z } from "zod";

export const placementCandidateSourceTypes = [
  "manual",
  "dataforseo",
  "crawler_discovery",
  "search_discovery",
  "import",
] as const;

const nonBlank = z.string().trim().min(1);
const evidenceJsonValueSchema = z.json();
z.globalRegistry.add(evidenceJsonValueSchema, {
  id: "BacklinksEvidenceJsonValue",
});
const evidencePayloadSchema = z
  .record(z.string().min(1).max(100), evidenceJsonValueSchema)
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
  opportunityId: z.uuid().optional(),
  sourceExternalId: nonBlank.max(500).optional(),
  sourcePageUrl: nonBlank.max(2_048).optional(),
  targetUrl: nonBlank.max(2_048),
  evidence: placementCandidateEvidenceSchema,
}).strict().superRefine((value, context) => {
  const isUserEntered =
    value.sourceType === "manual" || value.sourceType === "import";
  if (
    (value.opportunityId !== undefined || isUserEntered)
    && value.sourcePageUrl === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourcePageUrl"],
      message: "A source page URL is required for direct validation.",
    });
  }
  if (value.opportunityId !== undefined && !isUserEntered) {
    context.addIssue({
      code: "custom",
      path: ["sourceType"],
      message:
        "Only manual and imported links can bind directly to an Opportunity.",
    });
  }
});

export type CreatePlacementCandidateBody = z.output<
  typeof createPlacementCandidateBodySchema
>;
export type PlacementCandidateDiscoveryEvidence = z.output<
  typeof placementCandidateEvidenceSchema
>;
