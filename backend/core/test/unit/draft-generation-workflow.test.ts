import { describe, expect, it } from "vitest";

import type {
  DraftGenerationRepository,
  DraftPromptContext,
} from "../../src/modules/backlinks/application/repositories/draft-generation.repository.js";
import { runDraftGenerationWorkflow } from
  "../../src/modules/backlinks/application/workflows/draft-generation-workflow.js";
import {
  AiDraftError,
  type AiDraftResult,
} from "../../src/modules/backlinks/ports/ai-draft.port.js";

const validBody = [
  "Hello, I am reaching out from GrowthOS after reviewing publisher.test and the audience it serves. The published context appears relevant to teams researching practical outreach workflows, so I wanted to ask whether a focused editorial collaboration could be useful.",
  "We would like to explore a relevant content partnership around GrowthOS. The proposed destination is https://growthos.test/. We can provide concise product context, factual source material, and a clear outline while leaving topic selection, wording, review standards, and publication decisions with your editorial team.",
  "Any link treatment would remain entirely subject to your policy. We are not assuming acceptance, publication, ranking, indexing, placement, pricing, or a dofollow attribute, and the final format should only proceed if it is genuinely useful to your readers.",
  "Would you be open to a brief review of the collaboration idea? If it is not a fit, no action is needed. If it may be relevant, please share the information or format your team would need before considering it.",
].join("\n\n");

const context: DraftPromptContext = {
  prompt: {
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    websiteProjectId: "project-1",
    opportunityId: "opportunity-1",
    evidenceSnapshotId: "evidence-snapshot-1",
    promptVersion: "draft-prompt.v1",
    outputSchemaVersion: "draft-output.v1",
    systemInstruction: "Create one governed outreach email draft.",
    userContext: {
      project: {
        siteName: "GrowthOS",
        products: ["outreach workflow software"],
      },
      promotionTarget: { url: "https://growthos.test/" },
      opportunity: { targetHost: "publisher.test" },
      preferences: {
        cooperationType: "GENERAL_PARTNERSHIP",
        linkAttributePreference: "NOT_SPECIFIED",
      },
    },
    evidence: [
      {
        id: "profile:current",
        sourceKind: "PROFILE",
        value: "GrowthOS provides outreach workflow software.",
      },
      {
        id: "opportunity:current",
        sourceKind: "OPPORTUNITY",
        value: "publisher.test is the target website.",
      },
      {
        id: "promotion-target:current",
        sourceKind: "PROMOTION_TARGET",
        value: "https://growthos.test/ is the selected target.",
      },
    ],
  },
  approvedEvidence: [
    {
      id: "profile:current",
      sourceKind: "PROFILE",
      value: "GrowthOS provides outreach workflow software.",
      untrustedContent: true,
    },
    {
      id: "opportunity:current",
      sourceKind: "OPPORTUNITY",
      value: "publisher.test is the target website.",
      untrustedContent: true,
    },
    {
      id: "promotion-target:current",
      sourceKind: "PROMOTION_TARGET",
      value: "https://growthos.test/ is the selected target.",
      untrustedContent: true,
    },
  ],
  forbiddenValues: [],
};

const modelResult = (
  overrides: Partial<AiDraftResult["output"]> = {},
): AiDraftResult => ({
  output: {
    subject: "Evidence-led collaboration",
    bodyText: validBody,
    factsUsed: [{
      claim: "GrowthOS is the sender project.",
      evidenceIds: ["profile:current"],
    }],
    riskFlags: [],
    requiresUserConfirmation: true,
    canAutoSend: false,
    ...overrides,
  },
  usage: { inputTokens: 100, outputTokens: 150 },
  estimatedCostUsd: 0.002,
  model: {
    providerRef: "provider-secret-ref",
    modelId: "model-1",
    modelVersion: "2026-08-01",
  },
  latencyMs: 180,
  repairCount: 0,
});

const workflowInput = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  runId: "run-1",
  versionId: "version-1",
  actorId: "user-1",
  recordedAt: "2026-08-12T08:00:00.000Z",
  generationMode: "MODEL" as const,
};

