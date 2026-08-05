export type GmailSentMessageQueryInput = Readonly<{
  gmailConnectionId: string;
  rfcMessageId: string;
}>;

export type GmailSentMessageQueryResult =
  | Readonly<{
    kind: "found";
    providerMessageId: string;
    providerThreadId?: string;
    evidenceReference: string;
  }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "inconclusive"; code: string }>;

export interface GmailSentMessageQueryPort {
  findByRfcMessageId(
    input: GmailSentMessageQueryInput,
  ): Promise<GmailSentMessageQueryResult>;
}
