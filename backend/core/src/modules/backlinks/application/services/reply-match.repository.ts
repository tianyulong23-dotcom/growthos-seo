import { createHash, randomUUID } from "node:crypto";

import type {
  ReplyMatchConfidence,
  ReplyMatchResult,
} from "../../domain/replies/matching.js";
import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export type ReplyMatchStatus =
  | "UNMATCHED"
  | "CANDIDATES_READY"
  | "MATCH_CONFIRMED";

export const replyAssignmentFactContractVersion =
  "reply-assignment-fact.v1" as const;

export type ReplyAssignmentFact = Readonly<{
  inboundMessageId: string;
  providerMessageId: string;
  providerThreadId: string;
  matchCandidateId: string;
  opportunityId: string;
  matchAuthority: "AUTO" | "MANUAL";
  confidence: number;
  ruleVersion: string;
  actorId: string;
  occurredAt: string;
  contractVersion: typeof replyAssignmentFactContractVersion;
}>;

export const createReplyAssignmentFact = (
  input: Omit<ReplyAssignmentFact, "occurredAt" | "contractVersion"> &
    Readonly<{ occurredAt: Date }>,
): ReplyAssignmentFact => Object.freeze({
  ...input,
  occurredAt: input.occurredAt.toISOString(),
  contractVersion: replyAssignmentFactContractVersion,
});

export type PersistedReplyMatchCandidate = Readonly<{
  id: string;
  inboundMessageId: string;
  opportunityId: string;
  candidateRank: number;
  confidenceScore: number;
  reasonCodes: readonly Readonly<Record<string, unknown>>[];
  requiresManualConfirmation: boolean;
  createdAt: string;
}>;

type ReplyMatchTenantScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type SaveReplyMatchResultInput = ReplyMatchTenantScope & Readonly<{
  gmailConnectionId: string;
  inboundMessageId: string;
  actorId: string;
  result: ReplyMatchResult;
}>;

export type SaveReplyMatchResultOutput =
  | Readonly<{
    state: "saved";
    inboundMessageId: string;
    matchStatus: ReplyMatchStatus;
    candidates: readonly PersistedReplyMatchCandidate[];
  }>
  | Readonly<{ state: "not_found" | "conflict" }>;

export type ListReplyMatchCandidatesInput =
  ReplyMatchTenantScope & Readonly<{ inboundMessageId: string }>;

export type ListReplyMatchCandidatesOutput =
  | Readonly<{
    state: "found";
    inboundMessageId: string;
    matchStatus: ReplyMatchStatus;
    candidates: readonly PersistedReplyMatchCandidate[];
  }>
  | Readonly<{ state: "not_found" }>;

export type ConfirmReplyMatchInput = ReplyMatchTenantScope & Readonly<{
  inboundMessageId: string;
  candidateId: string;
  expectedMatchStatus: "CANDIDATES_READY";
  actorId: string;
  requestId: string;
  reason: string;
}>;

export type ConfirmReplyMatchOutput =
  | Readonly<{
    state: "confirmed";
    candidateId: string;
    inboundMessageId: string;
    opportunityId: string;
    matchStatus: "MATCH_CONFIRMED";
    auditEventId: string;
  }>
  | Readonly<{ state: "not_found" | "conflict" }>;

export interface ReplyMatchRepository {
  saveMatchResult(
    input: SaveReplyMatchResultInput,
  ): Promise<SaveReplyMatchResultOutput>;
  listCandidates(
    input: ListReplyMatchCandidatesInput,
  ): Promise<ListReplyMatchCandidatesOutput>;
  confirmCandidate(
    input: ConfirmReplyMatchInput,
  ): Promise<ConfirmReplyMatchOutput>;
}

type PostgresqlReplyMatchRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
  now?: () => Date;
}>;

