import { describe, expect, it } from "vitest";

import {
  createContactEnrichmentCommands,
  ensureReadyContactEnrichmentJobs,
  queueHistoricalContactEnrichmentJobs,
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
      [],
      [
        {
          recommendationId,
          prospectId,
          recommendationContextVersionId: contextVersionId,
          hostname: "publisher.example",
        },
      ],
      [{ id: jobId }],
      [
        {
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
        },
      ],
      [{ id: "018f0000-0000-7000-8000-000000000009" }],
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
    expect(calls[0]?.text).toContain("attempt_count>=max_attempts");
    expect(calls[1]?.text).toContain("attempt_count<max_attempts");
    expect(calls[1]?.text).not.toContain("max_attempts=LEAST");
    expect(calls[2]?.text).toContain("event.status='published'");
    expect(calls[2]?.text).toContain("status='retry_scheduled'");
    expect(calls[2]?.text).toContain("retry_after=now()");
    expect(calls[3]?.text).toContain("stale_context");
    expect(calls[9]?.text).toContain("$2::uuid");
    expect(calls[9]?.text).toContain("$2::uuid::text");
    expect(calls[9]?.text).toContain("$6::uuid::text");
    expect(calls[9]?.text).toContain("RETURNING id");
    expect(calls[9]?.values?.slice(1, 7)).toEqual([
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
    expect(calls[0]?.text).toContain(
      "inventory.publication_status<>'PUBLISHED'",
    );
    expect(calls[0]?.text).toContain(
      "last_publishable_count=capacity.published_count",
    );
    expect(calls[0]?.text).toContain(
      "RETURNING policy.visible_pool_generation",
    );
    expect(calls[0]?.text).not.toContain("RETURNING policy.id");
    expect(calls[0]?.text).toContain("version=policy.version+1");
    expect(calls[0]?.text).toContain("JOIN effective_policy AS policy");
    expect(calls[0]?.text).toContain("policy.visible_pool_state='building'");
    expect(calls[0]?.values).toEqual([
      organizationId,
      workspaceId,
      websiteProjectId,
      "local-product-operator",
    ]);
    expect(calls[1]?.text).toContain("browser_allowed=$5");
    expect(calls[1]?.text).toContain("policy.visible_pool_state='building'");
    expect(calls[1]?.values).toEqual([
      organizationId,
      workspaceId,
      websiteProjectId,
      "local-product-operator",
      true,
    ]);
  });

  it("reassesses stored evidence before queueing another crawl", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createContactEnrichmentCommands(
      {
        query: async (text, values) => {
          calls.push({ text, values });
          return {
            rows:
              calls.length === 1
                ? [{ prospectId, recommendationContextVersionId: contextVersionId }]
                : [],
          };
        },
      },
      {
        maxAttempts: 3,
        maxPages: 8,
        maxDepth: 2,
        browserAllowed: false,
      },
    );

    await commands.retryUnpublished({
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

    expect(calls[1]?.text).toContain("FROM backlink_contact_candidates");
    expect(calls.at(-2)?.text).toContain("WITH pool_policy AS MATERIALIZED");
    expect(calls.at(-1)?.text).toContain(
      "UPDATE backlink_contact_enrichment_jobs",
    );
  });

  it("does not queue contact work for already published reassessments", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const result = await queueHistoricalContactEnrichmentJobs(
      {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows: [] };
        },
      },
      {
        scope: { organizationId, workspaceId, websiteProjectId },
        actorId: "local-product-035",
        recommendationIds: [recommendationId],
        options: {
          maxAttempts: 3,
          maxPages: 8,
          maxDepth: 2,
          browserAllowed: false,
        },
      },
    );

    expect(result).toMatchObject({
      eligibleRecommendationCount: 0,
      jobsCreated: 0,
      jobsRetried: 0,
      outboxEventsCreated: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "inventory.publication_status<>'PUBLISHED'",
    );
  });

  it("reuses the existing job and outbox path for expired contact evidence", async () => {
    const batchId = "018f0000-0000-7000-8000-000000000008";
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const responses: readonly Record<string, unknown>[][] = [
      [
        {
          recommendationId,
          prospectId,
          recommendationContextVersionId: contextVersionId,
          hostname: "publisher.example",
          currentContext: true,
          jobId,
          jobStatus: "partially_completed",
          attemptCount: 1,
          maxAttempts: 3,
          batchId,
        },
      ],
      [{ batchId }],
      [],
      [
        {
          id: jobId,
          batchId,
          recommendationId,
          prospectId,
          recommendationContextVersionId: contextVersionId,
          rootUrl: "https://publisher.example/",
          status: "retry_scheduled",
          attemptCount: 1,
          maxAttempts: 3,
          maxPages: 8,
          maxDepth: 2,
          browserAllowed: false,
          browserUsed: false,
          pagesVisited: 0,
          candidateCount: 0,
          evidenceCount: 0,
          lastErrorCode: null,
          terminalReasonCode: null,
          method: "none",
          lastErrorCategory: null,
          retryAfter: "2026-08-11T04:00:00.000Z",
          completedAt: null,
          startedAt: null,
          finishedAt: null,
          version: 2,
        },
      ],
      [{ id: "018f0000-0000-7000-8000-000000000009" }],
    ];

    const result = await queueHistoricalContactEnrichmentJobs(
      {
        query: async (text, values) => {
          calls.push({ text, values });
          return { rows: responses[calls.length - 1] ?? [] };
        },
      },
      {
        scope: { organizationId, workspaceId, websiteProjectId },
        actorId: "local-product-035",
        recommendationIds: [recommendationId, recommendationId],
        options: {
          maxAttempts: 3,
          maxPages: 8,
          maxDepth: 2,
          browserAllowed: false,
        },
      },
    );

    expect(result).toMatchObject({
      eligibleRecommendationCount: 1,
      jobsCreated: 0,
      jobsRetried: 1,
      outboxEventsCreated: 1,
    });
    expect(calls[1]?.text).toContain("status='retry_scheduled'");
    expect(calls[1]?.values?.[4]).toBe(false);
    expect(calls[4]?.values?.[4]).toBe(
      "backlinks.contact-enrichment.requested.v1",
    );
  });
});
