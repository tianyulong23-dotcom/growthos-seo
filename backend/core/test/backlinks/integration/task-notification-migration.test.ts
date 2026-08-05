import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backlinkTaskProjections,
} from "../../../src/modules/backlinks/db/schema/task-projections.js";
import {
  backlinkNotificationProjections,
  backlinkNotificationReadStates,
} from "../../../src/modules/backlinks/db/schema/notification-projections.js";
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
  "../../../src/modules/backlinks/db/migrations/0031_backlink_tasks_notifications.sql",
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

describe("BL-AI-170 task and notification projection persistence", () => {
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

  it("declares separate task, notification, and user read-state projections", () => {
    const configs = [
      backlinkTaskProjections,
      backlinkNotificationProjections,
      backlinkNotificationReadStates,
    ].map(getTableConfig);

    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_task_projections",
      "backlink_notification_projections",
      "backlink_notification_read_states",
    ]);
    expect(configs[2]?.foreignKeys.map((key) => key.getName())).toEqual([
      "backlink_notification_read_state_notification_fk",
    ]);
  });

  it("deduplicates occurrences and rebuilds projections independently of read state", async () => {
    await client.query(`
      INSERT INTO backlink_task_projections (
        id, organization_id, workspace_id, website_project_id,
        occurrence_key, source_event_id, source_event_type, rule_key,
        rule_version, task_type, title, status, occurred_at, projected_at
      ) VALUES (
        '${id(101)}', ${identity}, 'placement-health-review:event-170',
        'event-170', 'placement.monitoring.status_decided',
        'placement-health-review', 1, 'placement_health_review',
        'Review lost placement evidence', 'open',
        '2026-07-29T02:00:00Z', '2026-07-29T02:01:00Z'
      );
      INSERT INTO backlink_notification_projections (
        id, organization_id, workspace_id, website_project_id,
        occurrence_key, source_event_id, source_event_type, rule_key,
        rule_version, notification_type, title, occurred_at, projected_at
      ) VALUES (
        '${id(201)}', ${identity}, 'placement-health-alert:event-170',
        'event-170', 'placement.monitoring.status_decided',
        'placement-health-alert', 1, 'placement_health_alert',
        'Placement monitoring detected a lost link',
        '2026-07-29T02:00:00Z', '2026-07-29T02:01:00Z'
      );
      INSERT INTO backlink_notification_read_states (
        id, organization_id, workspace_id, website_project_id,
        notification_occurrence_key, user_id, read_at, version, updated_at
      ) VALUES (
        '${id(301)}', ${identity}, 'placement-health-alert:event-170',
        'user-170', '2026-07-29T02:10:00Z', 1,
        '2026-07-29T02:10:00Z'
      )
    `);
    await expectCode(client.query(`
      INSERT INTO backlink_task_projections (
        id, organization_id, workspace_id, website_project_id,
        occurrence_key, source_event_id, source_event_type, rule_key,
        rule_version, task_type, title, status, occurred_at, projected_at
      ) VALUES (
        '${id(102)}', ${identity}, 'placement-health-review:event-170',
        'event-170', 'placement.monitoring.status_decided',
        'placement-health-review', 1, 'placement_health_review',
        'duplicate', 'open',
        '2026-07-29T02:00:00Z', '2026-07-29T02:01:00Z'
      )
    `), "23505");

    await client.query(`
      UPDATE backlink_notification_read_states
      SET read_at='2026-07-29T02:20:00Z', version=2,
        updated_at='2026-07-29T02:20:00Z'
      WHERE id='${id(301)}'
    `);
    await client.query(`
      DELETE FROM backlink_task_projections WHERE id='${id(101)}';
      INSERT INTO backlink_task_projections (
        id, organization_id, workspace_id, website_project_id,
        occurrence_key, source_event_id, source_event_type, rule_key,
        rule_version, task_type, title, status, occurred_at, projected_at
      ) VALUES (
        '${id(103)}', ${identity}, 'placement-health-review:event-170',
        'event-170', 'placement.monitoring.status_decided',
        'placement-health-review', 1, 'placement_health_review',
        'Review lost placement evidence', 'open',
        '2026-07-29T02:00:00Z', '2026-07-29T02:30:00Z'
      )
    `);

    expect((await client.query(`
      SELECT version FROM backlink_notification_read_states
      WHERE id='${id(301)}'
    `)).rows).toEqual([{ version: 2 }]);
    expect((await client.query(`
      SELECT source_event_id AS "sourceEventId"
      FROM backlink_task_projections WHERE id='${id(103)}'
    `)).rows).toEqual([{ sourceEventId: "event-170" }]);
  });

  it("forces project RLS for all projection tables", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query(`
        SELECT set_config('app.current_organization_id','${organization}',true),
          set_config('app.current_workspace_id','${workspace}',true),
          set_config('app.current_website_project_id','${otherProject}',true)
      `);
      for (const table of [
        "backlink_task_projections",
        "backlink_notification_projections",
        "backlink_notification_read_states",
      ]) {
        expect((await client.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        )).rows).toEqual([{ count: 0 }]);
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
