export const gmailHistoryRepairLookbackDays = 7;
export const gmailHistoryRepairPageSize = 100;
export const gmailHistoryRepairMaxPages = 10;
export const gmailHistoryRepairMaxMessages = 1_000;

const dayMilliseconds = 24 * 60 * 60 * 1_000;

export type GmailHistoryRepairPolicy = Readonly<{
  receivedAfter: Date;
  receivedBefore: Date;
  pageSize: number;
  maxPages: number;
  maxMessages: number;
}>;

export function createGmailHistoryRepairPolicy(
  anchor: Date,
): GmailHistoryRepairPolicy {
  if (!(anchor instanceof Date) || !Number.isFinite(anchor.getTime())) {
    throw new TypeError("History repair anchor must be a valid date.");
  }
  return Object.freeze({
    receivedAfter: new Date(
      anchor.getTime() - gmailHistoryRepairLookbackDays * dayMilliseconds,
    ),
    receivedBefore: new Date(anchor),
    pageSize: gmailHistoryRepairPageSize,
    maxPages: gmailHistoryRepairMaxPages,
    maxMessages: gmailHistoryRepairMaxMessages,
  });
}
