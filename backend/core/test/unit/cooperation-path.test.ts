import { describe, expect, it } from "vitest";

import {
  allowedManualActionOrigins,
  canTransitionManualAction,
  normalizeCooperationPathUrl,
  parseVerifiedCooperationPath,
} from "../../src/modules/backlinks/domain/opportunities/cooperation-path.js";

describe("cooperation path domain", () => {
  it("accepts only absolute HTTP(S) evidence URLs without credentials", () => {
    expect(normalizeCooperationPathUrl("https://publisher.example/contact"))
      .toBe("https://publisher.example/contact");
    expect(normalizeCooperationPathUrl("/contact")).toBeNull();
    expect(normalizeCooperationPathUrl("ftp://publisher.example/contact"))
      .toBeNull();
    expect(normalizeCooperationPathUrl(
      "https://operator:secret@publisher.example/contact",
    )).toBeNull();
  });

  it("parses a verified non-email path and selects its editable content type", () => {
    expect(parseVerifiedCooperationPath({
      factId: "path-fact-1",
      decision: "verified",
      pathType: "contact_form",
      evidence: { url: "https://publisher.example/contact" },
    })).toMatchObject({
      factId: "path-fact-1",
      pathType: "contact_form",
      pathUrl: "https://publisher.example/contact",
      contentType: "FORM_MESSAGE",
    });

    expect(parseVerifiedCooperationPath({
      factId: "path-fact-2",
      decision: "rejected",
      pathType: "resource_submission",
      evidence: { url: "https://publisher.example/resources" },
    })).toBeNull();
  });

  it("keeps submission behind the explicit in-progress transition", () => {
    expect(canTransitionManualAction("READY_FOR_MANUAL_ACTION", "SUBMITTED"))
      .toBe(false);
    expect(canTransitionManualAction("IN_PROGRESS", "SUBMITTED")).toBe(true);
    expect(allowedManualActionOrigins("SUBMITTED")).toEqual(["IN_PROGRESS"]);
  });
});
