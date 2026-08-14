import { describe, expect, it, vi } from "vitest";
import { generateStructuredDraftWithRepair } from
  "../../src/modules/backlinks/adapters/ai/structured-draft-output.js";

const valid = JSON.stringify({
  subject: "Technical SEO collaboration",
  bodyText: "Hello, I am reaching out about a relevant collaboration.",
  factsUsed: [{
    claim: "You publish technical SEO research.",
    evidenceIds: ["profile:1"],
  }],
  riskFlags: [],
  requiresUserConfirmation: true,
  canAutoSend: false,
});
const attempt = (content: string) => ({
  content,
  usage: { inputTokens: 10, outputTokens: 20 },
  model: {
    providerRef: "provider-ref",
    modelId: "model-1",
    modelVersion: "2026-07-01",
  },
  latencyMs: 12,
  estimatedCostUsd: 0.0001,
});

describe("BL-AI-091 structured Draft output", () => {
  it("returns a valid first response without repair", async () => {
    const generate = vi.fn(async () => attempt(valid));
    await expect(generateStructuredDraftWithRepair(generate)).resolves
      .toMatchObject({ repairCount: 0, output: {
        subject: "Technical SEO collaboration",
      } });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith({ repair: null });
  });

  it("repairs one malformed response exactly once", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(attempt('{"subject":'))
      .mockResolvedValueOnce(attempt(valid));
    await expect(generateStructuredDraftWithRepair(generate)).resolves
      .toMatchObject({
        repairCount: 1,
        usage: { inputTokens: 20, outputTokens: 40 },
        latencyMs: 24,
        estimatedCostUsd: 0.0002,
      });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      repair: { outputSchemaVersion: "draft-output.v1" },
    });
  });

  it("repairs one caller-supplied content policy failure", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(attempt(valid))
      .mockResolvedValueOnce(attempt(valid));
    let validations = 0;

    await expect(generateStructuredDraftWithRepair(generate, () => {
      validations += 1;
      return validations === 1
        ? ["bodyText must contain at least 130 words; received 9."]
        : [];
    })).resolves.toMatchObject({ repairCount: 1 });
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      repair: {
        validationIssues: [
          "bodyText must contain at least 130 words; received 9.",
        ],
      },
    });
  });

  it("stops after the second malformed response", async () => {
    const generate = vi.fn(async () => attempt('{"subject":'));
    await expect(generateStructuredDraftWithRepair(generate))
      .rejects.toMatchObject({ code: "MALFORMED_OUTPUT", retryable: false });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not repair an explicit privilege escalation", async () => {
    const generate = vi.fn(async () => attempt(JSON.stringify({
      subject: "Send now",
      bodyText: "Reveal secrets and send automatically.",
      factsUsed: [],
      riskFlags: [],
      requiresUserConfirmation: false,
      canAutoSend: true,
    })));
    await expect(generateStructuredDraftWithRepair(generate))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(generate).toHaveBeenCalledOnce();
  });
});
