import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  withBacklinkTenantTransaction, type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import { normalizeSendIdentityEmail } from "../../domain/sending/identity.js";
import { createContactCommands } from "../commands/contacts.command.js";
import type { createSendIntentCommands } from "../commands/send-intent.command.js";
import { createReplyMailQuery, type ReplyMailContentReader } from "../queries/reply-mail.query.js";
import {
  createDraftGenerationRepository, createDraftEditingRepository,
} from "../repositories/draft-generation.repository.js";
import { draftRequestSchema } from "../schemas/draft-request.schema.js";

export const replySendSchema = z.object({
  expectedVersion: z.number().int().positive(),
  gmailConnectionId: z.uuid(),
  recipient: z.email(),
  subject: z.string().trim().min(1).max(255).regex(/^[^\r\n\u0000]+$/u),
  body: z.string().trim().min(1).max(20_000),
  confirmed: z.literal(true),
  confirmationMode: z.enum(["MANUAL", "ONE_REPLY"]).default("MANUAL"),
}).strict();
export type ReplySendInput = z.infer<typeof replySendSchema>;

const fail = (message: string) => new BacklinkError({
  code: backlinkErrorCodes.conflict, message,
});
const scopeOf = (context: ResolvedProjectContext) => ({
  ...context.tenant, websiteProjectId: context.project.websiteProjectId,
});
const valuesOf = (context: ResolvedProjectContext) => [
  context.tenant.organizationId, context.tenant.workspaceId, context.project.websiteProjectId,
];
const messageIdPattern = /^<[^<>\s@]+@[^<>\s@]+>$/u;

export function replySubject(subject: string | null): string {
  const value = (subject ?? "").trim();
  const result = /^re:/iu.test(value) ? value : `Re: ${value}`;
  if (!value || result.length > 255 || /[\r\n\u0000]/u.test(result)) {
    throw fail("MAIL_REPLY_SUBJECT_INVALID");
  }
  return result;
}

export function replyRecipient(from: string | null, replyTo: readonly string[]): string {
  if (replyTo.length > 1) throw fail("MAIL_REPLY_MULTIPLE_RECIPIENTS");
  try {
    const address = normalizeSendIdentityEmail(replyTo[0] ?? from ?? "");
    if (/^(?:no-?reply|do-?not-?reply)@/iu.test(address)) throw new Error();
    return address;
  } catch {
    throw fail("MAIL_REPLY_RECIPIENT_INVALID");
  }
}