const assertNonBlank = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const assertScope = (input: ReplyMatchTenantScope): void => {
  assertNonBlank(input.organizationId, "Reply match organizationId");
  assertNonBlank(input.workspaceId, "Reply match workspaceId");
  assertNonBlank(input.websiteProjectId, "Reply match websiteProjectId");
};

const confidenceScore = (
  confidence: Exclude<ReplyMatchConfidence, "NONE">,
): number => {
  if (confidence === "HIGH") return 1;
  if (confidence === "MEDIUM") return 0.6;
  return 0.25;
};

const numberFromRow = (value: unknown, name: string): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${name} returned an invalid value.`);
  }
  return numeric;
};

const dateStringFromRow = (value: unknown, name: string): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${name} returned an invalid value.`);
  }
  return date.toISOString();
};

const reasonCodesFromRow = (
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value)) {
    throw new TypeError("Reply match reasonCodes returned an invalid value.");
  }
  return Object.freeze(value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError(
        "Reply match reasonCodes returned an invalid entry.",
      );
    }
    return Object.freeze({ ...item });
  }));
};

const candidateFromRow = (
  row: Record<string, unknown>,
): PersistedReplyMatchCandidate => Object.freeze({
  id: String(row.id),
  inboundMessageId: String(row.inboundMessageId),
  opportunityId: String(row.opportunityId),
  candidateRank: numberFromRow(row.candidateRank, "Reply candidate rank"),
  confidenceScore: numberFromRow(
    row.confidenceScore,
    "Reply candidate confidenceScore",
  ),
  reasonCodes: reasonCodesFromRow(row.reasonCodes),
  requiresManualConfirmation: row.requiresManualConfirmation === true,
  createdAt: dateStringFromRow(row.createdAt, "Reply candidate createdAt"),
});

const candidateSelect = `
  SELECT candidate.id,
         candidate.inbound_message_id AS "inboundMessageId",
         candidate.opportunity_id AS "opportunityId",
         candidate.candidate_rank AS "candidateRank",
         candidate.confidence_score AS "confidenceScore",
         candidate.reason_codes AS "reasonCodes",
         candidate.requires_manual_confirmation AS
           "requiresManualConfirmation",
         candidate.created_at AS "createdAt"
    FROM backlinks.backlink_reply_match_candidates AS candidate
   WHERE candidate.organization_id = $1
     AND candidate.workspace_id = $2
     AND candidate.website_project_id = $3
     AND candidate.inbound_message_id = $4
   ORDER BY candidate.candidate_rank, candidate.id`;

const listCandidatesInTransaction = async (
  transaction: BacklinkTransactionClient,
  input: ListReplyMatchCandidatesInput,
): Promise<ListReplyMatchCandidatesOutput> => {
  const inbound = await transaction.query(
    `SELECT message.id,
            message.match_status AS "matchStatus"
       FROM backlinks.backlink_inbound_messages AS message
      WHERE message.organization_id = $1
        AND message.workspace_id = $2
        AND message.website_project_id = $3
        AND message.id = $4`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.inboundMessageId,
    ],
  );
  const row = inbound.rows[0];
  if (row === undefined) return { state: "not_found" };

  const candidates = await transaction.query(candidateSelect, [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.inboundMessageId,
  ]);
  return Object.freeze({
    state: "found",
    inboundMessageId: input.inboundMessageId,
    matchStatus: String(row.matchStatus) as ReplyMatchStatus,
    candidates: Object.freeze(candidates.rows.map(candidateFromRow)),
  });
};

const ruleVersionFromReasonCodes = (
  reasonCodes: readonly Readonly<Record<string, unknown>>[],
): string => {
  const marker = reasonCodes.find((item) => item.kind === "RULE_VERSION");
  const value = marker?.value;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : "unknown";
};

const auditIntegrityHash = (
  previousIntegrityHash: string | null,
  fact: ReplyAssignmentFact,
  requestId: string,
  action: string,
  reason: string,
): string => createHash("sha256").update(JSON.stringify({
  previousIntegrityHash,
  fact,
  requestId,
  action,
  reason,
})).digest("hex");

