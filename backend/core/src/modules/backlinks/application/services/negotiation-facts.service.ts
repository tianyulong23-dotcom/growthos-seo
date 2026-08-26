import { createHash, randomUUID } from "node:crypto";

import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export type NegotiationFactAuthority = "INFERRED" | "MANUAL";
export type NegotiationFactReviewStatus =
  | "PENDING"
  | "CONFIRMED"
  | "REJECTED"
  | "SUPERSEDED";
export type NegotiationFactDecision = "CONFIRM" | "REJECT" | "CORRECT";

export type NegotiationFactVersion = Readonly<{
  id: string;
  inboundMessageId: string;
  opportunityId: string;
  factKey: string;
  factVersion: number;
  factType: string;
  rawValue: string;
  normalizedValue: unknown;
  factAuthority: NegotiationFactAuthority;
  reviewStatus: NegotiationFactReviewStatus;
  extractorType: "RULE" | "AI" | "MANUAL";
  extractorVersion: string;
  confidenceScore: number;
  evidenceText: string;
  evidenceStart: number;
  evidenceEnd: number;
  supersedesFactVersionId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  schemaVersion: number;
  createdAt: string;
  createdBy: string;
}>;

export type NegotiationFactsView = Readonly<{
  inboundMessageId: string;
  opportunityId: string;
  items: readonly NegotiationFactVersion[];
}>;

export type NegotiationFactDecisionResult = Readonly<{
  decision: NegotiationFactDecision;
  replayed: boolean;
  appendedFactVersionIds: readonly string[];
  latestFact: NegotiationFactVersion;
}>;

export type NegotiationFactsService = Readonly<{
  list(
    context: ResolvedProjectContext,
    inboundMessageId: string,
  ): Promise<NegotiationFactsView>;
  decide(input: Readonly<{
    context: ResolvedProjectContext;
    inboundMessageId: string;
    sourceFactVersionId: string;
    expectedFactVersion: number;
    decision: NegotiationFactDecision;
    reason: string;
    requestId: string;
    idempotencyKey: string;
    correction?: Readonly<{
      factType: string;
      rawValue: string;
      normalizedValue: unknown;
    }>;
  }>): Promise<NegotiationFactDecisionResult>;
}>;

type Binding = Readonly<{
  state: "ready";
  opportunityId: string;
}> | Readonly<{
  state: "not_found";
}> | Readonly<{
  state: "conflict";
}>;

type DecisionPlanRow = Readonly<{
  id: string;
  factVersion: number;
  factType: string;
  rawValue: string;
  normalizedValue: unknown;
  reviewStatus: "CONFIRMED" | "REJECTED" | "SUPERSEDED";
  supersedesFactVersionId: string | null;
}>;

const nonBlank = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
  return normalized;
};

const numberFromRow = (value: unknown, name: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${name} returned an invalid number.`);
  }
  return parsed;
};

const isoFromRow = (value: unknown, name: string): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${name} returned an invalid timestamp.`);
  }
  return parsed.toISOString();
};

const nullableIsoFromRow = (value: unknown, name: string): string | null =>
  value === null || value === undefined ? null : isoFromRow(value, name);

const factFromRow = (
  row: Readonly<Record<string, unknown>>,
): NegotiationFactVersion => Object.freeze({
  id: String(row.id),
  inboundMessageId: String(row.inboundMessageId),
  opportunityId: String(row.opportunityId),
  factKey: String(row.factKey),
  factVersion: numberFromRow(row.factVersion, "Negotiation fact version"),
  factType: String(row.factType),
  rawValue: String(row.rawValue),
  normalizedValue: row.normalizedValue,
  factAuthority: String(row.factAuthority) as NegotiationFactAuthority,
  reviewStatus: String(row.reviewStatus) as NegotiationFactReviewStatus,
  extractorType: String(row.extractorType) as "RULE" | "AI" | "MANUAL",
  extractorVersion: String(row.extractorVersion),
  confidenceScore: numberFromRow(
    row.confidenceScore,
    "Negotiation fact confidence",
  ),
  evidenceText: String(row.evidenceText),
  evidenceStart: numberFromRow(
    row.evidenceStart,
    "Negotiation fact evidenceStart",
  ),
  evidenceEnd: numberFromRow(row.evidenceEnd, "Negotiation fact evidenceEnd"),
  supersedesFactVersionId:
    row.supersedesFactVersionId === null
      || row.supersedesFactVersionId === undefined
      ? null
      : String(row.supersedesFactVersionId),
  decidedBy:
    row.decidedBy === null || row.decidedBy === undefined
      ? null
      : String(row.decidedBy),
  decidedAt: nullableIsoFromRow(row.decidedAt, "Negotiation fact decidedAt"),
  schemaVersion: numberFromRow(
    row.schemaVersion,
    "Negotiation fact schemaVersion",
  ),
  createdAt: isoFromRow(row.createdAt, "Negotiation fact createdAt"),
  createdBy: String(row.createdBy),
});

