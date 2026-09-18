import { expect, it, vi } from "vitest";
import { preflightSendBatch } from "../../src/modules/backlinks/application/commands/send-batch-preflight.js";
import {
  createGmailSendReadinessSnapshot,
  gmailSendReadinessConditionCodes,
} from "../../src/modules/backlinks/application/services/send-policy-gate.js";

type Commands = Parameters<typeof preflightSendBatch>[0];
type Input = Parameters<typeof preflightSendBatch>[1][number];
const inputs = ["draft-1", "draft-2"].map((draftId) => ({
  draftId, gmailConnectionId: "account", messagePurpose: "INITIAL_OUTREACH", followUpIndex: 0,
})) as Input[];
function fixture(revisions = ["0/20", "0/20"]) {
  const snapshots = revisions.map((revision) => createGmailSendReadinessSnapshot({
    evaluatedAt: new Date("2026-09-14T00:00:00Z"),
    conditions: gmailSendReadinessConditionCodes.map((code) => ({
      code, revision: code === "QUOTA" ? revision : "unchanged",
    })),
  }));
  const preflight = vi.fn();
  for (const readinessSnapshot of snapshots) preflight.mockResolvedValueOnce({ readinessSnapshot, allowed: true });
  const create = vi.fn();
  return { commands: { preflight, create } as unknown as Commands, snapshots, create, preflight };
}

it("plans sequential quota snapshots without reservations, mutation or sends", async () => {
  const f = fixture();
  const before = structuredClone(f.snapshots);
  const result = await preflightSendBatch(f.commands, inputs);
  expect(result.map((r) => r.draftId)).toEqual(["draft-1", "draft-2"]);
  expect(result.map((r) => r.readinessSnapshot.conditions.find((c) => c.code === "QUOTA")?.revision))
    .toEqual(["0/20", "1/20"]);
  expect(result[1].readinessSnapshot).toEqual(createGmailSendReadinessSnapshot({
    evaluatedAt: new Date(before[1].evaluatedAt),
    ttlSeconds: 24 * 60 * 60,
    conditions: before[1].conditions.map((c) => c.code === "QUOTA" ? { ...c, revision: "1/20" } : c),
  }));
  expect(f.snapshots).toEqual(before);
  expect(f.create).not.toHaveBeenCalled();
});

it.each([["19/20", "19/20"], ["0/20", "1/20"], ["invalid", "invalid"]])(
  "rejects exhausted, drifting or malformed quota %s, %s", async (a, b) => {
    const f = fixture([a, b]);
    await expect(preflightSendBatch(f.commands, inputs)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  },
);

it.each([
  [], [inputs[0], inputs[0]],
  [inputs[0], { ...inputs[1], gmailConnectionId: "other" }],
  [{ ...inputs[0], followUpIndex: 1 }],
  Array.from({ length: 21 }, (_, i) => ({ ...inputs[0], draftId: String(i) })),
])("rejects invalid scope or size before preflight", async (batch) => {
  const f = fixture();
  await expect(preflightSendBatch(f.commands, batch)).rejects.toThrow();
  expect(f.preflight).not.toHaveBeenCalled();
});
