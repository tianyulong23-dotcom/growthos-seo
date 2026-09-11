import { describe, expect, it, vi } from "vitest";

import {
  inspectContactHtml,
  lockContactBatchCompletion,
  createContactEnrichmentActivity,
} from "../../src/modules/backlinks/activities/contact-enrichment.activity.js";
import { SafeFetchAdapter } from "../../src/modules/backlinks/adapters/http/safe-fetch.adapter.js";
import { ContactDiscoveryService } from "../../src/modules/backlinks/application/services/contact-discovery.service.js";
import { parseContactPage } from "../../src/modules/backlinks/adapters/html/contact-parser.adapter.js";

describe("contact enrichment page signals", () => {
  it.each([true, false])("follows rendered contact links only when authorized (%s)", async (authorized) => {
    const page = (url: string, html: string, status = 200) => ({
      requestedUrl: url, finalUrl: url, status, contentType: "text/html",
      body: new TextEncoder().encode(html), redirectChain: [], resolvedIps: [],
      fetchedAt: new Date().toISOString(),
    });
    const fetch = vi.spyOn(SafeFetchAdapter.prototype, "fetch")
      .mockImplementation(async request => page(request.url, "", 403));
    const persisted: string[] = [];
    const discover = vi.spyOn(ContactDiscoveryService.prototype, "discoverFetched")
      .mockImplementation(async (_input, result) => {
        const emails = parseContactPage(result).candidates.map(candidate => candidate.email);
        persisted.push(...emails);
        return { candidateCount: emails.length, evidenceInserted: emails.length, evidenceMerged: 0 };
      });
    const render = vi.fn(async (input: { url: string }) => page(input.url,
      input.url.endsWith("/contact-team/")
        ? "<a href='mailto:editor@publisher.com'>Editorial</a>"
        : `<nav><a href='/news/'>News</a><a href='/editorials/'>Columns</a>
          <a href='https://outside.example/contact/'>Partner</a>
          <a href='/contact-team/'>Editorial staff</a></nav>`));
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("attempt_count=attempt_count+1") ? [{
        id: "job-1", batchId: "batch-1", rootUrl: "https://publisher.com/",
        prospectId: "prospect-1", recommendationContextVersionId: "context-1",
        registrableDomain: "publisher.com", attemptCount: 1, maxAttempts: 2,
        maxPages: 2, maxDepth: 1, browserAllowed: authorized,
      }] : sql.includes("SELECT blocked") ? [{ blocked: false }] : [],
      rowCount: 1,
    }));
    try {
      const run = createContactEnrichmentActivity({
        pool: { async connect() { return { query, release() {} }; } },
        browserWorker: { render }, fetchTimeoutMs: 1000,
      });
      const result = await run({
        organizationId: "org-1", workspaceId: "workspace-1",
        websiteProjectId: "project-1", jobId: "job-1",
        requestVersion: 1, actorId: "worker",
      });
      if (authorized) {
        expect(render.mock.calls.map(([request]) => request.url)).toEqual([
          "https://publisher.com/", "https://publisher.com/contact-team/",
        ]);
        expect(persisted).toContain("editor@publisher.com");
        expect(result.browserUsed).toBe(true);
      } else {
        expect(render).not.toHaveBeenCalled();
        expect(persisted).toEqual([]);
      }
    } finally {
      fetch.mockRestore();
      discover.mockRestore();
    }
  });

  it("does not classify a normal sign-in navigation link as login-required", () => {
    expect(inspectContactHtml(`
      <body>
        <nav><a href="/account">Sign in</a></nav>
        <main><h1>Public publisher page</h1></main>
      </body>
    `).loginRequired).toBe(false);
  });

  it("classifies an actual login form as login-required", () => {
    expect(inspectContactHtml(`
      <body>
        <form action="/login">
          <input type="email" name="email">
          <input type="password" name="password">
          <button type="submit">Log in</button>
        </form>
      </body>
    `).loginRequired).toBe(true);
  });

  it("does not discard public contact content because a form embeds CAPTCHA", () => {
    expect(inspectContactHtml(`
      <body><a href="mailto:editor@publisher.com">Editorial</a>
      <form><div class="g-recaptcha" data-sitekey="public-key"></div></form>
      <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></body>
    `).challenge).toBe(false);
    expect(inspectContactHtml(
      "<body>Verify you are human to continue</body>",
    ).challenge).toBe(true);
  });

  it("serializes concurrent completion for the same tenant-scoped batch", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await lockContactBatchCompletion(
      { query },
      {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        jobId: "job-1",
        requestVersion: 1,
        actorId: "worker",
      },
      "batch-1",
    );

    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [
        "org-1:workspace-1:project-1:batch-1:"
          + "contact-enrichment-batch-completion",
      ],
    );
  });

  it("persists non-overlapping timing for failed HTTP attempts and final storage", async () => {
    const fetch = vi.spyOn(SafeFetchAdapter.prototype, "fetch")
      .mockRejectedValue(Object.assign(new Error("fixture timeout"), {
        code: "FETCH_TIMEOUT", retryable: true,
      }));
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("attempt_count=attempt_count+1") ? [{
        id: "job-1", batchId: "batch-1", rootUrl: "https://publisher.test/",
        prospectId: "prospect-1", recommendationContextVersionId: "context-1",
        registrableDomain: "publisher.test", attemptCount: 1, maxAttempts: 2,
        maxPages: 1, maxDepth: 1, browserAllowed: false,
      }] : [],
      rowCount: 1,
    }));
    try {
      const run = createContactEnrichmentActivity({
        pool: { async connect() { return { query, release() {} }; } },
        browserWorker: null, fetchTimeoutMs: 1000,
      });
      const result = await run({
        organizationId: "org-1", workspaceId: "workspace-1",
        websiteProjectId: "project-1", jobId: "job-1",
        requestVersion: 1, actorId: "worker",
      });
      expect(result.status).toBe("retry_scheduled");
      const timing = result.timing;
      if (timing === undefined) throw new Error("Missing contact timing");
      expect(Number.isFinite(Date.parse(timing.startedAt))).toBe(true);
      expect(timing.spans.map(span => span.phase)).toEqual(
        expect.arrayContaining([
          "job_claim", "public_http", "robots_policy",
          "page_persistence", "job_completion_persistence",
        ]),
      );
      let previousEnd = 0;
      for (const span of timing.spans) {
        expect(span.startMs).toBeGreaterThanOrEqual(previousEnd);
        expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
        previousEnd = span.endMs;
      }
      expect(timing.durationMs).toBeGreaterThanOrEqual(previousEnd);
      expect(JSON.parse(JSON.stringify(result)).timing).toEqual(timing);
    } finally {
      fetch.mockRestore();
    }
  });
});
