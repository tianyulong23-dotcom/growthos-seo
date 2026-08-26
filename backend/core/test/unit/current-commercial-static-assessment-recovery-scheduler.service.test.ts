import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ensureCurrentCommercialStaticAssessmentRecovery,
} from "../../src/modules/backlinks/application/services/current-commercial-static-assessment-recovery-scheduler.service.js";
import {
  currentCommercialStaticAssessmentRecoveryContractVersion,
} from "../../src/modules/backlinks/application/services/current-commercial-static-assessment-recovery.service.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

function projectContext() {
  return Object.freeze({
    actor: createActorContext({
      userId: randomUUID(),
      sessionId: "static-recovery-scheduler-test",
      roles: ["member"],
    }),
    tenant: createTenantContext({
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
    }),
    project: createProjectContext({
      websiteProjectId: randomUUID(),
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: randomUUID(),
      promotionTargetVersionId: randomUUID(),
    }),
  });
}

describe("current commercial static assessment recovery scheduler", () => {
  it("queues a durable existing-evidence refill without provider authorization", async () => {
    const context = projectContext();
    const recommendationContextVersionId = randomUUID();
    const candidateId = randomUUID();
    const jobId = randomUUID();
    const calls: Array<Readonly<{
      text: string;
      values: readonly unknown[];
    }>> = [];
    const client = {
      async query(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        if (calls.length === 1) {
          return {
            rows: [
              {
                visiblePoolGeneration: 2,
                visiblePoolTargetCount: 10,
                candidateId,
                attemptCount: 1,
              },
              {
                visiblePoolGeneration: 2,
                visiblePoolTargetCount: 10,
                candidateId: randomUUID(),
                attemptCount: 0,
              },
            ],
          };
        }
        if (calls.length < 5) return { rows: [] };
        return {
          rows: [
            {
              state: "completed",
              requestHash: String(values[7]),
              responseBody: {
                operationId: randomUUID(),
                jobId,
                workflowId: "backlinks:recommendation-refill:test",
                outboxEventId: randomUUID(),
                status: "queued",
                version: 1,
                visiblePoolGeneration: 2,
                lifecycleEventId: randomUUID(),
                auditEventId: randomUUID(),
              },
            },
          ],
        };
      },
    };

    await expect(
      ensureCurrentCommercialStaticAssessmentRecovery(client, {
        context,
        recommendationContextVersionId,
        maximumCandidates: 25,
        now: new Date("2026-08-25T13:30:00.000Z"),
      }),
    ).resolves.toEqual({
      status: "queued",
      jobId,
      recoverableCandidateCount: 2,
      replayed: false,
    });

    expect(calls[0]?.text).toContain("END < $8");
    expect(calls[0]?.text).toContain(
      "#>>'{recovery,contractVersion}' IS DISTINCT FROM $10",
    );
    expect(calls[0]?.values[9]).toBe(
      currentCommercialStaticAssessmentRecoveryContractVersion,
    );
    expect(calls[0]?.text).toContain(
      "recommendation.status IN ('ready','shown','accepted')",
    );
    const commandValues = calls[4]?.values ?? [];
    expect(commandValues[15]).toBe(0);
    expect(commandValues[16]).toBe(10);
    expect(commandValues[17]).toBe(
      [
        "commercial-existing",
        context.project.websiteProjectId,
        recommendationContextVersionId,
        "g2",
        "static-recovery-v4",
        candidateId,
        "a2",
      ].join(":"),
    );
    expect(commandValues[17]).not.toContain(":static-recovery:");
    expect(commandValues[20]).toBeNull();
    expect(commandValues[22]).toBeNull();
    expect(commandValues[23]).toBe("existing_evidence");
  });

  it("does not replay a terminal recovery refill for the same attempt", async () => {
    const context = projectContext();
    const recommendationContextVersionId = randomUUID();
    const candidateId = randomUUID();
    const calls: Array<Readonly<{
      text: string;
      values: readonly unknown[];
    }>> = [];
    const client = {
      async query(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        if (calls.length === 1) {
          return {
            rows: [{
              visiblePoolGeneration: 2,
              visiblePoolTargetCount: 10,
              candidateId,
              attemptCount: 1,
            }],
          };
        }
        return { rows: [{ exists: 1 }] };
      },
    };

    await expect(
      ensureCurrentCommercialStaticAssessmentRecovery(client, {
        context,
        recommendationContextVersionId,
        maximumCandidates: 25,
        now: new Date("2026-08-25T13:30:00.000Z"),
      }),
    ).resolves.toEqual({
      status: "idle",
      recoverableCandidateCount: 0,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toContain(
      "'success','partial_success','failed','cancelled'",
    );
    expect(calls[1]?.values[5]).toBe(
      [
        "commercial-existing",
        context.project.websiteProjectId,
        recommendationContextVersionId,
        "g2",
        "static-recovery-v4",
        candidateId,
        "a2",
      ].join(":"),
    );
  });

  it("stays idle when no current candidate is due", async () => {
    const context = projectContext();
    const calls: string[] = [];
    const result =
      await ensureCurrentCommercialStaticAssessmentRecovery(
        {
          async query(text: string) {
            calls.push(text);
            return { rows: [] };
          },
        },
        {
          context,
          recommendationContextVersionId: randomUUID(),
          maximumCandidates: 25,
          now: new Date("2026-08-25T13:30:00.000Z"),
        },
      );

    expect(result).toEqual({
      status: "idle",
      recoverableCandidateCount: 0,
    });
    expect(calls).toHaveLength(1);
  });
});
