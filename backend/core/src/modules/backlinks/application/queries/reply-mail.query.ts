import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";

export const replyMailDirections = ["INBOUND", "OUTBOUND"] as const;
export type ReplyMailDirection = (typeof replyMailDirections)[number];

export const replyMailParseStatuses = ["PENDING", "PARSED", "FAILED"] as const;
export type ReplyMailParseStatus = (typeof replyMailParseStatuses)[number];

export const replyMailMatchStatuses = [
  "UNMATCHED",
  "CANDIDATES_READY",
  "MATCH_CONFIRMED",
] as const;
export type ReplyMailMatchStatus = (typeof replyMailMatchStatuses)[number];

export type SanitizedReplyMailHtml = Readonly<{
  content: string;
  trust: "SANITIZED";
  sanitized: true;
  policyVersion: string;
}>;

export type SafeReplyMailBody = Readonly<{
  plainText: string | null;
  sanitizedHtml: SanitizedReplyMailHtml | null;
}>;

export type ReplyMailListItem = Readonly<{
  id: string;
  threadId: string;
  direction: ReplyMailDirection;
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  receivedAt: string;
  parseStatus: ReplyMailParseStatus;
  version: number;
  inboundMessageId: string | null;
  matchStatus: ReplyMailMatchStatus | null;
  matchedOpportunityId: string | null;
}>;

export type ReplyMailDetail = ReplyMailListItem & Readonly<{
  body: SafeReplyMailBody;
}>;

export type ReplyMailThread = Readonly<{
  id: string;
  latestMessageAt: string | null;
  messageCount: number;
  version: number;
  messages: ReplyMailDetail[];
}>;

export type ReplyMailListInput = Readonly<{
  matchStatus?: ReplyMailMatchStatus | undefined;
  limit: number;
  cursor?: string | undefined;
}>;

export type ReplyMailPage = Readonly<{
  items: ReplyMailListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

export type ReplyMailQuery = Readonly<{
  listMailMessages(
    context: ResolvedProjectContext,
    input: ReplyMailListInput,
  ): Promise<ReplyMailPage>;
  getMailMessage(
    context: ResolvedProjectContext,
    messageId: string,
  ): Promise<ReplyMailDetail>;
  getMailThread(
    context: ResolvedProjectContext,
    threadId: string,
  ): Promise<ReplyMailThread>;
}>;

export type ReplyMailQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type ReplyMailContentReader = Readonly<{
  read(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    rawObjectKey: string;
  }>): Promise<SafeReplyMailBody>;
}>;

type ReplyMailCursor = readonly [string, string];

const emptyBody = Object.freeze({
  plainText: null,
  sanitizedHtml: null,
} satisfies SafeReplyMailBody);

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest,
  message: "Mail cursor is invalid.",
  fieldErrors: [{
    field: "cursor",
    message: "Use a cursor returned by this API.",
  }],
});

function decodeCursor(value: string | undefined): ReplyMailCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (!Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || !Number.isFinite(new Date(parsed[0]).getTime())
      || typeof parsed[1] !== "string"
      || parsed[1].length === 0) {
      throw invalidCursor();
    }
    return [new Date(parsed[0]).toISOString(), parsed[1]];
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toNullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function toListItem(row: Record<string, unknown>): ReplyMailListItem {
  return Object.freeze({
    id: String(row.id),
    threadId: String(row.threadId),
    direction: row.direction as ReplyMailDirection,
    fromAddress: toNullableString(row.fromAddress),
    toAddresses: toStringArray(row.toAddresses),
    ccAddresses: toStringArray(row.ccAddresses),
    subject: toNullableString(row.subject),
    receivedAt: toIsoString(row.receivedAt),
    parseStatus: row.parseStatus as ReplyMailParseStatus,
    version: Number(row.version),
    inboundMessageId: toNullableString(row.inboundMessageId),
    matchStatus: row.matchStatus as ReplyMailMatchStatus | null,
    matchedOpportunityId: toNullableString(row.matchedOpportunityId),
  });
}

function assertSafeBody(body: SafeReplyMailBody): SafeReplyMailBody {
  const html = body.sanitizedHtml;
  if ((body.plainText !== null && typeof body.plainText !== "string")
    || (html !== null && (
      typeof html.content !== "string"
      || html.trust !== "SANITIZED"
      || html.sanitized !== true
      || typeof html.policyVersion !== "string"
      || html.policyVersion.trim().length === 0
    ))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.internal,
      message: "Safe mail content contract was violated.",
    });
  }
  return Object.freeze({
    plainText: body.plainText,
    sanitizedHtml: html === null ? null : Object.freeze({ ...html }),
  });
}

const messageColumns = `
  message.id,
  message.mail_thread_id "threadId",
  message.direction,
  message.from_address "fromAddress",
  message.to_addresses "toAddresses",
  message.cc_addresses "ccAddresses",
  message.subject_text "subject",
  COALESCE(message.received_at,message.created_at) "receivedAt",
  message.parse_status "parseStatus",
  message.version,
  inbound.id "inboundMessageId",
  inbound.match_status "matchStatus",
  matched.opportunity_id "matchedOpportunityId"`;

