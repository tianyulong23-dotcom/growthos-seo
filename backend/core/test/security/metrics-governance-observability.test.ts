import { describe, expect, it } from "vitest";

import {
  assertSafeObservabilityAttributes,
  createMetricsGovernanceObservability,
} from "../../src/modules/backlinks/adapters/observability/metrics-governance-observability.js";

describe("BL-AI-176 Metrics/Governance OTel safety", () => {
  it("correlates Job, Workflow, and Provider spans using an attribute allowlist", async () => {
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
      ended: boolean;
    }> = [];
    const metrics: Array<Record<string, unknown>> = [];
    const observability = createMetricsGovernanceObservability({
      tracer: {
        startSpan(name, options) {
          const span = {
            name,
            attributes: { ...options?.attributes },
            ended: false,
          };
          spans.push(span);
          return {
            setStatus: () => undefined,
            end: () => {
              span.ended = true;
            },
          };
        },
      },
      meter: {
        createCounter: () => ({
          add: (_value, attributes) => {
            metrics.push({ ...attributes });
          },
        }),
        createHistogram: () => ({
          record: (_value, attributes) => {
            metrics.push({ ...attributes });
          },
        }),
      },
      nowMilliseconds: (() => {
        const values = [100, 125];
        return () => values.shift() ?? 125;
      })(),
    });

    await observability.traceProviderOperation({
      jobId: "job-176",
      workflowId: "workflow-176",
      providerName: "DataForSEO",
      correlationId: "correlation-176",
      operation: "provider.analysis",
    }, async () => "ok");

    expect(spans).toMatchObject([{
      name: "backlinks.provider.operation",
      attributes: {
        "backlinks.job.id": "job-176",
        "backlinks.workflow.id": "workflow-176",
        "backlinks.provider.name": "DataForSEO",
        "backlinks.correlation.id": "correlation-176",
        "backlinks.operation": "provider.analysis",
      },
      ended: true,
    }]);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "backlinks.provider.name": "DataForSEO",
        "backlinks.outcome": "success",
      }),
    ]));
  });

  it("rejects secrets, tokens, bodies, emails, and provider payload attributes", () => {
    for (const attributes of [{
      "backlinks.token": "secret",
    }, {
      "backlinks.operation": "user@example.com",
    }, {
      "backlinks.provider.payload": "{\"raw\":true}",
    }, {
      "backlinks.body": "message body",
    }]) {
      expect(() => assertSafeObservabilityAttributes(attributes))
        .toThrow(/observability attribute/i);
    }
  });
});
