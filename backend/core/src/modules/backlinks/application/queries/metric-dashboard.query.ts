import type {
  BacklinkMetricKey,
} from "../../domain/metrics/definitions.js";
import type {
  MetricProjectScope,
} from "../services/metric-snapshot-builder.js";

export type MetricDashboardPoint = Readonly<{
  snapshotId: string;
  snapshotVersion: number;
  windowStart: Date;
  windowEnd: Date;
  asOf: Date;
  dimensions: Readonly<Record<string, string>>;
  numerator: number;
  denominator: number | null;
  value: number | null;
}>;

export type MetricDashboardSummary = MetricDashboardPoint & Readonly<{
  metricKey: BacklinkMetricKey;
  metricDefinitionVersion: string;
}>;

export type MetricDashboardTrend = Readonly<{
  metricKey: BacklinkMetricKey;
  metricDefinitionVersion: string;
  points: readonly MetricDashboardPoint[];
}>;

export type MetricDashboard = Readonly<{
  timezone: string;
  from: Date;
  to: Date;
  asOf: Date;
  summary: readonly MetricDashboardSummary[];
  trends: readonly MetricDashboardTrend[];
}>;

export type MetricDashboardQueryInput = Readonly<{
  scope: MetricProjectScope;
  from: Date;
  to: Date;
  asOf: Date;
  timezone: string;
}>;

export type MetricDashboardQuery = Readonly<{
  getDashboard(input: MetricDashboardQueryInput): Promise<MetricDashboard>;
}>;

export type MetricDashboardQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

function requiredDate(name: string, value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Metric dashboard ${name} is invalid.`);
  }
  return date;
}

function requiredNumber(name: string, value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Metric dashboard ${name} is invalid.`);
  }
  return number;
}

function nullableNumber(name: string, value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : requiredNumber(name, value);
}

function dimensions(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Metric dashboard dimensions are invalid.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    throw new Error("Metric dashboard dimensions must contain strings.");
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function assertQuery(input: MetricDashboardQueryInput): void {
  if (
    !Number.isFinite(input.from.getTime())
    || !Number.isFinite(input.to.getTime())
    || !Number.isFinite(input.asOf.getTime())
    || input.from >= input.to
    || input.to > input.asOf
  ) {
    throw new TypeError("Dashboard window must satisfy from < to <= asOf.");
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: input.timezone,
    }).format(0);
  } catch {
    throw new TypeError("Dashboard timezone must be an IANA timezone.");
  }
}

export function createMetricDashboardQuery(
  client: MetricDashboardQueryClient,
): MetricDashboardQuery {
  return {
    async getDashboard(input) {
      assertQuery(input);
      const result = await client.query(
        `
          WITH ranked AS (
            SELECT id AS "snapshotId",
              snapshot_version AS "snapshotVersion",
              metric_key AS "metricKey",
              metric_definition_version AS "metricDefinitionVersion",
              window_start AS "windowStart",
              window_end AS "windowEnd",
              as_of AS "asOf",
              dimensions,
              dimension_hash AS "dimensionHash",
              numerator, denominator, value_numeric AS value,
              row_number() OVER (
                PARTITION BY metric_key, metric_definition_version,
                  window_start, window_end, as_of, dimension_hash
                ORDER BY snapshot_version DESC
              ) AS rank
            FROM backlink_metric_snapshots
            WHERE organization_id=$1
              AND workspace_id=$2
              AND website_project_id=$3
              AND workspace_timezone=$4
              AND window_start >= $5
              AND window_end <= $6
              AND as_of <= $7
          )
          SELECT * FROM ranked
          WHERE rank=1
          ORDER BY "metricKey", "metricDefinitionVersion", "dimensionHash",
            "windowStart", "windowEnd", "asOf"
        `,
        [
          input.scope.organizationId,
          input.scope.workspaceId,
          input.scope.websiteProjectId,
          input.timezone,
          input.from,
          input.to,
          input.asOf,
        ],
      );
      const grouped = new Map<string, {
        metricKey: BacklinkMetricKey;
        metricDefinitionVersion: string;
        points: MetricDashboardPoint[];
      }>();
      for (const row of result.rows) {
        const metricKey = String(row.metricKey) as BacklinkMetricKey;
        const metricDefinitionVersion = String(
          row.metricDefinitionVersion,
        );
        const rowDimensions = dimensions(row.dimensions);
        const groupKey = JSON.stringify([
          metricKey,
          metricDefinitionVersion,
          rowDimensions,
        ]);
        const group = grouped.get(groupKey) ?? {
          metricKey,
          metricDefinitionVersion,
          points: [],
        };
        group.points.push({
          snapshotId: String(row.snapshotId),
          snapshotVersion: requiredNumber(
            "snapshotVersion",
            row.snapshotVersion,
          ),
          windowStart: requiredDate("windowStart", row.windowStart),
          windowEnd: requiredDate("windowEnd", row.windowEnd),
          asOf: requiredDate("asOf", row.asOf),
          dimensions: rowDimensions,
          numerator: requiredNumber("numerator", row.numerator),
          denominator: nullableNumber("denominator", row.denominator),
          value: nullableNumber("value", row.value),
        });
        grouped.set(groupKey, group);
      }
      const trends = [...grouped.values()].map((group) => ({
        metricKey: group.metricKey,
        metricDefinitionVersion: group.metricDefinitionVersion,
        points: group.points,
      }));
      const summary = trends.flatMap((trend) => {
        const point = trend.points.at(-1);
        return point === undefined
          ? []
          : [{
              metricKey: trend.metricKey,
              metricDefinitionVersion: trend.metricDefinitionVersion,
              ...point,
            }];
      });
      return {
        timezone: input.timezone,
        from: input.from,
        to: input.to,
        asOf: input.asOf,
        summary,
        trends,
      };
    },
  };
}