type AppendReplyAssignmentFactInput = ReplyMatchTenantScope & Readonly<{
  fact: ReplyAssignmentFact;
  actorKind: "system" | "user";
  auditAction: string;
  auditTargetType: string;
  auditTargetId: string;
  reason: string;
  beforeRedacted: Readonly<Record<string, unknown>>;
  afterRedacted: Readonly<Record<string, unknown>>;
  requestId: string;
}>;

export class PostgresqlReplyMatchRepository
implements ReplyMatchRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: PostgresqlReplyMatchRepositoryDependencies) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async #appendAssignmentFact(
    transaction: BacklinkTransactionClient,
    input: AppendReplyAssignmentFactInput,
  ): Promise<string> {
    const previousAudit = await transaction.query(
      `SELECT audit.integrity_hash AS "integrityHash"
         FROM backlinks.backlink_audit_events AS audit
        WHERE audit.organization_id = $1
          AND audit.workspace_id = $2
          AND audit.website_project_id = $3
        ORDER BY audit.created_at DESC, audit.id DESC
        LIMIT 1`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
      ],
    );
    const previousValue = previousAudit.rows[0]?.integrityHash;
    const previousIntegrityHash = typeof previousValue === "string"
      ? previousValue
      : null;
    const lifecycleEventId = this.#newId();
    const auditEventId = this.#newId();
    const result = await transaction.query(
      `WITH lifecycle AS (
         INSERT INTO backlinks.backlink_lifecycle_events (
           id, organization_id, workspace_id, website_project_id,
           aggregate_type, aggregate_id, sequence, aggregate_version,
           event_type, actor_type, actor_id, after_state, reason,
           correlation_id, idempotency_key, event_schema_version
         ) VALUES (
           $1, $2, $3, $4, 'reply_assignment', $5::uuid, 1, 1,
           'reply.assignment.recorded', $6, $7, $8::jsonb, $9, $10,
           'reply.assignment:' || $5::uuid::text, 1
         )
         RETURNING id
       ), audit AS (
         INSERT INTO backlinks.backlink_audit_events (
           id, organization_id, workspace_id, website_project_id,
           lifecycle_event_id, actor_id, actor_kind, action, target_type,
           target_id, outcome, reason, before_redacted, after_redacted,
           request_id, correlation_id, previous_integrity_hash,
           integrity_hash, event_schema_version
         )
         SELECT $11, $2, $3, $4, lifecycle.id, $7, $6, $12, $13, $14,
           'success', $9, $15::jsonb, $16::jsonb, $10, $10, $17, $18, 1
         FROM lifecycle
         RETURNING id
       )
       SELECT audit.id AS "auditEventId"
       FROM lifecycle CROSS JOIN audit`,
      [
        lifecycleEventId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.fact.inboundMessageId,
        input.actorKind,
        input.fact.actorId,
        JSON.stringify(input.fact),
        input.reason,
        input.requestId,
        auditEventId,
        input.auditAction,
        input.auditTargetType,
        input.auditTargetId,
        JSON.stringify(input.beforeRedacted),
        JSON.stringify(input.afterRedacted),
        previousIntegrityHash,
        auditIntegrityHash(
          previousIntegrityHash,
          input.fact,
          input.requestId,
          input.auditAction,
          input.reason,
        ),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Reply assignment fact could not be appended.");
    }
    return String(row.auditEventId);
  }

  async saveMatchResult(
    input: SaveReplyMatchResultInput,
  ): Promise<SaveReplyMatchResultOutput> {
    assertScope(input);
    assertNonBlank(input.gmailConnectionId, "Reply match gmailConnectionId");
    assertNonBlank(input.inboundMessageId, "Reply match inboundMessageId");
    assertNonBlank(input.actorId, "Reply match actorId");

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const inbound = await transaction.query(
        `SELECT message.id,
                message.match_status AS "matchStatus",
                raw.provider_message_id AS "providerMessageId",
                raw.provider_thread_id AS "providerThreadId"
           FROM backlinks.backlink_inbound_messages AS message
           JOIN backlinks.backlink_mail_messages AS mail
             ON mail.organization_id = message.organization_id
            AND mail.workspace_id = message.workspace_id
            AND mail.website_project_id = message.website_project_id
            AND mail.gmail_connection_id = message.gmail_connection_id
            AND mail.id = message.mail_message_id
           JOIN backlinks.backlink_mail_raw_message_references AS raw
             ON raw.organization_id = mail.organization_id
            AND raw.workspace_id = mail.workspace_id
            AND raw.website_project_id = mail.website_project_id
            AND raw.gmail_connection_id = mail.gmail_connection_id
            AND raw.id = mail.raw_message_reference_id
          WHERE message.organization_id = $1
            AND message.workspace_id = $2
            AND message.website_project_id = $3
            AND message.gmail_connection_id = $4
            AND message.id = $5
          FOR UPDATE`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.gmailConnectionId,
          input.inboundMessageId,
        ],
      );
      const inboundRow = inbound.rows[0];
      if (inboundRow === undefined) return { state: "not_found" };
      if (inboundRow.matchStatus === "MATCH_CONFIRMED") {
        return { state: "conflict" };
      }

      const manualDecision = input.result.decision !== "AUTO_MATCHED";
      for (const [index, candidate] of input.result.candidates.entries()) {
        const requiresManualConfirmation =
          manualDecision
          || candidate.opportunityId !== input.result.matchedOpportunityId;
        const reasonCodes = [{
          kind: "RULE_VERSION",
          value: input.result.ruleVersion,
        }, ...candidate.evidence];
        await transaction.query(
          `INSERT INTO backlinks.backlink_reply_match_candidates (
             id, organization_id, workspace_id, website_project_id,
             inbound_message_id, opportunity_id, candidate_rank,
             confidence_score, reason_codes,
             requires_manual_confirmation, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
           )
           ON CONFLICT (inbound_message_id, opportunity_id)
           DO UPDATE SET
             candidate_rank = EXCLUDED.candidate_rank,
             confidence_score = EXCLUDED.confidence_score,
             reason_codes = EXCLUDED.reason_codes,
             requires_manual_confirmation =
               EXCLUDED.requires_manual_confirmation`,
          [
            this.#newId(),
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.inboundMessageId,
            candidate.opportunityId,
            index + 1,
            confidenceScore(candidate.confidence),
            JSON.stringify(reasonCodes),
            requiresManualConfirmation,
            input.actorId,
          ],
        );
      }

      const matchStatus: ReplyMatchStatus =
        input.result.decision === "AUTO_MATCHED"
          ? "MATCH_CONFIRMED"
          : input.result.candidates.length > 0
          ? "CANDIDATES_READY"
          : "UNMATCHED";
      await transaction.query(
        `UPDATE backlinks.backlink_inbound_messages AS message
            SET match_status = $6,
                updated_at = statement_timestamp(),
                updated_by = $7
          WHERE message.organization_id = $1
            AND message.workspace_id = $2
            AND message.website_project_id = $3
            AND message.gmail_connection_id = $4
            AND message.id = $5`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.gmailConnectionId,
          input.inboundMessageId,
          matchStatus,
          input.actorId,
        ],
      );
      if (input.result.decision === "AUTO_MATCHED") {
        const matchedOpportunityId = input.result.matchedOpportunityId;
        if (matchedOpportunityId === null) {
          throw new Error(
            "Automatic Reply Match did not identify an opportunity.",
          );
        }
        const selectedCandidate = await transaction.query(
          `SELECT candidate.id,
                  candidate.confidence_score AS "confidenceScore"
             FROM backlinks.backlink_reply_match_candidates AS candidate
            WHERE candidate.organization_id = $1
              AND candidate.workspace_id = $2
              AND candidate.website_project_id = $3
              AND candidate.inbound_message_id = $4
              AND candidate.opportunity_id = $5`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.inboundMessageId,
            matchedOpportunityId,
          ],
        );
        const candidateRow = selectedCandidate.rows[0];
        if (candidateRow === undefined) {
          throw new Error(
            "Automatic Reply Match candidate could not be loaded.",
          );
        }
        const fact = createReplyAssignmentFact({
          inboundMessageId: input.inboundMessageId,
          providerMessageId: String(inboundRow.providerMessageId),
          providerThreadId: String(inboundRow.providerThreadId),
          matchCandidateId: String(candidateRow.id),
          opportunityId: matchedOpportunityId,
          matchAuthority: "AUTO",
          confidence: numberFromRow(
            candidateRow.confidenceScore,
            "Automatic Reply candidate confidenceScore",
          ),
          ruleVersion: input.result.ruleVersion,
          actorId: input.actorId,
          occurredAt: this.#now(),
        });
        await this.#appendAssignmentFact(transaction, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          fact,
          actorKind: "system",
          auditAction: "reply.assignment.recorded",
          auditTargetType: "inbound_message",
          auditTargetId: input.inboundMessageId,
          reason: "automatic_reply_match",
          beforeRedacted: {
            matchStatus: String(inboundRow.matchStatus),
          },
          afterRedacted: {
            matchStatus,
            opportunityId: matchedOpportunityId,
            matchCandidateId: String(candidateRow.id),
            ruleVersion: input.result.ruleVersion,
          },
          requestId: `reply.assignment.auto:${input.inboundMessageId}`,
        });
      }
      const listed = await listCandidatesInTransaction(transaction, input);
      if (listed.state !== "found") {
        throw new Error("Saved Reply Match candidates could not be loaded.");
      }
      return Object.freeze({
        state: "saved",
        inboundMessageId: input.inboundMessageId,
        matchStatus,
        candidates: listed.candidates,
      });
    });
  }

  async listCandidates(
    input: ListReplyMatchCandidatesInput,
  ): Promise<ListReplyMatchCandidatesOutput> {
    assertScope(input);
    assertNonBlank(input.inboundMessageId, "Reply match inboundMessageId");
    return withGmailTenantTransaction(
      this.#pool,
      input,
      (transaction) => listCandidatesInTransaction(transaction, input),
    );
  }

  async confirmCandidate(
    input: ConfirmReplyMatchInput,
  ): Promise<ConfirmReplyMatchOutput> {
    assertScope(input);
    assertNonBlank(input.inboundMessageId, "Reply match inboundMessageId");
    assertNonBlank(input.candidateId, "Reply match candidateId");
    assertNonBlank(input.actorId, "Reply match actorId");
    assertNonBlank(input.requestId, "Reply match requestId");
    assertNonBlank(input.reason, "Reply match reason");

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const selected = await transaction.query(
        `SELECT candidate.opportunity_id AS "opportunityId",
                candidate.reason_codes AS "reasonCodes",
                candidate.confidence_score AS "confidenceScore",
                candidate.requires_manual_confirmation AS
                  "requiresManualConfirmation",
                message.match_status AS "matchStatus",
                raw.provider_message_id AS "providerMessageId",
                raw.provider_thread_id AS "providerThreadId"
           FROM backlinks.backlink_reply_match_candidates AS candidate
           JOIN backlinks.backlink_inbound_messages AS message
             ON message.organization_id = candidate.organization_id
            AND message.workspace_id = candidate.workspace_id
            AND message.website_project_id = candidate.website_project_id
            AND message.id = candidate.inbound_message_id
           JOIN backlinks.backlink_mail_messages AS mail
             ON mail.organization_id = message.organization_id
            AND mail.workspace_id = message.workspace_id
            AND mail.website_project_id = message.website_project_id
            AND mail.gmail_connection_id = message.gmail_connection_id
            AND mail.id = message.mail_message_id
           JOIN backlinks.backlink_mail_raw_message_references AS raw
             ON raw.organization_id = mail.organization_id
            AND raw.workspace_id = mail.workspace_id
            AND raw.website_project_id = mail.website_project_id
            AND raw.gmail_connection_id = mail.gmail_connection_id
            AND raw.id = mail.raw_message_reference_id
          WHERE candidate.organization_id = $1
            AND candidate.workspace_id = $2
            AND candidate.website_project_id = $3
            AND candidate.inbound_message_id = $4
            AND candidate.id = $5
          FOR UPDATE OF candidate, message`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.inboundMessageId,
          input.candidateId,
        ],
      );
      const selectedRow = selected.rows[0];
      if (selectedRow === undefined) return { state: "not_found" };
      if (
        selectedRow.matchStatus !== input.expectedMatchStatus
        || selectedRow.requiresManualConfirmation !== true
      ) {
        return { state: "conflict" };
      }

      const opportunityId = String(selectedRow.opportunityId);
      const reasonCodes = reasonCodesFromRow(selectedRow.reasonCodes);
      const ruleVersion = ruleVersionFromReasonCodes(reasonCodes);
      const candidateUpdated = await transaction.query(
        `UPDATE backlinks.backlink_reply_match_candidates AS candidate
            SET requires_manual_confirmation = false
          WHERE candidate.organization_id = $1
            AND candidate.workspace_id = $2
            AND candidate.website_project_id = $3
            AND candidate.inbound_message_id = $4
            AND candidate.id = $5
            AND candidate.requires_manual_confirmation = true
          RETURNING candidate.id`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.inboundMessageId,
          input.candidateId,
        ],
      );
      const inboundUpdated = await transaction.query(
        `UPDATE backlinks.backlink_inbound_messages AS message
            SET match_status = 'MATCH_CONFIRMED',
                updated_at = statement_timestamp(),
                updated_by = $6
          WHERE message.organization_id = $1
            AND message.workspace_id = $2
            AND message.website_project_id = $3
            AND message.id = $4
            AND message.match_status = $5
          RETURNING message.id`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.inboundMessageId,
          input.expectedMatchStatus,
          input.actorId,
        ],
      );
      if (
        candidateUpdated.rows[0] === undefined
        || inboundUpdated.rows[0] === undefined
      ) {
        throw new Error("Reply Match confirmation lost its transaction lock.");
      }

      const fact = createReplyAssignmentFact({
        inboundMessageId: input.inboundMessageId,
        providerMessageId: String(selectedRow.providerMessageId),
        providerThreadId: String(selectedRow.providerThreadId),
        matchCandidateId: input.candidateId,
        opportunityId,
        matchAuthority: "MANUAL",
        confidence: numberFromRow(
          selectedRow.confidenceScore,
          "Manual Reply candidate confidenceScore",
        ),
        ruleVersion,
        actorId: input.actorId,
        occurredAt: this.#now(),
      });
      const auditEventId = await this.#appendAssignmentFact(transaction, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        fact,
        actorKind: "user",
        auditAction: "reply_match_candidate.confirmed",
        auditTargetType: "reply_match_candidate",
        auditTargetId: input.candidateId,
        reason: input.reason,
        beforeRedacted: {
          matchStatus: input.expectedMatchStatus,
          requiresManualConfirmation: true,
        },
        afterRedacted: {
          matchStatus: "MATCH_CONFIRMED",
          opportunityId,
          requiresManualConfirmation: false,
          ruleVersion,
        },
        requestId: input.requestId,
      });
      return Object.freeze({
        state: "confirmed",
        candidateId: input.candidateId,
        inboundMessageId: input.inboundMessageId,
        opportunityId,
        matchStatus: "MATCH_CONFIRMED",
        auditEventId,
      });
    });
  }
}
