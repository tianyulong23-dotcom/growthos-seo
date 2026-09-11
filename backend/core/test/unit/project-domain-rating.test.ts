import { describe, expect, it, vi } from "vitest";
import { createProjectDomainRatingAdapter, ProjectDomainRatingError } from "../../src/modules/backlinks/adapters/ahrefs/project-domain-rating.adapter.js";
import { createProjectDomainRatingService, type ProjectDomainRatingCache } from "../../src/modules/backlinks/application/services/project-domain-rating.service.js";

const at = new Date("2026-09-10T06:00:00.000Z");
const now = () => at;
const resolveApiKey = async () => "fixture-key";

describe("project-only Ahrefs GET", () => {
  it.each([0, 19.9, 20, 40, 60, 100])("parses DR %s without treating zero as absent", async (value) => {
    const http = vi.fn(async () => Response.json({ domain_rating: { domain_rating: value } }));
    const result = await createProjectDomainRatingAdapter({ resolveApiKey, fetch: http, now }).get("www.aiper.com");
    expect(result).toEqual({ target: "aiper.com", value, provider: "ahrefs", observedAt: at.toISOString() });
    const [url, request] = http.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.ahrefs.com/v3/public/domain-rating-free?target=aiper.com");
    expect(request).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer fixture-key" } });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403, 400])("does not retry HTTP %s or expose its body", async (status) => {
    const http = vi.fn(async () => new Response("secret-provider-body", { status }));
    await expect(createProjectDomainRatingAdapter({ resolveApiKey, fetch: http }).get("aiper.com"))
      .rejects.toMatchObject({ message: `AHREFS_HTTP_${status}`, retryable: false });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])("bounds transient HTTP %s retries", async (status) => {
    const http = vi.fn(async () => new Response(null, { status }));
    const sleep = vi.fn(async () => undefined);
    await expect(createProjectDomainRatingAdapter({ resolveApiKey, fetch: http, sleep }).get("aiper.com"))
      .rejects.toMatchObject({ code: `AHREFS_HTTP_${status}`, retryable: true });
    expect(http).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it("recovers once after a network timeout without exposing transport errors", async () => {
    const http = vi.fn()
      .mockRejectedValueOnce(new Error("credential-in-error"))
      .mockResolvedValueOnce(Response.json({ domain_rating: { domain_rating: 61 } }));
    const result = await createProjectDomainRatingAdapter({ resolveApiKey, fetch: http, sleep: async () => undefined }).get("aiper.com");
    expect(result.value).toBe(61);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { domain_rating: { domain_rating: null } }, { domain_rating: { domain_rating: "61" } }, { domain_rating: { domain_rating: 101 } }])(
    "rejects invalid successful payload %j", async (body) => {
      const http = vi.fn(async () => Response.json(body));
      await expect(createProjectDomainRatingAdapter({ resolveApiKey, fetch: http }).get("aiper.com"))
        .rejects.toMatchObject({ code: "AHREFS_RESPONSE_INVALID" });
      expect(http).toHaveBeenCalledTimes(1);
    },
  );

  it("does not send a request when secret resolution fails", async () => {
    const http = vi.fn();
    await expect(createProjectDomainRatingAdapter({
      fetch: http, resolveApiKey: async () => { throw new Error("private-key"); },
    }).get("aiper.com")).rejects.toMatchObject({ message: "AHREFS_CREDENTIAL_UNAVAILABLE" });
    expect(http).not.toHaveBeenCalled();
  });
  it("does not retry malformed JSON or include it in errors", async () => {
    const http = vi.fn(async () => new Response("private-invalid-json"));
    await expect(createProjectDomainRatingAdapter({ fetch: http, resolveApiKey }).get("aiper.com"))
      .rejects.toMatchObject({ message: "AHREFS_RESPONSE_INVALID", retryable: false });
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe("project domain rating cache", () => {
  function cache(initial: ProjectDomainRatingCache | null = null) {
    let row = initial;
    const get = vi.fn(async (target: string) => ({ target, value: 0, provider: "ahrefs" as const, observedAt: at.toISOString() }));
    const save = vi.fn(async (value: ProjectDomainRatingCache) => { row = value; });
    const service = createProjectDomainRatingService({ now, get, save, read: async () => row });
    return { service, get, save };
  }
  it("persists 30 days and reuses DR zero on repeated calls", async () => {
    const subject = cache();
    await subject.service.get("aiper.com");
    expect((await subject.service.get("aiper.com")).value).toBe(0);
    expect(subject.get).toHaveBeenCalledTimes(1);
    expect(subject.save).toHaveBeenCalledWith(expect.objectContaining({ value: 0, expiresAt: "2026-10-10T06:00:00.000Z" }));
  });
  it.each(["2026-09-09T06:00:00.000Z", "2026-09-10T06:00:00.000Z"])("refreshes expired entry at %s", async (expiresAt) => {
    const subject = cache({ target: "aiper.com", value: 50, observedAt: "2026-08-01T06:00:00.000Z", expiresAt, failureCode: null });
    await subject.service.get("aiper.com");
    expect(subject.get).toHaveBeenCalledTimes(1);
  });
  it("never reuses another target cache", async () => {
    const subject = cache({ target: "other.com", value: 50, observedAt: at.toISOString(), expiresAt: "2026-10-10T06:00:00.000Z", failureCode: null });
    await subject.service.get("aiper.com");
    expect(subject.get).toHaveBeenCalledWith("aiper.com");
  });
  it("caches an auth failure briefly instead of repeated GETs on retries", async () => {
    const subject = cache();
    subject.get.mockRejectedValue(new ProjectDomainRatingError("AHREFS_HTTP_401", false));
    await expect(subject.service.get("aiper.com")).rejects.toThrow("AHREFS_HTTP_401");
    await expect(subject.service.get("aiper.com")).rejects.toThrow("AHREFS_HTTP_401");
    expect(subject.get).toHaveBeenCalledTimes(1);
    expect(subject.save).toHaveBeenCalledWith(expect.objectContaining({ value: null, expiresAt: "2026-09-10T06:10:00.000Z" }));
  });
});
