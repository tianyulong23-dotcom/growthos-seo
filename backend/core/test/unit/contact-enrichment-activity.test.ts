import { describe, expect, it, vi } from "vitest";

import {
  inspectContactHtml,
  lockContactBatchCompletion,
} from "../../src/modules/backlinks/activities/contact-enrichment.activity.js";

describe("contact enrichment page signals", () => {
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
});
