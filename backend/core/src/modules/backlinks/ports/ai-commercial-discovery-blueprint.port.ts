import { z } from "zod";

import type {
  CommercialDiscoveryAiGeneration,
  CommercialDiscoveryAiModel,
  CommercialDiscoveryBlueprintContext,
  CommercialDiscoveryHypothesis,
} from "../domain/recommendations/commercial-discovery-blueprint.js";

const nonBlank = z.string().trim().min(1).max(320);
const searchQuery = z.string().trim().min(1).max(256);

export const aiCommercialDiscoveryHypothesisSchema = z.object({
  targetAudience: z.array(nonBlank).min(1).max(6).readonly(),
  productValuePropositions: z.array(nonBlank).min(1).max(6).readonly(),
  topicClusters: z.array(nonBlank).min(1).max(8).readonly(),
  searchQueryClusters: z.array(searchQuery).min(4).max(12).readonly(),
  targetSiteArchetypes: z.array(nonBlank).min(1).max(6).readonly(),
  cooperationAngles: z.array(nonBlank).min(1).max(6).readonly(),
  negativeKeywords: z.array(nonBlank).max(12).readonly(),
  excludedSiteTypes: z.array(nonBlank).max(12).readonly(),
  discoveredCompetitorSeeds: z.array(
    z.string().trim().min(1).max(253),
  ).max(8).readonly(),
}).strict();

export type AiCommercialDiscoveryBlueprintInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  context: CommercialDiscoveryBlueprintContext;
}>;

export type AiCommercialDiscoveryBlueprintResult = Readonly<{
  output: CommercialDiscoveryHypothesis;
  model: CommercialDiscoveryAiModel;
  generation: CommercialDiscoveryAiGeneration;
}>;

export type AiCommercialDiscoveryBlueprintPort = Readonly<{
  generate(
    input: AiCommercialDiscoveryBlueprintInput,
  ): Promise<AiCommercialDiscoveryBlueprintResult>;
}>;
