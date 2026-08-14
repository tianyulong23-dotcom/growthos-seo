import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backlinkMonitorObservations,
  backlinkMonitorPolicies,
  backlinkMonitorRuns,
} from "../../../src/modules/backlinks/db/schema/monitoring.js";
import {
  createMonitoringScheduleRepository,
} from "../../../src/modules/backlinks/db/repositories/monitoring-schedule.repository.js";
import {
  createPlacementMonitorRepository,
} from "../../../src/modules/backlinks/application/repositories/placement-monitor.repository.js";
import {
  createPlacementReverifyCommand,
} from "../../../src/modules/backlinks/application/commands/placement-reverify.command.js";
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
const policyId = id(701);
const placementId = id(601);
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-150 backlink monitoring persistence", () => {
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
      "0028_backlink_placements.sql",
      "0029_backlink_monitoring.sql",
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
        '${id(101)}', ${identity}, '${id(102)}', 'publisher.example',
        'publisher.example', 'tldts-7.4.9-v1', 'test', 'test'
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
        'publisher.example', 'publisher.example', 'tldts-7.4.9-v1', 1,
        'test', 'test'
      );
      INSERT INTO backlink_placement_candidates (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        source_type, source_page_url, normalized_source_url,
        normalized_source_url_hash, target_url, normalized_target_url,
        normalized_target_url_hash, url_normalization_version, status,
        match_status, initial_validation_status, discovery_evidence_snapshot,
        discovery_evidence_hash, evidence_contract_version,
        evidence_schema_version, created_by, updated_by
      ) VALUES (
        '${id(401)}', ${identity}, '${id(301)}', 'crawler_discovery',
        'https://publisher.example/article',
        'https://publisher.example/article', '${"a".repeat(64)}',
        'https://owner.example/guide', 'https://owner.example/guide',
        '${"b".repeat(64)}', 'whatwg-tldts-v1', 'PROMOTED', 'AUTO_MATCHED',
        'VALID', '{"source":"crawler"}', '${"c".repeat(64)}',
        'crawler.evidence.v1', 1, 'test', 'test'
      );
      INSERT INTO backlink_placement_validation_runs (
        id, organization_id, workspace_id, website_project_id, candidate_id,
        opportunity_id, run_number, validation_method, status, source_page_url,
        normalized_source_url, normalized_source_url_hash, target_url,
        normalized_target_url, normalized_target_url_hash,
        url_normalization_version, evidence_snapshot, evidence_snapshot_hash,
        evidence_contract_version, evidence_schema_version, evidence_observed_at,
        verified_by, verified_at, audit_event_id, initial_evidence_ref,
        created_by
      ) VALUES (
        '${id(501)}', ${identity}, '${id(401)}', '${id(301)}', 1,
        'direct_page_check', 'VALID', 'https://publisher.example/article',
        'https://publisher.example/article', '${"a".repeat(64)}',
        'https://owner.example/guide', 'https://owner.example/guide',
        '${"b".repeat(64)}', 'whatwg-tldts-v1',
        '{"result":"VALID"}', '${"d".repeat(64)}', 'crawler.evidence.v1', 1,
        '2026-07-27T09:00:00Z', 'validator', '2026-07-27T09:00:01Z',
        'audit-501', 'crawler:page-1', 'test'
      );
      INSERT INTO backlink_placements (
        id, organization_id, workspace_id, website_project_id, candidate_id,
        opportunity_id, initial_validation_id, initial_validation_status,
        source_page_url, normalized_source_url, normalized_source_url_hash,
        target_url, normalized_target_url, normalized_target_url_hash,
        url_normalization_version, initial_evidence_snapshot_hash,
        evidence_contract_version, initial_evidence_schema_version,
        created_by, updated_by
      ) VALUES (
        '${placementId}', ${identity}, '${id(401)}', '${id(301)}', '${id(501)}',
        'VALID', 'https://publisher.example/article',
        'https://publisher.example/article', '${"a".repeat(64)}',
        'https://owner.example/guide', 'https://owner.example/guide',
        '${"b".repeat(64)}', 'whatwg-tldts-v1', '${"d".repeat(64)}',
        'crawler.evidence.v1', 1, 'test', 'test'
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares Policy, Run, and immutable Observation schemas", () => {
    const configs = [
      backlinkMonitorPolicies,
      backlinkMonitorRuns,
      backlinkMonitorObservations,
    ].map(getTableConfig);

    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_monitor_policies",
      "backlink_monitor_runs",
      "backlink_monitor_observations",
    ]);
    expect(
      configs.flatMap(({ foreignKeys }) =>
        foreignKeys.map((key) => key.getName()),
      ),
    ).toEqual([
      "backlink_monitor_policy_placement_fk",
      "backlink_monitor_run_placement_fk",
      "backlink_monitor_run_policy_fk",
      "backlink_monitor_observation_run_fk",
    ]);
  });

  it("stores bounded daily scheduling, retry, and confirmation policy", async () => {
    await client.query(`
      INSERT INTO backlink_monitor_policies (
        id, organization_id, workspace_id, website_project_id, placement_id,
        policy_version, next_check_at, schema_version, created_by, updated_by
      ) VALUES (
        '${policyId}', ${identity}, '${placementId}', 'placement-monitoring-v1',
        '2026-07-28T09:00:00Z', 1, 'test', 'test'
      )
    `);
    expect((await client.query(`
      SELECT normal_interval_seconds AS "normalInterval",
        suspected_recheck_interval_seconds AS "suspectedInterval",
        jitter_window_seconds AS "jitterWindow",
        retry_initial_delay_seconds AS "retryInitial",
        retry_max_delay_seconds AS "retryMax",
        retry_backoff_multiplier AS "retryMultiplier",
        max_retry_attempts AS "maxAttempts",
        loss_confirmation_count AS "lossConfirmations",
        change_confirmation_count AS "changeConfirmations",
        browser_fallback_enabled AS "browserFallback"
      FROM backlink_monitor_policies WHERE id='${policyId}'
    `)).rows).toEqual([{
      normalInterval: 86_400,
      suspectedInterval: 3_600,
      jitterWindow: 3_600,
      retryInitial: 60,
      retryMax: 3_600,
      retryMultiplier: 2,
      maxAttempts: 3,
      lossConfirmations: 2,
      changeConfirmations: 2,
      browserFallback: false,
    }]);
    await expectCode(client.query(`
      INSERT INTO backlink_monitor_policies (
        id, organization_id, workspace_id, website_project_id, placement_id,
        policy_version, next_check_at, schema_version, created_by, updated_by
      ) VALUES (
        '${id(702)}', ${identity}, '${placementId}', 'placement-monitoring-v1',
        '2026-07-29T09:00:00Z', 1, 'test', 'test'
      )
    `), "23505");
    await expectCode(client.query(`
      INSERT INTO backlink_monitor_policies (
        id, organization_id, workspace_id, website_project_id, placement_id,
        policy_version, next_check_at, retry_initial_delay_seconds,
        retry_max_delay_seconds, loss_confirmation_count, schema_version,
        created_by, updated_by
      ) VALUES (
        '${id(703)}', ${identity}, '${placementId}', 'invalid-policy-v2',
        '2026-07-29T09:00:00Z', 120, 60, 1, 1, 'test', 'test'
      )
    `), "23514");
  });

  it("deduplicates scheduled runs and keeps observations immutable", async () => {
    const scheduledFor = "2026-07-28T09:00:00Z";
    await client.query(`
      INSERT INTO backlink_monitor_runs (
        id, organization_id, workspace_id, website_project_id, placement_id,
        monitor_policy_id, policy_version, scheduled_for, execution_mode,
        status, schema_version, created_by, updated_by
      ) VALUES (
        '${id(801)}', ${identity}, '${placementId}', '${policyId}',
        'placement-monitoring-v1', '${scheduledFor}', 'static', 'SCHEDULED',
        1, 'test', 'test'
      )
    `);
    await expectCode(client.query(`
      INSERT INTO backlink_monitor_runs (
        id, organization_id, workspace_id, website_project_id, placement_id,
        monitor_policy_id, policy_version, scheduled_for, execution_mode,
        status, schema_version, created_by, updated_by
      ) VALUES (
        '${id(802)}', ${identity}, '${placementId}', '${policyId}',
        'placement-monitoring-v1', '${scheduledFor}', 'static', 'SCHEDULED',
        1, 'test', 'test'
      )
    `), "23505");
    await client.query(`
      INSERT INTO backlink_monitor_observations (
        id, organization_id, workspace_id, website_project_id, monitor_run_id,
        placement_id, monitor_policy_id, policy_version, scheduled_for,
        execution_mode, result, evidence_snapshot, evidence_snapshot_hash,
        evidence_fingerprint, evidence_contract_version,
        evidence_schema_version, observed_at, created_by
      ) VALUES (
        '${id(901)}', ${identity}, '${id(801)}', '${placementId}',
        '${policyId}', 'placement-monitoring-v1', '${scheduledFor}', 'static',
        'present',
        '{"httpStatus":200,"targetFound":true,"finalUrl":"https://publisher.example/article"}',
        '${"e".repeat(64)}', '${"f".repeat(64)}',
        'placement.monitor-observation.v1', 1, '2026-07-28T09:00:05Z',
        'monitor-worker'
      )
    `);
    await expectCode(client.query(`
      UPDATE backlink_monitor_observations
      SET evidence_snapshot='{"mutated":true}'
      WHERE id='${id(901)}'
    `), "55000");
    await expectCode(client.query(`
      DELETE FROM backlink_monitor_observations WHERE id='${id(901)}'
    `), "55000");
    await expectCode(client.query(`
      INSERT INTO backlink_monitor_observations (
        id, organization_id, workspace_id, website_project_id, monitor_run_id,
        placement_id, monitor_policy_id, policy_version, scheduled_for,
        execution_mode, result, evidence_snapshot, evidence_snapshot_hash,
        evidence_fingerprint, evidence_contract_version,
        evidence_schema_version, observed_at, created_by
      ) VALUES (
        '${id(902)}', ${identity}, '${id(801)}', '${placementId}',
        '${policyId}', 'placement-monitoring-v1', '${scheduledFor}', 'static',
        'timeout', '{}', '${"1".repeat(64)}', '${"2".repeat(64)}',
        'placement.monitor-observation.v1', 1, '2026-07-28T09:00:06Z',
        'monitor-worker'
      )
    `), "23514");
  });

  it("enforces owner, forced RLS, and append-only writer access", async () => {
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
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='backlinks'
        AND c.relname IN (
          'backlink_monitor_policies',
          'backlink_monitor_runs',
          'backlink_monitor_observations'
        )
      ORDER BY c.relname
    `)).rows;
    expect(rows).toEqual([
      {
        relname: "backlink_monitor_observations",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: false,
      },
      {
        relname: "backlink_monitor_policies",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: true,
      },
      {
        relname: "backlink_monitor_runs",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: true,
      },
    ]);
  });

  it("runs idempotently, backs off, and retains the last successful Observation", async () => {
    const repository = createPlacementMonitorRepository(client);
    const scheduledFor = new Date("2026-07-29T09:00:00.000Z");
    const nextScheduledFor = new Date("2026-07-30T09:00:00.000Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      placementId,
      monitorPolicyId: policyId,
      policyVersion: "placement-monitoring-v1",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,
          snapshot_version,project_status,canonical_domain,locale,
          country_code,profile_version_id,promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1001)}',${identity},1,'ACTIVE','owner.example','en-US','US',
          'profile-v1','promotion-target-v1','test'
        );
        UPDATE backlink_monitor_policies
        SET next_check_at='${scheduledFor.toISOString()}'
        WHERE id='${policyId}';
      `);

      const first = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(804),
        workerId: "monitor-worker",
        now: new Date("2026-07-29T09:00:01.000Z"),
      });
      expect(first).toMatchObject({
        state: "ready",
        execution: {
          runId: id(804),
          attemptCount: 1,
          previousSuccessfulObservation: {
            result: "present",
            evidenceFingerprint: "f".repeat(64),
          },
        },
      });
      if (first.state !== "ready") {
        throw new Error("Expected the first Monitor Run to be ready.");
      }

      const completed = await repository.complete({
        ...scope,
        scheduledFor,
        runId: first.execution.runId,
        expectedAttemptCount: first.execution.attemptCount,
        observationId: id(903),
        expectedPlacementVersion: first.execution.placementVersion,
        expectedHealthStatus: first.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1",
          nextHealthStatus: "active",
          confirmationType: null,
          matchingEvidenceCount: 0,
          requiredConfirmationCount: null,
          reasonCode: "PLACEMENT_PRESENT",
          shouldRecheckSoon: false,
        },
        decisionFactId: id(1304),
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
        recoveryProjection: null,
        observation: {
          result: "present",
          failureCode: null,
          evidenceSnapshot: {
            result: "present",
            targetFound: true,
          },
          evidenceSnapshotHash: "3".repeat(64),
          evidenceFingerprint: "4".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-07-29T09:00:02.000Z"),
        },
        terminalStatus: "SUCCEEDED",
        nextCheckAt: nextScheduledFor,
        workerId: "monitor-worker",
        completedAt: new Date("2026-07-29T09:00:03.000Z"),
      });
      expect(completed).toMatchObject({
        runId: id(804),
        status: "SUCCEEDED",
        attemptCount: 1,
        observationResult: "present",
      });

      const replay = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(899),
        workerId: "monitor-worker",
        now: new Date("2026-07-29T09:00:04.000Z"),
      });
      expect(replay).toMatchObject({
        state: "completed",
        run: {
          runId: id(804),
          status: "SUCCEEDED",
          observationResult: "present",
        },
      });

      const second = await repository.prepare({
        ...scope,
        scheduledFor: nextScheduledFor,
        runId: id(805),
        workerId: "monitor-worker",
        now: new Date("2026-07-30T09:00:01.000Z"),
      });
      expect(second).toMatchObject({
        state: "ready",
        execution: {
          runId: id(805),
          attemptCount: 1,
          previousSuccessfulObservation: {
            result: "present",
            evidenceFingerprint: "4".repeat(64),
          },
        },
      });
      if (second.state !== "ready") {
        throw new Error("Expected the second Monitor Run to be ready.");
      }

      const retry = await repository.scheduleRetry({
        ...scope,
        scheduledFor: nextScheduledFor,
        runId: second.execution.runId,
        expectedAttemptCount: second.execution.attemptCount,
        errorCode: "HTTP_429",
        retryAfterSeconds: 60,
        nextRetryAt: new Date("2026-07-30T09:01:01.000Z"),
        workerId: "monitor-worker",
        recordedAt: new Date("2026-07-30T09:00:01.000Z"),
      });
      expect(retry).toMatchObject({
        status: "RETRY_WAIT",
        attemptCount: 1,
        retryAfterSeconds: 60,
        errorCode: "HTTP_429",
        observationResult: null,
      });
      expect((await client.query(`
        SELECT count(*)::int AS count
        FROM backlink_monitor_observations
        WHERE monitor_run_id='${id(805)}'
      `)).rows).toEqual([{ count: 0 }]);

      const waiting = await repository.prepare({
        ...scope,
        scheduledFor: nextScheduledFor,
        runId: id(805),
        workerId: "monitor-worker",
        now: new Date("2026-07-30T09:00:30.000Z"),
      });
      expect(waiting).toMatchObject({
        state: "retry_wait",
        run: {
          status: "RETRY_WAIT",
          observationResult: null,
        },
      });

      const retried = await repository.prepare({
        ...scope,
        scheduledFor: nextScheduledFor,
        runId: id(805),
        workerId: "monitor-worker",
        now: new Date("2026-07-30T09:01:01.000Z"),
      });
      expect(retried).toMatchObject({
        state: "ready",
        execution: {
          attemptCount: 2,
          previousSuccessfulObservation: {
            result: "present",
            evidenceFingerprint: "4".repeat(64),
          },
        },
      });
      if (retried.state !== "ready") {
        throw new Error("Expected the Monitor retry to be ready.");
      }

      const failed = await repository.complete({
        ...scope,
        scheduledFor: nextScheduledFor,
        runId: retried.execution.runId,
        expectedAttemptCount: retried.execution.attemptCount,
        observationId: id(904),
        expectedPlacementVersion: retried.execution.placementVersion,
        expectedHealthStatus: retried.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1",
          nextHealthStatus: "active",
          confirmationType: null,
          matchingEvidenceCount: 0,
          requiredConfirmationCount: null,
          reasonCode: "INACCESSIBLE_PRESERVES_STATUS",
          shouldRecheckSoon: true,
        },
        decisionFactId: id(1305),
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
        recoveryProjection: null,
        observation: {
          result: "inaccessible",
          failureCode: "HTTP_429",
          evidenceSnapshot: {
            result: "inaccessible",
            failureCode: "HTTP_429",
          },
          evidenceSnapshotHash: "5".repeat(64),
          evidenceFingerprint: "6".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-07-30T09:01:02.000Z"),
        },
        terminalStatus: "FAILED",
        nextCheckAt: new Date("2026-07-31T09:00:00.000Z"),
        workerId: "monitor-worker",
        completedAt: new Date("2026-07-30T09:01:03.000Z"),
      });
      expect(failed).toMatchObject({
        status: "FAILED",
        attemptCount: 2,
        errorCode: "HTTP_429",
        observationResult: "inaccessible",
      });
      const decisions = (await client.query(`
        SELECT id,aggregate_id AS "monitorRunId",sequence,after_state AS fact
        FROM backlink_lifecycle_events
        WHERE event_type='placement.monitoring.status_decided'
          AND aggregate_id IN ('${id(804)}','${id(805)}')
        ORDER BY aggregate_id
      `)).rows;
      expect(decisions).toMatchObject([
        {
          id: id(1304),
          monitorRunId: id(804),
          sequence: 1,
          fact: {
            monitorRunId: id(804),
            placementId,
            observationId: id(903),
            previousHealthStatus: "active",
            nextHealthStatus: "active",
            reasonCode: "PLACEMENT_PRESENT",
          },
        },
        {
          id: id(1305),
          monitorRunId: id(805),
          sequence: 1,
          fact: {
            monitorRunId: id(805),
            placementId,
            observationId: id(904),
            previousHealthStatus: "active",
            nextHealthStatus: "active",
            reasonCode: "INACCESSIBLE_PRESERVES_STATUS",
          },
        },
      ]);
      expect((await client.query(`
        SELECT count(*)::int AS count
        FROM backlink_lifecycle_events
        WHERE aggregate_type='placement'
          AND aggregate_id='${placementId}'
          AND event_type='placement.lost'
      `)).rows).toEqual([{ count: 0 }]);

      const afterFailure = await repository.prepare({
        ...scope,
        scheduledFor: new Date("2026-07-31T09:00:00.000Z"),
        runId: id(806),
        workerId: "monitor-worker",
        now: new Date("2026-07-31T09:00:01.000Z"),
      });
      expect(afterFailure).toMatchObject({
        state: "ready",
        execution: {
          attemptCount: 1,
          previousSuccessfulObservation: {
            result: "present",
            evidenceFingerprint: "4".repeat(64),
          },
        },
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("persists confirmed health transitions as immutable Lifecycle facts", async () => {
    const repository = createPlacementMonitorRepository(client);
    const scheduledFor = new Date("2026-07-31T09:00:00.000Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      placementId,
      monitorPolicyId: policyId,
      policyVersion: "placement-monitoring-v1",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,
          snapshot_version,project_status,canonical_domain,locale,
          country_code,profile_version_id,promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1011)}',${identity},1,'ACTIVE','owner.example','en-US','US',
          'profile-v1','promotion-target-v1','test'
        );
        UPDATE backlink_monitor_policies
        SET next_check_at='${scheduledFor.toISOString()}'
        WHERE id='${policyId}';
      `);

      const prepared = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(808),
        workerId: "monitor-worker",
        now: new Date("2026-07-31T09:00:01.000Z"),
      });
      expect(prepared).toMatchObject({
        state: "ready",
        execution: {
          healthStatus: "active",
          placementVersion: 1,
        },
      });
      if (prepared.state !== "ready") {
        throw new Error("Expected the changed Placement monitor to be ready.");
      }

      await expect(repository.complete({
        ...scope,
        scheduledFor,
        runId: prepared.execution.runId,
        expectedAttemptCount: prepared.execution.attemptCount,
        observationId: id(906),
        expectedPlacementVersion: prepared.execution.placementVersion,
        expectedHealthStatus: prepared.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1",
          nextHealthStatus: "changed",
          confirmationType: "changed",
          matchingEvidenceCount: 2,
          requiredConfirmationCount: 2,
          reasonCode: "CHANGE_CONFIRMED",
          shouldRecheckSoon: false,
        },
        decisionFactId: id(1308),
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
        recoveryProjection: {
          lifecycleEventId: id(1006),
          outboxEventId: null,
          eventType: "placement.changed",
          nextHealthStatus: "changed",
          reasonCode: "CHANGE_CONFIRMED",
          kpiProjection: null,
        },
        observation: {
          result: "changed",
          failureCode: null,
          evidenceSnapshot: {
            result: "changed",
            targetFound: true,
          },
          evidenceSnapshotHash: "9".repeat(64),
          evidenceFingerprint: "a".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-07-31T09:00:02.000Z"),
        },
        terminalStatus: "SUCCEEDED",
        nextCheckAt: new Date("2026-08-01T09:00:00.000Z"),
        workerId: "monitor-worker",
        completedAt: new Date("2026-07-31T09:00:03.000Z"),
      })).resolves.toMatchObject({
        status: "SUCCEEDED",
        observationResult: "changed",
      });

      expect((await client.query(`
        SELECT p.health_status AS "healthStatus",p.version,
          (SELECT count(*)::int FROM backlink_lifecycle_events event
            WHERE event.id='${id(1006)}'
              AND event.aggregate_type='placement'
              AND event.aggregate_id=p.id
              AND event.event_type='placement.changed') AS "changedEvents",
          (SELECT count(*)::int FROM backlink_outbox_events event
            WHERE event.aggregate_id=p.id
              AND event.event_type=
                'backlinks.placement-monitoring.lifecycle.v1') AS "outboxEvents"
        FROM backlink_placements p
        WHERE p.id='${placementId}'
      `)).rows).toEqual([{
        healthStatus: "changed",
        version: 2,
        changedEvents: 1,
        outboxEvents: 0,
      }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("atomically restores Lost to active with Lifecycle and KPI Outbox facts", async () => {
    const repository = createPlacementMonitorRepository(client);
    const scheduledFor = new Date("2026-08-01T09:00:00.000Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      placementId,
      monitorPolicyId: policyId,
      policyVersion: "placement-monitoring-v1",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,
          snapshot_version,project_status,canonical_domain,locale,
          country_code,profile_version_id,promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1012)}',${identity},1,'ACTIVE','owner.example','en-US','US',
          'profile-v1','promotion-target-v1','test'
        );
        UPDATE backlink_placements
        SET health_status='lost',version=version+1,updated_by='test'
        WHERE id='${placementId}';
        UPDATE backlink_monitor_policies
        SET next_check_at='${scheduledFor.toISOString()}'
        WHERE id='${policyId}';
      `);

      const prepared = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(807),
        workerId: "monitor-worker",
        now: new Date("2026-08-01T09:00:01.000Z"),
      });
      expect(prepared).toMatchObject({
        state: "ready",
        execution: {
          healthStatus: "lost",
          placementVersion: 2,
        },
      });
      if (prepared.state !== "ready") {
        throw new Error("Expected the Lost Placement monitor to be ready.");
      }

      const completed = await repository.complete({
        ...scope,
        scheduledFor,
        runId: prepared.execution.runId,
        expectedAttemptCount: prepared.execution.attemptCount,
        observationId: id(905),
        expectedPlacementVersion: prepared.execution.placementVersion,
        expectedHealthStatus: prepared.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1",
          nextHealthStatus: "lost",
          confirmationType: null,
          matchingEvidenceCount: 0,
          requiredConfirmationCount: null,
          reasonCode: "RECOVERY_EVENT_REQUIRED",
          shouldRecheckSoon: false,
        },
        decisionFactId: id(1307),
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
        recoveryProjection: {
          lifecycleEventId: id(1005),
          outboxEventId: id(1105),
          eventType: "placement.recovered",
          nextHealthStatus: "active",
          reasonCode: "PLACEMENT_RECOVERED",
          kpiProjection: {
            countsTowardKpi: true,
            recoveredPlacementCount: 1,
            restoredPlacementCount: 0,
          },
        },
        observation: {
          result: "present",
          failureCode: null,
          evidenceSnapshot: {
            result: "present",
            targetFound: true,
          },
          evidenceSnapshotHash: "7".repeat(64),
          evidenceFingerprint: "8".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-08-01T09:00:02.000Z"),
        },
        terminalStatus: "SUCCEEDED",
        nextCheckAt: new Date("2026-08-02T09:00:00.000Z"),
        workerId: "monitor-worker",
        completedAt: new Date("2026-08-01T09:00:03.000Z"),
      });
      expect(completed).toMatchObject({
        status: "SUCCEEDED",
        observationResult: "present",
      });

      expect((await client.query(`
        SELECT p.health_status AS "healthStatus",p.version,
          (SELECT count(*)::int FROM backlink_lifecycle_events l
            WHERE l.aggregate_type='placement'
              AND l.aggregate_id=p.id
              AND l.event_type='placement.recovered') AS "recoveredEvents",
          (SELECT payload FROM backlink_outbox_events e
            WHERE e.id='${id(1105)}') AS "outboxPayload"
        FROM backlink_placements p
        WHERE p.id='${placementId}'
      `)).rows).toEqual([{
        healthStatus: "active",
        version: 3,
        recoveredEvents: 1,
        outboxPayload: {
          contractVersion: "backlinks.placement-monitoring.lifecycle.v1",
          lifecycleEventId: id(1005),
          lifecycleEventType: "placement.recovered",
          placementId,
          monitorRunId: id(807),
          monitorPolicyId: policyId,
          observationId: id(905),
          previousHealthStatus: "lost",
          healthStatus: "active",
          kpiProjection: {
            countsTowardKpi: true,
            recoveredPlacementCount: 1,
            restoredPlacementCount: 0,
          },
        },
      }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("replays suspected_lost from one immutable historical decision fact", async () => {
    const repository = createPlacementMonitorRepository(client);
    const scheduledFor = new Date("2026-08-04T09:00:00.000Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      placementId,
      monitorPolicyId: policyId,
      policyVersion: "placement-monitoring-v1",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,
          snapshot_version,project_status,canonical_domain,locale,
          country_code,profile_version_id,promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1014)}',${identity},1,'ACTIVE','owner.example','en-US','US',
          'profile-v1','promotion-target-v1','test'
        );
        UPDATE backlink_monitor_policies
        SET next_check_at='${scheduledFor.toISOString()}',
          loss_confirmation_count=3,change_confirmation_count=4
        WHERE id='${policyId}';
      `);
      const prepared = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(810),
        workerId: "monitor-worker",
        now: new Date("2026-08-04T09:00:01.000Z"),
      });
      expect(prepared).toMatchObject({
        state: "ready",
        execution: {
          healthStatus: "active",
          lossConfirmationCount: 3,
          changeConfirmationCount: 4,
        },
      });
      if (prepared.state !== "ready") {
        throw new Error("Expected the suspected Lost monitor to be ready.");
      }
      const completion = {
        ...scope,
        scheduledFor,
        runId: prepared.execution.runId,
        expectedAttemptCount: prepared.execution.attemptCount,
        observationId: id(910),
        expectedPlacementVersion: prepared.execution.placementVersion,
        expectedHealthStatus: prepared.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1" as const,
          nextHealthStatus: "suspected_lost" as const,
          confirmationType: "lost" as const,
          matchingEvidenceCount: 1,
          requiredConfirmationCount: 3,
          reasonCode: "LOSS_REQUIRES_CONFIRMATION" as const,
          shouldRecheckSoon: true,
        },
        decisionFactId: id(1310),
        lossConfirmationCount: prepared.execution.lossConfirmationCount,
        changeConfirmationCount: prepared.execution.changeConfirmationCount,
        recoveryProjection: null,
        observation: {
          result: "absent" as const,
          failureCode: null,
          evidenceSnapshot: {
            result: "absent",
            targetFound: false,
          },
          evidenceSnapshotHash: "1".repeat(64),
          evidenceFingerprint: "2".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-08-04T09:00:02.000Z"),
        },
        terminalStatus: "SUCCEEDED" as const,
        nextCheckAt: new Date("2026-08-04T10:00:00.000Z"),
        workerId: "monitor-worker",
        completedAt: new Date("2026-08-04T09:00:03.000Z"),
      };
      await expect(repository.complete(completion)).resolves.toMatchObject({
        status: "SUCCEEDED",
        observationResult: "absent",
      });

      await client.query(`
        UPDATE backlink_monitor_policies
        SET loss_confirmation_count=5,change_confirmation_count=6
        WHERE id='${policyId}'
      `);
      await expect(repository.complete({
        ...completion,
        observationId: id(911),
        decisionFactId: id(1311),
      })).resolves.toMatchObject({
        status: "SUCCEEDED",
        observationResult: "absent",
      });

      const facts = (await client.query(`
        SELECT after_state AS fact,created_at AS "occurredAt"
        FROM backlink_lifecycle_events
        WHERE aggregate_type='placement_monitor_run'
          AND aggregate_id='${id(810)}'
          AND sequence=1
          AND event_type='placement.monitoring.status_decided'
      `)).rows;
      expect(facts).toHaveLength(1);
      expect(facts[0]?.fact).toEqual({
        monitorRunId: id(810),
        placementId,
        observationId: id(910),
        previousHealthStatus: "active",
        nextHealthStatus: "suspected_lost",
        policyId,
        policyVersion: "placement-monitoring-v1",
        policyContractVersion: "placement-monitoring-status.v1",
        lossConfirmationCount: 3,
        changeConfirmationCount: 4,
        matchingEvidenceCount: 1,
        requiredConfirmationCount: 3,
        confirmationType: "lost",
        reasonCode: "LOSS_REQUIRES_CONFIRMATION",
        occurredAt: "2026-08-04T09:00:03+00:00",
        contractVersion: "placement.monitoring.status-decision.v1",
      });
      expect(new Date(String(facts[0]?.occurredAt)).toISOString()).toBe(
        "2026-08-04T09:00:03.000Z",
      );
      const replayedHealthStatus = facts.reduce(
        (current, row) => {
          const fact = row.fact as Record<string, unknown>;
          expect(fact.previousHealthStatus).toBe(current);
          return String(fact.nextHealthStatus);
        },
        "active",
      );
      expect(replayedHealthStatus).toBe("suspected_lost");
      expect((await client.query(`
        SELECT p.health_status AS "healthStatus",
          policy.loss_confirmation_count AS "currentLossCount",
          policy.change_confirmation_count AS "currentChangeCount",
          (SELECT count(*)::int FROM backlink_monitor_observations observation
            WHERE observation.monitor_run_id='${id(810)}') AS observations,
          (SELECT count(*)::int FROM backlink_lifecycle_events lifecycle
            WHERE lifecycle.aggregate_type='placement'
              AND lifecycle.aggregate_id=p.id
              AND lifecycle.event_type='placement.lost') AS "lostEvents",
          (SELECT count(*)::int FROM backlink_outbox_events outbox
            WHERE outbox.aggregate_id=p.id
              AND outbox.event_type=
                'backlinks.placement-monitoring.lifecycle.v1') AS "kpiOutbox"
        FROM backlink_placements p
        JOIN backlink_monitor_policies policy ON policy.placement_id=p.id
        WHERE p.id='${placementId}'
      `)).rows).toEqual([{
        healthStatus: "suspected_lost",
        currentLossCount: 5,
        currentChangeCount: 6,
        observations: 1,
        lostEvents: 0,
        kpiOutbox: 0,
      }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("rolls back Observation, status, decision, Lifecycle, and Outbox together", async () => {
    const repository = createPlacementMonitorRepository(client);
    const scheduledFor = new Date("2026-08-05T09:00:00.000Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      placementId,
      monitorPolicyId: policyId,
      policyVersion: "placement-monitoring-v1",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,
          snapshot_version,project_status,canonical_domain,locale,
          country_code,profile_version_id,promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1015)}',${identity},1,'ACTIVE','owner.example','en-US','US',
          'profile-v1','promotion-target-v1','test'
        );
        UPDATE backlink_placements
        SET health_status='lost',version=version+1,updated_by='test'
        WHERE id='${placementId}';
        UPDATE backlink_monitor_policies
        SET next_check_at='${scheduledFor.toISOString()}'
        WHERE id='${policyId}';
        INSERT INTO backlink_outbox_events (
          id,organization_id,workspace_id,website_project_id,event_type,
          aggregate_id,aggregate_version,idempotency_key,payload,
          payload_schema_version,created_by,updated_by
        ) VALUES (
          '${id(1400)}',${identity},'rollback.seed','${id(1401)}',1,
          'rollback-seed','{}',1,'test','test'
        );
      `);
      const prepared = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(811),
        workerId: "monitor-worker",
        now: new Date("2026-08-05T09:00:01.000Z"),
      });
      expect(prepared).toMatchObject({
        state: "ready",
        execution: {
          healthStatus: "lost",
          placementVersion: 2,
        },
      });
      if (prepared.state !== "ready") {
        throw new Error("Expected the rollback monitor to be ready.");
      }
      await client.query("SAVEPOINT before_monitor_completion");
      const error = await repository.complete({
        ...scope,
        scheduledFor,
        runId: prepared.execution.runId,
        expectedAttemptCount: prepared.execution.attemptCount,
        observationId: id(912),
        expectedPlacementVersion: prepared.execution.placementVersion,
        expectedHealthStatus: prepared.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1",
          nextHealthStatus: "lost",
          confirmationType: null,
          matchingEvidenceCount: 0,
          requiredConfirmationCount: null,
          reasonCode: "RECOVERY_EVENT_REQUIRED",
          shouldRecheckSoon: false,
        },
        decisionFactId: id(1312),
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
        recoveryProjection: {
          lifecycleEventId: id(1412),
          outboxEventId: id(1400),
          eventType: "placement.recovered",
          nextHealthStatus: "active",
          reasonCode: "PLACEMENT_RECOVERED",
          kpiProjection: {
            countsTowardKpi: true,
            recoveredPlacementCount: 1,
            restoredPlacementCount: 0,
          },
        },
        observation: {
          result: "present",
          failureCode: null,
          evidenceSnapshot: {
            result: "present",
            targetFound: true,
          },
          evidenceSnapshotHash: "3".repeat(64),
          evidenceFingerprint: "4".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-08-05T09:00:02.000Z"),
        },
        terminalStatus: "SUCCEEDED",
        nextCheckAt: new Date("2026-08-06T09:00:00.000Z"),
        workerId: "monitor-worker",
        completedAt: new Date("2026-08-05T09:00:03.000Z"),
      }).catch((caught: unknown) => caught as PgError);
      expect(error).toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT before_monitor_completion");

      expect((await client.query(`
        SELECT run.status,placement.health_status AS "healthStatus",
          placement.version,
          (SELECT count(*)::int FROM backlink_monitor_observations observation
            WHERE observation.monitor_run_id=run.id) AS observations,
          (SELECT count(*)::int FROM backlink_lifecycle_events lifecycle
            WHERE lifecycle.id IN ('${id(1312)}','${id(1412)}'))
            AS "lifecycleFacts",
          (SELECT count(*)::int FROM backlink_outbox_events outbox
            WHERE outbox.id='${id(1400)}') AS "seedOutbox"
        FROM backlink_monitor_runs run
        JOIN backlink_placements placement ON placement.id=run.placement_id
        WHERE run.id='${id(811)}'
      `)).rows).toEqual([{
        status: "RUNNING",
        healthStatus: "lost",
        version: 2,
        observations: 0,
        lifecycleFacts: 0,
        seedOutbox: 1,
      }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("isolates monitoring decision facts by Workspace", async () => {
    const repository = createPlacementMonitorRepository(client);
    const scheduledFor = new Date("2026-08-06T09:00:00.000Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      placementId,
      monitorPolicyId: policyId,
      policyVersion: "placement-monitoring-v1",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,
          snapshot_version,project_status,canonical_domain,locale,
          country_code,profile_version_id,promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1016)}',${identity},1,'ACTIVE','owner.example','en-US','US',
          'profile-v1','promotion-target-v1','test'
        );
        UPDATE backlink_monitor_policies
        SET next_check_at='${scheduledFor.toISOString()}'
        WHERE id='${policyId}';
      `);
      const prepared = await repository.prepare({
        ...scope,
        scheduledFor,
        runId: id(812),
        workerId: "monitor-worker",
        now: new Date("2026-08-06T09:00:01.000Z"),
      });
      if (prepared.state !== "ready") {
        throw new Error("Expected the isolated monitor to be ready.");
      }
      await repository.complete({
        ...scope,
        scheduledFor,
        runId: prepared.execution.runId,
        expectedAttemptCount: prepared.execution.attemptCount,
        observationId: id(913),
        expectedPlacementVersion: prepared.execution.placementVersion,
        expectedHealthStatus: prepared.execution.healthStatus,
        statusDecision: {
          policyVersion: "placement-monitoring-status.v1",
          nextHealthStatus: "active",
          confirmationType: null,
          matchingEvidenceCount: 0,
          requiredConfirmationCount: null,
          reasonCode: "PLACEMENT_PRESENT",
          shouldRecheckSoon: false,
        },
        decisionFactId: id(1313),
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
        recoveryProjection: null,
        observation: {
          result: "present",
          failureCode: null,
          evidenceSnapshot: {
            result: "present",
            targetFound: true,
          },
          evidenceSnapshotHash: "5".repeat(64),
          evidenceFingerprint: "6".repeat(64),
          evidenceContractVersion: "placement.monitor-observation.v1",
          evidenceSchemaVersion: 1,
          observedAt: new Date("2026-08-06T09:00:02.000Z"),
        },
        terminalStatus: "SUCCEEDED",
        nextCheckAt: new Date("2026-08-07T09:00:00.000Z"),
        workerId: "monitor-worker",
        completedAt: new Date("2026-08-06T09:00:03.000Z"),
      });

      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query(`
        SELECT set_config('app.current_organization_id','${organization}',true),
          set_config('app.current_workspace_id','${workspace}',true),
          set_config('app.current_website_project_id','${project}',true)
      `);
      expect((await client.query(`
        SELECT count(*)::int AS count
        FROM backlink_lifecycle_events
        WHERE id='${id(1313)}'
      `)).rows).toEqual([{ count: 1 }]);
      await client.query(`
        SELECT set_config(
          'app.current_workspace_id',
          '${id(9999)}',
          true
        )
      `);
      expect((await client.query(`
        SELECT count(*)::int AS count
        FROM backlink_lifecycle_events
        WHERE id='${id(1313)}'
      `)).rows).toEqual([{ count: 0 }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("reverifies through the existing static Monitor Run and Outbox boundary", async () => {
    const requestedAt = new Date("2026-08-03T09:00:00.000Z");
    const generatedIds = [
      id(1201), id(809), id(907), id(1107),
      id(1202), id(1203), id(1204), id(1205),
      id(1206), id(1207), id(1208), id(1209),
    ];
    const command = createPlacementReverifyCommand(
      client,
      {
        newId: () => generatedIds.shift() ?? id(1299),
        now: () => requestedAt,
      },
    );
    const context = {
      actor: createActorContext({
        userId: "member-158",
        sessionId: "session-158",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: organization,
        workspaceId: workspace,
      }),
      project: createProjectContext({
        websiteProjectId: project,
        canonicalDomain: "owner.example",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-target-v1",
      }),
    };
    const input = {
      context,
      placementId,
      expectedVersion: 1,
      idempotencyKey: "placement-reverify-158",
      requestId: "request-158",
    };
    await client.query("BEGIN");
    try {
      await client.query(`
        UPDATE backlink_monitor_runs
        SET status='CANCELLED',finished_at='2026-07-29T10:00:00Z',
          version=version+1,updated_at='2026-07-29T10:00:00Z',
          updated_by='test'
        WHERE id='${id(801)}'
      `);

      const first = await command.execute(input);
      expect(first).toMatchObject({
        placementId,
        placementVersion: 2,
        accepted: true,
        replayed: false,
        browserFallbackAllowed: false,
        monitorRun: {
          monitorRunId: id(809),
          status: "scheduled",
        },
      });
      expect(Date.parse(first.monitorRun.scheduledFor)).toBe(
        requestedAt.getTime(),
      );
      await expect(command.execute(input)).resolves.toEqual({
        ...first,
        replayed: true,
      });

      await expect(command.execute({
        ...input,
        expectedVersion: 2,
        idempotencyKey: "placement-reverify-active-158",
      })).resolves.toMatchObject({
        placementVersion: 2,
        accepted: false,
        replayed: false,
        browserFallbackAllowed: false,
        monitorRun: {
          monitorRunId: id(809),
          status: "scheduled",
        },
      });

      const stored = (await client.query(`
        SELECT placement.version,
          policy.next_check_at AS "nextCheckAt",
          run.execution_mode AS "executionMode",
          run.status AS "runStatus",
          outbox.event_type AS "eventType",
          outbox.payload AS payload,
          (SELECT count(*)::int FROM backlink_monitor_runs candidate
            WHERE candidate.id='${id(809)}') AS "runCount",
          (SELECT count(*)::int FROM backlink_outbox_events candidate
            WHERE candidate.id='${id(1107)}') AS "outboxCount",
          (SELECT count(*)::int FROM backlink_idempotency_records record
            WHERE record.command_type='placement.reverify') AS "idempotencyCount"
        FROM backlink_placements placement
        JOIN backlink_monitor_policies policy
          ON policy.placement_id=placement.id
        JOIN backlink_monitor_runs run ON run.id='${id(809)}'
        JOIN backlink_outbox_events outbox ON outbox.id='${id(1107)}'
        WHERE placement.id='${placementId}'
      `)).rows[0];
      expect(stored).toMatchObject({
        version: 2,
        executionMode: "static",
        runStatus: "SCHEDULED",
        eventType: "backlinks.placement-monitoring.requested.v1",
        runCount: 1,
        outboxCount: 1,
        idempotencyCount: 2,
        payload: expect.objectContaining({
          requestKind: "reverify",
          placementId,
          monitorRunId: id(809),
          executionMode: "static",
          browserFallbackAllowed: false,
        }),
      });
      expect(new Date(String(stored?.nextCheckAt)).getTime()).toBe(
        requestedAt.getTime(),
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("returns only active-project, enabled, unscheduled due placements", async () => {
    const repository = createMonitoringScheduleRepository(client);
    const dueAt = new Date("2026-07-31T00:00:00Z");
    const scope = {
      organizationId: organization,
      workspaceId: workspace,
      websiteProjectId: project,
      dueAt,
      limit: 10,
    };
    const appendProjectStatus = async (
      snapshotVersion: number,
      projectStatus:
        "ACTIVE" | "PAUSED" | "DELETION_REQUESTED" | "DELETED",
    ) => {
      await client.query(`
        INSERT INTO backlink_project_context_snapshots (
          id, organization_id, workspace_id, website_project_id,
          snapshot_version, project_status, canonical_domain, locale,
          country_code, profile_version_id, promotion_target_version_id,
          created_by
        ) VALUES (
          '${id(1000 + snapshotVersion)}', ${identity}, ${snapshotVersion},
          '${projectStatus}', 'owner.example', 'en-US', 'US',
          'profile-v1', 'promotion-target-v1', 'test'
        )
      `);
    };

    await client.query(`
      UPDATE backlink_monitor_policies
      SET next_check_at='2026-07-30T09:00:00Z'
      WHERE id='${policyId}'
    `);

    expect(await repository.listDue(scope)).toEqual([]);

    await appendProjectStatus(1, "ACTIVE");
    expect(await repository.listDue(scope)).toEqual([{
      monitorPolicyId: policyId,
      placementId,
      policyVersion: "placement-monitoring-v1",
      normalIntervalSeconds: 86_400,
      suspectedRecheckIntervalSeconds: 3_600,
      jitterWindowSeconds: 3_600,
      browserFallbackEnabled: false,
      nextCheckAt: new Date("2026-07-30T09:00:00.000Z"),
      placementVersion: 1,
      healthStatus: "active",
      sourcePageUrl: "https://publisher.example/article",
      targetUrl: "https://owner.example/guide",
      projectContextSnapshotVersion: 1,
    }]);

    await client.query(`
      UPDATE backlink_placements
      SET monitoring_status='paused'
      WHERE id='${placementId}'
    `);
    expect(await repository.listDue(scope)).toEqual([]);
    await client.query(`
      UPDATE backlink_placements
      SET monitoring_status='enabled'
      WHERE id='${placementId}'
    `);

    await appendProjectStatus(2, "PAUSED");
    expect(await repository.listDue(scope)).toEqual([]);
    await appendProjectStatus(3, "ACTIVE");
    expect(await repository.listDue(scope)).toHaveLength(1);

    await client.query(`
      INSERT INTO backlink_monitor_runs (
        id, organization_id, workspace_id, website_project_id, placement_id,
        monitor_policy_id, policy_version, scheduled_for, execution_mode,
        status, schema_version, created_by, updated_by
      ) VALUES (
        '${id(803)}', ${identity}, '${placementId}', '${policyId}',
        'placement-monitoring-v1', '2026-07-30T09:00:00Z', 'static',
        'SCHEDULED', 1, 'test', 'test'
      )
    `);
    expect(await repository.listDue(scope)).toEqual([]);

    await client.query(`
      UPDATE backlink_monitor_policies
      SET next_check_at='2026-07-30T10:00:00.123456Z'
      WHERE id='${policyId}'
    `);
    expect(await repository.listDue(scope)).toHaveLength(1);

    await client.query(`
      INSERT INTO backlink_monitor_runs (
        id, organization_id, workspace_id, website_project_id, placement_id,
        monitor_policy_id, policy_version, scheduled_for, execution_mode,
        status, schema_version, created_by, updated_by
      ) VALUES (
        '${id(804)}', ${identity}, '${placementId}', '${policyId}',
        'placement-monitoring-v1', '2026-07-30T10:00:00.123Z', 'static',
        'SCHEDULED', 1, 'test', 'test'
      )
    `);
    expect(await repository.listDue(scope)).toEqual([]);

    await appendProjectStatus(4, "DELETION_REQUESTED");
    expect(await repository.listDue(scope)).toEqual([]);
    await appendProjectStatus(5, "DELETED");
    expect(await repository.listDue(scope)).toEqual([]);
  });
});
