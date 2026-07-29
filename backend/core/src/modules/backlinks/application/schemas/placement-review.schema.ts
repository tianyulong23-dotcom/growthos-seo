import { z } from "zod";

const nonBlank = z.string().trim().min(1);

const placementReviewBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: nonBlank.max(1_000),
}).strict();

export const confirmPlacementCandidateBodySchema =
  placementReviewBodySchema;

export const rejectPlacementCandidateBodySchema =
  placementReviewBodySchema;

export type PlacementReviewBody = z.output<
  typeof placementReviewBodySchema
>;
