import { describe, expect, it } from "vitest";

import { createRecommendationCommands } from "../../src/modules/backlinks/application/commands/recommendations.command.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const organizationId = "018f0000-0000-7000-8000-000000000001";
const workspaceId = "018f0000-0000-7000-8000-000000000002";
const websiteProjectId = "018f0000-0000-7000-8000-000000000003";
const contextVersionId = "018f0000-0000-7000-8000-000000000004";

describe("recommendation commands", () => {
  it("persists existing-evidence reassessment intent without synthesizing an operation", async () => {
    let sql = "";
    let values: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: "completed",
            requestHash: queryValues?.[7],
            responseBody: {
              operationId: "018f0000-0000-7000-8000-000000000005",
              jobId: "018f0000-0000-7000-8000-000000000006",
              workflowId: "workflow-1",
              outboxEventId: "018f0000-0000-7000-8000-000000000009",
              status: "queued",
              version: 1,
              visiblePoolGeneration: 1,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
              auditEventId: "018f0000-0000-7000-8000-000000000008",
            },
          }],
        };
      },
    });

    await commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "existing-evidence-reassessment-1",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      supplyMode: "existing_evidence",
    });

    expect(values?.[20]).toBeNull();
    expect(values?.[22]).toBeNull();
    expect(values?.[23]).toBe("existing_evidence");
    expect(sql).toContain("'supplyMode',$24::text");
    expect(sql).toContain("result_summary");
    expect(sql).toContain("after_state");
    expect(sql).toContain("after_redacted");
  });

  it("restores existing-evidence mode when rearming a durable refill", async () => {
    const operationId = "018f0000-0000-7000-8000-000000000005";
    const jobId = "018f0000-0000-7000-8000-000000000006";
    const outboxEventId = "018f0000-0000-7000-8000-000000000009";
    let authorizationRecoveryCalled = false;
    let refillValues: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        if (text.includes("JOIN backlink_idempotency_records AS idempotency")) {
          return {
            rows: [{
              refillWindowKey:
                `commercial-existing:${websiteProjectId}:${contextVersionId}:g1:archive-prepared`,
              idempotencyKey:
                `recommendation-refill:commercial-existing:${websiteProjectId}:${contextVersionId}:g1:archive-prepared`,
              requestHash: "historical-existing-evidence-request-hash",
              triggerReason: "inventory_low",
              lowWatermark: 0,
              highWatermark: 10,
              visiblePoolGeneration: 1,
              jobId,
              supplyMode: "existing_evidence",
              outboxEventId,
            }],
          };
        }
        if (text.includes("WITH target AS MATERIALIZED")) {
          authorizationRecoveryCalled = true;
          return { rows: [] };
        }
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        if (text.includes("WITH guard AS")) {
          refillValues = values;
          return {
            rows: [{
              state: "replay",
              requestHash: values?.[7],
              responseBody: {
                operationId,
                jobId,
                workflowId: "workflow-1",
                outboxEventId,
                status: "queued",
                version: 2,
                visiblePoolGeneration: 1,
                lifecycleEventId:
                  "018f0000-0000-7000-8000-000000000007",
                auditEventId:
                  "018f0000-0000-7000-8000-000000000008",
              },
            }],
          };
        }
        return { rows: [] };
      },
    }, {
      persistentProviderBudgetGrant: {
        provider: "dataforseo",
        reasonCode: "user_authorized_persistent_discovery",
        maxPaidCalls: 3,
        maxCostMicros: 1_000_000,
      },
    });

    await expect(commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "existing-evidence-recovery-1",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 0,
      highWatermark: 10,
      operationId,
    })).resolves.toMatchObject({ operationId, replayed: true });

    expect(authorizationRecoveryCalled).toBe(false);
    expect(refillValues?.[22]).toBeNull();
    expect(refillValues?.[23]).toBe("existing_evidence");
  });

  it("persists a reusable provider budget authorization for a new refill", async () => {
    let sql = "";
    let values: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: "completed",
            requestHash: queryValues?.[7],
            responseBody: {
              operationId: "018f0000-0000-7000-8000-000000000005",
              jobId: "018f0000-0000-7000-8000-000000000006",
              workflowId: "workflow-1",
              outboxEventId: "018f0000-0000-7000-8000-000000000009",
              status: "queued",
              version: 1,
              visiblePoolGeneration: 1,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
              auditEventId: "018f0000-0000-7000-8000-000000000008",
            },
          }],
        };
      },
    });

    await commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "bounded-real-refill-1",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      providerBudgetAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
      },
    });

    expect(values?.[22]).toEqual(JSON.stringify({
      provider: "dataforseo",
      reasonCode: "user_authorized_bounded_real_refill",
      maxPaidCalls: 4,
      maxCostMicros: 1_000_000,
      authorizedBy: "local-product-operator",
    }));
    expect(sql).toContain("providerBudgetAuthorization");
    expect(sql).toContain("result_summary");
    expect(sql).toContain("after_state");
    expect(sql).toContain("after_redacted");
  });

  it("binds the configured persistent discovery authorization to a public refill", async () => {
    let sql = "";
    let values: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: "completed",
            requestHash: queryValues?.[7],
            responseBody: {
              operationId: "018f0000-0000-7000-8000-000000000005",
              jobId: "018f0000-0000-7000-8000-000000000006",
              workflowId: "workflow-1",
              outboxEventId: "018f0000-0000-7000-8000-000000000009",
              status: "queued",
              version: 1,
              visiblePoolGeneration: 1,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
              auditEventId: "018f0000-0000-7000-8000-000000000008",
            },
          }],
        };
      },
    }, {
      persistentProviderBudgetGrant: {
        provider: "dataforseo",
        reasonCode: "user_authorized_persistent_discovery",
        maxPaidCalls: 3,
        maxCostMicros: 1_000_000,
      },
    });

    await commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "persistent-refill-1",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
    });

    expect(values?.[22]).toEqual(JSON.stringify({
      provider: "dataforseo",
      reasonCode: "user_authorized_persistent_discovery",
      maxPaidCalls: 3,
      maxCostMicros: 1_000_000,
      authorizedBy: "local-product-operator",
    }));
    expect(sql).toContain(
      "'providerOperationId',CASE WHEN $23::jsonb IS NULL THEN NULL ELSE "
        + "'commercial-refill-operation:'||$10::uuid::text END",
    );
    expect(sql).toContain(
      "'providerBudgetAuthorization',$23::jsonb",
    );
  });

  it("accepts internally configured refill watermarks", async () => {
    let queryCount = 0;
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        queryCount += 1;
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              operationId: "018f0000-0000-7000-8000-000000000005",
              jobId: "018f0000-0000-7000-8000-000000000006",
              workflowId: "workflow-1",
              outboxEventId: "018f0000-0000-7000-8000-000000000009",
              status: "queued",
              version: 1,
              visiblePoolGeneration: 1,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
              auditEventId: "018f0000-0000-7000-8000-000000000008",
            },
          }],
        };
      },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "invalid-target",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 10,
        highWatermark: 20,
      }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(queryCount).toBeGreaterThan(0);
  });

  it("requeues a failed refill before rearming its persisted outbox", async () => {
    let sql = "";
    const commands = createRecommendationCommands({
      query: async (text) => {
        sql = text;
        return { rows: [] };
      },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "request-1",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 9,
        highWatermark: 10,
      }),
    ).rejects.toThrow();

    expect(sql).toContain(
      "JOIN backlink_recommendation_refills failed_refill",
    );
    expect(sql).toContain(
      "request.request_id LIKE failed_refill.refill_window_key||':%'",
    );
    const compactSql = sql.replace(/\s+/gu, "");
    expect(compactSql).toContain(
      "request.budget_reservation_idLIKE'commercial-refill-operation:'||failed_job.id::text||':discovery:'||failed_refill.refill_window_key||':%'",
    );
    expect(compactSql).toContain(
      "blueprint.id::text=provider_request.request_payload#>>'{__growthosDiscoveryPlannerLineage,blueprintId}'",
    );
    expect(compactSql).toContain(
      "provider_request.request_payload#>>'{__growthosDiscoveryPlannerLineage,queryId}'~'^[0-9a-f]{64}$'",
    );
    expect(sql).toContain(
      "conflicting.refill_job_id<>failed_job.id",
    );
    expect(sql).toContain(
      "'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%'",
    );
    expect(sql).toContain(
      "recovery.\"rearmedCount\">0 OR prior_job.status IN ('queued','running','waiting_provider','success')",
    );
    expect(sql).toContain("failed_job.status='failed' AND (");
    expect(sql).toContain("failed_job.retry_count<6 OR");
    expect(sql).toContain("failed_job.retry_count=6");
    expect(sql).toContain(
      "(failed_job.status='failed') \"resumeFailed\"",
    );
    expect(sql).toContain(
      "resumed_job AS (UPDATE backlink_jobs job SET status='queued'",
    );
    expect(sql).toContain(
      "recoverable.\"resumeFailed\" AND job.status='failed'",
    );
    expect(sql).toContain(
      "FROM recoverable JOIN resumed_job resumed",
    );
    expect(sql).toContain(
      "failed_job.status='failed' AND event.status='pending' AND event.claimed_at IS NULL AND event.claimed_by IS NULL",
    );
    expect(sql).toContain(
      "event.status IN ('published','pending')",
    );
    expect(sql).toContain(
      "completedProviderCheckpointRecoveryAttempted",
    );
    expect(sql).toContain("completed_provider_checkpoint");
    expect(sql).toContain("request.status='succeeded'");
    expect(sql).toContain("provider_request.status='succeeded'");
    expect(sql).toContain("usage.status='settled'");
    expect(sql).toContain("lease.status='completed'");
    expect(sql).toContain(
      "request.status IN ('running','unknown_charge')",
    );
    expect(sql).toContain("request.provider_task_id IS NOT NULL");
    expect(sql).toContain("lease.lease_expires_at<=now()");
    expect(sql).toContain(
      "usage.reservation_key=request.budget_reservation_id",
    );
    expect(sql).toContain("accepted_provider_recovery");
    expect(sql).not.toContain(
      "WHERE request.provider_task_id IS NOT NULL AND provider_request.request_payload",
    );
    expect(sql).toContain("failed_refill.refill_window_key");
    expect(sql).not.toContain("request.status='failed'");
    expect(sql).not.toContain("providerCallOccurred'='false'");
    expect(sql).toContain(
      "policy.termination_reason='TIERS_EXHAUSTED'",
    );
    expect(sql).toContain(
      "attempted_refill_tiers=CASE",
    );
    expect(sql).toContain("'outboxEventId',$19");
    expect(sql).toContain("LEFT JOIN backlink_jobs job");
    expect(sql).not.toContain("reservation_key=failed_job.id::text");
    expect(sql).not.toContain("request_id=failed_job.id::text");
  });

  it("requeues an accepted semantic task paused by exhausted authorization", async () => {
    let sql = "";
    const commands = createRecommendationCommands({
      query: async (text) => {
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        sql = text;
        return { rows: [] };
      },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "accepted-semantic-budget-recovery",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 9,
        highWatermark: 10,
      }),
    ).rejects.toThrow();

    expect(sql).toContain("failed_job.status='partial_success'");
    expect(sql).toContain("failed_job.step='paused_budget'");
    expect(sql).toContain(
      "failed_job.result_summary->>'stageReason'='semantic_discovery_budget_insufficient'",
    );
    expect(sql).toContain("resumed_job AS (UPDATE backlink_jobs");
    expect(sql).toContain(
      "FROM recoverable JOIN resumed_job resumed",
    );
    expect(sql).not.toContain(
      "prior_job.status IN ('queued','running','waiting_provider','partial_success','success')",
    );
  });

  it("rearms only an unpublished V4 existing-evidence terminal once", async () => {
    let sql = "";
    const commands = createRecommendationCommands({
      query: async (text) => {
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        sql = text;
        return { rows: [] };
      },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "existing-evidence-publication-recovery",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 9,
        highWatermark: 10,
      }),
    ).rejects.toThrow();

    expect(sql).toContain("publication_contract_recovery AS MATERIALIZED");
    expect(sql).toContain(
      "failed_job.step='existing_evidence_no_progress'",
    );
    expect(sql).toContain(
      "failed_job.result_summary->>'terminalReason'='EXISTING_EVIDENCE_NO_PROGRESS'",
    );
    expect(sql).toContain(
      "candidate.score_model_version='recommendation-commercial-fit.v4'",
    );
    expect(sql).toContain(
      "candidate.gate_decision->>'decision'='eligible'",
    );
    expect(sql).toContain(
      "jsonb_array_length(candidate.gate_decision->'hitGates')=0",
    );
    expect(sql).toContain(
      "candidate.commercial_score->>'decision'='eligible'",
    );
    expect(sql).toContain(
      "(candidate.commercial_score->>'total')::numeric>=(candidate.commercial_score#>>'{admission,appliedThreshold}')::numeric",
    );
    expect(sql).toContain("qualification.decision='eligible'");
    expect(sql).toContain(
      "prior.\"responseBody\"->>'existingEvidencePublicationRecoveryKey' IS DISTINCT FROM",
    );
    expect(sql).toContain(
      "response_body=record.response_body||jsonb_build_object('existingEvidencePublicationRecoveryKey'",
    );
    expect(sql).toContain(
      "COALESCE(job.result_summary,'{}'::jsonb)-'existingCandidatesCompleted'",
    );
    expect(sql).toContain("event.status='published'");
    expect(sql).toContain(
      "active_event.status IN ('pending','processing','failed')",
    );
    expect(sql).toContain(
      "lease.status IN ('acquired','unknown_charge')",
    );
    expect(sql).toContain(
      "LEFT JOIN marked_publication_recovery marked",
    );
  });

  it("resolves an operation recovery to its persisted commercial refill request", async () => {
    const operationId = "018f0000-0000-7000-8000-000000000005";
    const jobId = "018f0000-0000-7000-8000-000000000006";
    const outboxEventId = "018f0000-0000-7000-8000-000000000009";
    const originalRefillWindowKey =
      `commercial-refill:${websiteProjectId}:${contextVersionId}:g1:t1:r1:w1`;
    const currentRefillWindowKey =
      `commercial-refill:${websiteProjectId}:${contextVersionId}:g1:t2:r1:w1`;
    const historicalIdempotencyKey =
      `recommendation-refill:project-bootstrap:${websiteProjectId}:3:g1`;
    const historicalRequestHash = "historical-request-hash";
    let recoverySql = "";
    let refillValues: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        if (text.includes("JOIN backlink_idempotency_records AS idempotency")) {
          recoverySql = text;
          return {
            rows: [{
              refillWindowKey: originalRefillWindowKey,
              idempotencyKey: historicalIdempotencyKey,
              requestHash: historicalRequestHash,
              triggerReason: "inventory_low",
              lowWatermark: 9,
              highWatermark: 10,
              visiblePoolGeneration: 1,
              jobId,
              outboxEventId,
            }],
          };
        }
        if (text.includes("WITH target AS MATERIALIZED")) {
          return {
            rows: [{
              state: "ready",
              providerBudgetAuthorization: {
                provider: "dataforseo",
                reasonCode: "user_authorized_persistent_discovery",
                maxPaidCalls: 3,
                maxCostMicros: 1_000_000,
                authorizedBy: "original-operator",
              },
            }],
          };
        }
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        refillValues = values;
        return {
          rows: [{
            state: "replay",
            requestHash: values?.[7],
            responseBody: {
              operationId,
              jobId,
              workflowId: "workflow-1",
              outboxEventId,
              status: "queued",
              version: 1,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
              auditEventId: "018f0000-0000-7000-8000-000000000008",
            },
          }],
        };
      },
    });

    const recovered = await commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-recover-1",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      operationId,
    });

    expect(recovered).toMatchObject({ operationId, replayed: true });
    expect(recoverySql).toContain("refill.id=$5");
    expect(recoverySql).toContain(
      "idempotency.response_body->>'operationId'=refill.id::text",
    );
    expect(recoverySql).toContain(
      'refill.refill_window_key "refillWindowKey"',
    );
    expect(recoverySql).toContain(
      'idempotency.idempotency_key "idempotencyKey"',
    );
    expect(recoverySql).toContain(
      'idempotency.request_hash "requestHash"',
    );
    expect(recoverySql).not.toContain("substring(");
    expect(refillValues?.[6]).toBe(historicalIdempotencyKey);
    expect(refillValues?.[7]).toBe(historicalRequestHash);
    expect(refillValues?.[17]).toBe(originalRefillWindowKey);
    expect(refillValues?.[19]).toBe("inventory_low");
    expect(refillValues?.[20]).toBe(operationId);
    expect(refillValues).not.toContain(currentRefillWindowKey);
  });

  it("repairs a failed pre-provider refill with the configured durable authorization", async () => {
    const operationId = "018f0000-0000-7000-8000-000000000005";
    const jobId = "018f0000-0000-7000-8000-000000000006";
    const outboxEventId = "018f0000-0000-7000-8000-000000000009";
    const refillWindowKey =
      `commercial-refill:${websiteProjectId}:${contextVersionId}:g1:t1:r1:w1`;
    const idempotencyKey =
      `recommendation-refill:project-bootstrap:${websiteProjectId}:3:g1`;
    const authorization = {
      provider: "dataforseo" as const,
      reasonCode: "user_authorized_persistent_discovery" as const,
      maxPaidCalls: 3,
      maxCostMicros: 1_000_000,
      authorizedBy: "local-product-operator",
    };
    let repairSql = "";
    let repairValues: readonly unknown[] | undefined;
    let refillValues: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        if (text.includes("JOIN backlink_idempotency_records AS idempotency")) {
          return {
            rows: [{
              refillWindowKey,
              idempotencyKey,
              requestHash: "historical-request-hash",
              triggerReason: "inventory_low",
              lowWatermark: 9,
              highWatermark: 10,
              visiblePoolGeneration: 1,
              jobId,
              outboxEventId,
            }],
          };
        }
        if (text.includes("WITH target AS MATERIALIZED")) {
          repairSql = text;
          repairValues = values;
          return {
            rows: [{
              state: "repaired",
              providerBudgetAuthorization: authorization,
            }],
          };
        }
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        if (text.includes("WITH guard AS")) {
          refillValues = values;
          return {
            rows: [{
              state: "replay",
              requestHash: values?.[7],
              responseBody: {
                operationId,
                jobId,
                workflowId: "workflow-1",
                outboxEventId,
                status: "queued",
                version: 2,
                visiblePoolGeneration: 1,
                lifecycleEventId:
                  "018f0000-0000-7000-8000-000000000007",
                auditEventId:
                  "018f0000-0000-7000-8000-000000000008",
              },
            }],
          };
        }
        return { rows: [] };
      },
    }, {
      persistentProviderBudgetGrant: {
        provider: "dataforseo",
        reasonCode: "user_authorized_persistent_discovery",
        maxPaidCalls: 3,
        maxCostMicros: 1_000_000,
      },
    });

    await expect(commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "repair-pre-provider-refill",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      operationId,
    })).resolves.toMatchObject({
      operationId,
      jobId,
      outboxEventId,
      replayed: true,
    });

    expect(repairSql).toContain(
      "INSERT INTO backlink_commercial_supply_operations",
    );
    expect(repairSql).toContain("batch.refill_job_id");
    expect(repairSql).toContain("provider_batch_requests");
    expect(repairSql).toContain("backlink_provider_usage_ledger");
    expect(repairSql).toContain("provider_fetch_leases");
    expect(repairSql).toContain("providerCallOccurred");
    expect(repairSql).toContain("providerAuthorizationRecovery");
    expect(repairSql).toContain("UPDATE backlink_outbox_events");
    expect(repairValues?.[9]).toBe(
      `commercial-refill-operation:${jobId}`,
    );
    expect(repairValues?.[10]).toBe(JSON.stringify(authorization));
    expect(refillValues?.[20]).toBe(operationId);
    expect(refillValues?.[22]).toBe(JSON.stringify(authorization));
  });

  it("blocks recovery when the original provider authorization cannot be repaired safely", async () => {
    const operationId = "018f0000-0000-7000-8000-000000000005";
    let mainCommandCalled = false;
    const commands = createRecommendationCommands({
      query: async (text) => {
        if (text.includes("JOIN backlink_idempotency_records AS idempotency")) {
          return {
            rows: [{
              refillWindowKey:
                `commercial-refill:${websiteProjectId}:${contextVersionId}:g1:t1:r1:w1`,
              idempotencyKey:
                `recommendation-refill:project-bootstrap:${websiteProjectId}:3:g1`,
              requestHash: "historical-request-hash",
              triggerReason: "inventory_low",
              lowWatermark: 9,
              highWatermark: 10,
              visiblePoolGeneration: 1,
              jobId: "018f0000-0000-7000-8000-000000000006",
              outboxEventId:
                "018f0000-0000-7000-8000-000000000009",
            }],
          };
        }
        if (text.includes("WITH target AS MATERIALIZED")) {
          return {
            rows: [{
              state: "blocked",
              providerBudgetAuthorization: null,
            }],
          };
        }
        if (text.includes("WITH guard AS")) mainCommandCalled = true;
        return { rows: [] };
      },
    }, {
      persistentProviderBudgetGrant: {
        provider: "dataforseo",
        reasonCode: "user_authorized_persistent_discovery",
        maxPaidCalls: 3,
        maxCostMicros: 1_000_000,
      },
    });

    await expect(commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "blocked-provider-side-effect-recovery",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      operationId,
    })).rejects.toThrow(
      "cannot resume without its original provider authorization contract",
    );
    expect(mainCommandCalled).toBe(false);
  });

  it("does not report a failed refill as queued when recovery was blocked", async () => {
    const commands = createRecommendationCommands({
      query: async (text, values) =>
        text.includes("INSERT INTO backlink_commercial_inventory_policies")
          ? { rows: [] }
          : {
              rows: [{
                state: "recovery_blocked",
                requestHash: values?.[7],
                responseBody: {
                  operationId: "018f0000-0000-7000-8000-000000000005",
                  jobId: "018f0000-0000-7000-8000-000000000006",
                  workflowId: "workflow-1",
                  status: "queued",
                  version: 1,
                  lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
                  auditEventId: "018f0000-0000-7000-8000-000000000008",
                },
              }],
            },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "request-1",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 9,
        highWatermark: 10,
      }),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
  });

  it("archives only the active generation and leaves the next generation waiting", async () => {
    let sql = "";
    let values: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: "completed",
            requestHash: queryValues?.[7],
            responseBody: {
              archivedGeneration: 1,
              nextGeneration: 2,
              archivedCount: 20,
              preparedCandidateCount: 8,
              state: "awaiting_refresh",
              version: 4,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000009",
              auditEventId: "018f0000-0000-7000-8000-000000000010",
            },
          }],
        };
      },
    });

    const archived = await commands.archivePool({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-archive-1",
      idempotencyKey: "archive-generation-1",
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
    });

    expect(archived).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      preparedCandidateCount: 8,
      state: "awaiting_refresh",
      replayed: false,
    });
    expect(values?.slice(4, 8)).toEqual([
      contextVersionId,
      1,
      "archive-generation-1",
      expect.any(String),
    ]);
    expect(sql).toContain(
      "visible_pool_state='active' OR (visible_pool_state='building'",
    );
    expect(sql).toContain("pause_reason='incompatible_generation'");
    expect(sql).toContain(
      "job.status IN ('queued','running','waiting_provider')",
    );
    expect(sql).toContain("event.status IN ('pending','processing')");
    expect(sql).toContain("batch.status='running'");
    expect(sql).toContain(
      "request.status IN ('running','unknown_charge')",
    );
    expect(sql).toContain("usage.status='reserved'");
    expect(sql).toContain(
      "lease.status IN ('acquired','unknown_charge')",
    );
    expect(sql).toContain("inventory.visible_pool_generation=$6");
    expect(sql).toContain("status='archived'");
    expect(sql).toContain("prepared_candidates AS");
    expect(sql).toContain("qualification.decision='eligible'");
    expect(sql).toContain("candidate.recommendation_id IS NULL");
    expect(sql).toContain("candidate.visible_pool_generation=$6");
    expect(sql).toContain("candidate.commercial_score->>'decision'='eligible'");
    expect(sql).toContain(
      "jsonb_array_length(candidate.gate_decision->'hitGates')=0",
    );
    expect(sql).toContain(
      "candidate.commercial_score->>'total')::numeric>=(candidate.commercial_score#>>'{admission,appliedThreshold}')::numeric",
    );
    expect(sql).toContain("candidate.project_context_version_id,$6+1");
    expect(sql).toContain("LIMIT (SELECT visible_pool_target_count FROM pool)");
    expect(sql).toContain("visible_pool_state='awaiting_refresh'");
    expect(sql).toContain('pool.visible_pool_state "previousState"');
    expect(sql).toContain("'state',changed.\"previousState\"");
    expect(sql).not.toContain("recommendation_refill.requested");
  });

  it("cancels only an undispatched provider-free bootstrap refill", async () => {
    const jobId = "018f0000-0000-7000-8000-000000000011";
    const refillId = "018f0000-0000-7000-8000-000000000012";
    const outboxEventId = "018f0000-0000-7000-8000-000000000013";
    let sql = "";
    let values: readonly unknown[] | undefined;
    let callCount = 0;
    const responseBody = {
      jobId,
      refillId,
      outboxEventId,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      status: "cancelled" as const,
      outboxStatus: "published" as const,
      dispatchDisposition: "cancelled_before_dispatch" as const,
      policyState: "idle" as const,
      reasonCode: "read_side_effect_cleanup" as const,
      version: 2,
      lifecycleEventId:
        "018f0000-0000-7000-8000-000000000014",
      auditEventId:
        "018f0000-0000-7000-8000-000000000015",
    };
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        callCount += 1;
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: callCount === 1 ? "completed" : "replay",
            requestHash: queryValues?.[8],
            responseBody,
          }],
        };
      },
    });

    const cancelled = await commands.cancelQueuedRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-cancel-read-side-effect-1",
      idempotencyKey: "cancel-read-side-effect-1",
      expectedVersion: 1,
      jobId,
      reasonCode: "read_side_effect_cleanup",
    });

    expect(cancelled).toMatchObject({
      jobId,
      refillId,
      outboxEventId,
      status: "cancelled",
      outboxStatus: "published",
      dispatchDisposition: "cancelled_before_dispatch",
      policyState: "idle",
      reasonCode: "read_side_effect_cleanup",
      replayed: false,
    });
    await expect(commands.cancelQueuedRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-cancel-read-side-effect-replay",
      idempotencyKey: "cancel-read-side-effect-1",
      expectedVersion: 1,
      jobId,
      reasonCode: "read_side_effect_cleanup",
    })).resolves.toMatchObject({
      ...responseBody,
      replayed: true,
    });
    expect(values?.slice(4, 9)).toEqual([
      jobId,
      1,
      "read_side_effect_cleanup",
      "cancel-read-side-effect-1",
      expect.any(String),
    ]);
    expect(sql).toContain("job.status='queued'");
    expect(sql).toContain("event.status='pending'");
    expect(sql).toContain("event.attempt_count=0");
    expect(sql).toContain("event.claimed_at IS NULL");
    expect(sql).toContain(
      "'project-bootstrap:'||$3::text||':%'",
    );
    expect(sql).toContain("backlink_commercial_discovery_batches");
    expect(sql).toContain("SET status='published'");
    expect(sql).toContain(
      "'dispatchDisposition','cancelled_before_dispatch'",
    );
    expect(sql).toContain("SET status='cancelled'");
    expect(sql).toContain("visible_pool_state='idle'");
    expect(sql).toContain("refill_state='idle'");
    expect(sql).toContain("termination_reason=NULL");
    expect(sql).toContain("pause_reason=NULL");
    expect(sql).toContain("next_refill_at=NULL");
    expect(sql).toContain("'refillState',changed_policy.\"refillState\"");
    expect(sql).toContain(
      "'terminationReason',changed_policy.\"terminationReason\"",
    );
    expect(sql).toContain(
      "'pauseReason',changed_policy.\"pauseReason\"",
    );
    expect(sql).toContain(
      "recommendation_refill.cancelled_before_dispatch",
    );
    expect(sql).toContain(
      "'recommendation.refill.queued.cancel'",
    );
    expect(sql).not.toContain("DELETE FROM");
  });

  it("formally closes a provider-free duplicate refill under a recovered owner", async () => {
    const duplicateJobId = "018f0000-0000-7000-8000-000000000011";
    const canonicalJobId = "018f0000-0000-7000-8000-000000000012";
    let sql = "";
    let values: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: "completed",
            requestHash: queryValues?.[9],
            responseBody: {
              duplicateJobId,
              canonicalJobId,
              status: "cancelled",
              reasonCode: "duplicate_recovery_owner",
              version: 62,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000013",
              auditEventId: "018f0000-0000-7000-8000-000000000014",
            },
          }],
        };
      },
    });

    const closed = await commands.closeDuplicateRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-close-duplicate-1",
      idempotencyKey: "close-duplicate-1",
      expectedVersion: 61,
      duplicateJobId,
      canonicalJobId,
      reasonCode: "duplicate_recovery_owner",
    });

    expect(closed).toMatchObject({
      duplicateJobId,
      canonicalJobId,
      status: "cancelled",
      reasonCode: "duplicate_recovery_owner",
      replayed: false,
    });
    expect(values?.slice(4, 10)).toEqual([
      duplicateJobId,
      61,
      canonicalJobId,
      "duplicate_recovery_owner",
      "close-duplicate-1",
      expect.any(String),
    ]);
    expect(sql).toContain("duplicate_job.status='failed'");
    expect(sql).toContain(
      "canonical_job.result_summary->>'existingCandidatesCompleted'='true'",
    );
    expect(sql).toContain(
      "request.provider_task_id IS NOT NULL",
    );
    expect(sql).toContain("usage.status IN ('reserved','settled')");
    expect(sql).toContain("status='cancelled'");
    expect(sql).toContain("'reasonCode',$8::text");
    expect(sql).toContain("recommendation_refill.duplicate_closed");
    expect(sql).toContain("backlink_idempotency_records");
    expect(sql).not.toContain("DELETE FROM");
  });

  it("rejects a duplicate refill that names itself as canonical", async () => {
    let queryCount = 0;
    const commands = createRecommendationCommands({
      query: async () => {
        queryCount += 1;
        return { rows: [] };
      },
    });
    const sameJobId = "018f0000-0000-7000-8000-000000000011";

    await expect(commands.closeDuplicateRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-close-duplicate-self",
      idempotencyKey: "close-duplicate-self",
      expectedVersion: 1,
      duplicateJobId: sameJobId,
      canonicalJobId: sameJobId,
      reasonCode: "duplicate_recovery_owner",
    })).rejects.toThrow("cannot be its own canonical owner");
    expect(queryCount).toBe(0);
  });
});
