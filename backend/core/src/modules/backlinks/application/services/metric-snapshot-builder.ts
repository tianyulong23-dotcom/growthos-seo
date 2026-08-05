import type {
  BacklinkMetricDefinition,
  BacklinkMetricKey,
} from "../../domain/metrics/definitions.js";
import {
  metricSha256,
} from "./metric-canonical.js";

export type MetricProjectScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type ImmutableMetricFact = Readonly<{
  factId: string;
  sourceName: string;
  eventType?: string;
  contractVersion: string;
  occurredAt: Date;
  payload: Readonly<Record<string, unknown>>;
}>;

export type MetricSnapshot = MetricProjectScope & Readonly<{
  id: string;
  metricKey: BacklinkMetricKey;
  metricDefinitionVersion: string;
  snapshotVersion: number;
  windowStart: Date;
  windowEnd: Date;
  asOf: Date;
  workspaceTimezone: string;
  dimensions: Readonly<Record<string, string>>;
  dimensionHash: string;
  numerator: number;
  denominator: number | null;
  value: number | null;
  sourceStartedAt: Date | null;
  sourceEndedAt: Date | null;
  sourceFactCount: number;
  sourceFactIds: readonly string[];
  sourceWatermarkAt: Date | null;
  sourceWatermarkId: string | null;
  inputChecksum: string;
  resultChecksum: string;
  computedAt: Date;
  createdBy: string;
}>;

export type MetricSnapshotIdentity = MetricProjectScope & Readonly<{
  metricKey: BacklinkMetricKey;
  metricDefinitionVersion: string;
  windowStart: Date;
  windowEnd: Date;
  asOf: Date;
  workspaceTimezone: string;
  dimensionHash: string;
}>;

export type MetricSnapshotStore = Readonly<{
  findLatest(identity: MetricSnapshotIdentity): Promise<MetricSnapshot | null>;
  append(snapshot: MetricSnapshot): Promise<void>;
}>;

export type MetricEvaluation = Readonly<{
  numerator: number;
  denominator: number | null;
  value: number | null;
}>;

export type MetricSnapshotBuildInput<
  TFact extends ImmutableMetricFact = ImmutableMetricFact,
> = Readonly<{
  scope: MetricProjectScope;
  definition: BacklinkMetricDefinition;
  window: Readonly<{
    start: Date;
    end: Date;
    asOf: Date;
  }>;
  workspaceTimezone: string;
  dimensions: Readonly<Record<string, string>>;
  facts: readonly TFact[];
  createdBy: string;
}>;

export type MetricSnapshotBuilderDependencies<
  TFact extends ImmutableMetricFact = ImmutableMetricFact,
> = Readonly<{
  store: MetricSnapshotStore;
  evaluate(input: Readonly<{
    definition: BacklinkMetricDefinition;
    facts: readonly TFact[];
    window: MetricSnapshotBuildInput<TFact>["window"];
    workspaceTimezone: string;
    dimensions: Readonly<Record<string, string>>;
  }>): MetricEvaluation;
  newId(): string;
  now(): Date;
}>;

function assertValidDate(name: string, value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
}

function assertIanaTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new TypeError("workspaceTimezone must be an IANA timezone.");
  }
}

function validateInput<TFact extends ImmutableMetricFact>(
  input: MetricSnapshotBuildInput<TFact>,
): void {
  assertValidDate("window.start", input.window.start);
  assertValidDate("window.end", input.window.end);
  assertValidDate("window.asOf", input.window.asOf);
  if (
    input.window.start >= input.window.end
    || input.window.end > input.window.asOf
  ) {
    throw new TypeError("Metric window must satisfy start < end <= asOf.");
  }
  assertIanaTimezone(input.workspaceTimezone);
  if (input.createdBy.trim().length === 0) {
    throw new TypeError("createdBy is required.");
  }

  const allowedDimensions = new Set<string>(
    input.definition.allowedDimensions,
  );
  for (const [key, value] of Object.entries(input.dimensions)) {
    if (!allowedDimensions.has(key)) {
      throw new TypeError(`Metric dimension ${key} is not allowed.`);
    }
    if (value.trim().length === 0) {
      throw new TypeError(`Metric dimension ${key} must not be blank.`);
    }
  }

  const seenFacts = new Set<string>();
  for (const fact of input.facts) {
    if (fact.sourceName === "backlink_placement_candidates") {
      throw new TypeError(
        "Placement Candidate facts cannot contribute to success metrics.",
      );
    }
    if (fact.factId.trim().length === 0 || seenFacts.has(fact.factId)) {
      throw new TypeError("Metric facts require unique non-blank fact IDs.");
    }
    seenFacts.add(fact.factId);
    assertValidDate("fact.occurredAt", fact.occurredAt);
    if (fact.occurredAt > input.window.asOf) {
      throw new TypeError("Metric facts cannot occur after asOf.");
    }
    const declaredSource = input.definition.sources.find((source) =>
      source.name === fact.sourceName
      && source.contractVersion === fact.contractVersion
      && (
        source.eventType === undefined
        || source.eventType === fact.eventType
      )
    );
    if (declaredSource === undefined) {
      throw new TypeError(
        `Metric fact ${fact.factId} is outside the frozen source contract.`,
      );
    }
  }
}

