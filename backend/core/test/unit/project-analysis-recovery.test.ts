import { describe, expect, it } from "vitest";

import {
  combineProjectTaskHealth,
  createGlobalProjectAnalysisRecovery,
  createScopedProjectAnalysisRecovery,
} from "../../src/modules/backlinks/runtime/project-analysis-recovery.js";

describe("project-analysis recovery", () => {
  it("uses the governed global recovery functions", async () => {
    const recorded: unknown[][] = [];
    const recovery = createGlobalProjectAnalysisRecovery({
      async query(sql, values = []) {
        recorded.push([sql, values]);
        if (sql.includes("backlink_rearm_stale_project_analysis_events")) {
          return { rows: [{ rearmedCount: "2" }] };
        }
        return {
          rows: [{
            activeJobs: "4",
            recoverableQueuedProjectAnalysis: "1",
            unrecoverableStaleQueuedProjectAnalysis: "1",
            staleRunningJobs: "1",
            waitingProviderJobs: "1",
            oldestActiveAt: new Date("2026-08-25T00:00:00.000Z"),
          }],
        };
      },
    });
    const staleBefore = new Date("2026-08-25T01:00:00.000Z");

    await expect(recovery.rearm({
      workerId: "worker-1",
      staleBefore,
      limit: 10,
    })).resolves.toBe(2);
    await expect(recovery.health(staleBefore)).resolves.toEqual({
      activeJobs: 4,
      recoverableQueuedProjectAnalysis: 1,
      unrecoverableStaleQueuedProjectAnalysis: 1,
      staleRunningJobs: 1,
      waitingProviderJobs: 1,
      oldestActiveAt: "2026-08-25T00:00:00.000Z",
    });
    expect(String(recorded[0]?.[0])).toContain(
      "backlink_rearm_stale_project_analysis_events",
    );
    expect(String(recorded[1]?.[0])).toContain(
      "backlink_project_task_runtime_health",
    );
  });

  it("rearms only queued analysis jobs with their exact published event", async () => {
    const sql: string[] = [];
    const recovery = createScopedProjectAnalysisRecovery({
      async query(text) {
        sql.push(text);
        return text.includes("RETURNING job.id")
          ? { rows: [{ id: "job-1" }] }
          : { rows: [] };
      },
    });

    await expect(recovery.rearm({
      workerId: "worker-1",
      staleBefore: new Date("2026-08-25T01:00:00.000Z"),
      limit: 10,
    })).resolves.toBe(1);
    expect(sql[0]).toContain("job.status = 'queued'");
    expect(sql[0]).toContain("superseded_project_context");
    expect(sql[1]).toContain("event.status = 'published'");
    expect(sql[1]).toContain("event.payload->>'workflowId' = job.workflow_id");
    expect(sql[1]).toContain("latest.snapshot_version");
    expect(sql[1]).toContain("source.snapshot_version");
    expect(sql[1]).not.toContain("job.status = 'running'");
    expect(sql[1]).not.toContain("job.status = 'waiting_provider'");
  });

  it("aggregates project health without hiding the oldest active task", () => {
    expect(combineProjectTaskHealth([
      {
        activeJobs: 2,
        recoverableQueuedProjectAnalysis: 1,
        unrecoverableStaleQueuedProjectAnalysis: 0,
        staleRunningJobs: 1,
        waitingProviderJobs: 0,
        oldestActiveAt: "2026-08-25T02:00:00.000Z",
      },
      {
        activeJobs: 1,
        recoverableQueuedProjectAnalysis: 0,
        unrecoverableStaleQueuedProjectAnalysis: 1,
        staleRunningJobs: 0,
        waitingProviderJobs: 1,
        oldestActiveAt: "2026-08-25T01:00:00.000Z",
      },
    ])).toEqual({
      activeJobs: 3,
      recoverableQueuedProjectAnalysis: 1,
      unrecoverableStaleQueuedProjectAnalysis: 1,
      staleRunningJobs: 1,
      waitingProviderJobs: 1,
      oldestActiveAt: "2026-08-25T01:00:00.000Z",
    });
  });
});
