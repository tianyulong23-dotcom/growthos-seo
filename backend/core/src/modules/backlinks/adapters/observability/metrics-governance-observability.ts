import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
} from "@opentelemetry/api";

const allowedKeys = new Set([
  "backlinks.job.id",
  "backlinks.workflow.id",
  "backlinks.provider.name",
  "backlinks.correlation.id",
  "backlinks.operation",
  "backlinks.outcome",
]);
const emailLike = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;

type SafeAttributeValue = string | number | boolean;
type SafeAttributes = Readonly<Record<string, SafeAttributeValue>>;

export function assertSafeObservabilityAttributes(
  attributes: Readonly<Record<string, unknown>>,
): asserts attributes is SafeAttributes {
  for (const [key, value] of Object.entries(attributes)) {
    if (
      !allowedKeys.has(key)
      || !["string", "number", "boolean"].includes(typeof value)
      || (typeof value === "string" && emailLike.test(value))
    ) {
      throw new TypeError(
        `Unsafe observability attribute rejected: ${key}.`,
      );
    }
  }
}

type TracerPort = Readonly<{
  startSpan(
    name: string,
    options?: Readonly<{ attributes?: Attributes }>,
  ): Readonly<{
    setStatus(status: Readonly<{ code: number }>): unknown;
    end(): void;
  }>;
}>;

type MeterPort = Readonly<{
  createCounter(name: string): Readonly<{
    add(value: number, attributes?: Attributes): void;
  }>;
  createHistogram(name: string): Readonly<{
    record(value: number, attributes?: Attributes): void;
  }>;
}>;

export function createMetricsGovernanceObservability(
  options: Readonly<{
    tracer?: TracerPort;
    meter?: MeterPort;
    nowMilliseconds?: () => number;
  }> = {},
) {
  const tracer = options.tracer ?? trace.getTracer(
    "growthos.backlinks.metrics-governance",
  );
  const meter = options.meter ?? metrics.getMeter(
    "growthos.backlinks.metrics-governance",
  );
  const operationCount = meter.createCounter(
    "backlinks_governance_operations_total",
  );
  const operationDuration = meter.createHistogram(
    "backlinks_governance_operation_duration_ms",
  );
  const now = options.nowMilliseconds ?? Date.now;

  return {
    async traceProviderOperation<T>(
      input: Readonly<{
        jobId: string;
        workflowId: string;
        providerName: string;
        correlationId: string;
        operation: string;
      }>,
      operation: () => Promise<T>,
    ): Promise<T> {
      const attributes = {
        "backlinks.job.id": input.jobId,
        "backlinks.workflow.id": input.workflowId,
        "backlinks.provider.name": input.providerName,
        "backlinks.correlation.id": input.correlationId,
        "backlinks.operation": input.operation,
      };
      assertSafeObservabilityAttributes(attributes);
      const span = tracer.startSpan("backlinks.provider.operation", {
        attributes,
      });
      const startedAt = now();
      try {
        const result = await operation();
        const successAttributes = {
          ...attributes,
          "backlinks.outcome": "success",
        };
        assertSafeObservabilityAttributes(successAttributes);
        operationCount.add(1, successAttributes);
        operationDuration.record(now() - startedAt, successAttributes);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const failureAttributes = {
          ...attributes,
          "backlinks.outcome": "failure",
        };
        assertSafeObservabilityAttributes(failureAttributes);
        operationCount.add(1, failureAttributes);
        operationDuration.record(now() - startedAt, failureAttributes);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  };
}
