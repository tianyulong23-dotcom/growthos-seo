import { describe, expect, it } from "vitest";

import {
  createAiSdkCommercialDiscoveryBlueprintAdapter,
} from "../../src/modules/backlinks/adapters/ai/ai-sdk-commercial-discovery-blueprint.adapter.js";
import type {
  AiSdkGenerateProviderText,
} from "../../src/modules/backlinks/adapters/ai/ai-sdk-draft.transport.js";

describe("AI commercial discovery blueprint adapter", () => {
  it("makes one structured call with current-project facts only", async () => {
    const calls: Parameters<AiSdkGenerateProviderText>[0][] = [];
    const generateProviderText: AiSdkGenerateProviderText = async (input) => {
      calls.push(input);
      return {
        text: JSON.stringify({
          targetAudience: ["streaming viewers"],
          productValuePropositions: ["live TV access"],
          topicClusters: ["streaming television"],
          searchQueryClusters: [
            "South Africa streaming television blogs",
            "South Africa streaming television publications",
            "\"streaming television\" \"write for us\" South Africa",
            "South Africa streaming television resource directory",
          ],
          targetSiteArchetypes: ["review site"],
          cooperationAngles: ["editorial review"],
          negativeKeywords: [],
          excludedSiteTypes: ["link marketplace"],
          discoveredCompetitorSeeds: ["showmax.com"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    };
    const adapter = createAiSdkCommercialDiscoveryBlueprintAdapter({
      providerRef: "openai",
      providerBaseUrl: "https://provider.example/v1",
      modelId: "gpt-5.6-terra",
      modelVersion: "2026-08-10",
      credentialSecretReference: "secret-ref",
      timeoutMs: 10_000,
      maxOutputTokens: 1_000,
      inputCostUsdPerMillionTokens: 1,
      outputCostUsdPerMillionTokens: 2,
      resolveSecret: async () => "not-persisted-secret",
      beforeProviderCall: async () => {},
      createModel: () => "model",
      generateProviderText,
      now: (() => {
        let current = 1_000;
        return () => {
          current += 5;
          return current;
        };
      })(),
    });

    const result = await adapter.generate({
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      context: {
        projectContextVersionId: "context-1",
        projectSettingsVersionId: "settings-1",
        projectSettingsVersion: 2,
        canonicalDomain: "elephtv.com",
        countries: ["ZA"],
        languages: ["en"],
        products: ["ElephTV streaming app"],
        keywords: ["live sports streaming"],
        promotionTargetUrls: ["https://elephtv.com/"],
        declaredTargetAudiences: ["South African streaming viewers"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: ["showmax.com"],
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:1"],
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({
      maxRetries: 0,
      responseMode: "json-text",
      telemetry: { isEnabled: false },
    }));
    const prompt = String(calls[0]?.prompt);
    expect(prompt).toContain("elephtv.com");
    expect(prompt).toContain("showmax.com");
    expect(prompt).toContain("South Africa live sports streaming blogs");
    expect(String(calls[0]?.system)).toContain(
      "Do not browse, fetch, crawl, or re-read",
    );
    expect(String(calls[0]?.system)).toContain(
      "Return exactly one valid JSON object",
    );
    expect(prompt).not.toContain("not-persisted-secret");
    expect(result.output.discoveredCompetitorSeeds).toEqual(["showmax.com"]);
    expect(result.model.modelId).toBe("gpt-5.6-terra");
    expect(result.model.modelVersion).toBe("2026-08-10");
  });
});
