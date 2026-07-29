import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapDataForSeoBacklinkSnapshot } from "../../src/modules/backlinks/adapters/dataforseo/mapper.js";
type FixtureEnvelope = {
  cost: number;
  tasks_count: number;
  tasks: [
    {
      result_count: number;
      result: [
        {
          items_count: number;
          items: Array<Record<string, unknown>>;
        },
      ];
    },
  ];
};
const readFixture = (): FixtureEnvelope =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/dataforseo-referring-domains-success.json", import.meta.url),
      "utf8",
    ),
  ) as FixtureEnvelope;
const mapFixture = (raw: unknown) =>
  mapDataForSeoBacklinkSnapshot({
    raw,
    requestedAt: "2026-07-22T08:00:00.000Z",
    completedAt: "2026-07-22T08:00:01.000Z",
  });
describe("DataForSEO envelope mapper", () => {
  it("maps a provider envelope to the owned Core snapshot", () => {
    const snapshot = mapFixture(readFixture());
    expect(snapshot).toEqual({
      provider: "dataforseo",
      schemaVersion: "dataforseo.backlinks-referring-domains.v1",
      requestedAt: "2026-07-22T08:00:00.000Z",
      completedAt: "2026-07-22T08:00:01.000Z",
      costMicros: 20_100,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      referringDomains: [
        {
          domain: "publisher.example",
          backlinkCount: 3,
          rank: 72,
          spamScore: 4,
          countryCode: "US",
        },
        {
          domain: "news.example",
          backlinkCount: 1,
          rank: 41,
          spamScore: null,
          countryCode: null,
        },
      ],
    });
    expect(Object.keys(snapshot)).not.toContain("status_code");
    expect(Object.keys(snapshot.referringDomains[0] ?? {})).not.toContain(
      "backlinks_spam_score",
    );
  });
  it("rejects a dirty item instead of coercing vendor fields", () => {
    const raw = readFixture();
    const firstItem = raw.tasks[0].result[0].items[0];
    if (firstItem === undefined) {
      throw new Error("Fixture must contain a referring-domain item");
    }
    firstItem.backlinks = "3";
    expect(() => mapFixture(raw)).toThrow();
  });
  it("rejects inconsistent envelope and result counts", () => {
    const raw = readFixture();
    raw.tasks_count = 2;
    raw.tasks[0].result_count = 2;
    raw.tasks[0].result[0].items_count = 3;
    expect(() => mapFixture(raw)).toThrow();
  });
  it("rejects unsafe provider cost before producing a snapshot", () => {
    const raw = readFixture();
    raw.cost = Number.MAX_SAFE_INTEGER;
    expect(() => mapFixture(raw)).toThrow();
  });
});
