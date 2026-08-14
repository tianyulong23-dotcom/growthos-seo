import {
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
  type AiSdkGenerateProviderText,
  type AiSdkLanguageModel,
} from "./ai-sdk-draft.transport.js";

const structuredOutput = createAiSdkObjectOutput(
  aiCommercialDiscoveryHypothesisSchema,
  "growthos_commercial_discovery_blueprint",
  "Project-scoped backlink discovery hypotheses only.",
);

export type AiSdkCommercialDiscoveryBlueprintOptions = Readonly<{
  providerRef: string;
  providerBaseUrl: string;
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

  return Object.freeze({
    async generate(input) {
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
      });
      const startedAt = now();
      const result = await generateProviderText({
        model,
        system: [
          "Generate one structured backlink discovery hypothesis.",
          "Use only the supplied current-project facts.",
          "Do not send messages, create opportunities, or change business state.",
          "Competitor domains are suggestions and require later verification.",
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
        }),
        output: structuredOutput,
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
