import { describe, expect, it, vi } from "vitest";

import {
  runPlacementInitialValidationWorkflow,
  type PlacementInitialValidationWorkflowInput,
} from "../../src/modules/backlinks/application/workflows/placement-initial-validation.workflow.js";
import type {
  PlacementInitialValidationRepository,
  PlacementValidationCandidate,
  PlacementValidationResultStatus,
} from "../../src/modules/backlinks/application/repositories/placement-validation.repository.js";
import {
  SafeFetchError,
  safeFetchFailureCodes,
  type SafeFetchPort,
  type SafeFetchResult,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const encoder = new TextEncoder();
const input: PlacementInitialValidationWorkflowInput = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  candidateId: "candidate-1",
  validationRunId: "validation-1",
  placementId: "placement-1",
  monitoringOutboxEventId: "outbox-1",
  placementLifecycleEventId: "placement-lifecycle-1",
  auditEventId: "audit-1",
  actorId: "validator-1",
  recordedAt: new Date("2026-07-27T10:00:01.000Z"),
};
const candidate: PlacementValidationCandidate = {
  candidateId: input.candidateId,
  opportunityId: "opportunity-1",
  sourceType: "crawler_discovery",
  sourcePageUrl: "https://publisher.example.net/story",
  normalizedSourceUrl: "https://publisher.example.net/story",
  normalizedSourceUrlHash: "a".repeat(64),
  targetUrl: "https://client.example.com/guide",
  normalizedTargetUrl: "https://client.example.com/guide",
  normalizedTargetUrlHash: "b".repeat(64),
  urlNormalizationVersion: "whatwg-url-tldts-7.4.9-sha256-v1",
  version: 1,
};

function page(
  body: string,
  status = 200,
): SafeFetchResult {
  return {
    requestedUrl: candidate.sourcePageUrl,
    finalUrl: candidate.sourcePageUrl,
    status,
    contentType: "text/html; charset=utf-8",
    body: encoder.encode(body),
    redirectChain: [],
    resolvedIps: ["203.0.113.10"],
    fetchedAt: "2026-07-27T10:00:00.000Z",
  };
}

function repository(
  initialState: Awaited<
    ReturnType<PlacementInitialValidationRepository["getCandidate"]>
  > = { state: "ready", candidate },
) {
  const recorded: Array<Parameters<
    PlacementInitialValidationRepository["record"]
  >[0]> = [];
  const value: PlacementInitialValidationRepository = {
    getCandidate: vi.fn(async () => initialState),
    record: vi.fn(async (recordInput) => {
      recorded.push(recordInput);
      return {
        state: "recorded",
        candidateId: recordInput.candidateId,
        validationRunId: recordInput.validationRunId,
        status: recordInput.status,
        placementId: recordInput.status === "VALID"
          ? recordInput.placementId
          : null,
        monitoringOutboxEventId: recordInput.status === "VALID"
          ? recordInput.monitoringOutboxEventId
          : null,
      };
    }),
  };
  return { value, recorded };
}

function safeFetch(result: SafeFetchResult): SafeFetchPort {
  return { fetch: vi.fn(async () => result) };
}

