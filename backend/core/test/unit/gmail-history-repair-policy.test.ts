import { describe, expect, it } from "vitest";

import {
  createGmailHistoryRepairPolicy,
  gmailHistoryRepairLookbackDays,
  gmailHistoryRepairMaxMessages,
  gmailHistoryRepairMaxPages,
  gmailHistoryRepairPageSize,
} from "../../src/modules/backlinks/application/policies/mail-history-repair.policy.js";

describe("BL-AI-130 Gmail History Repair Policy", () => {
  it("fixes the repair scan to a bounded seven-day window", () => {
    const policy = createGmailHistoryRepairPolicy(
      new Date("2026-07-28T08:00:00.000Z"),
    );

    expect(gmailHistoryRepairLookbackDays).toBe(7);
    expect(gmailHistoryRepairPageSize).toBe(100);
    expect(gmailHistoryRepairMaxPages).toBe(10);
    expect(gmailHistoryRepairMaxMessages).toBe(1_000);
    expect(policy).toEqual({
      receivedAfter: new Date("2026-07-21T08:00:00.000Z"),
      receivedBefore: new Date("2026-07-28T08:00:00.000Z"),
      pageSize: 100,
      maxPages: 10,
      maxMessages: 1_000,
    });
  });

  it("rejects invalid repair anchors", () => {
    expect(() => createGmailHistoryRepairPolicy(new Date("invalid")))
      .toThrow("History repair anchor must be a valid date.");
  });
});
