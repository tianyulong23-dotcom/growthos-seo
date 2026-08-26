import { describe, expect, it } from "vitest";

import {
  deriveOpportunityHandoffState,
} from "../../src/modules/backlinks/application/read-models/opportunity-handoff.js";

describe("Opportunity handoff state", () => {
  it("allows email only when a reviewed contact is ready", () => {
    expect(deriveOpportunityHandoffState({
      engagementChannel: "EMAIL",
      contactEmail: "editor@example.com",
      contactReviewRequired: false,
      manualActionState: null,
      draftStatus: null,
      draftVersionSource: null,
    })).toEqual({
      engagementPathState: "EMAIL_READY",
      primaryNextAction: {
        kind: "CREATE_EMAIL_DRAFT",
        enabled: true,
        blockerCode: null,
      },
    });
  });

  it("routes non-email opportunities to their manual action", () => {
    expect(deriveOpportunityHandoffState({
      engagementChannel: "COOPERATION_PATH",
      contactEmail: null,
      contactReviewRequired: false,
      manualActionState: "READY_FOR_MANUAL_ACTION",
      draftStatus: null,
      draftVersionSource: null,
    })).toMatchObject({
      engagementPathState: "MANUAL_PATH_READY",
      primaryNextAction: { kind: "CONTINUE_MANUAL_PATH", enabled: true },
    });
  });

  it.each([
    { contactEmail: null, contactReviewRequired: true },
    { contactEmail: "review@example.com", contactReviewRequired: true },
  ])("blocks sendable email while contact resolution is pending", (contact) => {
    expect(deriveOpportunityHandoffState({
      engagementChannel: "EMAIL",
      manualActionState: null,
      draftStatus: null,
      draftVersionSource: null,
      ...contact,
    })).toEqual({
      engagementPathState: "CONTACT_PENDING",
      primaryNextAction: {
        kind: "RESOLVE_CONTACT_OR_PATH",
        enabled: false,
        blockerCode: "CONTACT_OR_PATH_REQUIRED",
      },
    });
  });

  it.each([
    {
      draftStatus: "generating" as const,
      draftVersionSource: null,
      expected: {
        kind: "WAIT_FOR_DRAFT",
        enabled: false,
        blockerCode: "DRAFT_GENERATING",
      },
    },
    {
      draftStatus: "draft" as const,
      draftVersionSource: "TEMPLATE_FALLBACK" as const,
      expected: {
        kind: "EDIT_DRAFT",
        enabled: true,
        blockerCode: null,
      },
    },
    {
      draftStatus: "draft" as const,
      draftVersionSource: "MODEL" as const,
      expected: {
        kind: "REVIEW_DRAFT",
        enabled: true,
        blockerCode: null,
      },
    },
    {
      draftStatus: "approved" as const,
      draftVersionSource: "MANUAL" as const,
      expected: {
        kind: "REVIEW_SEND_READINESS",
        enabled: true,
        blockerCode: null,
      },
    },
    {
      draftStatus: "sent" as const,
      draftVersionSource: "MANUAL" as const,
      expected: {
        kind: "VIEW_MAIL_STATUS",
        enabled: true,
        blockerCode: null,
      },
    },
  ])("derives a read-only action from the current Draft stage", ({
    draftStatus,
    draftVersionSource,
    expected,
  }) => {
    expect(deriveOpportunityHandoffState({
      engagementChannel: "EMAIL",
      contactEmail: "editor@example.com",
      contactReviewRequired: false,
      manualActionState: null,
      draftStatus,
      draftVersionSource,
    }).primaryNextAction).toEqual(expected);
  });
});
