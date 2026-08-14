import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createAiDraftClient } from
  "../../src/modules/backlinks/adapters/ai/ai-draft-client.js";
import { AiDraftError, type AiDraftInput } from
  "../../src/modules/backlinks/ports/ai-draft.port.js";

const input: AiDraftInput = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  opportunityId: "opportunity-1",
  evidenceSnapshotId: "snapshot-1",
  promptVersion: "draft-prompt.v1",
  outputSchemaVersion: "draft-output.v1",
  systemInstruction: "PROMPT_BODY_MUST_NOT_BE_LOGGED",
  userContext: { cooperationType: "guest_post" },
  evidence: [{
    id: "profile:1",
    sourceKind: "PROFILE",
    value: "GrowthOS publishes technical SEO research.",
  }],
};
const result = {
  output: {
    subject: "Technical SEO collaboration",
    bodyText: "Hello, I am reaching out about a relevant collaboration.",
    factsUsed: [{
      claim: "You publish technical SEO research.",
      evidenceIds: ["profile:1"],
    }],
    riskFlags: [],
    requiresUserConfirmation: true as const,
    canAutoSend: false as const,
  },
  usage: { inputTokens: 10, outputTokens: 20 },
  model: {
    providerRef: "provider-ref",
    modelId: "model-1",
    modelVersion: "2026-07-01",
  },
  latencyMs: 12,
  repairCount: 0 as const,
  estimatedCostUsd: 0.0001,
};

describe("BL-AI-090 real AI Adapter shell", () => {
  const validConfig = {
    enabled: true,
    secretRef: "secret-ref",
    providerRef: "provider-ref",
    modelId: "model-1",
    modelVersion: "2026-07-01",
    timeoutMs: 1000,
    maxInputTokens: 1000,
    maxOutputTokens: 500,
    absoluteBudgetUsd: 0.01,
  } as const;

  it.each([
    [{ ...validConfig, secretRef: undefined }, "secretRef"],
    [{ ...validConfig, modelId: undefined }, "modelId"],
    [{ ...validConfig, timeoutMs: undefined }, "timeoutMs"],
    [{ ...validConfig, timeoutMs: 0 }, "timeoutMs"],
    [{ ...validConfig, maxInputTokens: 0 }, "maxInputTokens"],
    [{ ...validConfig, maxOutputTokens: 0 }, "maxOutputTokens"],
    [{ ...validConfig, absoluteBudgetUsd: 0 }, "absoluteBudgetUsd"],
  ] as const)("fails closed when %s is invalid", async (config, field) => {
    const error = await createAiDraftClient({
      config,
      transport: { generate: async () => result },
    }).generate(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiDraftError);
    expect(error).toMatchObject({ code: "MISCONFIGURED" });
    expect((error as Error).message).toContain(field);
  });

  it("is disabled by default and contains no built-in network client", async () => {
    await expect(createAiDraftClient({
      config: {},
      transport: { generate: async () => result },
    }).generate(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const source = await readFile(new URL(
      "../../src/modules/backlinks/adapters/ai/ai-draft-client.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|undici|axios/iu);
  });

  it("delegates through an injected Transport with redacted logs", async () => {
    const logs: unknown[] = [];
    const generate = vi.fn(async () => result);
    const client = createAiDraftClient({
      config: {
        ...validConfig,
        secretRef: "SECRET_REF_MUST_NOT_BE_LOGGED",
      },
      transport: { generate },
      logger: (event) => logs.push(event),
    });

    await expect(client.generate(input)).resolves.toEqual(result);
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs)).not.toContain("PROMPT_BODY_MUST_NOT_BE_LOGGED");
    expect(JSON.stringify(logs)).not.toContain("SECRET_REF_MUST_NOT_BE_LOGGED");
    expect(logs).toEqual([
      { event: "backlinks.ai_draft.started", modelId: "model-1",
        providerRef: "provider-ref" },
      { event: "backlinks.ai_draft.completed", modelId: "model-1",
        providerRef: "provider-ref", latencyMs: 12 },
    ]);
  });
});
