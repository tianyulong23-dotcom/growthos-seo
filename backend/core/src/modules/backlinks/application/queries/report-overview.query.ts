import type {
  MetricProjectScope,
} from "../services/metric-snapshot-builder.js";

export type ReportOverviewRevision = Readonly<{
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
  resultChecksum: string;
  generatedAt: Date;
  freshness: "fresh" | "stale";
}>;

export type ReportOverviewQuery = Readonly<{
  listPublished(input: Readonly<{
    scope: MetricProjectScope;
    asOf: Date;
    reportKey?: string;
  }>): Promise<readonly ReportOverviewRevision[]>;
}>;

export type ReportOverviewQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

function dateValue(name: string, value: unknown): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) {
    throw new Error(`Report overview ${name} is invalid.`);
  }
  return result;
}

function recordValue(
  name: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Report overview ${name} is invalid.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringRecord(
  name: string,
  value: unknown,
): Readonly<Record<string, string>> {
  const record = recordValue(name, value);
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new Error(`Report overview ${name} must contain strings.`);
  }
  return record as Readonly<Record<string, string>>;
}

function stringArray(name: string, value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Report overview ${name} is invalid.`);
  }
  return value;
}

export function createReportOverviewQuery(
  client: ReportOverviewQueryClient,
  options: Readonly<{ staleAfterMilliseconds?: number }> = {},
): ReportOverviewQuery {
  const staleAfterMilliseconds =
    options.staleAfterMilliseconds ?? 24 * 60 * 60 * 1000;
  if (
    !Number.isSafeInteger(staleAfterMilliseconds)
    || staleAfterMilliseconds < 0
  ) {
    throw new TypeError("Report stale interval must be non-negative.");
  }

  return {
    async listPublished(input) {
      if (!Number.isFinite(input.asOf.getTime())) {
        throw new TypeError("Report overview asOf is invalid.");
      }
      const values: unknown[] = [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
      ];
      const reportFilter = input.reportKey === undefined
        ? ""
        : `AND publication.report_key=$${values.push(input.reportKey)}`;
      const result = await client.query(
        `
          SELECT revision.id,
            revision.report_key AS "reportKey",
            revision.revision,
            revision.input_snapshot_ids AS "inputSnapshotIds",
            revision.metric_definition_versions AS "metricDefinitionVersions",
            revision.query_spec AS "querySpec",
            revision.report_payload AS payload,
            revision.source_started_at AS "sourceStartedAt",
            revision.source_ended_at AS "sourceEndedAt",
            revision.source_watermark_at AS "sourceWatermarkAt",
            revision.source_watermark_id AS "sourceWatermarkId",
            revision.result_checksum AS "resultChecksum",
            revision.generated_at AS "generatedAt"
          FROM backlink_report_publications publication
          JOIN backlink_report_revisions revision
            ON revision.organization_id=publication.organization_id
            AND revision.workspace_id=publication.workspace_id
            AND revision.website_project_id=publication.website_project_id
            AND revision.id=publication.report_revision_id
            AND revision.report_key=publication.report_key
            AND revision.revision=publication.report_revision
          WHERE publication.organization_id=$1
            AND publication.workspace_id=$2
            AND publication.website_project_id=$3
            ${reportFilter}
          ORDER BY publication.report_key
        `,
        values,
      );
      return result.rows.map((row) => {
        const sourceWatermarkAt = dateValue(
          "sourceWatermarkAt",
          row.sourceWatermarkAt,
        );
        return {
          id: String(row.id),
          reportKey: String(row.reportKey),
          revision: Number(row.revision),
          inputSnapshotIds: stringArray(
            "inputSnapshotIds",
            row.inputSnapshotIds,
          ),
          metricDefinitionVersions: stringRecord(
            "metricDefinitionVersions",
            row.metricDefinitionVersions,
          ),
          querySpec: recordValue("querySpec", row.querySpec),
          payload: recordValue("payload", row.payload),
          sourceStartedAt: dateValue(
            "sourceStartedAt",
            row.sourceStartedAt,
          ),
          sourceEndedAt: dateValue("sourceEndedAt", row.sourceEndedAt),
          sourceWatermarkAt,
          sourceWatermarkId: String(row.sourceWatermarkId),
          resultChecksum: String(row.resultChecksum),
          generatedAt: dateValue("generatedAt", row.generatedAt),
          freshness:
            input.asOf.getTime() - sourceWatermarkAt.getTime()
              > staleAfterMilliseconds
              ? "stale" as const
              : "fresh" as const,
        };
      });
    },
  };
}
