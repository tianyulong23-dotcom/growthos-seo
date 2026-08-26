import { describe, expect, it } from "vitest";

import {
  resolveDraftPromotionTarget,
} from "../../src/modules/backlinks/domain/drafts/promotion-target.js";

describe("Draft promotion target resolution", () => {
  it("accepts a requested product page on the project domain", () => {
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "awolvision.com",
      configuredTargetUrls: [
        "https://awolvision.com/products/",
        "https://awolvision.com/",
      ],
      requestedTargetUrl:
        "https://awolvision.com/products/rgb-laser-ust-projector-aetherion-max",
    })).toEqual({
      state: "resolved",
      targetUrl:
        "https://awolvision.com/products/rgb-laser-ust-projector-aetherion-max",
    });
  });

  it("accepts a project subdomain and removes fragments", () => {
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
      requestedTargetUrl: "https://shop.example.com/products/one#details",
    })).toEqual({
      state: "resolved",
      targetUrl: "https://shop.example.com/products/one",
    });
  });

  it("rejects lookalike and unrelated domains", () => {
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
      requestedTargetUrl: "https://example.com.attacker.test/products/one",
    })).toEqual({ state: "outside_project" });
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
      requestedTargetUrl: "https://unrelated.test/products/one",
    })).toEqual({ state: "outside_project" });
  });

  it("rejects invalid protocols, credentials, ports, and missing targets", () => {
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
      requestedTargetUrl: "ftp://example.com/file",
    })).toEqual({ state: "invalid" });
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
      requestedTargetUrl: "https://user:secret@example.com/product",
    })).toEqual({ state: "invalid" });
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
      requestedTargetUrl: "https://example.com:8443/product",
    })).toEqual({ state: "invalid" });
    expect(resolveDraftPromotionTarget({
      canonicalDomain: "example.com",
      configuredTargetUrls: [],
    })).toEqual({ state: "missing" });
  });
});
