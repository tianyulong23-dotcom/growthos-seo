import { describe, expect, it } from "vitest";

import { createDraftTemplateFallback } from
  "../../src/modules/backlinks/application/services/draft-template-fallback.js";
import { draftOutputContentPolicyIssues } from
  "../../src/modules/backlinks/domain/drafts/evidence-policy.js";
import type { AiDraftInput } from
  "../../src/modules/backlinks/ports/ai-draft.port.js";

const createInput = (userContext: unknown): AiDraftInput => ({
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  opportunityId: "opportunity-1",
  evidenceSnapshotId: "snapshot-1",
  promptVersion: "draft-prompt.v1",
  outputSchemaVersion: "draft-output.v1",
  systemInstruction: "Create one governed outreach draft.",
  userContext,
  evidence: [
    {
      id: "profile:current",
      sourceKind: "PROFILE",
      value: "GrowthOS is the sender project.",
    },
    {
      id: "opportunity:current",
      sourceKind: "OPPORTUNITY",
      value: "publisher.test is the target website.",
    },
    {
      id: "promotion-target:current",
      sourceKind: "PROMOTION_TARGET",
      value: "https://growthos.test/research is the target.",
    },
  ],
});

describe("Draft template fallback", () => {
  it("creates an editable, policy-compliant draft from shared project context", () => {
    const result = createDraftTemplateFallback(createInput({
      project: { siteName: "GrowthOS" },
      promotionTarget: {
        label: "SEO workflow research",
        url: "https://growthos.test/research",
      },
      opportunity: { targetHost: "publisher.test" },
      preferences: {
        cooperationType: "CONTENT_PARTNERSHIP",
        linkAttributePreference: "NOFOLLOW_ACCEPTABLE",
        anchorTextSuggestion: "SEO workflow research",
      },
    }), "UNAVAILABLE");

    expect(result.model).toMatchObject({
      providerRef: "template-fallback",
      modelVersion: "cooperation-template.v2",
    });
    expect(result.output.subject).toBe("Editorial idea for publisher.test");
    expect(result.output.bodyText.split(/\n\s*\n/u)).toHaveLength(4);
    expect(result.output.bodyText).toContain(
      "https://growthos.test/research",
    );
    expect(result.output.bodyText).not.toContain("profile:current");
    expect(result.output.requiresUserConfirmation).toBe(true);
    expect(result.output.canAutoSend).toBe(false);
    expect(draftOutputContentPolicyIssues(
      result.output,
      createInput({}).evidence.map((item) => item.id),
    )).toEqual([]);
  });

  it("removes placeholders and never fabricates a project URL", () => {
    const result = createDraftTemplateFallback(createInput({
      project: { siteName: "{{company}}" },
      promotionTarget: {
        label: "[website]",
        url: "not-a-url",
      },
      opportunity: { targetHost: "[name]" },
      preferences: {
        anchorTextSuggestion: "TBD",
      },
    }), "MISCONFIGURED");

    expect(result.output.subject).toBe(
      "Editorial idea for the target website",
    );
    expect(result.output.bodyText).not.toMatch(
      /\{\{|\[(?:name|company|website)\]|\bTBD\b/iu,
    );
    expect(result.output.bodyText).not.toContain("https://our website");
    expect(result.output.factsUsed).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceIds: ["promotion-target:current"],
        }),
      ]),
    );
    expect(draftOutputContentPolicyIssues(
      result.output,
      createInput({}).evidence.map((item) => item.id),
    )).toEqual([]);
  });
});