const factSelect = `
  SELECT fact.id,
         fact.inbound_message_id AS "inboundMessageId",
         fact.opportunity_id AS "opportunityId",
         fact.fact_key AS "factKey",
         fact.fact_version AS "factVersion",
         fact.fact_type AS "factType",
         fact.raw_value AS "rawValue",
         fact.normalized_value AS "normalizedValue",
         fact.fact_authority AS "factAuthority",
         fact.review_status AS "reviewStatus",
         fact.extractor_type AS "extractorType",
         fact.extractor_version AS "extractorVersion",
         fact.confidence_score AS "confidenceScore",
         fact.evidence_text AS "evidenceText",
         fact.evidence_start AS "evidenceStart",
         fact.evidence_end AS "evidenceEnd",
         fact.supersedes_fact_version_id AS "supersedesFactVersionId",
         fact.decided_by AS "decidedBy",
         fact.decided_at AS "decidedAt",
         fact.schema_version AS "schemaVersion",
         fact.created_at AS "createdAt",
         fact.created_by AS "createdBy"
    FROM backlinks.backlink_negotiation_fact_versions AS fact`;

async function resolveBinding(
  transaction: BacklinkTransactionClient,
  context: ResolvedProjectContext,
  inboundMessageId: string,
  lock: boolean,
): Promise<Binding> {
  const result = await transaction.query(
    `SELECT message.id,
            message.match_status AS "matchStatus",
            candidate.opportunity_id AS "opportunityId"
       FROM backlinks.backlink_inbound_messages AS message
       LEFT JOIN backlinks.backlink_reply_match_candidates AS candidate
         ON candidate.organization_id = message.organization_id
        AND candidate.workspace_id = message.workspace_id
        AND candidate.website_project_id = message.website_project_id
        AND candidate.inbound_message_id = message.id
        AND candidate.requires_manual_confirmation = false
      WHERE message.organization_id = $1
        AND message.workspace_id = $2
        AND message.website_project_id = $3
        AND message.id = $4
      ${lock ? "FOR UPDATE OF message" : ""}`,
    [
      context.tenant.organizationId,
      context.tenant.workspaceId,
      context.project.websiteProjectId,
      inboundMessageId,
    ],
  );
  if (result.rows.length === 0) return { state: "not_found" };
  if (
    result.rows.length !== 1
    || result.rows[0]?.matchStatus !== "MATCH_CONFIRMED"
    || result.rows[0]?.opportunityId === null
    || result.rows[0]?.opportunityId === undefined
  ) {
    return { state: "conflict" };
  }
  return {
    state: "ready",
    opportunityId: String(result.rows[0].opportunityId),
  };
}

const scopeValues = (context: ResolvedProjectContext) => [
  context.tenant.organizationId,
  context.tenant.workspaceId,
  context.project.websiteProjectId,
] as const;

const authorizeDecision = (context: ResolvedProjectContext): void => {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role)
    )
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Negotiation fact review permission is required.",
    });
  }
};

export function planNegotiationFactDecision(input: Readonly<{
  source: NegotiationFactVersion;
  decision: NegotiationFactDecision;
  correction?: Readonly<{
    factType: string;
    rawValue: string;
    normalizedValue: unknown;
  }>;
  newId: () => string;
}>): readonly DecisionPlanRow[] {
  if (input.decision !== "CORRECT") {
    return [Object.freeze({
      id: input.newId(),
      factVersion: input.source.factVersion + 1,
      factType: input.source.factType,
      rawValue: input.source.rawValue,
      normalizedValue: input.source.normalizedValue,
      reviewStatus: input.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED",
      supersedesFactVersionId: null,
    })];
  }
  if (input.correction === undefined) {
    throw new TypeError("Negotiation fact correction is required.");
  }
  return Object.freeze([
    Object.freeze<DecisionPlanRow>({
      id: input.newId(),
      factVersion: input.source.factVersion + 1,
      factType: input.source.factType,
      rawValue: input.source.rawValue,
      normalizedValue: input.source.normalizedValue,
      reviewStatus: "SUPERSEDED",
      supersedesFactVersionId: input.source.id,
    }),
    Object.freeze<DecisionPlanRow>({
      id: input.newId(),
      factVersion: input.source.factVersion + 2,
      factType: nonBlank(input.correction.factType, "Correction factType"),
      rawValue: nonBlank(input.correction.rawValue, "Correction rawValue"),
      normalizedValue: input.correction.normalizedValue,
      reviewStatus: "CONFIRMED",
      supersedesFactVersionId: null,
    }),
  ]);
}

type ServiceDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
  now?: () => Date;
}>;

const replayResultFromState = (
  value: unknown,
): NegotiationFactDecisionResult | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const state = value as Record<string, unknown>;
  if (
    !["CONFIRM", "REJECT", "CORRECT"].includes(String(state.decision))
    || !Array.isArray(state.appendedFactVersionIds)
    || typeof state.latestFact !== "object"
    || state.latestFact === null
    || Array.isArray(state.latestFact)
  ) {
    return null;
  }
  return Object.freeze({
    decision: String(state.decision) as NegotiationFactDecision,
    replayed: true,
    appendedFactVersionIds: Object.freeze(
      state.appendedFactVersionIds.map(String),
    ),
    latestFact: factFromRow(state.latestFact as Record<string, unknown>),
  });
};

async function loadReplay(
  transaction: BacklinkTransactionClient,
  context: ResolvedProjectContext,
  idempotencyKey: string,
): Promise<NegotiationFactDecisionResult | null> {
  const result = await transaction.query(
    `SELECT event.after_state AS "afterState"
       FROM backlinks.backlink_lifecycle_events AS event
      WHERE event.organization_id = $1
        AND event.workspace_id = $2
        AND event.website_project_id = $3
        AND event.idempotency_key = $4
        AND event.event_type = 'negotiation.fact.reviewed'
      LIMIT 1`,
    [...scopeValues(context), idempotencyKey],
  );
  return replayResultFromState(result.rows[0]?.afterState);
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as { code?: unknown }).code === "23505";

const reviewIdempotencyKey = (value: string): string =>
  `negotiation.fact.review:${nonBlank(
    value,
    "Negotiation fact idempotencyKey",
  )}`;

