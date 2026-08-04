import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlinkAssessmentRuns,
  backlinkAssessmentSnapshots,
} from "../../../src/modules/backlinks/db/schema/assessments.js";
import {
  assessmentDimensionIds,
  type AssessmentDimensionInput,
} from "../../../src/modules/backlinks/domain/assessments/assessment-policy.js";
import { runBacklinkAssessmentWorkflow } from "../../../src/modules/backlinks/application/workflows/assessment-workflow.js";
import { createAssessmentRepository } from "../../../src/modules/backlinks/repositories/assessment.repository.js";
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
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1);
const workspace = id(2);
const project = id(3);
const identity = `'${organization}', '${workspace}', '${project}'`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-081 provider-neutral Assessment persistence", () => {
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
      "0010_backlink_assessments.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii,
        registrable_domain, normalization_version, created_by, updated_by
      ) VALUES (
        '${id(101)}', ${identity}, '${id(102)}', 'www.example.com',
        'example.com', 'tldts-7.4.9-v1', 'test', 'test'
      );
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES (
        '${id(201)}', ${identity}, '${id(101)}', '${id(102)}',
        'accepted', 'test', 'test'
      );
      INSERT INTO backlink_opportunities (
        id, organization_id, workspace_id, website_project_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        target_site_key, target_host_ascii, target_identity_rule_version,
        join_sequence, created_by, updated_by
      ) VALUES (
        '${id(301)}', ${identity}, '${id(201)}', '${id(101)}', '${id(102)}',
        'example.com', 'www.example.com', 'tldts-7.4.9-v1', 1,
        'test', 'test'
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares tenant-safe Run and immutable Snapshot schemas", () => {
    const configs = [
      backlinkAssessmentRuns,
      backlinkAssessmentSnapshots,
    ].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_assessment_runs",
      "backlink_assessment_snapshots",
    ]);
    expect(
      configs.flatMap(({ foreignKeys }) =>
        foreignKeys.map((key) => key.getName()),
      ),
    ).toEqual([
      "backlink_assessment_run_opportunity_fk",
      "backlink_assessment_run_last_success_fk",
      "backlink_assessment_snapshot_run_fk",
    ]);
  });

  it("deduplicates one evidence/policy input and preserves last success", async () => {
    const runSql = (runId: string, evidenceHash: string) => `
      INSERT INTO backlink_assessment_runs (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        policy_version, evidence_contract_version, source_release_ids,
        input_evidence_refs, input_evidence_hash, status, schema_version,
        created_by, updated_by
      ) VALUES (
        '${runId}', ${identity}, '${id(301)}', 'assessment-policy-v1',
        'evidence-contract-v1', '["dataforseo-2026-07-25","crawler-run-42"]',
        '["graph:example.com","crawler:artifact-42"]', '${evidenceHash}',
        'QUEUED', 1, 'test', 'test'
      )`;
    await client.query(runSql(id(401), "a".repeat(64)));
    await expectCode(client.query(runSql(id(402), "a".repeat(64))), "23505");
    await client.query(runSql(id(403), "b".repeat(64)));

    await client.query(`
      UPDATE backlink_assessment_runs
      SET status = 'RUNNING', attempt_count = 1, started_at = now(),
        updated_at = now(), updated_by = 'test'
      WHERE id = '${id(401)}';
      INSERT INTO backlink_assessment_snapshots (
        id, organization_id, workspace_id, website_project_id, run_id,
        opportunity_id, policy_version, input_evidence_hash, snapshot_version,
        source_release_ids, availability, confidence, evidence_refs,
        stale, result_payload, result_hash, generated_at, schema_version,
        created_by
      ) VALUES (
        '${id(501)}', ${identity}, '${id(401)}', '${id(301)}',
        'assessment-policy-v1', '${"a".repeat(64)}', 1,
        '["dataforseo-2026-07-25","crawler-run-42"]', 'available', 0.9300,
        '["graph:example.com","crawler:artifact-42"]', false,
        '{"outcome":"review_recommended"}', '${"c".repeat(64)}', now(), 1,
        'test'
      );
      UPDATE backlink_assessment_runs
      SET status = 'SUCCEEDED', finished_at = now(),
        last_successful_snapshot_id = '${id(501)}',
        updated_at = now(), updated_by = 'test'
      WHERE id = '${id(401)}';
      UPDATE backlink_assessment_runs
      SET status = 'FAILED', attempt_count = 1, started_at = now(),
        finished_at = now(), error_code = 'SOURCE_UNAVAILABLE',
        last_successful_snapshot_id = '${id(501)}',
        updated_at = now(), updated_by = 'test'
      WHERE id = '${id(403)}';
    `);
    expect(
      (
        await client.query(`
          SELECT status, last_successful_snapshot_id AS "lastSuccess"
          FROM backlink_assessment_runs
          WHERE id IN ('${id(401)}', '${id(403)}')
          ORDER BY id
        `)
      ).rows,
    ).toEqual([
      { status: "SUCCEEDED", lastSuccess: id(501) },
      { status: "FAILED", lastSuccess: id(501) },
    ]);
  });

  it("fails closed on fabricated availability and snapshot mutation", async () => {
    await expectCode(
      client.query(`
        INSERT INTO backlink_assessment_snapshots (
          id, organization_id, workspace_id, website_project_id, run_id,
          opportunity_id, policy_version, input_evidence_hash, snapshot_version,
          source_release_ids, availability, confidence, evidence_refs,
          unavailable_reason, stale, result_payload, result_hash, generated_at,
          schema_version, created_by
        ) VALUES (
          '${id(502)}', ${identity}, '${id(403)}', '${id(301)}',
          'assessment-policy-v1', '${"b".repeat(64)}', 2,
          '["crawler-run-43"]', 'unavailable', 0.5000, '[]',
          'source_unavailable', false, '{}', '${"d".repeat(64)}', now(), 1,
          'test'
        )
      `),
      "23514",
    );
    await expectCode(
      client.query(`
        UPDATE backlink_assessment_snapshots
        SET stale = true
        WHERE id = '${id(501)}'
      `),
      "55000",
    );
  });

  it("enforces owner, forced RLS, and append-only writer access", async () => {
    const rows = (
      await client.query(`
        SELECT c.relname,
          c.relrowsecurity AND c.relforcerowsecurity AS secure,
          pg_get_userbyid(c.relowner) AS owner,
          has_table_privilege(
            'growthos_backlinks_writer', c.oid, 'SELECT,INSERT'
          ) AS writer_append,
          has_table_privilege(
            'growthos_backlinks_writer', c.oid, 'UPDATE,DELETE'
          ) AS writer_mutation
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'backlinks'
          AND c.relname IN (
            'backlink_assessment_runs', 'backlink_assessment_snapshots'
          )
        ORDER BY c.relname
      `)
    ).rows;
    expect(rows).toEqual([
      {
        relname: "backlink_assessment_runs",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: true,
      },
      {
        relname: "backlink_assessment_snapshots",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: false,
      },
    ]);
  });

  it("runs idempotently and preserves the last success on failure", async () => {
    await client.query("TRUNCATE backlink_assessment_runs, backlink_assessment_snapshots");
    const repository = createAssessmentRepository(client);
    const dimensions = (release: string): AssessmentDimensionInput[] =>
      assessmentDimensionIds.map((dimensionId) => ({
        id: dimensionId, normalizedValue: 0.8,
        normalizationRuleVersion: `${dimensionId}.v1`,
        reasonCode: `${dimensionId}_normalized`,
        evidence: {
          availability: "observed", value: 80,
          sourceType: dimensionId === "technical_health"
            ? "crawler" : "dataforseo",
          sourceReleaseId: dimensionId === "technical_health"
            ? release : "dataforseo-2026-07-25",
          confidence: 0.9, stale: false,
          observedAt: "2026-07-27T08:00:00.000Z",
          evidenceRefs: [`s3://assessment/${dimensionId}.json`],
        },
      }));
    const input = (sequence: number, inputEvidenceHash: string, release: string) => ({
      organizationId: organization, workspaceId: workspace,
      websiteProjectId: project, opportunityId: id(301),
      runId: id(400 + sequence),
      snapshotId: id(500 + sequence),
      evidenceContractVersion: "open-evidence.v1",
      inputEvidenceRefs: ["s3://assessment/input.json"],
      inputEvidenceHash, dimensions: dimensions(release),
      actorId: "assessment-worker" as const,
      recordedAt: new Date("2026-07-27T08:05:00.000Z"),
    });
    const execute = (sequence: number, hash: string, release: string) =>
      runBacklinkAssessmentWorkflow(input(sequence, hash, release), repository);

    expect(await execute(1, "e".repeat(64), "crawler-run-42")).toEqual({
      outcome: "completed", runId: id(401),
      snapshotId: id(501), snapshotVersion: 1,
    });
    expect(await execute(2, "e".repeat(64), "crawler-run-42")).toEqual({
      outcome: "already_completed", runId: id(401),
      snapshotId: id(501), snapshotVersion: 1,
    });
    expect(await execute(3, "f".repeat(64), "crawler-run-43"))
      .toMatchObject({ outcome: "completed", snapshotVersion: 2 });
    await expect(runBacklinkAssessmentWorkflow(
      input(4, "f".repeat(63) + "0", "crawler-run-44"),
      repository, () => {
      throw new Error("crawler evidence unavailable");
    })).rejects.toThrow("crawler evidence unavailable");

    expect((await client.query(`
      SELECT status, last_successful_snapshot_id AS "lastSuccess", error_code
      FROM backlink_assessment_runs ORDER BY id
    `)).rows).toEqual([
      { status: "SUCCEEDED", lastSuccess: id(501), error_code: null },
      { status: "SUCCEEDED", lastSuccess: id(503), error_code: null },
      { status: "FAILED", lastSuccess: id(503),
        error_code: "ASSESSMENT_WORKFLOW_FAILED" },
    ]);
    expect((await client.query(
      "SELECT count(*)::integer AS count FROM backlink_assessment_snapshots",
    )).rows).toEqual([{ count: 2 }]);
  });
});
