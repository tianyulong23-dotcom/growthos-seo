import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migration = (name: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${name}`,
    import.meta.url,
  );
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `01910000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const contextId = id(4);
const prospectId = id(5);
const recommendationId = id(6);
const opportunityId = id(7);

describe("LP-FINAL Opportunity counter history reconciliation", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(roles, "utf8"));
    for (const name of [
      "0005_backlink_schema_role_ownership.sql",
      "0006_backlink_opportunities.sql",
      "0007_backlink_opportunity_counter.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `INSERT INTO backlink_prospects (
        id,organization_id,workspace_id,website_project_id,
        recommendation_context_version_id,hostname_ascii,registrable_domain,
        normalization_version,created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,$5,'legacy.test','legacy.test','test-v1','seed','seed'
      )`,
      [
        prospectId,
        organizationId,
        workspaceId,
        websiteProjectId,
        contextId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendations (
        id,organization_id,workspace_id,website_project_id,prospect_id,
        recommendation_context_version_id,status,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,'accepted','seed','seed')`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        contextId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_opportunities (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,target_site_key,
        target_host_ascii,target_identity_rule_version,join_sequence,
        created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,'legacy.test','legacy.test','test-v1',1,
        'legacy-seed','legacy-seed'
      )`,
      [
        opportunityId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        contextId,
      ],
    );
    await client.query(
      await readFile(
        migration("0036_backlink_opportunity_counter_reconciliation.sql"),
        "utf8",
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("allocates after a legacy direct-inserted Opportunity without a counter", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query("SET LOCAL search_path = backlinks, pg_catalog");
      await client.query(
        `SELECT set_config('app.current_organization_id',$1,true),
                set_config('app.current_workspace_id',$2,true),
                set_config('app.current_website_project_id',$3,true)`,
        [organizationId, workspaceId, websiteProjectId],
      );
      const allocated = await client.query(
        `SELECT backlink_allocate_opportunity_join_sequence(
          $1,$2,$3,'local-product-user'
        ) AS sequence`,
        [organizationId, workspaceId, websiteProjectId],
      );
      expect(allocated.rows).toEqual([{ sequence: 2 }]);
      expect(
        (
          await client.query(
            `SELECT last_join_sequence,version
               FROM backlink_opportunity_project_counters
              WHERE organization_id=$1
                AND workspace_id=$2
                AND website_project_id=$3`,
            [organizationId, workspaceId, websiteProjectId],
          )
        ).rows,
      ).toEqual([{ last_join_sequence: 2, version: 1 }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("keeps the reconciliation tenant-scoped", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query("SET LOCAL search_path = backlinks, pg_catalog");
      await client.query(
        `SELECT set_config('app.current_organization_id',$1,true),
                set_config('app.current_workspace_id',$2,true),
                set_config('app.current_website_project_id',$3,true)`,
        [organizationId, id(20), id(30)],
      );
      const allocated = await client.query(
        `SELECT backlink_allocate_opportunity_join_sequence(
          $1,$2,$3,'local-product-user'
        ) AS sequence`,
        [organizationId, id(20), id(30)],
      );
      expect(allocated.rows).toEqual([{ sequence: 1 }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
