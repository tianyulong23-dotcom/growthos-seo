import {
  buildDeterministicCommercialDiscoveryHypothesis,
  commercialDiscoveryBlueprintSchemaVersion,
  commercialDiscoveryPromptVersion,
} from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  aiCommercialDiscoveryHypothesisSchema,
  type AiCommercialDiscoveryBlueprintPort,
} from "../../ports/ai-commercial-discovery-blueprint.port.js";
import {
  calculateAiSdkCost,
  createAiSdkObjectOutput,
  createAiSdkProviderModel,
  defaultGenerateProviderText,
  safeAiSdkTokenCount,
  selectAiSdkResponseMode,
  type AiSdkGenerateProviderText,
  type AiSdkLanguageModel,
} from "./ai-sdk-draft.transport.js";

const structuredOutput = createAiSdkObjectOutput(
  aiCommercialDiscoveryHypothesisSchema,
  "growthos_commercial_discovery_blueprint",
  "Project-scoped backlink discovery hypotheses only.",
);
const jsonTextInstruction = [
  "Return exactly one valid JSON object with no Markdown or surrounding text.",
  "Use exactly these top-level fields: targetAudience, productValuePropositions, topicClusters, searchQueryClusters, targetSiteArchetypes, cooperationAngles, negativeKeywords, excludedSiteTypes, discoveredCompetitorSeeds.",
  "Every field must contain an array of strings.",
].join(" ");

export type AiSdkCommercialDiscoveryBlueprintOptions = Readonly<{
  providerRef: string;
  providerBaseUrl: string;
  providerFetch?: typeof globalThis.fetch;
  modelId: string;
  modelVersion: string;
  credentialSecretReference: string;
  timeoutMs: number;
  maxOutputTokens: number;
  inputCostUsdPerMillionTokens: number;
  outputCostUsdPerMillionTokens: number;
  resolveSecret(input: Readonly<{
    organizationId: string;
    secretRef: string;
  }>): Promise<string>;
  beforeProviderCall(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    providerRef: string;
    modelId: string;
  }>): Promise<void>;
  createModel?: (input: Readonly<{
    apiKey: string;
    baseUrl: string;
    modelId: string;
    providerRef: string;
    fetch?: typeof globalThis.fetch;
  }>) => AiSdkLanguageModel;
  generateProviderText?: AiSdkGenerateProviderText;
  now?: () => number;
}>;

export function createAiSdkCommercialDiscoveryBlueprintAdapter(
  options: AiSdkCommercialDiscoveryBlueprintOptions,
): AiCommercialDiscoveryBlueprintPort {
  const createModel = options.createModel ?? createAiSdkProviderModel;
  const generateProviderText = options.generateProviderText
    ?? defaultGenerateProviderText;
  const now = options.now ?? Date.now;
  const responseMode = selectAiSdkResponseMode({
    providerRef: options.providerRef,
    providerBaseUrl: options.providerBaseUrl,
  });

  return Object.freeze({
    async generate(input) {
      const deterministicBaseline =
        buildDeterministicCommercialDiscoveryHypothesis(input.context);
      const apiKey = await options.resolveSecret({
        organizationId: input.organizationId,
        secretRef: options.credentialSecretReference,
      });
      if (apiKey.trim().length === 0) {
        throw new Error("AI commercial discovery credential is empty");
      }
      await options.beforeProviderCall({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        providerRef: options.providerRef,
        modelId: options.modelId,
      });
      const model = createModel({
        apiKey,
        baseUrl: options.providerBaseUrl,
        modelId: options.modelId,
        providerRef: options.providerRef,
        ...(options.providerFetch === undefined
          ? {}
          : { fetch: options.providerFetch }),
      });
      const startedAt = now();
      const result = await generateProviderText({
        model,
        system: [
          "Act as a semantic query planner for backlink site discovery.",
          "Use only the supplied persisted project facts and deterministic baseline.",
          "Do not browse, fetch, crawl, or re-read the project website.",
          "Return 8 to 12 short DataForSEO-ready search queries.",
          "Each query should combine one topic, one market, and one discovery intent or site type.",
          "Preserve the target language and market.",
          "Do not use the project brand, raw backlink goals, giant brands, or general platforms as discovery targets.",
          "Prefer realistic specialist, regional, resource, review, and adjacent-industry publishers.",
          "Improve and deduplicate the baseline without making queries long or overly specific.",
          "Do not send messages, create opportunities, or change business state.",
          "Competitor domains are suggestions and require later verification.",
          ...(responseMode === "json-text" ? [jsonTextInstruction] : []),
        ].join(" "),
        prompt: JSON.stringify({
          schemaVersion: commercialDiscoveryBlueprintSchemaVersion,
          promptVersion: commercialDiscoveryPromptVersion,
          project: {
            projectContextVersionId: input.context.projectContextVersionId,
            projectSettingsVersionId: input.context.projectSettingsVersionId,
            canonicalDomain: input.context.canonicalDomain,
            countries: input.context.countries,
            languages: input.context.languages,
            products: input.context.products,
            keywords: input.context.keywords,
            promotionTargetUrls: input.context.promotionTargetUrls,
            declaredTargetAudiences:
              input.context.declaredTargetAudiences,
            partnershipGoals: input.context.partnershipGoals,
            explicitCompetitorDomains:
              input.context.explicitCompetitorDomains,
            historicalFeedbackDomains:
              input.context.historicalFeedbackDomains,
          },
          deterministicBaseline: {
            topicClusters: deterministicBaseline.topicClusters,
            searchQueryClusters:
              deterministicBaseline.searchQueryClusters,
            targetSiteArchetypes:
              deterministicBaseline.targetSiteArchetypes,
            cooperationAngles: deterministicBaseline.cooperationAngles,
          },
        }),
        output: structuredOutput,
        responseMode,
        maxRetries: 0,
        maxOutputTokens: options.maxOutputTokens,
        timeout: options.timeoutMs,
        telemetry: { isEnabled: false },
      });
      const parsed = aiCommercialDiscoveryHypothesisSchema.parse(
        JSON.parse(result.text) as unknown,
      );
      const inputTokens = safeAiSdkTokenCount(result.usage.inputTokens);
      const outputTokens = safeAiSdkTokenCount(result.usage.outputTokens);
      return Object.freeze({
        output: parsed,
        model: Object.freeze({
          providerRef: options.providerRef,
          modelId: options.modelId,
          modelVersion: options.modelVersion,
        }),
        generation: Object.freeze({
          inputTokens,
          outputTokens,
          estimatedCostUsd: calculateAiSdkCost(
            inputTokens,
            outputTokens,
            options.inputCostUsdPerMillionTokens,
            options.outputCostUsdPerMillionTokens,
          ),
          latencyMs: Math.max(0, now() - startedAt),
        }),
      });
    },
  });
}
