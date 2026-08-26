import { describe, expect, it, vi } from "vitest";

import { createCooperationPathOpportunityCommands } from "../../src/modules/backlinks/application/commands/cooperation-path-opportunities.command.js";
import type { CooperationPathOpportunityRepository } from "../../src/modules/backlinks/db/repositories/cooperation-path-opportunity.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const context = {
  actor: createActorContext({
    userId: "local-product-operator",
    sessionId: "session-1",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: "018f0000-0000-7000-8000-000000000001",
    workspaceId: "018f0000-0000-7000-8000-000000000002",
  }),
  project: createProjectContext({
    websiteProjectId: "018f0000-0000-7000-8000-000000000003",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-1",
    promotionTargetVersionId: "target-1",
  }),
};

const transitionInput = {
  context,
  opportunityId: "018f0000-0000-7000-8000-000000000004",
  expectedVersion: 1,
  toState: "SUBMITTED" as const,
  nextAction: "Wait for the publisher response.",
  evidence: {
    source: "operator_ui",
    pathUrl: "https://publisher.example/contact",
  },
  idempotencyKey: "manual-action-submit-1",
  requestId: "request-1",
};

function createRepository() {
  const transitionManualAction = vi.fn<
    CooperationPathOpportunityRepository["transitionManualAction"]
  >(async (input) => ({
    state: "completed",
    requestHash: input.requestHash,
    responseBody: {
      opportunityId: input.opportunityId,
      manualActionId: "018f0000-0000-7000-8000-000000000005",
      manualActionState: input.toState,
      editableContent: "Please review our resource.",
      nextAction: input.nextAction,
      manualActionVersion: input.expectedVersion + 1,
      lifecycleEventId: "018f0000-0000-7000-8000-000000000006",
      auditEventId: "018f0000-0000-7000-8000-000000000007",
    },
  }));
  return {
    createFromVerifiedPath: vi.fn<
      CooperationPathOpportunityRepository["createFromVerifiedPath"]
    >(),
    patchManualContent: vi.fn<
      CooperationPathOpportunityRepository["patchManualContent"]
    >(),
    transitionManualAction,
  } satisfies CooperationPathOpportunityRepository;
}

describe("cooperation path opportunity commands", () => {
  it("creates a contact-form Opportunity without fabricating a public contact", async () => {
    const repository = createRepository();
    repository.createFromVerifiedPath.mockImplementation(async (input) => ({
      state: "completed",
      requestHash: input.requestHash,
      responseBody: {
        opportunityId: input.opportunityId,
        recommendationId: input.recommendationId,
        cycleId: input.cycleId,
        websiteProjectId: input.websiteProjectId,
        targetSiteKey: "publisher.example",
        targetHostAscii: "publisher.example",
        cooperationPathFactId: input.cooperationPathFactId,
        manualActionId: input.manualActionId,
        pathType: "contact_form",
        pathUrl: "https://publisher.example/contact",
        contentType: "FORM_MESSAGE",
        editableContent: input.editableContent,
        manualActionState: "READY_FOR_MANUAL_ACTION",
        nextAction: input.nextAction,
        manualActionVersion: 1,
        joinSequence: 1,
        businessStage: "JOINED",
        managementStatus: "ACTIVE",
        outcomeStatus: "OPEN",
        fulfillmentStatus: "NOT_EXPECTED",
        version: 1,
        lifecycleEventId: input.lifecycleEventId,
        auditEventId: input.auditEventId,
      },
    }));
    const commands = createCooperationPathOpportunityCommands(repository);

    const result = await commands.createFromVerifiedPath({
      context,
      recommendationId: "018f0000-0000-7000-8000-000000000008",
      cooperationPathFactId: "018f0000-0000-7000-8000-000000000009",
      expectedVersion: 1,
      editableContent: "Please review our resource.",
      nextAction: "Open the contact form and submit manually.",
      idempotencyKey: "cooperation-path-create-1",
      requestId: "request-create-1",
    });

    expect(result).toMatchObject({
      pathType: "contact_form",
      contentType: "FORM_MESSAGE",
      manualActionState: "READY_FOR_MANUAL_ACTION",
      replayed: false,
    });
    expect(repository.createFromVerifiedPath.mock.calls[0]?.[0])
      .not.toHaveProperty("sourceContactCandidateId");
  });

  it("rejects SUBMITTED unless the operator explicitly confirms completion", async () => {
    const repository = createRepository();
    const commands = createCooperationPathOpportunityCommands(repository);

    await expect(commands.transitionManualAction({
      ...transitionInput,
      submissionConfirmed: false,
    })).rejects.toThrow("Explicit submission confirmation is required.");
    expect(repository.transitionManualAction).not.toHaveBeenCalled();
  });

  it("persists a confirmed submission with the allowed source state", async () => {
    const repository = createRepository();
    const commands = createCooperationPathOpportunityCommands(repository);

    const result = await commands.transitionManualAction({
      ...transitionInput,
      submissionConfirmed: true,
    });

    expect(result).toMatchObject({
      manualActionState: "SUBMITTED",
      replayed: false,
    });
    expect(repository.transitionManualAction).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedFromStates: ["IN_PROGRESS"],
        evidence: transitionInput.evidence,
      }),
    );
  });

  it("returns a duplicate manual confirmation as an idempotent replay", async () => {
    const repository = createRepository();
    repository.transitionManualAction.mockImplementationOnce(async (input) => ({
      state: "replay",
      requestHash: input.requestHash,
      responseBody: {
        opportunityId: input.opportunityId,
        manualActionId: "018f0000-0000-7000-8000-000000000005",
        manualActionState: "SUBMITTED",
        editableContent: "Please review our resource.",
        nextAction: input.nextAction,
        manualActionVersion: 2,
        lifecycleEventId: "018f0000-0000-7000-8000-000000000006",
        auditEventId: "018f0000-0000-7000-8000-000000000007",
      },
    }));
    const commands = createCooperationPathOpportunityCommands(repository);

    await expect(commands.transitionManualAction({
      ...transitionInput,
      submissionConfirmed: true,
    })).resolves.toMatchObject({
      manualActionState: "SUBMITTED",
      replayed: true,
    });
  });
});
