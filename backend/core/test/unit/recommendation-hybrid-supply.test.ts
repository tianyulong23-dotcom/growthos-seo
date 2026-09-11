import { describe, expect, it, vi } from "vitest";
import { ProjectDomainRatingError } from "../../src/modules/backlinks/adapters/ahrefs/project-domain-rating.adapter.js";
import { createRecommendationHybridSupplyService, type RecommendationHybridSupplyFacts } from "../../src/modules/backlinks/application/services/recommendation-hybrid-supply.service.js";
import type { ResourceLibraryMatchInput } from "../../src/modules/backlinks/ports/resource-library.port.js";
import { ResourceLibraryError } from "../../src/modules/backlinks/ports/resource-library.port.js";

const facts: RecommendationHybridSupplyFacts = {
  finalized: false, projectDomain: "aiper.com", language: "en",
  topics: ["pool"], excludedDomains: ["history.com"], admittedCount: 120, dataForSeoCount: 120,
};
function subject() {
  let sequence = 0;
  const getRating = vi.fn(async () => ({ target: "aiper.com", value: 61, provider: "ahrefs" as const, observedAt: "2026-09-10T06:00:00.000Z" }));
  const match = vi.fn(async (input: ResourceLibraryMatchInput) => Array.from({ length: input.limit }, () => ({
    canonicalDomain: `publisher${sequence++}.com`, websiteUrl: "https://publisher.com/", ahrefsDr: 45,
    monthlyTraffic: null, language: "English", categories: ["Home and Family"], categoryMatch: "RELATED" as const,
  })));
  const ingest = vi.fn(async (artifact) => ({
    rawCandidateCount: artifact.candidates.length, canonicalCandidateCount: artifact.candidates.length,
    newUniqueCount: artifact.candidates.length, duplicateCount: 0, admittedCount: artifact.candidates.length,
    hardExcludedCount: 0, materializedCount: artifact.candidates.length,
  }));
  return { getRating, match, ingest, service: createRecommendationHybridSupplyService({ getRating, library: { match }, ingest }) };
}
describe("hybrid supply before canonical finalization", () => {
  it.each([
    [0, [100, 100]], [50, [75, 75]], [120, [40, 40]], [199, [1]],
    [200, []], [450, [50]], [1_000, []],
  ])("only matches current deficits for %s DataForSEO candidates", async (dfs, expected) => {
    const s = subject();
    await s.service.prepare({ ...facts, admittedCount: dfs as number, dataForSeoCount: dfs as number });
    expect(s.match.mock.calls.map(([input]) => input.limit)).toEqual(expected);
    if ((expected as number[]).length === 0) expect(s.getRating).not.toHaveBeenCalled();
    else expect(s.getRating).toHaveBeenCalledTimes(1);
  });
  it("does not touch providers or ingestion on finalization replay", async () => {
    const s = subject();
    expect(await s.service.prepare({ ...facts, finalized: true })).toMatchObject({ status: "ALREADY_FINALIZED" });
    expect(s.getRating).not.toHaveBeenCalled();
    expect(s.ingest).not.toHaveBeenCalled();
  });
  it.each([[199, 2], [450, 5]])("reserves the actual deficit batch for %i DFS candidates", async (dfs, ordinal) => {
    const s = subject();
    await s.service.prepare({ ...facts, admittedCount: dfs, dataForSeoCount: dfs });
    expect(s.ingest.mock.calls[0]?.[0].candidates.every((candidate: {
      resourceLibrary: { releaseBatchOrdinal: number };
    }) => candidate.resourceLibrary.releaseBatchOrdinal === ordinal)).toBe(true);
  });
  it("excludes the first selection from the second and ingests zero-cost library evidence", async () => {
    const s = subject();
    await s.service.prepare(facts);
    expect(s.match.mock.calls[1]?.[0].excludedDomains).toHaveLength(41);
    expect(s.ingest).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "CURATED_RESOURCE_LIBRARY", endpoint: null, costMicros: 0, providerTaskIds: [],
      candidates: expect.arrayContaining([expect.objectContaining({ rank: null, traffic: null, resourceLibrary: expect.objectContaining({ ahrefsDr: 45 }) })]),
    }));
  });
  it("does not exceed the shared generation capacity", async () => {
    const s = subject();
    await s.service.prepare({ ...facts, admittedCount: 995 });
    expect(s.match.mock.calls.map(([input]) => input.limit)).toEqual([5]);
  });
  it.each(["rating", "library"])("preserves DFS when %s is blocked", async (failure) => {
    const s = subject();
    if (failure === "rating") s.getRating.mockRejectedValue(new ProjectDomainRatingError("AHREFS_HTTP_401", false));
    else s.match.mockRejectedValue(new ResourceLibraryError("RESOURCE_LIBRARY_UNAVAILABLE"));
    expect(await s.service.prepare(facts)).toMatchObject({ status: "BLOCKED", admittedCount: 0 });
    expect(s.ingest).not.toHaveBeenCalled();
  });
  it("does not call a zero-result library failure exhausted", async () => {
    const s = subject();
    s.match.mockRejectedValue(new ResourceLibraryError("RESOURCE_LIBRARY_UNAVAILABLE"));
    await expect(s.service.prepare({ ...facts, admittedCount: 0, dataForSeoCount: 0 })).rejects.toThrow("RESOURCE_LIBRARY_UNAVAILABLE");
  });
  it("reports genuine empty matching as exhausted", async () => {
    const s = subject();
    s.match.mockResolvedValue([]);
    expect(await s.service.prepare(facts)).toEqual({ status: "EXHAUSTED", admittedCount: 0 });
  });
});
