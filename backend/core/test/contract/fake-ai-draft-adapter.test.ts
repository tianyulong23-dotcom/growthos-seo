import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeAiDraftAdapter } from
  "../../src/modules/backlinks/adapters/ai/fake-ai-draft.adapter.js";
import { AiDraftError, type AiDraftInput } from
  "../../src/modules/backlinks/ports/ai-draft.port.js";

const scenarios = JSON.parse(await readFile(new URL(
  "./fixtures/ai-draft-scenarios.json",
  import.meta.url,
), "utf8")) as Record<string, unknown>;

const input: AiDraftInput = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  opportunityId: "opportunity-1",
  evidenceSnapshotId: "snapshot-1",
  promptVersion: "draft-prompt.v1",
  outputSchemaVersion: "draft-output.v1",
  systemInstruction: "Write one evidence-backed outreach draft.",
  userContext: { cooperationType: "guest_post" },
  evidence: [{
    id: "profile:1",
    sourceKind: "PROFILE",
    value: "GrowthOS publishes technical SEO research.",
  }],
};

describe("BL-AI-089 Fake AI Draft Adapter", () => {
  it("returns the success Fixture through the shared Port", async () => {
    await expect(createFakeAiDraftAdapter({
      scenario: scenarios.success,
    }).generate(input)).resolves.toMatchObject({
      output: { subject: "Technical SEO collaboration",
        requiresUserConfirmation: true, canAutoSend: false },
      model: { providerRef: "fake-ai" },
      repairCount: 0,
    });
  });

  it.each([
    ["refusal", "REFUSED"],
    ["timeout", "TIMEOUT"],
    ["malformed", "MALFORMED_OUTPUT"],
    ["privilege", "POLICY_VIOLATION"],
  ] as const)("maps %s to %s", async (scenario, code) => {
    const error = await createFakeAiDraftAdapter({
      scenario: scenarios[scenario],
    }).generate(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiDraftError);
    expect(error).toMatchObject({ code });
  });
});
