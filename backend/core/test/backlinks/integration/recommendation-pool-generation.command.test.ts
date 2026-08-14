import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRecommendationCommands } from "../../../src/modules/backlinks/application/commands/recommendations.command.js";
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
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{ migrationId: string; path: string }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
    import.meta.url,
  );
const id = (value: number) =>
  `018f0059-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const recommendationContextVersionId = id(4);

describe("recommendation pool generation lifecycle", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(rolesUrl, "utf8"));
    await client.query(`
      SET ROLE growthos_platform_owner;
      SET search_path = platform, pg_catalog;
      CREATE FUNCTION backlink_list_active_website_projects(text, text)
      RETURNS TABLE (website_project_id text, context_version integer)
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = platform, pg_catalog
      AS $function$ SELECT NULL::text, NULL::integer WHERE false; $function$;
      REVOKE ALL
        ON FUNCTION backlink_list_active_website_projects(text, text)
        FROM PUBLIC;
      GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
      GRANT EXECUTE
        ON FUNCTION backlink_list_active_website_projects(text, text)
        TO growthos_backlinks_owner;
      RESET ROLE;
      RESET search_path;
    `);
    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    for (const step of manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-")
        && migrationId !== "backlinks-0001",
    )) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `INSERT INTO backlink_commercial_inventory_policies (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         visible_pool_state,updated_by
       ) VALUES ($1,$2,$3,$4,1,'active','pool-test')`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
      ],
    );
    for (let index = 0; index < 20; index += 1) {
      const prospectId = id(100 + index);
      const recommendationId = id(200 + index);
      await client.query(
        `INSERT INTO backlink_prospects (
           id,organization_id,workspace_id,website_project_id,
           recommendation_context_version_id,hostname_ascii,
           registrable_domain,normalization_version,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'tldts-v1','pool-test','pool-test')`,
        [
          prospectId,
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId,
          `publisher-${index}.test`,
          `publisher-${index}.test`,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendations (
           id,organization_id,workspace_id,website_project_id,prospect_id,
           recommendation_context_version_id,status,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,'shown','pool-test','pool-test')`,
        [
          recommendationId,
          organizationId,
          workspaceId,
          websiteProjectId,
          prospectId,
          recommendationContextVersionId,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendation_inventory (
           id,organization_id,workspace_id,website_project_id,
           recommendation_id,prospect_id,recommendation_context_version_id,
           visible_pool_generation,status,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'shown','pool-test','pool-test')`,
        [
          id(300 + index),
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationId,
          prospectId,
          recommendationContextVersionId,
        ],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("archives a complete generation and waits for an explicit next generation", async () => {
    const context = {
      actor: createActorContext({
        userId: "pool-operator",
        sessionId: "pool-session",
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
    const commands = createRecommendationCommands(client);
    const archiveInput = {
      context,
      requestId: "archive-request-1",
      idempotencyKey:
        `recommendation-pool-archive:${recommendationContextVersionId}:g1`,
      recommendationContextVersionId,
      visiblePoolGeneration: 1,
    } as const;

    expect(await commands.archivePool(archiveInput)).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      state: "awaiting_refresh",
      replayed: false,
    });
    expect(await commands.archivePool(archiveInput)).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      state: "awaiting_refresh",
      replayed: true,
    });

    expect(
      (
        await client.query(
          `SELECT visible_pool_generation AS "generation",
                  visible_pool_state AS "state",
                  archived_visible_pool_count AS "archivedCount"
             FROM backlink_commercial_inventory_policies
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND project_context_version_id=$4`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([{
      generation: 2,
      state: "awaiting_refresh",
      archivedCount: 20,
    }]);
    expect(
      (
        await client.query(
          `SELECT status,count(*)::integer AS count
             FROM backlink_recommendation_inventory
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND recommendation_context_version_id=$4
              AND visible_pool_generation=1
            GROUP BY status`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([{ status: "archived", count: 20 }]);
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_recommendation_refills)
               AS "refillCount",
             (SELECT count(*)::integer FROM backlink_jobs) AS "jobCount",
             (SELECT count(*)::integer FROM backlink_outbox_events)
               AS "outboxCount"`,
        )
      ).rows,
    ).toEqual([{ refillCount: 0, jobCount: 0, outboxCount: 0 }]);

    const refillInput = {
      context,
      requestId: "refill-request-2",
      expectedVersion: 0,
      recommendationContextVersionId,
      visiblePoolGeneration: 2,
      lowWatermark: 9,
      highWatermark: 10,
    } as const;
    const started = await commands.requestRefill(refillInput);
    expect(started).toMatchObject({ status: "queued", replayed: false });
    expect(await commands.requestRefill(refillInput)).toMatchObject({
      operationId: started.operationId,
      jobId: started.jobId,
      status: "queued",
      replayed: true,
    });

    expect(
      (
        await client.query(
          `SELECT visible_pool_generation AS "generation",
                  visible_pool_state AS "state"
             FROM backlink_commercial_inventory_policies
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND project_context_version_id=$4`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([{ generation: 2, state: "building" }]);
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_recommendation_refills)
               AS "refillCount",
             (SELECT count(*)::integer FROM backlink_jobs) AS "jobCount",
             (SELECT count(*)::integer FROM backlink_outbox_events)
               AS "outboxCount"`,
        )
      ).rows,
    ).toEqual([{ refillCount: 1, jobCount: 1, outboxCount: 1 }]);

    await expect(
      commands.requestRefill({
        ...refillInput,
        visiblePoolGeneration: 1,
      }),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
  });
});
