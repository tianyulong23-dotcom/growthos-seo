import { describe, expect, it, vi } from "vitest";

import {
  executePlacementStaticMonitorActivity,
} from "../../src/modules/backlinks/application/activities/placement-static-monitor.activity.js";
import {
  SafeFetchError,
  safeFetchFailureCodes,
  type SafeFetchPort,
  type SafeFetchResult,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const encoder = new TextEncoder();
const sourcePageUrl = "https://publisher.example.com/article";
const targetUrl = "https://owner.example.com/guide";

function page(
  body: string,
  status = 200,
): SafeFetchResult {
  return {
    requestedUrl: sourcePageUrl,
    finalUrl: sourcePageUrl,
    status,
    contentType: "text/html; charset=utf-8",
    body: encoder.encode(body),
    redirectChain: [],
    resolvedIps: ["203.0.113.10"],
    fetchedAt: "2026-07-28T09:00:05.000Z",
  };
}

function fetcher(result: SafeFetchResult): SafeFetchPort {
  return { fetch: vi.fn(async () => result) };
}

const input = {
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  sourcePageUrl,
  targetUrl,
  previousSuccessfulObservation: null,
} as const;

describe("BL-AI-152 static Placement monitoring Activity", () => {
  it("records a present target occurrence with immutable static evidence", async () => {
    const safeFetch = fetcher(page(`
      <html>
        <head>
          <link rel="canonical"
            href="https://publisher.example.com/article">
        </head>
        <body>
          <p>
            Read the
            <a href="https://owner.example.com/guide" rel="nofollow">
              owner guide
            </a>.
          </p>
        </body>
      </html>
    `));

    const result = await executePlacementStaticMonitorActivity(
      input,
      safeFetch,
    );

    expect(safeFetch.fetch).toHaveBeenCalledWith({
      url: sourcePageUrl,
      purpose: "placement-check",
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      maxBytes: 2_000_000,
      maxRedirects: 5,
    });
    expect(result).toMatchObject({
      result: "present",
      retryable: false,
      failureCode: null,
      evidenceSnapshot: {
        fetchMode: "safe_fetch_static",
        fetch: {
          status: 200,
          finalUrl: sourcePageUrl,
        },
        page: {
          canonicalUrl: sourcePageUrl,
          noindex: false,
          occurrences: [{
            anchorText: "owner guide",
            nofollow: true,
          }],
        },
        result: {
          status: "present",
          reasonCode: "TARGET_LINK_PRESENT",
        },
      },
    });
    expect(result.evidenceSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("classifies a changed anchor against the last successful evidence", async () => {
    const initial = await executePlacementStaticMonitorActivity(
      input,
      fetcher(page(`
        <html><body>
          <a href="https://owner.example.com/guide">Original anchor</a>
        </body></html>
      `)),
    );

    const changed = await executePlacementStaticMonitorActivity({
      ...input,
      previousSuccessfulObservation: {
        result: "present",
        evidenceFingerprint: initial.evidenceFingerprint,
      },
    }, fetcher(page(`
      <html><body>
        <a href="https://owner.example.com/guide" rel="sponsored">
          Sponsored anchor
        </a>
      </body></html>
    `)));

    expect(changed).toMatchObject({
      result: "changed",
      retryable: false,
      failureCode: null,
      evidenceSnapshot: {
        result: {
          status: "changed",
          reasonCode: "LINK_EVIDENCE_CHANGED",
        },
      },
    });
    expect(changed.evidenceFingerprint).not.toBe(
      initial.evidenceFingerprint,
    );
  });

  it.each([
    {
      name: "missing target link",
      response: page("<html><body>No target link.</body></html>"),
      reasonCode: "TARGET_LINK_ABSENT",
    },
    {
      name: "gone source page",
      response: page("", 410),
      reasonCode: "SOURCE_GONE",
    },
  ])("records absent evidence for $name", async ({
    response,
    reasonCode,
  }) => {
    const result = await executePlacementStaticMonitorActivity(
      input,
      fetcher(response),
    );

    expect(result).toMatchObject({
      result: "absent",
      retryable: false,
      failureCode: null,
      evidenceSnapshot: {
        result: {
          status: "absent",
          reasonCode,
        },
      },
    });
  });

  it("returns retryable inaccessible evidence for HTTP 429", async () => {
    const result = await executePlacementStaticMonitorActivity(
      input,
      fetcher(page("", 429)),
    );

    expect(result).toMatchObject({
      result: "inaccessible",
      retryable: true,
      failureCode: "HTTP_429",
      evidenceSnapshot: {
        result: {
          status: "inaccessible",
          reasonCode: "HTTP_429",
        },
      },
    });
  });

  it("returns retryable inaccessible evidence for a SafeFetch timeout", async () => {
    const safeFetch: SafeFetchPort = {
      fetch: vi.fn(async () => {
        throw new SafeFetchError({
          code: safeFetchFailureCodes.timeout,
          requestedUrl: sourcePageUrl,
          message: "publisher timed out",
          retryable: true,
        });
      }),
    };

    const result = await executePlacementStaticMonitorActivity(
      input,
      safeFetch,
    );

    expect(result).toMatchObject({
      result: "inaccessible",
      retryable: true,
      failureCode: safeFetchFailureCodes.timeout,
      evidenceSnapshot: {
        fetch: null,
        page: null,
        result: {
          status: "inaccessible",
          reasonCode: safeFetchFailureCodes.timeout,
        },
      },
    });
  });
});
