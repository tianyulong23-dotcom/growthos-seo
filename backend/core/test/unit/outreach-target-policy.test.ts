import { describe, expect, it } from "vitest";
import {
  excludedOutreachTarget,
  nonOutreachTargetDomains,
} from "../../src/modules/backlinks/domain/recommendations/outreach-target-policy.js";

describe("outreach target policy", () => {
  it.each(nonOutreachTargetDomains)(
    "blocks root and subdomains of %s",
    (domain) => {
      for (const value of [
        domain,
        `www.${domain}`,
        ` NEWS.${domain.toUpperCase()}. `,
      ]) {
        expect(excludedOutreachTarget(value)).toMatchObject({
          reason: "NON_OUTREACH_TARGET",
          matchedDomain: domain,
          policyVersion: "outreach-target-policy.v2",
        });
      }
    },
  );

  it.each([
    "notamazon.com",
    "amazon.com.publisher.test",
    "apple.com.example",
    "publisher.example",
    "publisher.github.io",
    "androidauthority.com",
    "androidpolice.com",
    "9to5google.com",
    "9to5mac.com",
    "macrumors.com",
    "sammobile.com",
    "aiper.com",
    "android.com.publisher.test",
  ])("does not block unrelated domain %s", (domain) =>
    expect(excludedOutreachTarget(domain)).toBeNull(),
  );
});
