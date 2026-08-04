import { describe, expect, it } from "vitest";

import {
  createPlacementRedirectEvidence,
  createPlacementUrlKey,
  placementTargetSiteKeyRuleVersion,
  placementUrlNormalizationVersion,
} from "../../src/modules/backlinks/domain/placements/url-key.js";

describe("placement URL key Gold Set", () => {
  it("normalizes WHATWG URL identity without changing query semantics", () => {
    const rawUrl =
      "HTTPS://BÜCHER.DE.:443/A/../Path/Case?b=2&a=1&a=3#section";

    expect(createPlacementUrlKey(rawUrl)).toEqual({
      rawUrl,
      normalizedUrl:
        "https://xn--bcher-kva.de/Path/Case?b=2&a=1&a=3",
      normalizedUrlHash:
        "5f27743f83296af2779953e68b63bf5bcc05e3739e40cf6b47d68ec81e570777",
      hostnameAscii: "xn--bcher-kva.de",
      targetSiteKey: "xn--bcher-kva.de",
      normalizationVersion: placementUrlNormalizationVersion,
      targetSiteKeyRuleVersion: placementTargetSiteKeyRuleVersion,
    });
  });

  it("keeps the normalized host but collapses www for the target site key", () => {
    const rawUrl =
      "HTTPS://WWW.Example.COM.:443/Page?utm_source=x&id=1#fragment";

    expect(createPlacementUrlKey(rawUrl)).toEqual({
      rawUrl,
      normalizedUrl:
        "https://www.example.com/Page?utm_source=x&id=1",
      normalizedUrlHash:
        "517c703fb76d345864e29127147c9a91622c3bb049b8ce52c6e4982ac215595f",
      hostnameAscii: "www.example.com",
      targetSiteKey: "example.com",
      normalizationVersion: placementUrlNormalizationVersion,
      targetSiteKeyRuleVersion: placementTargetSiteKeyRuleVersion,
    });
  });

  it("deduplicates Unicode and Punycode forms", () => {
    const unicode = createPlacementUrlKey("https://bücher.de/Artikel");
    const punycode = createPlacementUrlKey(
      "https://xn--bcher-kva.de/Artikel",
    );

    expect(unicode.normalizedUrl).toBe(punycode.normalizedUrl);
    expect(unicode.normalizedUrlHash).toBe(punycode.normalizedUrlHash);
    expect(unicode.targetSiteKey).toBe(punycode.targetSiteKey);
  });

  it("uses private suffix boundaries for the target site key", () => {
    const key = createPlacementUrlKey(
      "https://www.author.blogspot.com/Post",
    );

    expect(key.hostnameAscii).toBe("www.author.blogspot.com");
    expect(key.targetSiteKey).toBe("author.blogspot.com");
  });

  it("preserves non-default ports, path case, query order, and tracking parameters", () => {
    const original = createPlacementUrlKey(
      "https://example.com:8443/Article?utm_source=mail&id=1",
    );
    const lowerPath = createPlacementUrlKey(
      "https://example.com:8443/article?utm_source=mail&id=1",
    );
    const reorderedQuery = createPlacementUrlKey(
      "https://example.com:8443/Article?id=1&utm_source=mail",
    );
    const strippedTracking = createPlacementUrlKey(
      "https://example.com:8443/Article?id=1",
    );

    expect(original.normalizedUrl).toBe(
      "https://example.com:8443/Article?utm_source=mail&id=1",
    );
    expect(original.normalizedUrlHash).not.toBe(lowerPath.normalizedUrlHash);
    expect(original.normalizedUrlHash).not.toBe(
      reorderedQuery.normalizedUrlHash,
    );
    expect(original.normalizedUrlHash).not.toBe(
      strippedTracking.normalizedUrlHash,
    );
  });

  it("removes fragments from the strict unique key", () => {
    const first = createPlacementUrlKey(
      "https://example.com/Article?id=1#first",
    );
    const second = createPlacementUrlKey(
      "https://example.com/Article?id=1#second",
    );

    expect(first.normalizedUrl).toBe("https://example.com/Article?id=1");
    expect(second.normalizedUrl).toBe(first.normalizedUrl);
    expect(second.normalizedUrlHash).toBe(first.normalizedUrlHash);
  });

  it("keeps redirect evidence separate from the requested URL identity", () => {
    const evidence = createPlacementRedirectEvidence(
      "https://example.com/Old?ref=1#requested",
      "https://www.example.com/New?ref=1#observed",
    );

    expect(evidence.requested.normalizedUrl).toBe(
      "https://example.com/Old?ref=1",
    );
    expect(evidence.requested.normalizedUrlHash).toBe(
      "9b76d629ca57a9fe4116ec8d72f33699add781b6b489413176a58e4b9c52f832",
    );
    expect(evidence.final.normalizedUrl).toBe(
      "https://www.example.com/New?ref=1",
    );
    expect(evidence.requested.targetSiteKey).toBe("example.com");
    expect(evidence.final.targetSiteKey).toBe("example.com");
    expect(evidence.identityChanged).toBe(true);
  });

  it("does not report an identity change for a fragment-only redirect result", () => {
    const evidence = createPlacementRedirectEvidence(
      "https://example.com/Page#requested",
      "https://example.com/Page#observed",
    );

    expect(evidence.identityChanged).toBe(false);
  });

  it.each([
    "",
    " https://example.com/",
    "https://example.com/ ",
    "ftp://example.com/file",
    "https://user:secret@example.com/",
    "https://example.com..",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://example.test/",
    "https://co.uk/",
  ])("rejects unsupported or ambiguous placement URL identity: %s", (rawUrl) => {
    expect(() => createPlacementUrlKey(rawUrl)).toThrow(TypeError);
  });
});
