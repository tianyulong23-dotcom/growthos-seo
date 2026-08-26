import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPlacementInitialValidationRepository,
} from "../../../src/modules/backlinks/application/repositories/placement-validation.repository.js";
import {
  createPlacementReviewRepository,
} from "../../../src/modules/backlinks/application/repositories/placement-review.repository.js";
import {
  backlinkPlacementCandidates,
  backlinkPlacements,
  backlinkPlacementValidationRuns,
} from "../../../src/modules/backlinks/db/schema/placements.js";
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
const otherProject = id(4);
const identity = `'${organization}', '${workspace}', '${project}'`;
const otherIdentity =
  `'${organization}', '${workspace}', '${otherProject}'`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

const candidateSql = (
  candidateId: string,
  projectIdentity: string,
  opportunityId: string,
  sourceHash: string,
  targetHash: string,
  evidenceSchemaVersion = 1,
  plannedPlacementId = candidateId,
) => `
  INSERT INTO backlink_placement_candidates (
    id, organization_id, workspace_id, website_project_id, opportunity_id,
    planned_placement_id,
    source_type, source_page_url, normalized_source_url,
    normalized_source_url_hash, target_url, normalized_target_url,
    normalized_target_url_hash, url_normalization_version, status,
    match_status, initial_validation_status, discovery_evidence_snapshot,
    discovery_evidence_hash, evidence_contract_version,
    evidence_schema_version, created_by, updated_by
  ) VALUES (
    '${candidateId}', ${projectIdentity}, '${opportunityId}',
    '${plannedPlacementId}',
    'crawler_discovery', 'https://publisher.example/article',
    'https://publisher.example/article', '${sourceHash}',
    'https://owner.example/guide', 'https://owner.example/guide',
    '${targetHash}', 'whatwg-tldts-v1', 'PENDING_VALIDATION',
    'AUTO_MATCHED', 'PENDING',
    '{"refs":["crawler:page-1"],"sourceReleaseId":"crawler-run-1"}',
    '${"c".repeat(64)}', 'crawler.evidence.v1', ${evidenceSchemaVersion},
    'test', 'test'
  )
`;

const validationSql = (
  validationId: string,
  candidateId: string,
  opportunityId: string,
  status: "VALID" | "INVALID" | "INCONCLUSIVE" | "MANUALLY_CONFIRMED",
  sourceHash: string,
  targetHash: string,
  runNumber = 1,
) => `
  INSERT INTO backlink_placement_validation_runs (
    id, organization_id, workspace_id, website_project_id, candidate_id,
    opportunity_id, run_number, validation_method, status, source_page_url,
    normalized_source_url, normalized_source_url_hash, target_url,
    normalized_target_url, normalized_target_url_hash,
    url_normalization_version, evidence_snapshot, evidence_snapshot_hash,
    evidence_contract_version, evidence_schema_version, evidence_observed_at,
    verified_by, verified_at, audit_event_id, initial_evidence_ref,
    manual_confirmation_reason, created_by
  ) VALUES (
    '${validationId}', ${identity}, '${candidateId}', '${opportunityId}',
    ${runNumber},
    '${status === "MANUALLY_CONFIRMED"
      ? "manual_confirmation"
      : "direct_page_check"}',
    '${status}', 'https://publisher.example/article',
    'https://publisher.example/article', '${sourceHash}',
    'https://owner.example/guide', 'https://owner.example/guide',
    '${targetHash}', 'whatwg-tldts-v1',
    '{"anchor":"streaming guide","rel":["noopener"],"statusCode":200}',
    '${"d".repeat(64)}', 'crawler.evidence.v1', 1,
    '2026-07-27T09:00:00Z', 'placement-validator',
    '2026-07-27T09:00:01Z', 'audit-placement-1', 'crawler:page-1',
    ${status === "MANUALLY_CONFIRMED"
      ? "'approved exception PLC-MANUAL-01'"
      : "NULL"},
    'test'
  )
`;

