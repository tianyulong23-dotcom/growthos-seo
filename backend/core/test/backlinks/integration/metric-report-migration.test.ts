import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMetricDashboardQuery,
} from "../../../src/modules/backlinks/application/queries/metric-dashboard.query.js";
import {
  backlinkMetricSnapshots,
} from "../../../src/modules/backlinks/db/schema/metric-snapshots.js";
import {
  backlinkReportPublications,
  backlinkReportRevisions,
} from "../../../src/modules/backlinks/db/schema/report-revisions.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
type PgError = Error & { readonly code?: string };

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migration = new URL(
  "../../../src/modules/backlinks/db/migrations/0030_backlink_metrics_reports.sql",
  import.meta.url,
);
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1);
const workspace = id(2);
const project = id(3);
const otherProject = id(4);
const identity = `'${organization}', '${workspace}', '${project}'`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-162 Metric Snapshot and Report Revision persistence", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(roles, "utf8"));
    await client.query(await readFile(migration, "utf8"));
    await client.query("SET search_path = backlinks, pg_catalog");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares Snapshot, immutable Revision, and publication pointer schemas", () => {
    const configs = [
      backlinkMetricSnapshots,
      backlinkReportRevisions,
      backlinkReportPublications,
    ].map(getTableConfig);

    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_metric_snapshots",
      "backlink_report_revisions",
      "backlink_report_publications",
    ]);
    expect(
      configs[2]?.foreignKeys.map((key) => key.getName()),
    ).toEqual(["backlink_report_publication_revision_fk"]);
  });

  it("appends late Snapshot versions without overwriting history", async () => {
    const insert = (snapshotId: string, version: number, facts: string) =>
      client.query(`
        INSERT INTO backlink_metric_snapshots (
          id, organization_id, workspace_id, website_project_id,
          metric_key, metric_definition_version, snapshot_version,
          window_start, window_end, as_of, workspace_timezone, dimensions,
          dimension_hash, numerator, denominator, value_numeric,
          source_started_at, source_ended_at, source_fact_count,
          source_fact_ids, source_watermark_at, source_watermark_id,
          input_checksum, result_checksum, computed_at, created_by
        ) VALUES (
          '${snapshotId}', ${identity}, 'send_count', 'send_count.v1',
          ${version}, '2026-07-28T00:00:00Z', '2026-07-29T00:00:00Z',
          '2026-07-29T01:00:00Z', 'Asia/Shanghai', '{"market":"CN"}',
          '${"a".repeat(64)}', ${version}, NULL, ${version},
          '2026-07-28T00:30:00Z', '2026-07-28T01:00:00Z', ${version},
          '${facts}', '2026-07-28T01:00:00Z', 'fact-${version}',
          '${String(version).repeat(64)}', '${"b".repeat(64)}',
          '2026-07-29T02:00:00Z', 'metrics-worker'
        )
      `);
    await insert(id(101), 1, '["fact-1"]');
    await insert(id(102), 2, '["fact-late","fact-1"]');

    expect((await client.query(`
      SELECT snapshot_version AS version, source_fact_count AS "factCount"
      FROM backlink_metric_snapshots
      ORDER BY snapshot_version
    `)).rows).toEqual([
      { version: 1, factCount: 1 },
      { version: 2, factCount: 2 },
    ]);
    await expectCode(client.query(`
      UPDATE backlink_metric_snapshots
      SET value_numeric=99 WHERE id='${id(101)}'
    `), "55000");
    await expectCode(client.query(`
      DELETE FROM backlink_metric_snapshots WHERE id='${id(101)}'
    `), "55000");
  });

  it("queries only the latest Snapshot version in the exact project scope", async () => {
    const scopedProject = id(5);
    const foreignProject = id(6);
    const insert = (
      snapshotId: string,
      projectId: string,
      version: number,
      value: number,
    ) => client.query(`
      INSERT INTO backlink_metric_snapshots (
        id, organization_id, workspace_id, website_project_id,
        metric_key, metric_definition_version, snapshot_version,
        window_start, window_end, as_of, workspace_timezone, dimensions,
        dimension_hash, numerator, denominator, value_numeric,
        source_started_at, source_ended_at, source_fact_count,
        source_fact_ids, source_watermark_at, source_watermark_id,
        input_checksum, result_checksum, computed_at, created_by
      ) VALUES (
        '${snapshotId}', '${organization}', '${workspace}', '${projectId}',
        'send_count', 'send_count.v1', ${version},
        '2026-07-28T00:00:00Z', '2026-07-29T00:00:00Z',
        '2026-07-29T01:00:00Z', 'Asia/Shanghai', '{"market":"CN"}',
        '${"e".repeat(64)}', ${value}, NULL, ${value},
        '2026-07-28T00:30:00Z', '2026-07-28T01:00:00Z', 1,
        '["fact-${snapshotId}"]', '2026-07-28T01:00:00Z',
        'fact-${snapshotId}', '${String(version).repeat(64)}',
        '${"f".repeat(64)}', '2026-07-29T02:00:00Z', 'metrics-worker'
      )
    `);
    await insert(id(111), scopedProject, 1, 1);
    await insert(id(112), scopedProject, 2, 2);
    await insert(id(113), foreignProject, 1, 99);

    const query = createMetricDashboardQuery(client);
    const dashboard = await query.getDashboard({
      scope: {
        organizationId: organization,
        workspaceId: workspace,
        websiteProjectId: scopedProject,
      },
      from: new Date("2026-07-28T00:00:00.000Z"),
      to: new Date("2026-07-29T00:00:00.000Z"),
      asOf: new Date("2026-07-29T01:00:00.000Z"),
      timezone: "Asia/Shanghai",
    });
    const empty = await query.getDashboard({
      scope: {
        organizationId: organization,
        workspaceId: workspace,
        websiteProjectId: id(7),
      },
      from: new Date("2026-07-28T00:00:00.000Z"),
      to: new Date("2026-07-29T00:00:00.000Z"),
      asOf: new Date("2026-07-29T01:00:00.000Z"),
      timezone: "Asia/Shanghai",
    });

    expect(dashboard.summary).toMatchObject([{
      snapshotId: id(112),
      snapshotVersion: 2,
      metricKey: "send_count",
      value: 2,
    }]);
    expect(dashboard.trends).toHaveLength(1);
    expect(dashboard.trends[0]?.points).toHaveLength(1);
    expect(empty).toMatchObject({ summary: [], trends: [] });
  });

  it("keeps revisions immutable while atomically moving the publication pointer", async () => {
    const revisionSql = (revisionId: string, revision: number) => `
      INSERT INTO backlink_report_revisions (
        id, organization_id, workspace_id, website_project_id, report_key,
        revision, input_snapshot_ids, metric_definition_versions, query_spec,
        report_payload, source_started_at, source_ended_at,
        source_watermark_at, source_watermark_id, input_checksum,
        result_checksum, generated_at, created_by
      ) VALUES (
        '${revisionId}', ${identity}, 'weekly-performance', ${revision},
        '["${id(100 + revision)}"]', '{"send_count":"send_count.v1"}',
        '{"grain":"day"}', '{"title":"Weekly"}',
        '2026-07-28T00:00:00Z', '2026-07-29T00:00:00Z',
        '2026-07-29T00:00:00Z', 'fact-${revision}',
        '${"c".repeat(64)}', '${"d".repeat(64)}',
        '2026-07-29T01:00:00Z', 'report-worker'
      )
    `;
    await client.query(revisionSql(id(201), 1));
    await client.query(`
      INSERT INTO backlink_report_publications (
        id, organization_id, workspace_id, website_project_id, report_key,
        report_revision_id, report_revision, published_at, published_by,
        updated_by
      ) VALUES (
        '${id(301)}', ${identity}, 'weekly-performance', '${id(201)}', 1,
        '2026-07-29T01:01:00Z', 'report-worker', 'report-worker'
      )
    `);
    await client.query(revisionSql(id(202), 2));
    await client.query(`
      UPDATE backlink_report_publications
      SET report_revision_id='${id(202)}', report_revision=2,
        published_at='2026-07-29T02:01:00Z', version=version+1,
        updated_at='2026-07-29T02:01:00Z', updated_by='report-worker'
      WHERE id='${id(301)}'
    `);

    expect((await client.query(`
      SELECT report_revision AS revision, version
      FROM backlink_report_publications WHERE id='${id(301)}'
    `)).rows).toEqual([{ revision: 2, version: 2 }]);
    await expectCode(client.query(`
      UPDATE backlink_report_revisions
      SET report_payload='{"mutated":true}' WHERE id='${id(201)}'
    `), "55000");
  });

  it("enforces RLS and append-only writer privileges", async () => {
    const privileges = (await client.query(`
      SELECT c.relname,
        c.relrowsecurity AND c.relforcerowsecurity AS secure,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'SELECT,INSERT'
        ) AS writer_append,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'UPDATE,DELETE'
        ) AS writer_mutation
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='backlinks'
        AND c.relname IN (
          'backlink_metric_snapshots',
          'backlink_report_revisions',
          'backlink_report_publications'
        )
      ORDER BY c.relname
    `)).rows;
    expect(privileges).toEqual([
      {
        relname: "backlink_metric_snapshots",
        secure: true,
        writer_append: true,
        writer_mutation: false,
      },
      {
        relname: "backlink_report_publications",
        secure: true,
        writer_append: true,
        writer_mutation: true,
      },
      {
        relname: "backlink_report_revisions",
        secure: true,
        writer_append: true,
        writer_mutation: false,
      },
    ]);

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query(`
        SELECT set_config('app.current_organization_id','${organization}',true),
          set_config('app.current_workspace_id','${workspace}',true),
          set_config('app.current_website_project_id','${otherProject}',true)
      `);
      expect((await client.query(`
        SELECT count(*)::int AS count FROM backlink_metric_snapshots
      `)).rows).toEqual([{ count: 0 }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
