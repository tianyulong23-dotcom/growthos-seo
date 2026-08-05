import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlinkDraftVersions,
  backlinkEmailDrafts,
  backlinkEvidenceSnapshots,
  backlinkModelRuns,
} from "../../../src/modules/backlinks/db/schema/drafts.js";
import {
  createDraftEditingRepository,
  createDraftGenerationRepository,
} from "../../../src/modules/backlinks/application/repositories/draft-generation.repository.js";
import {
  runDraftGenerationWorkflow,
} from "../../../src/modules/backlinks/application/workflows/draft-generation-workflow.js";
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

describe("BL-AI-086 Draft persistence", () => {
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
      "0011_backlink_contact_purpose_correction.sql",
      "0012_backlink_gmail_connections.sql",
      "0013_backlink_drafts.sql",
      "0014_backlink_send_intents.sql",
      "0015_backlink_gmail_sync_capabilities.sql",
      "0022_backlink_draft_documents.sql",
      "0035_backlink_contact_send_snapshots.sql",
      "0042_backlink_project_recommendation_context.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      INSERT INTO backlink_project_context_snapshots (
        id, organization_id, workspace_id, website_project_id,
        snapshot_version, project_status, canonical_domain, locale,
        country_code, products, keywords, target_urls,
        profile_version_id, promotion_target_version_id, created_by
      ) VALUES (
        '${id(100)}', ${identity}, 1, 'ACTIVE', 'owner.example', 'en-US',
        'US', '["GrowthOS"]', '["backlink outreach"]',
        '["https://owner.example/"]',
        'profile-v1', 'promotion-target-v1', 'test'
      );
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
      INSERT INTO backlink_contact_candidates (
        id, organization_id, workspace_id, website_project_id,
        prospect_id, recommendation_context_version_id,
        normalized_email, email_domain_ascii, domain_relation,
        syntax_validator_version, confidence, observed_role,
        inferred_purpose, purpose_confidence, purpose_rule_version,
        purpose_evidence, guessed, status, version, created_by, updated_by
      ) VALUES (
        '${id(103)}', ${identity}, '${id(101)}', '${id(102)}',
        'contact@example.com', 'example.com', 'same_registrable_domain',
        'test.v1', 100, 'editorial', 'editorial', 100,
        'test-contact-purpose.v1', '[]', false, 'promoted', 2,
        'test', 'test'
      );
      INSERT INTO backlink_contacts (
        id, organization_id, workspace_id, website_project_id,
        prospect_id, recommendation_context_version_id, source_candidate_id,
        normalized_email, contact_role, confidence, observed_role,
        inferred_purpose, purpose_confidence, purpose_rule_version,
        purpose_evidence, guessed, confirmed_at, confirmed_by,
        status, version, created_by, updated_by
      ) VALUES (
        '${id(104)}', ${identity}, '${id(101)}', '${id(102)}', '${id(103)}',
        'contact@example.com', 'editorial', 100, 'editorial',
        'editorial', 100, 'test-contact-purpose.v1', '[]', false,
        now(), 'test', 'active', 1, 'test', 'test'
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares the four tenant-safe Draft tables", () => {
    const configs = [
      backlinkEvidenceSnapshots,
      backlinkEmailDrafts,
      backlinkModelRuns,
      backlinkDraftVersions,
    ].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_evidence_snapshots",
      "backlink_email_drafts",
      "backlink_model_runs",
      "backlink_draft_versions",
    ]);
    expect(
      configs.flatMap(({ foreignKeys }) =>
        foreignKeys.map((key) => key.getName()),
      ),
    ).toEqual(expect.arrayContaining([
      "backlink_evidence_snapshot_opportunity_fk",
      "backlink_email_draft_opportunity_fk",
      "backlink_model_run_draft_fk",
      "backlink_model_run_evidence_snapshot_fk",
      "backlink_draft_version_draft_fk",
      "backlink_draft_version_evidence_snapshot_fk",
    ]));
  });

  it("stores one model result and keeps Snapshot and Version immutable", async () => {
    await client.query(`
      INSERT INTO backlink_evidence_snapshots (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        evidence_items, snapshot_hash, schema_version, created_by
      ) VALUES (
        '${id(401)}', ${identity}, '${id(301)}',
        '[{"id":"profile:1","status":"ACTIVE","visibility":"VISIBLE",
          "confidence":0.9,"sourceKind":"PROFILE","value":"GrowthOS"}]',
        '${"a".repeat(64)}', 1, 'test'
      );
      INSERT INTO backlink_email_drafts (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        contact_id, contact_version, logical_draft_key, status,
        created_by, updated_by
      ) VALUES (
        '${id(501)}', ${identity}, '${id(301)}', '${id(104)}', 1,
        'initial-outreach',
        'generating', 'test', 'test'
      );
      INSERT INTO backlink_model_runs (
        id, organization_id, workspace_id, website_project_id, draft_id,
        opportunity_id, contact_id, contact_version, evidence_snapshot_id,
        idempotency_key, request_hash,
        status, provider_ref, model_id, model_version, prompt_version,
        output_schema_version, input_tokens, output_tokens,
        estimated_cost_usd, latency_ms, attempt_count, repair_count,
        quality_result, started_at, finished_at, created_by, updated_by
      ) VALUES (
        '${id(601)}', ${identity}, '${id(501)}', '${id(301)}',
        '${id(104)}', 1, '${id(401)}',
        'draft-request-1', '${"b".repeat(64)}', 'SUCCEEDED',
        'provider-secret-ref', 'model-1', '2026-07-01', 'draft-prompt.v1',
        'draft-output.v1', 120, 60, 0.010000, 250, 1, 0,
        '{"passed":true}', now(), now(), 'test', 'test'
      );
      INSERT INTO backlink_draft_versions (
        id, organization_id, workspace_id, website_project_id, draft_id,
        opportunity_id, contact_id, contact_version, version_no, source,
        model_run_id, evidence_snapshot_id,
        subject_text, body_text, structured_output, evidence_ids,
        prompt_version, output_schema_version, model_id, model_version,
        requires_user_confirmation, can_auto_send, created_by
      ) VALUES (
        '${id(701)}', ${identity}, '${id(501)}', '${id(301)}',
        '${id(104)}', 1, 1, 'MODEL',
        '${id(601)}', '${id(401)}', 'A relevant collaboration',
        'Hello, this draft is evidence-backed.',
        '{"subject":"A relevant collaboration"}', '["profile:1"]',
        'draft-prompt.v1', 'draft-output.v1', 'model-1', '2026-07-01',
        true, false, 'test'
      );
      UPDATE backlink_email_drafts
      SET status = 'draft', current_version_id = '${id(701)}',
        last_successful_version_id = '${id(701)}', version = 2,
        updated_at = now(), updated_by = 'test'
      WHERE id = '${id(501)}';
    `);

    await expectCode(client.query(`
      UPDATE backlink_draft_versions
      SET body_text = 'overwritten'
      WHERE id = '${id(701)}'
    `), "55000");
    await expectCode(client.query(`
      DELETE FROM backlink_evidence_snapshots
      WHERE id = '${id(401)}'
    `), "55000");
    expect((await client.query(`
      SELECT status, version, current_version_id AS "currentVersionId"
      FROM backlink_email_drafts WHERE id = '${id(501)}'
    `)).rows).toEqual([{
      status: "draft",
      version: 2,
      currentVersionId: id(701),
    }]);
  });

  it("rejects cross-project references and sendable model output", async () => {
    await expectCode(client.query(`
      INSERT INTO backlink_draft_versions (
        id, organization_id, workspace_id, website_project_id, draft_id,
        opportunity_id, version_no, source, evidence_snapshot_id,
        subject_text, body_text, structured_output, evidence_ids,
        prompt_version, output_schema_version,
        requires_user_confirmation, can_auto_send, created_by
      ) VALUES (
        '${id(702)}', ${identity}, '${id(501)}', '${id(301)}', 2, 'MANUAL',
        '${id(401)}', 'Unsafe', 'Unsafe', '{}', '[]', 'manual.v1', 'manual.v1',
        false, true, 'test'
      )
    `), "23514");
    await expectCode(client.query(`
      INSERT INTO backlink_email_drafts (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        logical_draft_key, status, created_by, updated_by
      ) VALUES (
        '${id(502)}', '${organization}', '${workspace}', '${id(999)}',
        '${id(301)}', 'foreign-project', 'draft', 'test', 'test'
      )
    `), "23503");
  });

  it("enforces forced RLS and append-only writer privileges", async () => {
    const rows = (await client.query(`
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
          'backlink_evidence_snapshots', 'backlink_email_drafts',
          'backlink_model_runs', 'backlink_draft_versions'
        )
      ORDER BY c.relname
    `)).rows;
    expect(rows).toEqual([
      {
        relname: "backlink_draft_versions",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: false,
      },
      {
        relname: "backlink_email_drafts",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: true,
      },
      {
        relname: "backlink_evidence_snapshots",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: false,
      },
      {
        relname: "backlink_model_runs",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: true,
      },
    ]);
  });

  it("isolates Draft rows through the writer role RLS context", async () => {
    await client.query("SET ROLE growthos_backlinks_writer");
    try {
      await client.query(`
        SELECT set_config('app.current_workspace_id', '${workspace}', false),
          set_config('app.current_website_project_id', '${project}', false)
      `);
      expect((await client.query(`
        SELECT
          (SELECT count(*)::integer FROM backlink_evidence_snapshots)
            AS "evidenceSnapshots",
          (SELECT count(*)::integer FROM backlink_email_drafts)
            AS "emailDrafts",
          (SELECT count(*)::integer FROM backlink_model_runs)
            AS "modelRuns",
          (SELECT count(*)::integer FROM backlink_draft_versions)
            AS "draftVersions"
      `)).rows).toEqual([{
        evidenceSnapshots: 1,
        emailDrafts: 1,
        modelRuns: 1,
        draftVersions: 1,
      }]);

      await client.query(`
        SELECT set_config(
          'app.current_website_project_id',
          '${id(999)}',
          false
        )
      `);
      expect((await client.query(`
        SELECT
          (SELECT count(*)::integer FROM backlink_evidence_snapshots)
            AS "evidenceSnapshots",
          (SELECT count(*)::integer FROM backlink_email_drafts)
            AS "emailDrafts",
          (SELECT count(*)::integer FROM backlink_model_runs)
            AS "modelRuns",
          (SELECT count(*)::integer FROM backlink_draft_versions)
            AS "draftVersions"
      `)).rows).toEqual([{
        evidenceSnapshots: 0,
        emailDrafts: 0,
        modelRuns: 0,
        draftVersions: 0,
      }]);
    } finally {
      await client.query("RESET ROLE");
      await client.query("RESET app.current_workspace_id");
      await client.query("RESET app.current_website_project_id");
    }
  });

  it("replays completed generation without another AI call and preserves the last success", async () => {
    const repository = createDraftGenerationRepository(client);
    expect(await repository.prepareEvidenceSnapshot({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
      contactId: id(104),
      contactVersion: 1,
      snapshotId: id(402),
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:29:00.000Z"),
    })).toEqual({ snapshotId: id(402), replayed: false });
    expect(await repository.prepareEvidenceSnapshot({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
      contactId: id(104),
      contactVersion: 1,
      snapshotId: id(405),
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:29:30.000Z"),
    })).toEqual({ snapshotId: id(402), replayed: true });
    const prepared = (await client.query(`
      SELECT evidence_items AS "evidenceItems"
      FROM backlink_evidence_snapshots
      WHERE id='${id(402)}'
    `)).rows[0];
    expect(JSON.stringify(prepared?.evidenceItems)).not.toContain(
      "contact@example.com",
    );
    await expect(repository.prepareEvidenceSnapshot({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
      contactId: id(104),
      contactVersion: 99,
      snapshotId: id(406),
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:29:45.000Z"),
    })).rejects.toThrow("Draft Contact is unavailable or version is stale.");
    const job = await repository.createJob({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
      contactId: id(104),
      contactVersion: 1,
      evidenceSnapshotId: id(402),
      draftId: id(503),
      runId: id(603),
      logicalDraftKey: "workflow-outreach",
      idempotencyKey: "workflow-request-1",
      requestHash: "d".repeat(64),
      promptVersion: "draft-prompt.v1",
      outputSchemaVersion: "draft-output.v1",
      generationMode: "MODEL",
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:30:00.000Z"),
    });
    expect(job).toMatchObject({ status: "QUEUED", draftId: id(503) });

    let calls = 0;
    const ai = {
      async generate() {
        calls += 1;
        return {
          output: {
            subject: "Evidence-led collaboration",
            bodyText: "Hello, this draft uses approved Evidence.",
            personalizationClaims: [{
              text: "Evidence-led",
              evidenceIds: ["profile:current"],
            }],
            missingInformation: [],
            riskFlags: [],
            requiresUserConfirmation: true as const,
            canAutoSend: false as const,
          },
          usage: { inputTokens: 100, outputTokens: 50 },
          model: {
            providerRef: "provider-secret-ref",
            modelId: "model-1",
            modelVersion: "2026-07-01",
          },
          latencyMs: 200,
          repairCount: 0 as const,
          estimatedCostUsd: 0.0025,
        };
      },
    };
    const workflowInput = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      runId: id(603),
      versionId: id(703),
      actorId: "test",
      recordedAt: "2026-07-27T08:31:00.000Z",
      generationMode: "MODEL" as const,
    };

    expect(await runDraftGenerationWorkflow(
      workflowInput,
      repository,
      ai,
    )).toMatchObject({
      outcome: "completed",
      versionId: id(703),
      adoptedAsCurrent: true,
    });
    expect(await runDraftGenerationWorkflow(
      workflowInput,
      repository,
      ai,
    )).toMatchObject({
      outcome: "already_completed",
      versionId: id(703),
    });
    expect(calls).toBe(1);
    const completedJob = await repository.getJob({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      runId: id(603),
    });
    expect(completedJob).toMatchObject({
      status: "SUCCEEDED",
      latencyMs: 200,
      attemptCount: 1,
      lastErrorCategory: null,
    });
    expect(completedJob.startedAt).toBeInstanceOf(Date);
    expect(completedJob.finishedAt).toBeInstanceOf(Date);
    expect(completedJob.persistenceLatencyMs).not.toBeNull();
    expect(completedJob.persistenceLatencyMs).toBeGreaterThanOrEqual(0);
    if (completedJob.startedAt === null || completedJob.finishedAt === null) {
      throw new Error("Completed Draft Job timing fields are missing.");
    }
    expect(completedJob.startedAt.getTime()).toBeGreaterThanOrEqual(
      completedJob.queuedAt.getTime(),
    );
    expect(completedJob.finishedAt.getTime()).toBeGreaterThanOrEqual(
      completedJob.startedAt.getTime(),
    );
    expect(await repository.findLatestJob({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
      logicalDraftKey: "workflow-outreach",
    })).toMatchObject({
      runId: id(603),
      status: "SUCCEEDED",
      draftId: id(503),
    });
    expect((await client.query(`
      SELECT structured_output->'evidenceRefs' AS "evidenceRefs",
        evidence_ids AS "evidenceIds"
      FROM backlink_draft_versions
      WHERE id='${id(703)}'
    `)).rows[0]).toEqual({
      evidenceRefs: ["profile:current"],
      evidenceIds: ["profile:current"],
    });

    const failedJob = await repository.createJob({
      ...job,
      draftId: id(999),
      runId: id(604),
      evidenceSnapshotId: id(402),
      logicalDraftKey: "workflow-outreach",
      idempotencyKey: "workflow-request-2",
      requestHash: "e".repeat(64),
      promptVersion: "draft-prompt.v1",
      outputSchemaVersion: "draft-output.v1",
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:32:00.000Z"),
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
    });
    expect(failedJob.draftId).toBe(id(503));
    await expect(runDraftGenerationWorkflow({
      ...workflowInput,
      runId: id(604),
      versionId: id(704),
    }, repository, {
      async generate() {
        throw new Error("provider unavailable");
      },
    })).rejects.toThrow("provider unavailable");

    expect(await repository.getJob({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      runId: id(604),
    })).toMatchObject({
      status: "FAILED",
      lastSuccessfulVersionId: id(703),
      attemptCount: 1,
      lastErrorCategory: "DRAFT_GENERATION_FAILED",
    });
    await expect(repository.createJob({
      ...failedJob,
      draftId: id(503),
      runId: id(605),
      evidenceSnapshotId: id(402),
      logicalDraftKey: "workflow-outreach",
      idempotencyKey: "workflow-request-2",
      requestHash: "f".repeat(64),
      promptVersion: "draft-prompt.v1",
      outputSchemaVersion: "draft-output.v1",
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:33:00.000Z"),
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      opportunityId: id(301),
    })).rejects.toThrow("Idempotency key payload mismatch.");

    const editing = createDraftEditingRepository(client);
    expect(await editing.saveManualVersion({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      draftId: id(503),
      expectedVersion: 2,
      versionId: id(705),
      subjectText: "Human-edited subject",
      bodyText: "Human-edited body",
      bodyDocument: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "Human-edited body",
            marks: [{ type: "bold" }],
          }],
        }],
      },
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:34:00.000Z"),
    })).toMatchObject({
      state: "completed",
      versionId: id(705),
      draftVersion: 3,
      status: "draft",
    });
    expect((await client.query(`
      SELECT id,subject_text AS "subjectText",body_text AS "bodyText",
        body_document AS "bodyDocument"
      FROM backlink_draft_versions
      WHERE id IN ('${id(703)}','${id(705)}')
      ORDER BY id
    `)).rows).toEqual([
      {
        id: id(703),
        subjectText: "Evidence-led collaboration",
        bodyText: "Hello, this draft uses approved Evidence.",
        bodyDocument: null,
      },
      {
        id: id(705),
        subjectText: "Human-edited subject",
        bodyText: "Human-edited body",
        bodyDocument: {
          type: "doc",
          content: [{
            type: "paragraph",
            content: [{
              type: "text",
              text: "Human-edited body",
              marks: [{ type: "bold" }],
            }],
          }],
        },
      },
    ]);
    expect(await repository.getDraft({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      draftId: id(503),
    })).toMatchObject({
      draftId: id(503),
      draftVersion: 3,
      currentVersion: {
        id: id(705),
        bodyText: "Human-edited body",
        bodyDocument: {
          type: "doc",
          content: [{
            type: "paragraph",
            content: [{
              type: "text",
              text: "Human-edited body",
              marks: [{ type: "bold" }],
            }],
          }],
        },
      },
    });
    expect(await editing.approve({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      draftId: id(503),
      expectedVersion: 2,
      actorId: "test",
      recordedAt: new Date("2026-07-27T08:35:00.000Z"),
    })).toEqual({ state: "version_conflict", currentVersion: 3 });
    const approvedAt = new Date("2026-07-27T08:36:00.000Z");
    expect(await editing.approve({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      draftId: id(503),
      expectedVersion: 3,
      actorId: "test",
      recordedAt: approvedAt,
    })).toMatchObject({
      state: "completed",
      versionId: id(705),
      draftVersion: 4,
      status: "approved",
    });
    expect(await editing.approve({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      draftId: id(503),
      expectedVersion: 3,
      actorId: "test",
      recordedAt: approvedAt,
    })).toEqual({ state: "version_conflict", currentVersion: 4 });
    expect(await editing.approve({
      organizationId: organization,
      workspaceId: id(999),
      websiteProjectId: project,
      draftId: id(503),
      expectedVersion: 4,
      actorId: "foreign-workspace",
      recordedAt: approvedAt,
    })).toEqual({ state: "not_found" });

    const approvalFacts = (await client.query(`
      SELECT lifecycle.event_type AS "eventType",
        lifecycle.sequence,
        lifecycle.aggregate_version AS "aggregateVersion",
        lifecycle.before_state AS "beforeState",
        lifecycle.after_state AS "afterState",
        lifecycle.event_schema_version AS "eventSchemaVersion",
        audit.lifecycle_event_id AS "auditLifecycleEventId",
        audit.action AS "auditAction",
        audit.actor_id AS "auditActorId"
      FROM backlink_lifecycle_events lifecycle
      JOIN backlink_audit_events audit
        ON audit.lifecycle_event_id = lifecycle.id
      WHERE lifecycle.aggregate_type = 'email_draft'
        AND lifecycle.aggregate_id = '${id(503)}'
        AND lifecycle.event_type = 'draft.approval.recorded'
    `)).rows;
    expect(approvalFacts).toHaveLength(1);
    expect(approvalFacts[0]).toMatchObject({
      eventType: "draft.approval.recorded",
      sequence: 4,
      aggregateVersion: 4,
      eventSchemaVersion: 1,
      auditAction: "draft.approved",
      auditActorId: "test",
      beforeState: {
        status: "draft",
        aggregateVersion: 3,
      },
      afterState: {
        draftId: id(503),
        approvedVersionId: id(705),
        previousStatus: "draft",
        nextStatus: "approved",
        previousAggregateVersion: 3,
        nextAggregateVersion: 4,
        actorId: "test",
        contractVersion: "draft-approval-fact.v1",
      },
    });
    expect(
      new Date(String(
        (approvalFacts[0]?.afterState as Record<string, unknown>).occurredAt,
      )).toISOString(),
    ).toBe(approvedAt.toISOString());
  });

  it("rolls back Draft approval when its lifecycle/audit append fails", async () => {
    await client.query(`
      INSERT INTO backlink_evidence_snapshots (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        evidence_items, snapshot_hash, schema_version, created_by
      ) VALUES (
        '${id(403)}', ${identity}, '${id(301)}',
        '[{"id":"profile:403","status":"ACTIVE","visibility":"VISIBLE",
          "confidence":0.9,"sourceKind":"PROFILE","value":"Rollback"}]',
        '${"4".repeat(64)}', 1, 'test'
      );
      INSERT INTO backlink_email_drafts (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        contact_id, contact_version, logical_draft_key, status,
        created_by, updated_by
      ) VALUES (
        '${id(504)}', ${identity}, '${id(301)}', '${id(104)}', 1,
        'rollback-approval',
        'draft', 'test', 'test'
      );
      INSERT INTO backlink_draft_versions (
        id, organization_id, workspace_id, website_project_id, draft_id,
        opportunity_id, contact_id, contact_version, version_no, source,
        evidence_snapshot_id,
        subject_text, body_text, structured_output, evidence_ids,
        prompt_version, output_schema_version,
        requires_user_confirmation, can_auto_send, created_by
      ) VALUES (
        '${id(706)}', ${identity}, '${id(504)}', '${id(301)}',
        '${id(104)}', 1, 1, 'MANUAL',
        '${id(403)}', 'Rollback subject', 'Rollback body', '{}', '[]',
        'manual.v1', 'draft-output.v1', true, false, 'test'
      );
      UPDATE backlink_email_drafts
      SET current_version_id = '${id(706)}',
        last_successful_version_id = '${id(706)}', version = 2
      WHERE id = '${id(504)}';
      CREATE FUNCTION fail_draft_approval_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'draft.approved'
           AND NEW.target_id = '${id(504)}'::uuid THEN
          RAISE EXCEPTION 'forced draft approval audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_draft_approval_audit
      BEFORE INSERT ON backlink_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_draft_approval_audit();
    `);
    try {
      const editing = createDraftEditingRepository(client);
      await expect(editing.approve({
        organizationId: organization,
        workspaceId: workspace,
        websiteProjectId: project,
        draftId: id(504),
        expectedVersion: 2,
        actorId: "test",
        recordedAt: new Date("2026-07-29T04:02:00.000Z"),
      })).rejects.toThrow("forced draft approval audit failure");
    } finally {
      await client.query(`
        DROP TRIGGER fail_draft_approval_audit ON backlink_audit_events;
        DROP FUNCTION fail_draft_approval_audit();
      `);
    }

    expect((await client.query(`
      SELECT status, version, approved_version_id AS "approvedVersionId",
        (SELECT count(*)::integer FROM backlink_lifecycle_events
          WHERE aggregate_type = 'email_draft'
            AND aggregate_id = '${id(504)}') AS "factCount",
        (SELECT count(*)::integer FROM backlink_audit_events
          WHERE target_id = '${id(504)}'
            AND action = 'draft.approved') AS "auditCount"
      FROM backlink_email_drafts
      WHERE id = '${id(504)}'
    `)).rows).toEqual([{
      status: "draft",
      version: 2,
      approvedVersionId: null,
      factCount: 0,
      auditCount: 0,
    }]);
  });

  it("serializes concurrent Draft approvals into one fact and one conflict", async () => {
    await client.query(`
      INSERT INTO backlink_evidence_snapshots (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        evidence_items, snapshot_hash, schema_version, created_by
      ) VALUES (
        '${id(404)}', ${identity}, '${id(301)}',
        '[{"id":"profile:404","status":"ACTIVE","visibility":"VISIBLE",
          "confidence":0.9,"sourceKind":"PROFILE","value":"Concurrency"}]',
        '${"5".repeat(64)}', 1, 'test'
      );
      INSERT INTO backlink_email_drafts (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        contact_id, contact_version, logical_draft_key, status,
        created_by, updated_by
      ) VALUES (
        '${id(505)}', ${identity}, '${id(301)}', '${id(104)}', 1,
        'concurrent-approval',
        'draft', 'test', 'test'
      );
      INSERT INTO backlink_draft_versions (
        id, organization_id, workspace_id, website_project_id, draft_id,
        opportunity_id, contact_id, contact_version, version_no, source,
        evidence_snapshot_id,
        subject_text, body_text, structured_output, evidence_ids,
        prompt_version, output_schema_version,
        requires_user_confirmation, can_auto_send, created_by
      ) VALUES (
        '${id(707)}', ${identity}, '${id(505)}', '${id(301)}',
        '${id(104)}', 1, 1, 'MANUAL',
        '${id(404)}', 'Concurrent subject', 'Concurrent body', '{}', '[]',
        'manual.v1', 'draft-output.v1', true, false, 'test'
      );
      UPDATE backlink_email_drafts
      SET current_version_id = '${id(707)}',
        last_successful_version_id = '${id(707)}', version = 2
      WHERE id = '${id(505)}';
    `);
    const firstClient = new PgClient({
      connectionString: harness.connectionString,
    });
    const secondClient = new PgClient({
      connectionString: harness.connectionString,
    });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    await Promise.all([
      firstClient.query("SET search_path = backlinks, pg_catalog"),
      secondClient.query("SET search_path = backlinks, pg_catalog"),
    ]);
    try {
      const input = {
        organizationId: organization,
        workspaceId: workspace,
        websiteProjectId: project,
        draftId: id(505),
        expectedVersion: 2,
        actorId: "test",
        recordedAt: new Date("2026-07-29T04:03:00.000Z"),
      };
      const results = await Promise.all([
        createDraftEditingRepository(firstClient).approve(input),
        createDraftEditingRepository(secondClient).approve(input),
      ]);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: "completed",
          draftVersion: 3,
        }),
        { state: "version_conflict", currentVersion: 3 },
      ]));
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
    expect((await client.query(`
      SELECT
        (SELECT count(*)::integer FROM backlink_lifecycle_events
          WHERE aggregate_type = 'email_draft'
            AND aggregate_id = '${id(505)}') AS "factCount",
        (SELECT count(*)::integer FROM backlink_audit_events
          WHERE target_id = '${id(505)}'
            AND action = 'draft.approved') AS "auditCount"
    `)).rows).toEqual([{ factCount: 1, auditCount: 1 }]);
  });
});
