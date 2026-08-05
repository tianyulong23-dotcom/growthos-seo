import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  validateBackupRestoreEvidence,
} from "../../src/modules/backlinks/application/services/report-backup-restore-validation.js";

const runbook = new URL(
  "../../docs/execution/backlinks-kill-switch-disaster-recovery-runbook.md",
  import.meta.url,
);

describe("BL-AI-175/194 backup/restore validation", () => {
  it("accepts only temporary restore evidence within RPO/RTO and matching key counts", () => {
    expect(validateBackupRestoreEvidence({
      targetEnvironment: "temporary",
      sourceBackupCreatedAt: new Date("2026-07-29T05:30:00.000Z"),
      validationStartedAt: new Date("2026-07-29T06:00:00.000Z"),
      validationCompletedAt: new Date("2026-07-29T06:20:00.000Z"),
      expectedMigrationHead: "0032",
      restoredMigrationHead: "0032",
      sourceCounts: {
        backlink_metric_snapshots: 12,
        backlink_report_revisions: 4,
        backlink_task_projections: 3,
        backlink_notification_projections: 8,
        provider_batch_requests: 2,
        provider_artifacts: 5,
      },
      restoredCounts: {
        backlink_metric_snapshots: 12,
        backlink_report_revisions: 4,
        backlink_task_projections: 3,
        backlink_notification_projections: 8,
        provider_batch_requests: 2,
        provider_artifacts: 5,
      },
      rpoMilliseconds: 60 * 60 * 1000,
      rtoMilliseconds: 4 * 60 * 60 * 1000,
    })).toMatchObject({
      valid: true,
      migrationHead: "0032",
    });

    expect(() => validateBackupRestoreEvidence({
      targetEnvironment: "production",
      sourceBackupCreatedAt: new Date("2026-07-29T05:30:00.000Z"),
      validationStartedAt: new Date("2026-07-29T06:00:00.000Z"),
      validationCompletedAt: new Date("2026-07-29T06:20:00.000Z"),
      expectedMigrationHead: "0032",
      restoredMigrationHead: "0032",
      sourceCounts: {},
      restoredCounts: {},
      rpoMilliseconds: 60 * 60 * 1000,
      rtoMilliseconds: 4 * 60 * 60 * 1000,
    })).toThrow(/temporary/i);
  });

  it("documents a temporary-only custom backup, restore, migration, count, RPO, and RTO flow", async () => {
    const text = await readFile(runbook, "utf8");

    expect(text).toMatch(/temporary restore database/i);
    expect(text).toMatch(/pg_dump[\s\S]*--format=custom/i);
    expect(text).toMatch(/pg_restore/i);
    expect(text).toMatch(/migration head/i);
    expect(text).toMatch(/key table counts/i);
    expect(text).toMatch(/RPO[\s\S]*60 minutes/i);
    expect(text).toMatch(/RTO[\s\S]*4 hours/i);
    expect(text).toMatch(/must not target production/i);
    expect(text).toMatch(/backlinks\.dataforseo\.v1[\s\S]*KILL_SWITCH_ACTIVE/i);
    expect(text).toMatch(/GMAIL_SEND_POLICY_BLOCKED/i);
    expect(text).toMatch(/Browser[\s\S]*disabled/i);
    expect(text).toMatch(/BACKLINKS_WORKER_ENABLED[\s\S]*false/i);
    expect(text).toMatch(/migration head `0032`/i);
    expect(text).toMatch(/every `backlinks` table row count/i);
  });
});
