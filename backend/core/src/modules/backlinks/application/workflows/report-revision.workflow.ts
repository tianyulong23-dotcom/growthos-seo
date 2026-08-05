import {
  metricSha256,
} from "../services/metric-canonical.js";
import type {
  MetricProjectScope,
} from "../services/metric-snapshot-builder.js";

export type ReportMetricSnapshot = MetricProjectScope & Readonly<{
  id: string;
  metricKey: string;
  metricDefinitionVersion: string;
  sourceStartedAt: Date;
  sourceEndedAt: Date;
  sourceWatermarkAt: Date;
  sourceWatermarkId: string;
  resultChecksum: string;
  value: number | null;
}>;

export type ReportRevision = MetricProjectScope & Readonly<{
  id: string;
  reportKey: string;
  revision: number;
  inputSnapshotIds: readonly string[];
  metricDefinitionVersions: Readonly<Record<string, string>>;
  querySpec: Readonly<Record<string, unknown>>;
  payload: Readonly<Record<string, unknown>>;
  sourceStartedAt: Date;
  sourceEndedAt: Date;
  sourceWatermarkAt: Date;
  sourceWatermarkId: string;
  inputChecksum: string;
  resultChecksum: string;
  generatedAt: Date;
  createdBy: string;
}>;

export type ReportRevisionStore = Readonly<{
  loadSnapshots(
    scope: MetricProjectScope,
    snapshotIds: readonly string[],
  ): Promise<readonly ReportMetricSnapshot[]>;
  getPublished(
    scope: MetricProjectScope,
    reportKey: string,
  ): Promise<ReportRevision | null>;
  publish(
    revision: ReportRevision,
    expectedPublishedRevision: number | null,
  ): Promise<ReportRevision>;
}>;

export type ReportRevisionGenerator = Readonly<{
  generate(input: Readonly<{
    snapshots: readonly ReportMetricSnapshot[];
    querySpec: Readonly<Record<string, unknown>>;
  }>): Promise<Readonly<Record<string, unknown>>>;
}>;

export type ReportRevisionWorkflowInput = Readonly<{
  scope: MetricProjectScope;
  reportKey: string;
  inputSnapshotIds: readonly string[];
  querySpec: Readonly<Record<string, unknown>>;
  createdBy: string;
}>;

function assertInput(input: ReportRevisionWorkflowInput): string[] {
  if (input.reportKey.trim().length === 0) {
    throw new TypeError("reportKey is required.");
  }
  if (input.createdBy.trim().length === 0) {
    throw new TypeError("createdBy is required.");
  }
  const snapshotIds = [...new Set(
    input.inputSnapshotIds.map((id) => id.trim()),
  )].sort();
  if (
    snapshotIds.length === 0
    || snapshotIds.some((id) => id.length === 0)
    || snapshotIds.length !== input.inputSnapshotIds.length
  ) {
    throw new TypeError(
      "Every Report Revision requires unique input Snapshot IDs.",
    );
  }
  return snapshotIds;
}

function assertSnapshots(
  scope: MetricProjectScope,
  requestedIds: readonly string[],
  snapshots: readonly ReportMetricSnapshot[],
): void {
  const loadedIds = new Set(snapshots.map(({ id }) => id));
  if (
    snapshots.length !== requestedIds.length
    || requestedIds.some((id) => !loadedIds.has(id))
  ) {
    throw new Error("Report input Snapshots are incomplete.");
  }
  for (const snapshot of snapshots) {
    if (
      snapshot.organizationId !== scope.organizationId
      || snapshot.workspaceId !== scope.workspaceId
      || snapshot.websiteProjectId !== scope.websiteProjectId
    ) {
      throw new Error("Report input Snapshot escaped the project scope.");
    }
  }
}

function definitionVersions(
  snapshots: readonly ReportMetricSnapshot[],
): Readonly<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const snapshot of snapshots) {
    const existing = versions[snapshot.metricKey];
    if (
      existing !== undefined
      && existing !== snapshot.metricDefinitionVersion
    ) {
      throw new Error(
        `Report mixes Metric Definition versions for ${snapshot.metricKey}.`,
      );
    }
    versions[snapshot.metricKey] = snapshot.metricDefinitionVersion;
  }
  return Object.fromEntries(
    Object.entries(versions).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
}

function watermark(
  snapshots: readonly ReportMetricSnapshot[],
): ReportMetricSnapshot {
  const latest = [...snapshots].sort((left, right) => {
    const time =
      left.sourceWatermarkAt.getTime() - right.sourceWatermarkAt.getTime();
    return time === 0
      ? left.sourceWatermarkId.localeCompare(right.sourceWatermarkId)
      : time;
  }).at(-1);
  if (latest === undefined) {
    throw new Error("Report requires at least one input Snapshot.");
  }
  return latest;
}

export async function runReportRevisionWorkflow(
  input: ReportRevisionWorkflowInput,
  dependencies: Readonly<{
    store: ReportRevisionStore;
    generator: ReportRevisionGenerator;
    newId(): string;
    now(): Date;
  }>,
): Promise<ReportRevision> {
  const inputSnapshotIds = assertInput(input);
  const snapshots = [...await dependencies.store.loadSnapshots(
    input.scope,
    inputSnapshotIds,
  )].sort((left, right) => left.id.localeCompare(right.id));
  assertSnapshots(input.scope, inputSnapshotIds, snapshots);
  const versions = definitionVersions(snapshots);
  const previous = await dependencies.store.getPublished(
    input.scope,
    input.reportKey,
  );

  // Generation completes before publication, so a failed renderer cannot
  // replace the last usable revision.
  const payload = await dependencies.generator.generate({
    snapshots,
    querySpec: input.querySpec,
  });
  if (
    payload === null
    || Array.isArray(payload)
    || typeof payload !== "object"
  ) {
    throw new TypeError("Report generator must return an object payload.");
  }
  const sourceWatermark = watermark(snapshots);
  const sourceStartedAt = new Date(Math.min(
    ...snapshots.map(({ sourceStartedAt: value }) => value.getTime()),
  ));
  const sourceEndedAt = new Date(Math.max(
    ...snapshots.map(({ sourceEndedAt: value }) => value.getTime()),
  ));
  const inputChecksum = metricSha256({
    reportKey: input.reportKey,
    querySpec: input.querySpec,
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      metricKey: snapshot.metricKey,
      metricDefinitionVersion: snapshot.metricDefinitionVersion,
      resultChecksum: snapshot.resultChecksum,
    })),
  });
  const revision: ReportRevision = {
    id: dependencies.newId(),
    ...input.scope,
    reportKey: input.reportKey,
    revision: (previous?.revision ?? 0) + 1,
    inputSnapshotIds,
    metricDefinitionVersions: versions,
    querySpec: input.querySpec,
    payload,
    sourceStartedAt,
    sourceEndedAt,
    sourceWatermarkAt: sourceWatermark.sourceWatermarkAt,
    sourceWatermarkId: sourceWatermark.sourceWatermarkId,
    inputChecksum,
    resultChecksum: metricSha256({ inputChecksum, payload }),
    generatedAt: dependencies.now(),
    createdBy: input.createdBy,
  };
  return dependencies.store.publish(revision, previous?.revision ?? null);
}
