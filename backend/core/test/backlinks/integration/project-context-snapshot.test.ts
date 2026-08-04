import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProjectContextSnapshotRepository,
  type AppendProjectContextSnapshotInput,
} from "../../../src/modules/backlinks/db/repositories/project-context-snapshot.repository.js";
import { startBacklinksPostgresHarness,
  type BacklinksPostgresHarness } from "./harness/postgresql-container.js";
type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]):
    Promise<{ rows: Record<string, unknown>[] }>;
};
const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const uuid = (value: number) =>
  `018f0000-0000-7000-8000-${value.toString().padStart(12, "0")}`;
describe("BL-AI-037 Project Context Snapshot Repository", () => {
  const scope = {
    organizationId: uuid(1), workspaceId: uuid(2), websiteProjectId: uuid(3),
  } as const;
  let harness: BacklinksPostgresHarness;
  let client: RuntimeClient;
  let repository: ReturnType<typeof createProjectContextSnapshotRepository>;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
    repository = createProjectContextSnapshotRepository(client);
  }, 120_000);
  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });
  const snapshot = (
    version: number,
    projectStatus: AppendProjectContextSnapshotInput["projectStatus"],
  ): AppendProjectContextSnapshotInput => ({
    ...scope,
    snapshotId: uuid(100 + version),
    snapshotVersion: version,
    projectStatus,
    canonicalDomain: version === 1 ? "example.com" : "new.example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: `profile-version-${version}`,
    promotionTargetVersionId: `target-version-${version}`,
    actorId: "user-037",
  });
  it("appends versions without changing history and represents pause/delete", async () => {
    await repository.append(snapshot(1, "ACTIVE"));
    await repository.append(snapshot(2, "PAUSED"));
    await repository.append(snapshot(3, "DELETED"));
    await expect(repository.findLatest(scope)).resolves.toMatchObject({
      snapshotVersion: 3,
      projectStatus: "DELETED",
      profileVersionId: "profile-version-3",
    });
    await expect(
      repository.append({
        ...snapshot(1, "ACTIVE"),
        snapshotId: uuid(999),
        canonicalDomain: "overwrite.example.com",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    const stored = await client.query(`
      SELECT snapshot_version AS "snapshotVersion",
             project_status AS "projectStatus",
             canonical_domain AS "canonicalDomain"
        FROM backlink_project_context_snapshots
       ORDER BY snapshot_version
    `);
    expect(stored.rows).toEqual([
      { snapshotVersion: 1, projectStatus: "ACTIVE",
        canonicalDomain: "example.com" },
      { snapshotVersion: 2, projectStatus: "PAUSED",
        canonicalDomain: "new.example.com" },
      { snapshotVersion: 3, projectStatus: "DELETED",
        canonicalDomain: "new.example.com" },
    ]);
  });
  it("enforces fixed states, positive versions, and tenant RLS metadata", async () => {
    const invalidRow = (
      id: number, version: number, status: string,
    ) => client.query(
        `INSERT INTO backlink_project_context_snapshots (
           id, organization_id, workspace_id, website_project_id,
           snapshot_version, project_status, canonical_domain, locale,
           country_code, profile_version_id, promotion_target_version_id,
           created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,'example.com','en-US','US','p','t','u')`,
        [
          uuid(id), scope.organizationId, scope.workspaceId,
          scope.websiteProjectId, version, status,
        ],
      );
    await expect(invalidRow(500, 0, "ACTIVE"))
      .rejects.toMatchObject({ code: "23514" });
    await expect(invalidRow(501, 4, "ARCHIVED"))
      .rejects.toMatchObject({ code: "23514" });
    const security = await client.query(`
      SELECT c.relrowsecurity, c.relforcerowsecurity, count(p.policyname)::int AS policies
        FROM pg_class c
        LEFT JOIN pg_policies p ON p.tablename = c.relname
       WHERE c.relname = 'backlink_project_context_snapshots'
       GROUP BY c.relrowsecurity, c.relforcerowsecurity
    `);
    expect(security.rows).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true, policies: 1 },
    ]);
  });
});
