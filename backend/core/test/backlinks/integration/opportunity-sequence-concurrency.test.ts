import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOpportunityCommands } from "../../../src/modules/backlinks/application/commands/opportunities.command.js";
import { createOpportunityRepository } from "../../../src/modules/backlinks/db/repositories/opportunity.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
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
const migration = (name: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${name}`,
  import.meta.url,
);
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const repositorySource = new URL(
  "../../../src/modules/backlinks/db/repositories/opportunity.repository.ts",
  import.meta.url,
);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const recommendationContextVersionId = id(4);
const actorId = "user-077";
const concurrency = 100;

const context = {
  actor: createActorContext({
    userId: actorId,
    sessionId: "session-077",
    roles: ["member"],
  }),
  tenant: createTenantContext({ organizationId, workspaceId }),
  project: createProjectContext({
    websiteProjectId,
    canonicalDomain: "owner.test",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-v1",
    promotionTargetVersionId: "target-v1",
  }),
};

describe("BL-AI-077 project Opportunity counter", () => {
  let harness: BacklinksPostgresHarness;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    const client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    try {
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
      const prospectIds = Array.from(
        { length: concurrency },
        (_, index) => id(1_000 + index),
      );
      const recommendationIds = Array.from(
        { length: concurrency },
        (_, index) => id(2_000 + index),
      );
      const inventoryIds = Array.from(
        { length: concurrency },
        (_, index) => id(3_000 + index),
      );
      const domains = Array.from(
        { length: concurrency },
        (_, index) => `site-${index + 1}.test`,
      );
      await client.query(`INSERT INTO backlink_prospects (
        id,organization_id,workspace_id,website_project_id,
        recommendation_context_version_id,hostname_ascii,registrable_domain,
        normalization_version,created_by,updated_by
      ) SELECT p.id,$3,$4,$5,$6,p.domain,p.domain,'tldts-v1','seed','seed'
        FROM unnest($1::uuid[],$2::text[]) p(id,domain)`, [
        prospectIds, domains, organizationId, workspaceId, websiteProjectId,
        recommendationContextVersionId,
      ]);
      await client.query(`INSERT INTO backlink_recommendations (
        id,organization_id,workspace_id,website_project_id,prospect_id,
        recommendation_context_version_id,status,created_by,updated_by
      ) SELECT r.id,$3,$4,$5,r.prospect_id,$6,'shown','seed','seed'
        FROM unnest($1::uuid[],$2::uuid[]) r(id,prospect_id)`, [
        recommendationIds, prospectIds, organizationId, workspaceId,
        websiteProjectId, recommendationContextVersionId,
      ]);
      await client.query(`INSERT INTO backlink_recommendation_inventory (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,status,created_by,updated_by
      ) SELECT i.id,$4,$5,$6,i.recommendation_id,i.prospect_id,$7,
          'shown','seed','seed'
        FROM unnest($1::uuid[],$2::uuid[],$3::uuid[])
          i(id,recommendation_id,prospect_id)`, [
        inventoryIds, recommendationIds, prospectIds, organizationId,
        workspaceId, websiteProjectId, recommendationContextVersionId,
      ]);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("uses a Backlinks-owned row-locked Counter", async () => {
    const [migrationSql, repositorySql] = await Promise.all([
      readFile(migration("0007_backlink_opportunity_counter.sql"), "utf8"),
      readFile(repositorySource, "utf8"),
    ]);
    expect(migrationSql).toMatch(/\bFOR UPDATE\b/u);
    expect(migrationSql).not.toMatch(/\b(?:platform|audit|crawler)\./u);
    expect(repositorySql).not.toMatch(/\b(?:platform|audit|crawler)\./u);
    expect(repositorySql).not.toContain(":opportunity.sequence");
    expect(repositorySql).not.toMatch(/max\(o\.join_sequence\)/u);
  });

  it("allocates 100 unique continuous and auditable sequences", async () => {
    const clients = Array.from(
      { length: concurrency },
      () => new PgClient({
        connectionString: harness.connectionString,
        connectionTimeoutMillis: 10_000,
      }),
    );
    try {
      await Promise.all(clients.map(async (client) => {
        await client.connect();
        await client.query("SET ROLE growthos_backlinks_writer");
        await client.query("SET search_path = backlinks, pg_catalog");
        await client.query(
          "SELECT set_config('app.current_workspace_id',$1,false)",
          [workspaceId],
        );
        await client.query(
          "SELECT set_config('app.current_website_project_id',$1,false)",
          [websiteProjectId],
        );
      }));
      const results = await Promise.all(clients.map((client, index) =>
        createOpportunityCommands(createOpportunityRepository(client))
          .createFromRecommendation({
            context,
            recommendationId: id(2_000 + index),
            expectedVersion: 1,
            idempotencyKey: `accept-rec-077-${index + 1}`,
            requestId: `request-077-${index + 1}`,
          })));
      expect(results.map((result) => result.joinSequence).sort((a, b) => a - b))
        .toEqual(Array.from({ length: concurrency }, (_, index) => index + 1));
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
    }

    const verifier = new PgClient({ connectionString: harness.connectionString });
    await verifier.connect();
    try {
      await verifier.query("SET search_path = backlinks, pg_catalog");
      const sequences = (await verifier.query(
        "SELECT join_sequence FROM backlink_opportunities ORDER BY join_sequence",
      )).rows.map((row) => row.join_sequence);
      const auditSequences = (await verifier.query(`SELECT
        (after_redacted->>'joinSequence')::int join_sequence
        FROM backlink_audit_events
        WHERE action='opportunity.created'
        ORDER BY join_sequence`)).rows.map((row) => row.join_sequence);
      expect(sequences).toEqual(
        Array.from({ length: concurrency }, (_, index) => index + 1),
      );
      expect(auditSequences).toEqual(sequences);
      expect((await verifier.query(`SELECT table_schema
        FROM information_schema.tables
        WHERE table_name='backlink_opportunity_project_counters'`)).rows)
        .toEqual([{ table_schema: "backlinks" }]);
      expect((await verifier.query(`SELECT routine_schema
        FROM information_schema.routines
        WHERE routine_name='backlink_allocate_opportunity_join_sequence'`)).rows)
        .toEqual([{ routine_schema: "backlinks" }]);
      expect((await verifier.query(`SELECT last_join_sequence,version,updated_by
        FROM backlink_opportunity_project_counters
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)`, [
        organizationId, workspaceId, websiteProjectId,
      ])).rows).toEqual([{
        last_join_sequence: concurrency,
        version: concurrency,
        updated_by: actorId,
      }]);
    } finally {
      await verifier.end();
    }
  }, 180_000);
});