describe("BL-AI-148 initial Placement validation Workflow", () => {
  it("confirms a Placement only after static evidence proves the target link", async () => {
    const store = repository();
    const fetcher = safeFetch(page(`
      <html>
        <head>
          <link rel="canonical"
            href="https://publisher.example.net/story">
        </head>
        <body>
          <p>Read the
            <a href="https://client.example.com/guide" rel="nofollow">
              client guide
            </a>.
          </p>
        </body>
      </html>
    `));

    const result = await runPlacementInitialValidationWorkflow(
      input,
      store.value,
      fetcher,
    );

    expect(fetcher.fetch).toHaveBeenCalledWith({
      url: candidate.sourcePageUrl,
      purpose: "placement-check",
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      maxBytes: 2_000_000,
      maxRedirects: 5,
    });
    expect(result).toEqual({
      outcome: "confirmed",
      candidateId: input.candidateId,
      validationRunId: input.validationRunId,
      status: "VALID",
      placementId: input.placementId,
      monitoringOutboxEventId: input.monitoringOutboxEventId,
    });
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toMatchObject({
      status: "VALID",
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: {
          status: "VALID",
          reasonCode: "TARGET_LINK_FOUND",
        },
        page: {
          canonicalUrl: candidate.sourcePageUrl,
          noindex: false,
          occurrences: [{
            anchorText: "client guide",
            nofollow: true,
          }],
        },
      },
    });
    expect(store.recorded[0]?.evidenceSnapshotHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it.each([
    {
      name: "missing target link",
      response: page("<html><body>No placement here.</body></html>"),
      expected: "TARGET_LINK_MISSING",
    },
    {
      name: "source noindex",
      response: page(`
        <html>
          <head><meta name="robots" content="noindex, follow"></head>
          <body>
            <a href="https://client.example.com/guide">client guide</a>
          </body>
        </html>
      `),
      expected: "SOURCE_NOINDEX",
    },
    {
      name: "gone source page",
      response: page("", 410),
      expected: "SOURCE_GONE",
    },
  ])("retains the Candidate and evidence for $name", async ({
    response,
    expected,
  }) => {
    const store = repository();

    const result = await runPlacementInitialValidationWorkflow(
      input,
      store.value,
      safeFetch(response),
    );

    expect(result).toMatchObject({
      outcome: "review_required",
      status: "INVALID",
      placementId: null,
      monitoringOutboxEventId: null,
    });
    expect(store.recorded[0]).toMatchObject({
      status: "INVALID",
      evidenceSnapshot: {
        result: { status: "INVALID", reasonCode: expected },
      },
    });
  });

  it("records SafeFetch failures as inconclusive evidence instead of confirming", async () => {
    const store = repository();
    const fetcher: SafeFetchPort = {
      fetch: vi.fn(async () => {
        throw new SafeFetchError({
          code: safeFetchFailureCodes.timeout,
          requestedUrl: candidate.sourcePageUrl,
          message: "publisher timed out",
          retryable: true,
        });
      }),
    };

    const result = await runPlacementInitialValidationWorkflow(
      input,
      store.value,
      fetcher,
    );

    expect(result).toMatchObject({
      outcome: "review_required",
      status: "INCONCLUSIVE",
      placementId: null,
    });
    expect(store.recorded[0]).toMatchObject({
      status: "INCONCLUSIVE",
      evidenceSnapshot: {
        failure: {
          code: safeFetchFailureCodes.timeout,
          retryable: true,
        },
        result: {
          status: "INCONCLUSIVE",
          reasonCode: safeFetchFailureCodes.timeout,
        },
      },
    });
  });

  it("replays an existing validation without fetching or creating another fact", async () => {
    const store = repository({
      state: "already_validated",
      candidateId: input.candidateId,
      validationRunId: input.validationRunId,
      status: "VALID" as PlacementValidationResultStatus,
      placementId: input.placementId,
      monitoringOutboxEventId: input.monitoringOutboxEventId,
    });
    const fetcher = safeFetch(page(""));

    const result = await runPlacementInitialValidationWorkflow(
      input,
      store.value,
      fetcher,
    );

    expect(result).toMatchObject({
      outcome: "already_validated",
      status: "VALID",
      placementId: input.placementId,
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(store.recorded).toHaveLength(0);
  });

  it("does not fetch an unmatched or otherwise ineligible Candidate", async () => {
    const store = repository({
      state: "not_ready",
      candidateId: input.candidateId,
      candidateStatus: "PENDING_MATCH",
      matchStatus: "UNMATCHED",
      validationStatus: "PENDING",
    });
    const fetcher = safeFetch(page(""));

    const result = await runPlacementInitialValidationWorkflow(
      input,
      store.value,
      fetcher,
    );

    expect(result).toEqual({
      outcome: "not_ready",
      candidateId: input.candidateId,
      candidateStatus: "PENDING_MATCH",
      matchStatus: "UNMATCHED",
      validationStatus: "PENDING",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(store.recorded).toHaveLength(0);
  });
});
