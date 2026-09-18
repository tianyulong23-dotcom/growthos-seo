import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMailReplyService } from "../../../src/modules/backlinks/application/services/mail-reply.service.js";
import { withBacklinkTenantTransaction, type BacklinkTenantPool } from "../../../src/modules/backlinks/db/tenant-transaction.js";
import type { ResolvedProjectContext } from "../../../src/modules/backlinks/ports/project-context.port.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";

type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const { Client: PgClient, Pool: PgPool } = createRequire(import.meta.url)("pg") as {
  Client: new (options: unknown) => Client;
  Pool: new (options: unknown) => BacklinkTenantPool & { end(): Promise<void> };
};
const id = (n: number) => `018f9900-0000-7000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), workspaceId: id(2), websiteProjectId: id(3) };
const identity = `'${id(1)}','${id(2)}','${id(3)}'`;
const context = {
  tenant: { organizationId: id(1), workspaceId: id(2) },
  project: { websiteProjectId: id(3), websiteProjectKey: id(3) },
  actor: { userId: "fixture-user", roles: ["member"] },
} as unknown as ResolvedProjectContext;
const input = {
  expectedVersion: 1, gmailConnectionId: id(501), recipient: "bruno@example.com",
  subject: "Re: Cooperation", body: "Obrigado. Poderiam confirmar os atributos do link?",
  confirmed: true as const, confirmationMode: "MANUAL" as const,
};

describe("reply drafts on the canonical tenant database", () => {
  let harness: BacklinksPostgresHarness, admin: Client, pool: BacklinkTenantPool & { end(): Promise<void> };
  let role: string;
  let service: ReturnType<typeof createMailReplyService>;
  const preflight = vi.fn().mockResolvedValue({ readinessSnapshot: { snapshotVersion: 1 } });
  const create = vi.fn().mockResolvedValue({ id: id(900), status: "QUEUED" });

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness(); await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString }); await admin.connect();
    await installBacklinksManifestAfterFoundation(admin, "0102");
    await admin.query("RESET ROLE; SET search_path=backlinks,pg_catalog");
    // Seed a historical recommendation only in the isolated fixture DB.
    // Restore its write freeze before exercising any application commands.
    await admin.query(`ALTER TABLE backlink_recommendations
      DISABLE TRIGGER backlink_recommendation_v1_freeze_guard`);
    await admin.query(`
      INSERT INTO backlink_project_context_snapshots
        (id,organization_id,workspace_id,website_project_id,snapshot_version,project_status,canonical_domain,
         locale,country_code,products,keywords,target_urls,profile_version_id,promotion_target_version_id,created_by)
      VALUES ('${id(100)}',${identity},1,'ACTIVE','owner.example','en-US','US',
        '["GrowthOS"]','["outreach"]','["https://owner.example/"]','profile','promotion','test');
      INSERT INTO backlink_prospects
        (id,organization_id,workspace_id,website_project_id,recommendation_context_version_id,
         hostname_ascii,registrable_domain,normalization_version,created_by,updated_by)
      VALUES ('${id(101)}',${identity},'${id(102)}','www.example.com','example.com','test','test','test');
      INSERT INTO backlink_recommendations
        (id,organization_id,workspace_id,website_project_id,prospect_id,recommendation_context_version_id,status,created_by,updated_by)
      VALUES ('${id(201)}',${identity},'${id(101)}','${id(102)}','accepted','test','test');
      INSERT INTO backlink_opportunities
        (id,organization_id,workspace_id,website_project_id,recommendation_id,prospect_id,recommendation_context_version_id,
         target_site_key,target_host_ascii,target_identity_rule_version,join_sequence,created_by,updated_by)
      VALUES ('${id(301)}',${identity},'${id(201)}','${id(101)}','${id(102)}','example.com','www.example.com','test',1,'test','test');
      INSERT INTO backlink_contact_candidates
        (id,organization_id,workspace_id,website_project_id,prospect_id,recommendation_context_version_id,
         normalized_email,email_domain_ascii,domain_relation,syntax_validator_version,confidence,observed_role,
         inferred_purpose,purpose_confidence,purpose_rule_version,purpose_evidence,guessed,status,version,created_by,updated_by)
      VALUES ('${id(103)}',${identity},'${id(101)}','${id(102)}','contact@example.com','example.com','same_registrable_domain',
        'test',100,'general','general',100,'test','[]',false,'promoted',2,'test','test');
      INSERT INTO backlink_contacts
        (id,organization_id,workspace_id,website_project_id,prospect_id,recommendation_context_version_id,source_candidate_id,
         normalized_email,contact_role,confidence,observed_role,inferred_purpose,purpose_confidence,purpose_rule_version,
         purpose_evidence,guessed,confirmed_at,confirmed_by,status,version,created_by,updated_by)
      VALUES ('${id(104)}',${identity},'${id(101)}','${id(102)}','${id(103)}','contact@example.com','general',100,
        'general','general',100,'test','[]',false,now(),'test','active',1,'test','test');
      INSERT INTO backlink_draft_request_snapshots
        (id,organization_id,workspace_id,website_project_id,opportunity_id,contact_id,contact_version,request_payload,request_hash,schema_version,created_by)
      VALUES ('${id(400)}',${identity},'${id(301)}','${id(104)}',1,
        '{"promotionTargetUrl":"https://owner.example/","language":"en-US"}','${"0".repeat(64)}',1,'test');
      INSERT INTO backlink_secret_references
        (id,organization_id,provider,secret_kind,external_secret_id,external_secret_version,created_by,updated_by)
      VALUES ('${id(401)}','${id(1)}','gcp-secret-manager','GMAIL_TOKEN_SET','test/reply','1','test','test');
      INSERT INTO backlink_gmail_connections
        (id,organization_id,connected_by_user_id,google_subject,primary_email,granted_scopes,token_secret_reference_id,token_expires_at,created_by,updated_by)
      VALUES ('${id(501)}','${id(1)}','test','reply-fixture','sender@example.test',
        '["openid","email","profile","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/gmail.readonly"]',
        '${id(401)}',now()+interval '1 hour','test','test');
      INSERT INTO backlink_mail_raw_message_references
        (id,organization_id,workspace_id,website_project_id,gmail_connection_id,provider_message_id,provider_thread_id,
         history_id,raw_object_key,raw_content_sha256,raw_size_bytes,fetched_at,retention_expires_at,created_by)
      VALUES ('${id(701)}',${identity},'${id(501)}','message','thread','123','fixture/raw','${"a".repeat(64)}',42,now(),now()+interval '30 days','test');
      INSERT INTO backlink_mail_threads
        (id,organization_id,workspace_id,website_project_id,gmail_connection_id,provider_thread_id,message_count,created_by,updated_by)
      VALUES ('${id(702)}',${identity},'${id(501)}','thread',1,'test','test');
      INSERT INTO backlink_mail_messages
        (id,organization_id,workspace_id,website_project_id,gmail_connection_id,raw_message_reference_id,mail_thread_id,
         rfc_message_id,reference_message_ids,from_address,to_addresses,subject_text,received_at,direction,parse_status,parsed_at,created_by,updated_by)
      VALUES ('${id(703)}',${identity},'${id(501)}','${id(701)}','${id(702)}','<received@example.com>',
        '["<original@owner.example>"]','bruno@example.com','["sender@example.test"]','Re: Cooperation',now(),'INBOUND','PARSED',now(),'test','test');
      INSERT INTO backlink_inbound_messages
        (id,organization_id,workspace_id,website_project_id,gmail_connection_id,mail_message_id,received_at,match_status,created_by,updated_by)
      VALUES ('${id(704)}',${identity},'${id(501)}','${id(703)}',now(),'MATCH_CONFIRMED','test','test');
      INSERT INTO backlink_reply_match_candidates
        (id,organization_id,workspace_id,website_project_id,inbound_message_id,opportunity_id,candidate_rank,
         confidence_score,reason_codes,requires_manual_confirmation,created_by)
      VALUES ('${id(705)}',${identity},'${id(704)}','${id(301)}',1,1,'["gmail_thread_id"]',false,'test');
    `);
    await admin.query(`ALTER TABLE backlink_recommendations
      ENABLE TRIGGER backlink_recommendation_v1_freeze_guard`);
    await admin.query("RESET ROLE; SET search_path=backlinks,pg_catalog");
    role = `reply_test_${randomBytes(8).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${role}"`);
    const url = new URL(harness.connectionString); url.username = role; url.password = password;
    pool = new PgPool({ connectionString: url.toString(), max: 1, options: "-c search_path=backlinks,pg_catalog" });
    service = createMailReplyService({
      pool, contentReader: { read: async () => ({ plainText: "O preco e R$ 500.", sanitizedHtml: null }) },
      sendIntents: { preflight, create } as never,
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && role) await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await admin?.end(); await harness?.stop();
  });

  it("reads the actual sender and thread under RLS, rejects a different project", async () => {
    expect(await service.context(context, id(703))).toMatchObject({
      recipient: "bruno@example.com", providerThreadId: "thread", existingReply: null,
      inReplyTo: "<received@example.com>",
    });
    await expect(service.context({ ...context, project: { ...context.project, websiteProjectId: id(999) } }, id(703))).rejects.toThrow();
  });
  it("rejects stale mail and changed recipient before creating any draft", async () => {
    await expect(service.send(context, id(703), { ...input, expectedVersion: 2 })).rejects.toThrow("MAIL_REPLY_CONTEXT_CHANGED");
    await expect(service.send(context, id(703), { ...input, recipient: "contact@example.com" })).rejects.toThrow("MAIL_REPLY_CONTEXT_CHANGED");
    expect(create).not.toHaveBeenCalled();
  });
  it("creates a canonical approved reply to a newly confirmed inbound contact, replays without another draft", async () => {
    await service.send(context, id(703), input);
    expect(preflight.mock.calls[0][0]).toMatchObject({ messagePurpose: "NEGOTIATION_REPLY", gmailConnectionId: id(501) });
    expect(create.mock.calls[0][0].humanConfirmation.confirmed).toBe(true);
    const before = await service.context(context, id(703));
    expect(before.existingReply).toMatchObject({ body: input.body, sendIntentId: null });
    await service.send(context, id(703), input);
    const after = await service.context(context, id(703));
    expect(after.existingReply?.draftId).toBe(before.existingReply?.draftId);
    await expect(service.send(context, id(703), { ...input, body: "Changed content" })).rejects.toThrow("MAIL_REPLY_ALREADY_SUBMITTED");
    const drafts = await withBacklinkTenantTransaction(pool, scope, (client) => client.query(`
      SELECT d.status,c.normalized_email email,v.body_text body FROM backlink_email_drafts d
      JOIN backlink_contacts c ON c.id=d.contact_id JOIN backlink_draft_versions v ON v.id=d.approved_version_id`));
    expect(drafts.rows).toEqual([{ status: "approved", email: "bruno@example.com", body: input.body }]);
  });
});