function validateEvaluation(
  definition: BacklinkMetricDefinition,
  evaluation: MetricEvaluation,
): MetricEvaluation {
  if (
    !Number.isFinite(evaluation.numerator)
    || evaluation.numerator < 0
    || (
      evaluation.denominator !== null
      && (
        !Number.isFinite(evaluation.denominator)
        || evaluation.denominator < 0
      )
    )
  ) {
    throw new TypeError("Metric evaluation values must be finite and non-negative.");
  }

  const expectedValue = evaluation.denominator === null
    ? evaluation.numerator
    : evaluation.denominator === 0
      ? null
      : evaluation.numerator / evaluation.denominator;
  if (
    (definition.valueType === "COUNT" && evaluation.denominator !== null)
    || (definition.valueType === "RATE" && evaluation.denominator === null)
    || (
      expectedValue === null
        ? evaluation.value !== null
        : evaluation.value === null
          || Math.abs(evaluation.value - expectedValue) > 1e-12
    )
  ) {
    throw new TypeError(
      "Metric evaluation does not match the frozen numerator/denominator contract.",
    );
  }
  return {
    numerator: evaluation.numerator,
    denominator: evaluation.denominator,
    value: expectedValue,
  };
}

function sortFacts<TFact extends ImmutableMetricFact>(
  facts: readonly TFact[],
): TFact[] {
  return [...facts].sort((left, right) => {
    const time = left.occurredAt.getTime() - right.occurredAt.getTime();
    return time === 0 ? left.factId.localeCompare(right.factId) : time;
  });
}

export async function buildMetricSnapshot<
  TFact extends ImmutableMetricFact,
>(
  input: MetricSnapshotBuildInput<TFact>,
  dependencies: MetricSnapshotBuilderDependencies<TFact>,
): Promise<
  Readonly<{
    status: "created" | "unchanged";
    snapshot: MetricSnapshot;
  }>
> {
  validateInput(input);
  const facts = sortFacts(input.facts);
  const dimensions = Object.fromEntries(
    Object.entries(input.dimensions)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const dimensionHash = metricSha256(dimensions);
  const identity: MetricSnapshotIdentity = {
    ...input.scope,
    metricKey: input.definition.metricKey,
    metricDefinitionVersion: input.definition.definitionVersion,
    windowStart: input.window.start,
    windowEnd: input.window.end,
    asOf: input.window.asOf,
    workspaceTimezone: input.workspaceTimezone,
    dimensionHash,
  };
  const inputChecksum = metricSha256({
    scope: input.scope,
    metricKey: input.definition.metricKey,
    metricDefinitionVersion: input.definition.definitionVersion,
    window: input.window,
    workspaceTimezone: input.workspaceTimezone,
    dimensions,
    facts: facts.map((fact) => ({
      factId: fact.factId,
      sourceName: fact.sourceName,
      eventType: fact.eventType ?? null,
      contractVersion: fact.contractVersion,
      occurredAt: fact.occurredAt,
      payload: fact.payload,
    })),
  });
  const latest = await dependencies.store.findLatest(identity);
  if (latest?.inputChecksum === inputChecksum) {
    return { status: "unchanged", snapshot: latest };
  }

  const evaluation = validateEvaluation(
    input.definition,
    dependencies.evaluate({
      definition: input.definition,
      facts,
      window: input.window,
      workspaceTimezone: input.workspaceTimezone,
      dimensions,
    }),
  );
  const firstFact = facts[0] ?? null;
  const lastFact = facts.at(-1) ?? null;
  const resultChecksum = metricSha256({
    inputChecksum,
    numerator: evaluation.numerator,
    denominator: evaluation.denominator,
    value: evaluation.value,
    sourceFactIds: facts.map(({ factId }) => factId),
  });
  const snapshot: MetricSnapshot = {
    id: dependencies.newId(),
    ...input.scope,
    metricKey: input.definition.metricKey,
    metricDefinitionVersion: input.definition.definitionVersion,
    snapshotVersion: (latest?.snapshotVersion ?? 0) + 1,
    windowStart: input.window.start,
    windowEnd: input.window.end,
    asOf: input.window.asOf,
    workspaceTimezone: input.workspaceTimezone,
    dimensions,
    dimensionHash,
    ...evaluation,
    sourceStartedAt: firstFact?.occurredAt ?? null,
    sourceEndedAt: lastFact?.occurredAt ?? null,
    sourceFactCount: facts.length,
    sourceFactIds: facts.map(({ factId }) => factId),
    sourceWatermarkAt: lastFact?.occurredAt ?? null,
    sourceWatermarkId: lastFact?.factId ?? null,
    inputChecksum,
    resultChecksum,
    computedAt: dependencies.now(),
    createdBy: input.createdBy,
  };
  await dependencies.store.append(snapshot);
  return { status: "created", snapshot };
}
