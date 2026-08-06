import { describe, expect, it } from "vitest";

import {
  createContactEnrichmentCommands,
  ensureReadyContactEnrichmentJobs,
} from "../../src/modules/backlinks/application/commands/contact-enrichment.command.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const organizationId = "018f0000-0000-7000-8000-000000000001";
const workspaceId = "018f0000-0000-7000-8000-000000000002";
const websiteProjectId = "018f0000-0000-7000-8000-000000000003";
const recommendationId = "018f0000-0000-7000-8000-000000000004";
const prospectId = "018f0000-0000-7000-8000-000000000005";
const contextVersionId = "018f0000-0000-7000-8000-000000000006";
const jobId = "018f0000-0000-7000-8000-000000000007";

describe("contact enrichment job command", () => {
  it("uses consistent UUID parameter types in the requested outbox payload", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const responses: readonly Record<string, unknown>[][] = [
      [],
      [],
      [],
      [],
      [],
      [{
        recommendationId,
        prospectId,
        recommendationContextVersionId: contextVersionId,
        hostname: "publisher.example",
      }],
      [{ id: jobId }],
      [{
        id: jobId,
        batchId: "018f0000-0000-7000-8000-000000000008",
        recommendationId,
        prospectId,
        recommendationContextVersionId: contextVersionId,
        rootUrl: "https://publisher.example/",
        status: "pending",
        attemptCount: 0,
        maxAttempts: 3,
        maxPages: 8,
        maxDepth: 2,
        browserAllowed: true,
        browserUsed: false,
        pagesVisited: 0,
        candidateCount: 0,
        evidenceCount: 0,
        lastErrorCode: null,
        terminalReasonCode: null,
        method: "none",
        lastErrorCategory: null,
        retryAfter: null,
        completedAt: null,
        startedAt: null,
        finishedAt: null,
        version: 1,
      }],
      [],
    ];

    const created = await ensureReadyContactEnrichmentJobs(
      {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows: responses[calls.length - 1] ?? [] };
        },
      },
      {
        scope: { organizationId, workspaceId, websiteProjectId },
        actorId: "local-product-operator",
        limit: 1,
        options: {
          maxAttempts: 3,
          maxPages: 8,
          maxDepth: 2,
          browserAllowed: true,
        },
      },
    );

    expect(created).toBe(1);
    expect(calls[2]?.text).toContain("stale_context");
    expect(calls[8]?.text).toContain("$2::uuid");
    expect(calls[8]?.text).toContain("$2::uuid::text");
    expect(calls[8]?.text).toContain("$6::uuid::text");
    expect(calls[8]?.values?.slice(1, 7)).toEqual([
      organizationId,
      workspaceId,
      websiteProjectId,
      "backlinks.contact-enrichment.requested.v1",
      jobId,
      1,
    ]);
  });

  it("applies the current browser capability when retrying unpublished jobs", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createContactEnrichmentCommands(
      {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows: [] };
        },
      },
      {
        maxAttempts: 3,
        maxPages: 8,
        maxDepth: 2,
        browserAllowed: true,
      },
    );

    const result = await commands.retryUnpublished({
      actor: createActorContext({
        userId: "local-product-operator",
        sessionId: "session-1",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "example.com",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-1",
        promotionTargetVersionId: "target-1",
      }),
    });

    expect(result).toEqual({ batchId: null, retriedJobCount: 0 });
    expect(calls[0]?.text).toContain("browser_allowed=$5");
    expect(calls[0]?.values).toEqual([
      organizationId,
      workspaceId,
      websiteProjectId,
      "local-product-operator",
      true,
    ]);
  });
});