const createRepository = () => {
  let claims = 0;
  const completed: Parameters<DraftGenerationRepository["completeJob"]>[0][] =
    [];
  const failed: Parameters<DraftGenerationRepository["failJob"]>[0][] = [];
  const retries: Parameters<DraftGenerationRepository["scheduleRetry"]>[0][] =
    [];
  const repository: DraftGenerationRepository = {
    async prepareEvidenceSnapshot() {
      throw new Error("not used");
    },
    async createJob() {
      throw new Error("not used");
    },
    async claimJob() {
      claims += 1;
      return {
        runId: "run-1",
        draftId: "draft-1",
        status: "RUNNING",
        started: true,
        opportunityId: "opportunity-1",
        contactId: "contact-1",
        contactVersion: 1,
        evidenceSnapshotId: "evidence-snapshot-1",
        requestSnapshotId: "request-snapshot-1",
        request: null,
        generator: null,
        promptVersion: "draft-prompt.v1",
        outputSchemaVersion: "draft-output.v1",
        baseDraftVersion: 0,
        versionId: null,
        lastSuccessfulVersionId: null,
        queuedAt: new Date("2026-08-12T07:59:00.000Z"),
        startedAt: new Date("2026-08-12T08:00:00.000Z"),
        finishedAt: null,
        latencyMs: null,
        attemptCount: claims,
        lastErrorCategory: null,
        persistenceLatencyMs: null,
      };
    },
    async loadPromptContext() {
      return context;
    },
    async completeJob(candidate) {
      completed.push(candidate);
      return {
        versionId: candidate.versionId,
        draftVersion: 1,
        adoptedAsCurrent: true,
      };
    },
    async failJob(candidate) {
      failed.push(candidate);
    },
    async scheduleRetry(candidate) {
      retries.push(candidate);
    },
    async getJob() {
      throw new Error("not used");
    },
    async findLatestJob() {
      throw new Error("not used");
    },
    async getDraft() {
      throw new Error("not used");
    },
  };
  return {
    repository,
    completed,
    failed,
    retries,
    claims: () => claims,
  };
};

describe("LOCAL-PRODUCT-038 Draft generation fail-closed workflow", () => {
  it("fails MODEL mode explicitly when no AI provider is configured", async () => {
    const fake = createRepository();

    await expect(runDraftGenerationWorkflow(
      workflowInput,
      fake.repository,
      null,
    )).rejects.toMatchObject({
      name: "AiDraftError",
      code: "MISCONFIGURED",
      retryable: false,
    });
    expect(fake.completed).toHaveLength(0);
    expect(fake.failed).toMatchObject([{
      errorClass: "AiDraftError",
      errorCode: "MISCONFIGURED",
      refused: false,
    }]);
  });

  it("does not convert a terminal model error into a successful fallback", async () => {
    const fake = createRepository();

    await expect(runDraftGenerationWorkflow(
      workflowInput,
      fake.repository,
      {
        async generate() {
          throw new AiDraftError({
            code: "MALFORMED_OUTPUT",
            message: "Provider output did not match the schema.",
            retryable: false,
          });
        },
      },
    )).rejects.toMatchObject({
      code: "MALFORMED_OUTPUT",
      retryable: false,
    });
    expect(fake.completed).toHaveLength(0);
    expect(fake.failed[0]?.errorCode).toBe("MALFORMED_OUTPUT");
  });

  it("retries one recoverable failure on the same Job and persists MODEL", async () => {
    const fake = createRepository();
    let providerCalls = 0;

    await expect(runDraftGenerationWorkflow(
      workflowInput,
      fake.repository,
      {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 1) {
            throw new AiDraftError({
              code: "TIMEOUT",
              message: "Provider timed out.",
              retryable: true,
            });
          }
          return modelResult();
        },
      },
      { now: () => new Date("2026-08-12T08:00:05.000Z") },
    )).resolves.toMatchObject({
      outcome: "completed",
      versionId: "version-1",
    });
    expect(providerCalls).toBe(2);
    expect(fake.claims()).toBe(2);
    expect(fake.retries).toHaveLength(1);
    expect(fake.failed).toHaveLength(0);
    expect(fake.completed).toMatchObject([{ source: "MODEL" }]);
  });

  it("maps semantic policy rejection to an explicit failed Job", async () => {
    const fake = createRepository();

    await expect(runDraftGenerationWorkflow(
      workflowInput,
      fake.repository,
      {
        async generate() {
          return modelResult({
            subject: "Quarterly payroll changes",
          });
        },
      },
    )).rejects.toMatchObject({
      name: "AiDraftError",
      code: "POLICY_VIOLATION",
      retryable: false,
    });
    expect(fake.completed).toHaveLength(0);
    expect(fake.failed[0]?.errorCode).toBe("POLICY_VIOLATION");
  });

  it("keeps MANUAL fallback as a diagnostic version only", async () => {
    const fake = createRepository();

    await expect(runDraftGenerationWorkflow(
      { ...workflowInput, generationMode: "MANUAL" },
      fake.repository,
      null,
    )).resolves.toMatchObject({
      outcome: "completed",
      versionId: "version-1",
    });
    expect(fake.completed).toMatchObject([{
      source: "TEMPLATE_FALLBACK",
      result: {
        model: { providerRef: "template-fallback" },
      },
    }]);
    expect(fake.failed).toHaveLength(0);
  });
});