export function createPostgresqlNegotiationFactsService(
  dependencies: ServiceDependencies,
): NegotiationFactsService {
  const newId = dependencies.newId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  const list = async (
    context: ResolvedProjectContext,
    inboundMessageId: string,
  ): Promise<NegotiationFactsView> => withBacklinkTenantTransaction(
    dependencies.pool,
    {
      ...context.tenant,
      websiteProjectId: context.project.websiteProjectId,
    },
    async (transaction) => {
      const binding = await resolveBinding(
        transaction,
        context,
        nonBlank(inboundMessageId, "Inbound message ID"),
        false,
      );
      if (binding.state === "not_found") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Inbound Reply was not found in this project.",
        });
      }
      if (binding.state === "conflict") {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message:
            "Negotiation facts require one confirmed Reply to Opportunity match.",
        });
      }
      const result = await transaction.query(
        `${factSelect}
          WHERE fact.organization_id = $1
            AND fact.workspace_id = $2
            AND fact.website_project_id = $3
            AND fact.inbound_message_id = $4
            AND fact.opportunity_id = $5
          ORDER BY fact.fact_key, fact.fact_version, fact.id`,
        [...scopeValues(context), inboundMessageId, binding.opportunityId],
      );
      return Object.freeze({
        inboundMessageId,
        opportunityId: binding.opportunityId,
        items: Object.freeze(result.rows.map(factFromRow)),
      });
    },
  );

  const decideOnce = async (input: Parameters<NegotiationFactsService["decide"]>[0]) => {
    const idempotencyKey = reviewIdempotencyKey(input.idempotencyKey);
    return withBacklinkTenantTransaction(
      dependencies.pool,
      {
        ...input.context.tenant,
        websiteProjectId: input.context.project.websiteProjectId,
      },
      async (transaction): Promise<NegotiationFactDecisionResult> => {
        const replay = await loadReplay(
          transaction,
          input.context,
          idempotencyKey,
        );
        if (replay !== null) return replay;

        const binding = await resolveBinding(
          transaction,
          input.context,
          nonBlank(input.inboundMessageId, "Inbound message ID"),
          true,
        );
        if (binding.state === "not_found") {
          throw new BacklinkError({
            code: backlinkErrorCodes.notFound,
            message: "Inbound Reply was not found in this project.",
          });
        }
        if (binding.state === "conflict") {
          throw new BacklinkError({
            code: backlinkErrorCodes.conflict,
            message:
              "Negotiation facts require one confirmed Reply to Opportunity match.",
          });
        }

        const sourceResult = await transaction.query(
          `${factSelect}
            WHERE fact.organization_id = $1
              AND fact.workspace_id = $2
              AND fact.website_project_id = $3
              AND fact.inbound_message_id = $4
              AND fact.opportunity_id = $5
              AND fact.id = $6
            FOR UPDATE`,
          [
            ...scopeValues(input.context),
            input.inboundMessageId,
            binding.opportunityId,
            input.sourceFactVersionId,
          ],
        );
        const sourceRow = sourceResult.rows[0];
        if (sourceRow === undefined) {
          throw new BacklinkError({
            code: backlinkErrorCodes.notFound,
            message: "Negotiation fact was not found in this project.",
          });
        }
        const source = factFromRow(sourceRow);
        const latest = await transaction.query(
          `SELECT max(fact.fact_version)::integer AS version
             FROM backlinks.backlink_negotiation_fact_versions AS fact
            WHERE fact.organization_id = $1
              AND fact.workspace_id = $2
              AND fact.website_project_id = $3
              AND fact.opportunity_id = $4
              AND fact.fact_key = $5`,
          [
            ...scopeValues(input.context),
            binding.opportunityId,
            source.factKey,
          ],
        );
        if (
          source.factVersion !== input.expectedFactVersion
          || numberFromRow(latest.rows[0]?.version, "Latest fact version")
            !== input.expectedFactVersion
          || !["PENDING", "CONFIRMED"].includes(source.reviewStatus)
        ) {
          throw new BacklinkError({
            code: backlinkErrorCodes.conflict,
            message: "Negotiation fact review state is stale.",
          });
        }
        if (
          input.decision !== "CORRECT"
          && source.reviewStatus !== "PENDING"
        ) {
          throw new BacklinkError({
            code: backlinkErrorCodes.conflict,
            message: "Only pending negotiation facts can be confirmed or rejected.",
          });
        }

        const decidedAt = now();
        const rows = planNegotiationFactDecision({
          source,
          decision: input.decision,
          ...(input.correction === undefined
            ? {}
            : { correction: input.correction }),
          newId,
        });
        const inserted: NegotiationFactVersion[] = [];
        for (const row of rows) {
          const result = await transaction.query(
            `INSERT INTO backlinks.backlink_negotiation_fact_versions (
               id, organization_id, workspace_id, website_project_id,
               inbound_message_id, opportunity_id, fact_key, fact_version,
               fact_type, raw_value, normalized_value, fact_authority,
               review_status, extractor_type, extractor_version,
               confidence_score, evidence_text, evidence_start, evidence_end,
               supersedes_fact_version_id, decided_by, decided_at,
               schema_version, created_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'MANUAL',$12,
               'MANUAL','manual-review-v1',1,$13,$14,$15,$16,$17,$18,1,$17
             )
             RETURNING id,
               inbound_message_id AS "inboundMessageId",
               opportunity_id AS "opportunityId",
               fact_key AS "factKey", fact_version AS "factVersion",
               fact_type AS "factType", raw_value AS "rawValue",
               normalized_value AS "normalizedValue",
               fact_authority AS "factAuthority",
               review_status AS "reviewStatus",
               extractor_type AS "extractorType",
               extractor_version AS "extractorVersion",
               confidence_score AS "confidenceScore",
               evidence_text AS "evidenceText",
               evidence_start AS "evidenceStart",
               evidence_end AS "evidenceEnd",
               supersedes_fact_version_id AS "supersedesFactVersionId",
               decided_by AS "decidedBy", decided_at AS "decidedAt",
               schema_version AS "schemaVersion", created_at AS "createdAt",
               created_by AS "createdBy"`,
            [
              row.id,
              ...scopeValues(input.context),
              input.inboundMessageId,
              binding.opportunityId,
              source.factKey,
              row.factVersion,
              row.factType,
              row.rawValue,
              JSON.stringify(row.normalizedValue),
              row.reviewStatus,
              source.evidenceText,
              source.evidenceStart,
              source.evidenceEnd,
              row.supersedesFactVersionId,
              input.context.actor.userId,
              decidedAt,
            ],
          );
          const insertedRow = result.rows[0];
          if (insertedRow === undefined) {
            throw new Error("Negotiation fact version was not appended.");
          }
          inserted.push(factFromRow(insertedRow));
        }

        const latestFact = inserted.at(-1);
        if (latestFact === undefined) {
          throw new Error("Negotiation fact decision appended no versions.");
        }
        const outputState = {
          decision: input.decision,
          appendedFactVersionIds: inserted.map((item) => item.id),
          latestFact,
        };
        const lifecycleEventId = newId();
        const auditEventId = newId();
        const previousAudit = await transaction.query(
          `SELECT audit.integrity_hash AS "integrityHash"
             FROM backlinks.backlink_audit_events AS audit
            WHERE audit.organization_id = $1
              AND audit.workspace_id = $2
              AND audit.website_project_id = $3
            ORDER BY audit.created_at DESC, audit.id DESC
            LIMIT 1`,
          scopeValues(input.context),
        );
        const previousIntegrityHash =
          typeof previousAudit.rows[0]?.integrityHash === "string"
            ? previousAudit.rows[0].integrityHash
            : null;
        const integrityHash = createHash("sha256").update(JSON.stringify({
          previousIntegrityHash,
          requestId: input.requestId,
          sourceFactVersionId: source.id,
          outputState,
          reason: input.reason,
        })).digest("hex");
        await transaction.query(
          `WITH next_sequence AS (
             SELECT COALESCE(max(event.sequence),0)::integer + 1 AS value
               FROM backlinks.backlink_lifecycle_events AS event
              WHERE event.organization_id = $2
                AND event.workspace_id = $3
                AND event.website_project_id = $4
                AND event.aggregate_type = 'negotiation_fact'
                AND event.aggregate_id = $5::uuid
           ), lifecycle AS (
             INSERT INTO backlinks.backlink_lifecycle_events (
               id, organization_id, workspace_id, website_project_id,
               aggregate_type, aggregate_id, sequence, aggregate_version,
               event_type, actor_type, actor_id, before_state, after_state,
               reason, correlation_id, idempotency_key, event_schema_version
             ) VALUES (
               $1,$2,$3,$4,'negotiation_fact',$5::uuid,
               (SELECT value FROM next_sequence),
               (SELECT value FROM next_sequence),
               'negotiation.fact.reviewed','user',$6,$7::jsonb,$8::jsonb,
               $9,$10,$11,1
             )
             RETURNING id
           )
           INSERT INTO backlinks.backlink_audit_events (
             id, organization_id, workspace_id, website_project_id,
             lifecycle_event_id, actor_id, actor_kind, action, target_type,
             target_id, outcome, reason, before_redacted, after_redacted,
             request_id, correlation_id, previous_integrity_hash,
             integrity_hash, event_schema_version
           )
           SELECT $12,$2,$3,$4,lifecycle.id,$6,'user',
             'negotiation.fact.reviewed','negotiation_fact',$5::uuid,
             'success',$9,$7::jsonb,$8::jsonb,$10,$10,$13,$14,1
           FROM lifecycle`,
          [
            lifecycleEventId,
            ...scopeValues(input.context),
            source.id,
            input.context.actor.userId,
            JSON.stringify(source),
            JSON.stringify(outputState),
            nonBlank(input.reason, "Negotiation fact review reason"),
            input.requestId,
            idempotencyKey,
            auditEventId,
            previousIntegrityHash,
            integrityHash,
          ],
        );
        return Object.freeze({
          ...outputState,
          replayed: false,
          appendedFactVersionIds: Object.freeze(
            outputState.appendedFactVersionIds,
          ),
        });
      },
    );
  };

  return Object.freeze({
    list,
    async decide(input) {
      authorizeDecision(input.context);
      nonBlank(input.requestId, "Negotiation fact requestId");
      const idempotencyKey = reviewIdempotencyKey(input.idempotencyKey);
      try {
        return await decideOnce(input);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const replay = await withBacklinkTenantTransaction(
          dependencies.pool,
          {
            ...input.context.tenant,
            websiteProjectId: input.context.project.websiteProjectId,
          },
          (transaction) => loadReplay(
            transaction,
            input.context,
            idempotencyKey,
          ),
        );
        if (replay !== null) return replay;
        throw error;
      }
    },
  });
}
