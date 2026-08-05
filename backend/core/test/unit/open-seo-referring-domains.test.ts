import { describe, expect, it } from "vitest";

import {
  OpenSeoChargedTaskError,
  parseOpenSeoReferringDomains,
} from "../../src/modules/backlinks/third-party/open-seo/referring-domains.js";

const path = ["v3", "backlinks", "referring_domains", "live"];
const successTask = (overrides: Record<string, unknown> = {}) => ({
  status_code: 20_000,
  status_message: "Ok.",
  path,
  cost: 0.0201,
  result_count: 1,
  result: [{
    items: [{
      type: "backlinks_referring_domain",
      domain: "publisher.example",
      backlinks: 3,
      rank: 72,
      backlinks_spam_score: 4,
      referring_links_countries: { US: 3 },
      upstream_extra: "ignored",
    }],
  }],
  ...overrides,
});
const envelope = (task: Record<string, unknown> = successTask()) => ({
  status_code: 20_000,
  tasks_count: 1,
  tasks: [task],
});
function chargedError(raw: unknown): OpenSeoChargedTaskError {
  try {
    parseOpenSeoReferringDomains(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(OpenSeoChargedTaskError);
    return error as OpenSeoChargedTaskError;
  }
  throw new Error("expected parsing to fail");
}

describe("OpenSEO referring-domain port", () => {
  it("rewrites the approved success mapping vector deterministically", () => {
    const raw = envelope();
    const expected = {
      kind: "success",
      billing: { path, costMicros: 20_100 },
      items: [{
        domain: "publisher.example",
        backlinkCount: 3,
        rank: 72,
        spamScore: 4,
        countryCode: "US",
      }],
    };
    expect(parseOpenSeoReferringDomains(raw)).toEqual(expected);
    expect(parseOpenSeoReferringDomains(raw)).toEqual(expected);
  });

  it.each([undefined, null])(
    "rewrites the upstream empty-items vector for %s",
    (items) => {
      const result = items === undefined ? undefined : [{ items }];
      expect(parseOpenSeoReferringDomains(
        envelope(successTask({ result })),
      )).toMatchObject({ kind: "success", items: [] });
    },
  );

  it("preserves billing metadata on a charged task failure", () => {
    const raw = envelope(successTask({
      status_code: 40_000,
      status_message: "No Search Results",
      cost: 0.05,
      result_count: 0,
      result: undefined,
    }));
    expect(chargedError(raw)).toMatchObject({
      billing: { path, costMicros: 50_000 },
      isInvalidField: false,
    });
  });

  it("treats only the explicit no-results 40501 as empty", () => {
    const noResults = successTask({
      status_code: 40_501,
      status_message: "No Search Results",
      cost: 0,
      result: undefined,
    });
    expect(parseOpenSeoReferringDomains(envelope(noResults))).toEqual({
      kind: "empty",
      billing: { path, costMicros: 0 },
      items: [],
    });

    const invalid = successTask({
      status_code: 40_501,
      status_message: "Invalid Field: 'target'.",
      cost: 0.02,
      data: { target: "not a valid domain" },
      result: undefined,
    });
    expect(chargedError(envelope(invalid))).toMatchObject({
      message: 'Invalid Field: \'target\'. (sent target="not a valid domain")',
      isInvalidField: true,
    });
  });

  it("rejects missing mapped fields and invalid provider costs", () => {
    expect(() => parseOpenSeoReferringDomains(envelope(successTask({
      result: [{ items: [{ domain: "publisher.example" }] }],
    })))).toThrow();
    for (const cost of [-1, Number.MAX_SAFE_INTEGER]) {
      expect(() => parseOpenSeoReferringDomains(
        envelope(successTask({ cost })),
      )).toThrow();
    }
  });

  it("rejects multiple paid tasks instead of selecting one silently", () => {
    expect(() => parseOpenSeoReferringDomains({
      status_code: 20_000,
      tasks_count: 2,
      tasks: [successTask(), successTask()],
    })).toThrow();
  });
});