describe("BL-AI-144 Placement persistence", () => {
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
      "0016_backlink_mail_sync.sql",
      "0028_backlink_placements.sql",
      "0040_backlink_existing_placements.sql",
      "0074_backlink_placement_reply_lineage.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii,
        registrable_domain, normalization_version, created_by, updated_by
      ) VALUES
        (
          '${id(101)}', ${identity}, '${id(102)}', 'publisher.example',
          'publisher.example', 'tldts-7.4.9-v1', 'test', 'test'
        ),
        (
          '${id(111)}', ${otherIdentity}, '${id(112)}',
          'other-publisher.example', 'other-publisher.example',
          'tldts-7.4.9-v1', 'test', 'test'
        );
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES
        (
          '${id(201)}', ${identity}, '${id(101)}', '${id(102)}',
          'accepted', 'test', 'test'
        ),
        (
          '${id(211)}', ${otherIdentity}, '${id(111)}', '${id(112)}',
          'accepted', 'test', 'test'
        );
      INSERT INTO backlink_opportunities (
        id, organization_id, workspace_id, website_project_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        target_site_key, target_host_ascii, target_identity_rule_version,
        join_sequence, created_by, updated_by
      ) VALUES
        (
          '${id(301)}', ${identity}, '${id(201)}', '${id(101)}', '${id(102)}',
          'publisher.example', 'publisher.example', 'tldts-7.4.9-v1', 1,
          'test', 'test'
        ),
        (
          '${id(311)}', ${otherIdentity}, '${id(211)}', '${id(111)}',
          '${id(112)}', 'other-publisher.example', 'other-publisher.example',
          'tldts-7.4.9-v1', 1, 'test', 'test'
        );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares separate Candidate, Validation Run, and Placement schemas", () => {
    const configs = [
      backlinkPlacementCandidates,
      backlinkPlacementValidationRuns,
      backlinkPlacements,
    ].map(getTableConfig);

    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_placement_candidates",
      "backlink_placement_validation_runs",
      "backlink_placements",
    ]);
    expect(
      configs.flatMap(({ foreignKeys }) =>
        foreignKeys.map((key) => key.getName()),
      ),
    ).toEqual(expect.arrayContaining([
      "backlink_placement_candidate_opportunity_fk",
      "backlink_placement_validation_candidate_identity_fk",
      "backlink_placement_validation_candidate_fk",
      "backlink_placement_candidate_identity_fk",
      "backlink_placement_candidate_fk",
      "backlink_placement_opportunity_fk",
      "backlink_placement_initial_validation_identity_fk",
      "backlink_placement_initial_validation_fk",
    ]));
  });

  it("keeps a candidate out of confirmed Placements until validation passes", async () => {
    const sourceHash = "a".repeat(64);
    const targetHash = "b".repeat(64);
    await client.query(
      candidateSql(
        id(401),
        identity,
        id(301),
        sourceHash,
        targetHash,
        1,
        id(602),
      ),
    );
    expect((await client.query(`
      SELECT
        (SELECT count(*)::integer FROM backlink_placement_candidates)
          AS candidates,
        (SELECT count(*)::integer FROM backlink_placements) AS placements
    `)).rows).toEqual([{ candidates: 1, placements: 0 }]);

    await client.query(validationSql(
      id(501),
      id(401),
      id(301),
      "INVALID",
      sourceHash,
      targetHash,
    ));
    await expectCode(client.query(`
      INSERT INTO backlink_placements (
        id, organization_id, workspace_id, website_project_id, candidate_id,
        opportunity_id, initial_validation_id, initial_validation_status,
        source_page_url, normalized_source_url, normalized_source_url_hash,
        target_url, normalized_target_url, normalized_target_url_hash,
        url_normalization_version, initial_evidence_snapshot_hash,
        evidence_contract_version, initial_evidence_schema_version,
        created_by, updated_by
      ) VALUES (
        '${id(601)}', ${identity}, '${id(401)}', '${id(301)}', '${id(501)}',
        'INVALID', 'https://publisher.example/article',
        'https://publisher.example/article', '${sourceHash}',
        'https://owner.example/guide', 'https://owner.example/guide',
        '${targetHash}', 'whatwg-tldts-v1', '${"d".repeat(64)}',
        'crawler.evidence.v1', 1, 'test', 'test'
      )
    `), "23514");

    await client.query(validationSql(
      id(502),
      id(401),
      id(301),
      "VALID",
      sourceHash,
      targetHash,
      2,
    ));
    await client.query(`
      INSERT INTO backlink_placements (
        id, organization_id, workspace_id, website_project_id, candidate_id,
        opportunity_id, initial_validation_id, initial_validation_status,
        source_page_url, normalized_source_url, normalized_source_url_hash,
        target_url, normalized_target_url, normalized_target_url_hash,
        url_normalization_version, initial_evidence_snapshot_hash,
        evidence_contract_version, initial_evidence_schema_version,
        created_by, updated_by
      ) VALUES (
        '${id(602)}', ${identity}, '${id(401)}', '${id(301)}', '${id(502)}',
        'VALID', 'https://publisher.example/article',
        'https://publisher.example/article', '${sourceHash}',
        'https://owner.example/guide', 'https://owner.example/guide',
        '${targetHash}', 'whatwg-tldts-v1', '${"d".repeat(64)}',
        'crawler.evidence.v1', 1, 'test', 'test'
      )
    `);
    expect((await client.query(
      "SELECT count(*)::integer AS count FROM backlink_placements",
    )).rows).toEqual([{ count: 1 }]);
    await expectCode(client.query(`
      UPDATE backlink_placements
      SET initial_validation_id = '${id(501)}',
        initial_validation_status = 'INVALID', version = version + 1
      WHERE id = '${id(602)}'
    `), "55000");
  });

  it("requires versioned evidence snapshots and strict URL hashes", async () => {
    await expectCode(client.query(
      candidateSql(
        id(402),
        identity,
        id(301),
        "not-a-hash",
        "b".repeat(64),
      ),
    ), "23514");

    await expectCode(client.query(
      candidateSql(
        id(403),
        identity,
        id(301),
        "e".repeat(64),
        "f".repeat(64),
        0,
      ),
    ), "23514");
  });

  it("enforces owner, forced RLS, and project isolation", async () => {
    await client.query(candidateSql(
      id(411),
      otherIdentity,
      id(311),
      "1".repeat(64),
      "2".repeat(64),
    ));
    const metadata = (await client.query(`
      SELECT c.relname,
        c.relrowsecurity AND c.relforcerowsecurity AS secure,
        pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'backlinks'
        AND c.relname IN (
          'backlink_placement_candidates',
          'backlink_placement_validation_runs',
          'backlink_placements'
        )
      ORDER BY c.relname
    `)).rows;
    expect(metadata).toEqual([
      {
        relname: "backlink_placement_candidates",
        secure: true,
        owner: "growthos_backlinks_owner",
      },
      {
        relname: "backlink_placement_validation_runs",
        secure: true,
        owner: "growthos_backlinks_owner",
      },
      {
        relname: "backlink_placements",
        secure: true,
        owner: "growthos_backlinks_owner",
      },
    ]);

    await client.query(`
      SET ROLE growthos_backlinks_writer;
      SET search_path = backlinks, pg_catalog;
      SELECT set_config('app.current_organization_id', '${organization}', false);
      SELECT set_config('app.current_workspace_id', '${workspace}', false);
      SELECT set_config('app.current_website_project_id', '${project}', false);
    `);
    expect((await client.query(`
      SELECT id FROM backlink_placement_candidates ORDER BY id
    `)).rows).toEqual([{ id: id(401) }]);
    await expectCode(client.query(candidateSql(
      id(412),
      otherIdentity,
      id(311),
      "3".repeat(64),
      "4".repeat(64),
    )), "42501");
    await client.query("RESET ROLE");
  });

  it("atomically records VALID evidence, Placement, and monitoring Outbox", async () => {
    const candidateId = id(421);
    const validationRunId = id(521);
    const placementId = id(621);
    const outboxId = id(721);
    const placementLifecycleEventId = id(821);
    await client.query(candidateSql(
      candidateId,
      identity,
      id(301),
      "5".repeat(64),
      "6".repeat(64),
      1,
      placementId,
    ));
    const repository = createPlacementInitialValidationRepository(client);
    expect(await repository.getCandidate({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
    })).toMatchObject({
      state: "ready",
      candidate: { candidateId, version: 1 },
    });

    const recordInput = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
      expectedCandidateVersion: 1,
      validationRunId,
      placementId,
      monitoringOutboxEventId: outboxId,
      placementLifecycleEventId,
      status: "VALID" as const,
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: { status: "VALID", reasonCode: "TARGET_LINK_FOUND" },
      },
      evidenceSnapshotHash: "e".repeat(64),
      evidenceContractVersion: "placement.initial-validation.v1",
      evidenceSchemaVersion: 1,
      evidenceObservedAt: new Date("2026-07-27T10:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T10:00:01.000Z"),
      verifiedBy: "placement-validator",
      auditEventId: "audit-placement-421",
      initialEvidenceRef: `placement-validation:${validationRunId}`,
    };
    expect(await repository.record(recordInput)).toEqual({
      state: "recorded",
      candidateId,
      validationRunId,
      status: "VALID",
      placementId,
      monitoringOutboxEventId: outboxId,
    });

    expect((await client.query(`
      SELECT c.status AS "candidateStatus",
        c.initial_validation_status AS "validationStatus",
        count(DISTINCT v.id)::integer AS validations,
        count(DISTINCT p.id)::integer AS placements,
        count(DISTINCT e.id)::integer AS outbox,
        count(DISTINCT l.id)::integer AS lifecycle
      FROM backlink_placement_candidates c
      LEFT JOIN backlink_placement_validation_runs v
        ON v.candidate_id=c.id
      LEFT JOIN backlink_placements p ON p.candidate_id=c.id
      LEFT JOIN backlink_outbox_events e ON
        e.aggregate_id=p.id
        AND e.event_type='backlinks.placement-monitoring.requested.v1'
      LEFT JOIN backlink_lifecycle_events l ON
        l.aggregate_id=p.id
        AND l.aggregate_type='placement'
        AND l.event_type='placement.confirmed'
      WHERE c.id='${candidateId}'
      GROUP BY c.status,c.initial_validation_status
    `)).rows).toEqual([{
      candidateStatus: "PROMOTED",
      validationStatus: "VALID",
      validations: 1,
      placements: 1,
      outbox: 1,
      lifecycle: 1,
    }]);

    expect(await repository.record(recordInput)).toEqual({
      state: "existing",
      candidateId,
      validationRunId,
      status: "VALID",
      placementId,
      monitoringOutboxEventId: outboxId,
    });
  });

  it("records a manually entered existing link without an Opportunity", async () => {
    const candidateId = id(490);
    const validationRunId = id(590);
    const placementId = id(690);
    const outboxId = id(790);
    const sourceHash = "0".repeat(64);
    const targetHash = "d".repeat(64);
    await client.query(`
      INSERT INTO backlink_placement_candidates (
        id,organization_id,workspace_id,website_project_id,opportunity_id,
        planned_placement_id,
        source_type,source_external_id,source_page_url,normalized_source_url,
        normalized_source_url_hash,target_url,normalized_target_url,
        normalized_target_url_hash,url_normalization_version,status,
        match_status,initial_validation_status,discovery_evidence_snapshot,
        discovery_evidence_hash,evidence_contract_version,
        evidence_schema_version,created_by,updated_by
      ) VALUES (
        '${candidateId}',${identity},NULL,'${placementId}',
        'manual','existing-link-490',
        'https://existing.example/article',
        'https://existing.example/article','${sourceHash}',
        'https://owner.example/existing',
        'https://owner.example/existing','${targetHash}',
        'whatwg-tldts-v1','PENDING_VALIDATION','UNMATCHED','PENDING',
        '{"source":"manual-existing-link"}','${"b".repeat(64)}',
        'placement.user-entry.v1',1,'test','test'
      )
    `);
    const repository = createPlacementInitialValidationRepository(client);

    expect(await repository.getCandidate({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
    })).toMatchObject({
      state: "ready",
      candidate: {
        candidateId,
        opportunityId: null,
        sourceType: "manual",
      },
    });

    expect(await repository.record({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
      expectedCandidateVersion: 1,
      validationRunId,
      placementId,
      monitoringOutboxEventId: outboxId,
      placementLifecycleEventId: id(890),
      status: "VALID",
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: { status: "VALID", reasonCode: "TARGET_LINK_FOUND" },
      },
      evidenceSnapshotHash: "c".repeat(64),
      evidenceContractVersion: "placement.initial-validation.v1",
      evidenceSchemaVersion: 1,
      evidenceObservedAt: new Date("2026-08-04T01:00:00.000Z"),
      verifiedAt: new Date("2026-08-04T01:00:01.000Z"),
      verifiedBy: "placement-validator",
      auditEventId: "audit-placement-490",
      initialEvidenceRef: `placement-validation:${validationRunId}`,
    })).toEqual({
      state: "recorded",
      candidateId,
      validationRunId,
      status: "VALID",
      placementId,
      monitoringOutboxEventId: outboxId,
    });

    expect((await client.query(`
      SELECT p.opportunity_id AS "opportunityId",
        e.payload->'opportunityId' AS "outboxOpportunityId"
      FROM backlink_placements p
      JOIN backlink_outbox_events e
        ON e.aggregate_id=p.id
       AND e.event_type='backlinks.placement-monitoring.requested.v1'
      WHERE p.id='${placementId}'
    `)).rows).toEqual([{
      opportunityId: null,
      outboxOpportunityId: null,
    }]);
  });

  it("retains INVALID evidence and Candidate without creating Placement facts", async () => {
    const candidateId = id(422);
    const validationRunId = id(522);
    await client.query(candidateSql(
      candidateId,
      identity,
      id(301),
      "7".repeat(64),
      "8".repeat(64),
    ));
    const repository = createPlacementInitialValidationRepository(client);

    expect(await repository.record({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
      expectedCandidateVersion: 1,
      validationRunId,
      placementId: id(622),
      monitoringOutboxEventId: id(722),
      placementLifecycleEventId: id(822),
      status: "INVALID",
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: { status: "INVALID", reasonCode: "TARGET_LINK_MISSING" },
      },
      evidenceSnapshotHash: "f".repeat(64),
      evidenceContractVersion: "placement.initial-validation.v1",
      evidenceSchemaVersion: 1,
      evidenceObservedAt: new Date("2026-07-27T10:01:00.000Z"),
      verifiedAt: new Date("2026-07-27T10:01:01.000Z"),
      verifiedBy: "placement-validator",
      auditEventId: "audit-placement-422",
      initialEvidenceRef: `placement-validation:${validationRunId}`,
    })).toEqual({
      state: "recorded",
      candidateId,
      validationRunId,
      status: "INVALID",
      placementId: null,
      monitoringOutboxEventId: null,
    });

    expect((await client.query(`
      SELECT c.status AS "candidateStatus",
        c.initial_validation_status AS "validationStatus",
        c.discovery_evidence_snapshot AS "discoveryEvidence",
        count(DISTINCT v.id)::integer AS validations,
        count(DISTINCT p.id)::integer AS placements,
        count(DISTINCT e.id)::integer AS outbox
      FROM backlink_placement_candidates c
      LEFT JOIN backlink_placement_validation_runs v
        ON v.candidate_id=c.id
      LEFT JOIN backlink_placements p ON p.candidate_id=c.id
      LEFT JOIN backlink_outbox_events e ON e.aggregate_id=p.id
      WHERE c.id='${candidateId}'
      GROUP BY c.status,c.initial_validation_status,
        c.discovery_evidence_snapshot
    `)).rows).toEqual([{
      candidateStatus: "REVIEW_REQUIRED",
      validationStatus: "INVALID",
      discoveryEvidence: {
        refs: ["crawler:page-1"],
        sourceReleaseId: "crawler-run-1",
      },
      validations: 1,
      placements: 0,
      outbox: 0,
    }]);
  });

  it("atomically confirms an inconclusive Candidate with audit and KPI projections", async () => {
    const candidateId = id(423);
    const initialValidationId = id(523);
    const manualValidationId = id(524);
    const placementId = id(623);
    const outboxId = id(723);
    const lifecycleId = id(823);
    const auditId = id(923);
    await client.query(candidateSql(
      candidateId,
      identity,
      id(301),
      "9".repeat(64),
      "a".repeat(64),
      1,
      placementId,
    ));
    await client.query(`
      UPDATE backlink_opportunities
      SET business_stage='WAITING_PLACEMENT',
        fulfillment_status='PENDING',
        version=version+1,
        updated_by='test'
      WHERE id='${id(301)}'
    `);
    const validationRepository =
      createPlacementInitialValidationRepository(client);
    expect(await validationRepository.record({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
      expectedCandidateVersion: 1,
      validationRunId: initialValidationId,
      placementId: id(624),
      monitoringOutboxEventId: id(724),
      placementLifecycleEventId: id(824),
      status: "INCONCLUSIVE",
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: {
          status: "INCONCLUSIVE",
          reasonCode: "SAFE_FETCH_TIMEOUT",
        },
      },
      evidenceSnapshotHash: "1".repeat(64),
      evidenceContractVersion: "placement.initial-validation.v1",
      evidenceSchemaVersion: 1,
      evidenceObservedAt: new Date("2026-07-27T10:02:00.000Z"),
      verifiedAt: new Date("2026-07-27T10:02:01.000Z"),
      verifiedBy: "placement-validator",
      auditEventId: "audit-placement-423",
      initialEvidenceRef: `placement-validation:${initialValidationId}`,
    })).toMatchObject({
      state: "recorded",
      status: "INCONCLUSIVE",
      placementId: null,
      monitoringOutboxEventId: null,
    });

    const repository = createPlacementReviewRepository(client);
    expect(await repository.getCandidate({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
    })).toMatchObject({
      candidateStatus: "REVIEW_REQUIRED",
      initialValidationStatus: "INCONCLUSIVE",
      version: 2,
      latestValidation: {
        validationRunId: initialValidationId,
        reasonCode: "SAFE_FETCH_TIMEOUT",
      },
    });

    const reviewedAt = new Date("2026-07-27T10:03:00.000Z");
    const reviewInput = {
      action: "manual_confirm" as const,
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      actorId: "reviewer-149",
      candidateId,
      expectedVersion: 2,
      reason: "Rendered-page review confirmed the target link.",
      previousValidationRunId: initialValidationId,
      previousValidationStatus: "INCONCLUSIVE" as const,
      previousReasonCode: "SAFE_FETCH_TIMEOUT",
      validationRunId: manualValidationId,
      placementId,
      monitoringOutboxEventId: outboxId,
      lifecycleEventId: lifecycleId,
      placementLifecycleEventId: id(825),
      auditEventId: auditId,
      requestId: "request-149-confirm",
      reviewedAt,
      manualEvidenceSnapshot: {
        contractVersion: "placement.manual-review.v1",
        decision: "MANUALLY_CONFIRMED",
        reason: "Rendered-page review confirmed the target link.",
        overriddenValidation: {
          validationRunId: initialValidationId,
          status: "INCONCLUSIVE",
          reasonCode: "SAFE_FETCH_TIMEOUT",
          evidenceSnapshotHash: "1".repeat(64),
        },
      },
      manualEvidenceSnapshotHash: "2".repeat(64),
      evidenceContractVersion: "placement.manual-review.v1",
      evidenceSchemaVersion: 1,
      initialEvidenceRef:
        `placement-validation:${manualValidationId};overrides:${initialValidationId}`,
      auditIntegrityHash: "3".repeat(64),
    };
    expect(await repository.review(reviewInput)).toEqual({
      state: "completed",
      response: {
        action: "manual_confirm",
        candidateId,
        candidateStatus: "PROMOTED",
        initialValidationStatus: "MANUALLY_CONFIRMED",
        candidateVersion: 3,
        validationRunId: manualValidationId,
        placementId,
        placementVersion: 1,
        monitoringOutboxEventId: outboxId,
        lifecycleEventId: lifecycleId,
        auditEventId: auditId,
      },
    });

    expect((await client.query(`
      SELECT c.status AS "candidateStatus",
        c.initial_validation_status AS "validationStatus",
        c.version AS "candidateVersion",
        o.business_stage AS "businessStage",
        o.fulfillment_status AS "fulfillmentStatus",
        (SELECT count(*)::integer
          FROM backlink_placement_validation_runs v
          WHERE v.candidate_id=c.id) AS validations,
        (SELECT count(*)::integer FROM backlink_placements p
          WHERE p.candidate_id=c.id) AS placements,
        (SELECT count(*)::integer FROM backlink_outbox_events e
          WHERE e.aggregate_id='${placementId}'
            AND e.event_type=
              'backlinks.placement-monitoring.requested.v1') AS outbox,
        (SELECT count(*)::integer FROM backlink_lifecycle_events l
          WHERE l.aggregate_id=c.id) AS lifecycle,
        (SELECT count(*)::integer FROM backlink_lifecycle_events l
          WHERE l.aggregate_type='placement'
            AND l.aggregate_id='${placementId}'
            AND l.event_type='placement.confirmed')
          AS "placementLifecycle",
        (SELECT count(*)::integer FROM backlink_audit_events a
          WHERE a.target_id=c.id) AS audit,
        (SELECT v.manual_confirmation_reason
          FROM backlink_placement_validation_runs v
          WHERE v.id='${manualValidationId}') AS "manualReason",
        (SELECT l.before_state
          FROM backlink_lifecycle_events l
          WHERE l.id='${lifecycleId}') AS "beforeState",
        (SELECT e.payload
          FROM backlink_outbox_events e
          WHERE e.id='${outboxId}') AS "outboxPayload"
      FROM backlink_placement_candidates c
      JOIN backlink_opportunities o ON o.id=c.opportunity_id
      WHERE c.id='${candidateId}'
    `)).rows).toEqual([{
      candidateStatus: "PROMOTED",
      validationStatus: "MANUALLY_CONFIRMED",
      candidateVersion: 3,
      businessStage: "RELATIONSHIP_ACTIVE",
      fulfillmentStatus: "FULFILLED",
      validations: 2,
      placements: 1,
      outbox: 1,
      lifecycle: 1,
      placementLifecycle: 1,
      audit: 1,
      manualReason: "Rendered-page review confirmed the target link.",
      beforeState: expect.objectContaining({
        candidateStatus: "REVIEW_REQUIRED",
        candidateVersion: 2,
        validationRunId: initialValidationId,
        validationStatus: "INCONCLUSIVE",
        reasonCode: "SAFE_FETCH_TIMEOUT",
        evidenceSnapshotHash: "1".repeat(64),
      }),
      outboxPayload: expect.objectContaining({
        placementId,
        candidateId,
        countsTowardKpi: true,
        reviewAction: "manual_confirm",
      }),
    }]);

    expect(await repository.review(reviewInput)).toEqual({
      state: "version_conflict",
    });
    expect((await client.query(`
      SELECT
        (SELECT count(*)::integer
          FROM backlink_placement_validation_runs
          WHERE candidate_id='${candidateId}') AS validations,
        (SELECT count(*)::integer FROM backlink_placements
          WHERE candidate_id='${candidateId}') AS placements,
        (SELECT count(*)::integer FROM backlink_outbox_events
          WHERE aggregate_id='${placementId}') AS outbox,
        (SELECT count(*)::integer FROM backlink_lifecycle_events
          WHERE aggregate_id='${candidateId}') AS lifecycle,
        (SELECT count(*)::integer FROM backlink_lifecycle_events
          WHERE aggregate_type='placement'
            AND aggregate_id='${placementId}'
            AND event_type='placement.confirmed')
          AS "placementLifecycle",
        (SELECT count(*)::integer FROM backlink_audit_events
          WHERE target_id='${candidateId}') AS audit
    `)).rows).toEqual([{
      validations: 2,
      placements: 1,
      outbox: 1,
      lifecycle: 1,
      placementLifecycle: 1,
      audit: 1,
    }]);
  });

  it("rejects a reviewed Candidate without creating Placement or KPI facts", async () => {
    const candidateId = id(424);
    const validationRunId = id(525);
    const lifecycleId = id(824);
    const auditId = id(924);
    await client.query(candidateSql(
      candidateId,
      identity,
      id(301),
      "b".repeat(64),
      "c".repeat(64),
    ));
    const validationRepository =
      createPlacementInitialValidationRepository(client);
    expect(await validationRepository.record({
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      candidateId,
      expectedCandidateVersion: 1,
      validationRunId,
      placementId: id(625),
      monitoringOutboxEventId: id(725),
      placementLifecycleEventId: id(827),
      status: "INVALID",
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: {
          status: "INVALID",
          reasonCode: "TARGET_LINK_MISSING",
        },
      },
      evidenceSnapshotHash: "4".repeat(64),
      evidenceContractVersion: "placement.initial-validation.v1",
      evidenceSchemaVersion: 1,
      evidenceObservedAt: new Date("2026-07-27T10:04:00.000Z"),
      verifiedAt: new Date("2026-07-27T10:04:01.000Z"),
      verifiedBy: "placement-validator",
      auditEventId: "audit-placement-424",
      initialEvidenceRef: `placement-validation:${validationRunId}`,
    })).toMatchObject({
      state: "recorded",
      status: "INVALID",
      placementId: null,
      monitoringOutboxEventId: null,
    });

    const repository = createPlacementReviewRepository(client);
    const reviewInput = {
      action: "reject" as const,
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      actorId: "reviewer-149",
      candidateId,
      expectedVersion: 2,
      reason: "The target link is absent from the submitted page.",
      previousValidationRunId: validationRunId,
      previousValidationStatus: "INVALID" as const,
      previousReasonCode: "TARGET_LINK_MISSING",
      lifecycleEventId: lifecycleId,
      auditEventId: auditId,
      requestId: "request-149-reject",
      reviewedAt: new Date("2026-07-27T10:05:00.000Z"),
      auditIntegrityHash: "5".repeat(64),
    };
    expect(await repository.review(reviewInput)).toEqual({
      state: "completed",
      response: {
        action: "reject",
        candidateId,
        candidateStatus: "REJECTED",
        initialValidationStatus: "INVALID",
        candidateVersion: 3,
        lifecycleEventId: lifecycleId,
        auditEventId: auditId,
      },
    });

    expect((await client.query(`
      SELECT c.status AS "candidateStatus",
        c.initial_validation_status AS "validationStatus",
        c.version AS "candidateVersion",
        (SELECT count(*)::integer
          FROM backlink_placement_validation_runs v
          WHERE v.candidate_id=c.id) AS validations,
        (SELECT count(*)::integer FROM backlink_placements p
          WHERE p.candidate_id=c.id) AS placements,
        (SELECT count(*)::integer FROM backlink_outbox_events e
          JOIN backlink_placements p ON p.id=e.aggregate_id
          WHERE p.candidate_id=c.id) AS outbox,
        (SELECT count(*)::integer FROM backlink_lifecycle_events l
          WHERE l.aggregate_id=c.id) AS lifecycle,
        (SELECT count(*)::integer FROM backlink_audit_events a
          WHERE a.target_id=c.id) AS audit,
        (SELECT l.before_state
          FROM backlink_lifecycle_events l
          WHERE l.id='${lifecycleId}') AS "beforeState"
      FROM backlink_placement_candidates c
      WHERE c.id='${candidateId}'
    `)).rows).toEqual([{
      candidateStatus: "REJECTED",
      validationStatus: "INVALID",
      candidateVersion: 3,
      validations: 1,
      placements: 0,
      outbox: 0,
      lifecycle: 1,
      audit: 1,
      beforeState: expect.objectContaining({
        candidateStatus: "REVIEW_REQUIRED",
        candidateVersion: 2,
        validationRunId,
        validationStatus: "INVALID",
        reasonCode: "TARGET_LINK_MISSING",
        evidenceSnapshotHash: "4".repeat(64),
      }),
    }]);

    expect(await repository.review(reviewInput)).toEqual({
      state: "version_conflict",
    });
  });
});
