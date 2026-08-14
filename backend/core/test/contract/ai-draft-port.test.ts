import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AiDraftError,
  aiDraftInputSchema,
  aiDraftOutputSchema,
  type AiDraftPort,
} from "../../src/modules/backlinks/ports/ai-draft.port.js";

const input = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  opportunityId: "opportunity-1",
  evidenceSnapshotId: "snapshot-1",
  promptVersion: "draft-prompt.v1",
  outputSchemaVersion: "draft-output.v1",
  systemInstruction: "Write one evidence-backed outreach draft.",
  userContext: {
    cooperationType: "guest_post",
    tone: "friendly",
  },
  evidence: [{
    id: "profile:1",
    sourceKind: "PROFILE",
    value: "GrowthOS publishes technical SEO research.",
  }],
} as const;

const output = {
  subject: "Technical SEO collaboration",
  bodyText: "Hello, I am reaching out about a relevant collaboration.",
  factsUsed: [{
    claim: "You publish technical SEO research.",
    evidenceIds: ["profile:1"],
  }],
  riskFlags: [],
  requiresUserConfirmation: true,
  canAutoSend: false,
} as const;

describe("BL-AI-088 AiDraftPort", () => {
  it("defines strict provider-neutral structured input and output", async () => {
    expect(aiDraftInputSchema.parse(input)).toEqual(input);
    expect(aiDraftOutputSchema.parse(output)).toEqual(output);
    const source = await readFile(new URL(
      "../../src/modules/backlinks/ports/ai-draft.port.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(/openai|anthropic|gemini|provider sdk/iu);
  });

  it.each([
    ["TIMEOUT", true],
    ["RATE_LIMITED", true],
    ["MALFORMED_OUTPUT", false],
    ["REFUSED", false],
  ] as const)("expresses %s with stable retryability", (code, retryable) => {
    expect(new AiDraftError({
      code,
      message: "Draft generation failed.",
      retryable,
    })).toMatchObject({ code, retryable });
  });

  it("can be implemented without exposing a vendor response", async () => {
    const port: AiDraftPort = {
      generate: async () => ({
        output,
        usage: { inputTokens: 10, outputTokens: 20 },
        model: { providerRef: "provider-ref", modelId: "model-1",
          modelVersion: "2026-07-01" },
        latencyMs: 12,
        repairCount: 0,
      }),
    };
    await expect(port.generate(input)).resolves.toMatchObject({
      output,
      repairCount: 0,
    });
  });
});
