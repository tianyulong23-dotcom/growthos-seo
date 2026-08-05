import { describe, expect, it } from "vitest";

import {
  createRecommendationDomainKey,
  recommendationDomainNormalizationVersion,
} from "../../src/modules/backlinks/domain/recommendations/domain-key.js";

const expected = (hostnameAscii: string, registrableDomain: string) => ({
  hostnameAscii,
  registrableDomain,
  normalizationVersion: recommendationDomainNormalizationVersion,
});

describe("recommendation domain key", () => {
  it.each([
    "example.com",
    "Example.COM",
    "http://example.com",
    "https://www.example.com/",
    "https://WWW.EXAMPLE.COM/path?source=test#fragment",
    "example.com.",
  ])("deduplicates protocol, case, www, path, and trailing dot: %s", (input) => {
    expect(createRecommendationDomainKey(input)).toEqual(
      expected("example.com", "example.com"),
    );
  });

  it("deduplicates Unicode and Punycode IDN forms", () => {
    const unicode = createRecommendationDomainKey("https://www.bücher.de/");
    const punycode = createRecommendationDomainKey("xn--bcher-kva.de");
    expect(unicode).toEqual(expected("xn--bcher-kva.de", "xn--bcher-kva.de"));
    expect(punycode).toEqual(unicode);
  });

  it("removes only the exact leftmost www alias", () => {
    expect(createRecommendationDomainKey("www.blog.example.com")).toEqual(
      expected("blog.example.com", "example.com"),
    );
    expect(createRecommendationDomainKey("www2.example.com")).toEqual(
      expected("www2.example.com", "example.com"),
    );
    expect(createRecommendationDomainKey("blog.example.com")).not.toEqual(
      createRecommendationDomainKey("example.com"),
    );
  });

  it("uses private suffix boundaries without collapsing tenant sites", () => {
    expect(createRecommendationDomainKey("www.author.blogspot.com")).toEqual(
      expected("author.blogspot.com", "author.blogspot.com"),
    );
  });

  it("handles multi-label public suffixes and keeps cross-domain keys apart", () => {
    expect(createRecommendationDomainKey("news.example.co.uk")).toEqual(
      expected("news.example.co.uk", "example.co.uk"),
    );
    expect(createRecommendationDomainKey("example.net")).not.toEqual(
      createRecommendationDomainKey("example.com"),
    );
  });

  it.each([
    "",
    "localhost",
    "127.0.0.1",
    "[::1]",
    "example.test",
    "example.invalid",
    "co.uk",
  ])("rejects non-public recommendation domains: %s", (input) => {
    expect(() => createRecommendationDomainKey(input)).toThrow(TypeError);
  });

  it.each([
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com:8443",
    "https://example.com..",
  ])("rejects ambiguous URL identity: %s", (input) => {
    expect(() => createRecommendationDomainKey(input)).toThrow(TypeError);
  });
});