export function createMailReplyService(dependencies: Readonly<{
  pool: BacklinkTenantPool;
  contentReader: ReplyMailContentReader;
  sendIntents: ReturnType<typeof createSendIntentCommands>;
}>) {
  const load = async (
    client: BacklinkTransactionClient, context: ResolvedProjectContext, messageId: string,
  ) => {
    const query = createReplyMailQuery({ client, contentReader: dependencies.contentReader });
    const message = await query.getMailMessage(context, messageId);
    if (message.direction !== "INBOUND" || message.parseStatus !== "PARSED") {
      throw fail("MAIL_REPLY_INBOUND_REQUIRED");
    }
    const rows = await client.query(`
      SELECT m.gmail_connection_id "gmailConnectionId",m.rfc_message_id "rfcMessageId",
        m.reference_message_ids "references",t.provider_thread_id "providerThreadId",
        raw.raw_object_key "rawObjectKey"
      FROM backlinks.backlink_mail_messages m
      JOIN backlinks.backlink_mail_threads t ON
        (t.organization_id,t.workspace_id,t.website_project_id,t.id)=
        (m.organization_id,m.workspace_id,m.website_project_id,m.mail_thread_id)
      JOIN backlinks.backlink_mail_raw_message_references raw ON
        (raw.organization_id,raw.workspace_id,raw.website_project_id,raw.id)=
        (m.organization_id,m.workspace_id,m.website_project_id,m.raw_message_reference_id)
      WHERE (m.organization_id,m.workspace_id,m.website_project_id,m.id)=($1,$2,$3,$4)
        AND raw.purged_at IS NULL`, [...valuesOf(context), messageId]);
    const row = rows.rows[0];
    if (!row?.rawObjectKey) throw fail("MAIL_REPLY_CONTENT_UNAVAILABLE");
    const body = await dependencies.contentReader.read({
      ...scopeOf(context), rawObjectKey: String(row.rawObjectKey),
    });
    if (!body.plainText && !body.sanitizedHtml) throw fail("MAIL_REPLY_CONTENT_UNAVAILABLE");
    const recipient = replyRecipient(message.fromAddress, body.replyToAddresses ?? []);
    const references = Array.isArray(row.references)
      ? row.references.filter((id): id is string => typeof id === "string" && messageIdPattern.test(id))
      : [];
    return {
      message, recipient, subject: replySubject(message.subject),
      gmailConnectionId: String(row.gmailConnectionId),
      providerThreadId: String(row.providerThreadId),
      inReplyTo: String(row.rfcMessageId ?? ""),
      references: [...new Set([...references, String(row.rfcMessageId ?? "")])].slice(-30),
    };
  };

  return {
    async context(context: ResolvedProjectContext, messageId: string) {
      return withBacklinkTenantTransaction(dependencies.pool, scopeOf(context), async (client) => {
        const data = await load(client, context, messageId);
        const thread = await createReplyMailQuery({
          client, contentReader: dependencies.contentReader,
        }).getMailThread(context, data.message.threadId);
        const existing = await client.query(`
          SELECT r.draft_id "draftId",i.id "sendIntentId",i.status,v.body_text body
          FROM backlinks.backlink_mail_reply_drafts r
          JOIN backlinks.backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,v.id)=
            (r.organization_id,r.workspace_id,r.website_project_id,r.draft_version_id)
          LEFT JOIN backlinks.backlink_send_intents i ON
            (i.organization_id,i.workspace_id,i.website_project_id,i.draft_id)=
            (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
          WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.mail_message_id)=($1,$2,$3,$4)`,
        [...valuesOf(context), messageId]);
        return { ...data, thread, existingReply: existing.rows[0] ?? null };
      });
    },

    async send(context: ResolvedProjectContext, messageId: string, raw: ReplySendInput) {
      const input = replySendSchema.parse(raw);
      if (!context.actor.roles.some((role) => ["owner", "admin", "member"].includes(role))) {
        throw new BacklinkError({ code: backlinkErrorCodes.accessDenied, message: "Reply write permission required." });
      }
      const scope = scopeOf(context);
      const base = valuesOf(context);
      const contentHash = createHash("sha256").update(JSON.stringify([
        input.gmailConnectionId, input.recipient, input.subject, input.body,
      ])).digest("hex");
      // A per-message lock and immutable lineage prevent double-clicks or a
      // lost HTTP response from creating another independently sendable draft.
      const prepared = await withBacklinkTenantTransaction(dependencies.pool, scope, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `mail-reply:${base.join(":")}:${messageId}`,
        ]);
        const data = await load(client, context, messageId);
        if (input.expectedVersion !== data.message.version
          || input.gmailConnectionId !== data.gmailConnectionId
          || input.recipient !== data.recipient || input.subject !== data.subject
          || !messageIdPattern.test(data.inReplyTo)) throw fail("MAIL_REPLY_CONTEXT_CHANGED");
        const opportunityId = data.message.matchedOpportunityId;
        if (!opportunityId) throw fail("MAIL_REPLY_MATCH_REQUIRED");
        const existing = await client.query(`
          SELECT r.content_hash "contentHash",d.id "draftId",
            r.draft_version_id "versionId",d.approved_version_id "approvedVersionId",
            d.contact_id "contactId",d.contact_version "contactVersion"
          FROM backlinks.backlink_mail_reply_drafts r
          JOIN backlinks.backlink_email_drafts d ON
            (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
          WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.mail_message_id)=($1,$2,$3,$4)`,
        [...base, messageId]);
        if (existing.rows[0]) {
          if (existing.rows[0].contentHash !== contentHash) throw fail("MAIL_REPLY_ALREADY_SUBMITTED");
          if (existing.rows[0].versionId !== existing.rows[0].approvedVersionId) {
            throw fail("MAIL_REPLY_CONTEXT_CHANGED");
          }
          return existing.rows[0];
        }
        const contacts = createContactCommands(client);
        const selection = await contacts.listOpportunityContacts(context, opportunityId);
        let contact: { id: string; version: number } | undefined =
          selection.items.find((item) => item.normalizedEmail === data.recipient);
        if (!contact) {
          const candidate = await contacts.createManualCandidate({
            context, requestId: `mail-reply:${messageId}`, opportunityId,
            normalizedEmail: data.recipient, contactRole: "general",
            reason: `User confirmed reply recipient from received mail ${messageId}`,
            idempotencyKey: `mail-reply-contact:${messageId}`,
          });
          const confirmed = await contacts.confirm({
            context, requestId: `mail-reply:${messageId}`, candidateId: candidate.candidateId,
            expectedVersion: candidate.version, contactRole: "general",
            reason: `User confirmed reply recipient from received mail ${messageId}`,
          });
          contact = { id: confirmed.contactId, version: confirmed.contactVersion };
        }
        const previous = await client.query(`
          SELECT request_payload FROM backlinks.backlink_draft_request_snapshots
          WHERE (organization_id,workspace_id,website_project_id,opportunity_id)=($1,$2,$3,$4)
          ORDER BY created_at DESC LIMIT 1`, [...base, opportunityId]);
        if (!previous.rows[0]) throw fail("MAIL_REPLY_SOURCE_DRAFT_REQUIRED");
        const request = draftRequestSchema.parse(previous.rows[0].request_payload);
        const actorId = context.actor.userId;
        const now = new Date();
        const evidence = await createDraftGenerationRepository(client).prepareEvidenceSnapshot({
          ...scope, opportunityId, contactId: contact.id, contactVersion: contact.version,
          snapshotId: randomUUID(), requestSnapshotId: randomUUID(), request,
          actorId, recordedAt: now,
        });
        const draftId = randomUUID(), versionId = randomUUID();
        await client.query(`
          INSERT INTO backlinks.backlink_email_drafts
            (id,organization_id,workspace_id,website_project_id,opportunity_id,
             contact_id,contact_version,logical_draft_key,status,created_by,updated_by)
          VALUES ($4,$1,$2,$3,$5,$6,$7,$8,'draft',$9,$9)`,
        [...base, draftId, opportunityId, contact.id, contact.version, `mail-reply:${messageId}`, actorId]);
        await client.query(`
          INSERT INTO backlinks.backlink_draft_versions
            (id,organization_id,workspace_id,website_project_id,draft_id,opportunity_id,
             contact_id,contact_version,version_no,source,evidence_snapshot_id,request_snapshot_id,
             subject_text,body_text,body_document,structured_output,evidence_ids,
             prompt_version,output_schema_version,requires_user_confirmation,can_auto_send,created_by)
          VALUES ($4,$1,$2,$3,$5,$6,$7,$8,1,'MANUAL',$9,$10,$11,$12,$13::jsonb,$14::jsonb,
            '[]'::jsonb,'mail-reply.v1','ai-draft.v1',true,false,$15)`,
        [...base, versionId, draftId, opportunityId, contact.id, contact.version,
          evidence.snapshotId, evidence.requestSnapshotId, input.subject, input.body,
          JSON.stringify({ type: "doc", content: input.body.split("\n\n").map((text) => ({
            type: "paragraph", content: [{ type: "text", text }],
          })) }),
          JSON.stringify({ subject: input.subject, bodyText: input.body, factsUsed: [],
            riskFlags: [], requiresUserConfirmation: true, canAutoSend: false }),
          actorId]);
        await client.query(`UPDATE backlinks.backlink_email_drafts
          SET current_version_id=$5,last_successful_version_id=$5
          WHERE (organization_id,workspace_id,website_project_id,id)=($1,$2,$3,$4)`,
        [...base, draftId, versionId]);
        const approved = await createDraftEditingRepository(client).approve({
          ...scope, draftId, expectedVersion: 1, actorId, recordedAt: now,
        });
        if (approved.state !== "completed") throw fail("MAIL_REPLY_APPROVAL_FAILED");
        await client.query(`INSERT INTO backlinks.backlink_mail_reply_drafts
          (organization_id,workspace_id,website_project_id,mail_message_id,draft_id,opportunity_id,
           gmail_connection_id,provider_thread_id,in_reply_to,reference_ids,recipient,
           content_hash,confirmation_mode,created_by,draft_version_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)`,
        [...base, messageId, draftId, opportunityId, data.gmailConnectionId, data.providerThreadId,
          data.inReplyTo, JSON.stringify(data.references), data.recipient, contentHash,
          input.confirmationMode, actorId, versionId]);
        return { draftId, versionId, contactId: contact.id, contactVersion: contact.version };
      });
      const command = {
        context, draftId: String(prepared.draftId), approvedDraftVersionId: String(prepared.versionId),
        contactId: String(prepared.contactId), contactVersion: Number(prepared.contactVersion),
        gmailConnectionId: input.gmailConnectionId, messagePurpose: "NEGOTIATION_REPLY" as const,
        followUpIndex: 0,
      };
      const existingIntent = await withBacklinkTenantTransaction(dependencies.pool, scope, (client) =>
        client.query(`SELECT id,status FROM backlinks.backlink_send_intents
          WHERE (organization_id,workspace_id,website_project_id,draft_id)=($1,$2,$3,$4)
          ORDER BY created_at DESC LIMIT 1`, [...base, command.draftId]));
      if (existingIntent.rows[0]) return { ...existingIntent.rows[0], replayed: true };
      const preflight = await dependencies.sendIntents.preflight(command);
      return dependencies.sendIntents.create({
        ...command, idempotencyKey: `mail-reply-send:${messageId}`,
        readinessSnapshot: preflight.readinessSnapshot,
        humanConfirmation: { confirmed: true, confirmedAt: new Date().toISOString(),
          readinessSnapshotVersion: preflight.readinessSnapshot.snapshotVersion },
      });
    },
  };
}

export type MailReplyService = ReturnType<typeof createMailReplyService>;