const matchJoins = `
  LEFT JOIN backlinks.backlink_inbound_messages inbound
    ON (inbound.organization_id,inbound.workspace_id,
        inbound.website_project_id,inbound.mail_message_id)
     = (message.organization_id,message.workspace_id,
        message.website_project_id,message.id)
  LEFT JOIN LATERAL (
    SELECT candidate.opportunity_id
      FROM backlinks.backlink_reply_match_candidates candidate
     WHERE (candidate.organization_id,candidate.workspace_id,
            candidate.website_project_id,candidate.inbound_message_id)
         = (inbound.organization_id,inbound.workspace_id,
            inbound.website_project_id,inbound.id)
       AND inbound.match_status = 'MATCH_CONFIRMED'
       AND candidate.requires_manual_confirmation = false
     ORDER BY candidate.candidate_rank ASC,candidate.id ASC
     LIMIT 1
  ) matched ON true`;

export function createReplyMailQuery(
  dependencies: Readonly<{
    client: ReplyMailQueryClient;
    contentReader: ReplyMailContentReader;
  }>,
): ReplyMailQuery {
  const readBody = async (
    context: ResolvedProjectContext,
    rawObjectKey: unknown,
  ): Promise<SafeReplyMailBody> => {
    if (rawObjectKey === null || rawObjectKey === undefined) return emptyBody;
    return assertSafeBody(await dependencies.contentReader.read({
      organizationId: context.tenant.organizationId,
      workspaceId: context.tenant.workspaceId,
      websiteProjectId: context.project.websiteProjectId,
      rawObjectKey: String(rawObjectKey),
    }));
  };

  const toDetail = async (
    context: ResolvedProjectContext,
    row: Record<string, unknown>,
  ): Promise<ReplyMailDetail> => Object.freeze({
    ...toListItem(row),
    body: await readBody(context, row.rawObjectKey),
  });

  return Object.freeze({
    async listMailMessages(context, input) {
      const after = decodeCursor(input.cursor);
      const result = await dependencies.client.query(`
        SELECT ${messageColumns}
          FROM backlinks.backlink_mail_messages message
          ${matchJoins}
         WHERE (message.organization_id,message.workspace_id,
                message.website_project_id)=($1,$2,$3)
           AND ($4::text IS NULL OR inbound.match_status=$4)
           AND ($5::timestamptz IS NULL
             OR COALESCE(message.received_at,message.created_at) < $5
             OR (COALESCE(message.received_at,message.created_at)=$5
                 AND message.id < $6::uuid))
         ORDER BY COALESCE(message.received_at,message.created_at) DESC,
                  message.id DESC
         LIMIT $7
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
        input.matchStatus ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        input.limit + 1,
      ]);
      const items = result.rows.slice(0, input.limit).map(toListItem);
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return Object.freeze({
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? Buffer.from(
              JSON.stringify([last.receivedAt, last.id]),
            ).toString("base64url")
          : null,
      });
    },

    async getMailMessage(context, messageId) {
      const result = await dependencies.client.query(`
        SELECT ${messageColumns},
               raw_reference.raw_object_key "rawObjectKey"
          FROM backlinks.backlink_mail_messages message
          JOIN backlinks.backlink_mail_raw_message_references raw_reference
            ON (raw_reference.organization_id,raw_reference.workspace_id,
                raw_reference.website_project_id,raw_reference.id)
             = (message.organization_id,message.workspace_id,
                message.website_project_id,message.raw_message_reference_id)
          ${matchJoins}
         WHERE (message.organization_id,message.workspace_id,
                message.website_project_id,message.id)=($1,$2,$3,$4)
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
        messageId,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Mail message was not found in this project.",
        });
      }
      return toDetail(context, row);
    },

    async getMailThread(context, threadId) {
      const threadResult = await dependencies.client.query(`
        SELECT thread.id,
               thread.latest_message_at "latestMessageAt",
               thread.message_count "messageCount",
               thread.version
          FROM backlinks.backlink_mail_threads thread
         WHERE (thread.organization_id,thread.workspace_id,
                thread.website_project_id,thread.id)=($1,$2,$3,$4)
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
        threadId,
      ]);
      const thread = threadResult.rows[0];
      if (thread === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Mail thread was not found in this project.",
        });
      }

      const messageResult = await dependencies.client.query(`
        SELECT ${messageColumns},
               raw_reference.raw_object_key "rawObjectKey"
          FROM backlinks.backlink_mail_messages message
          JOIN backlinks.backlink_mail_raw_message_references raw_reference
            ON (raw_reference.organization_id,raw_reference.workspace_id,
                raw_reference.website_project_id,raw_reference.id)
             = (message.organization_id,message.workspace_id,
                message.website_project_id,message.raw_message_reference_id)
          ${matchJoins}
         WHERE (message.organization_id,message.workspace_id,
                message.website_project_id,message.mail_thread_id)=($1,$2,$3,$4)
         ORDER BY COALESCE(message.received_at,message.created_at) ASC,
                  message.id ASC
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
        threadId,
      ]);
      const messages = await Promise.all(
        messageResult.rows.map((row) => toDetail(context, row)),
      );
      return Object.freeze({
        id: String(thread.id),
        latestMessageAt: toNullableIsoString(thread.latestMessageAt),
        messageCount: Number(thread.messageCount),
        version: Number(thread.version),
        messages,
      });
    },
  });
}
