import { createRequire } from "node:module";
import { projectIdentityColumns, versionedProjectAuditColumns } from "./common.js";
import { backlinkProspects } from "./recommendations.js";

type Builder = { notNull(): Builder; primaryKey(): unknown;
  default(value: unknown): unknown; defaultNow(): unknown };
type Table = Readonly<Record<string, unknown>>;
const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (name: string, columns: Record<string, unknown>,
    extra: (table: Table) => readonly unknown[]) => Table;
  readonly uniqueIndex: (name: string) => { on(...columns: readonly unknown[]): unknown };
  readonly foreignKey: (config: {
    readonly name: string; readonly columns: readonly unknown[];
    readonly foreignColumns: readonly unknown[] }) => unknown;
  readonly uuid: (name: string) => Builder; readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder; readonly boolean: (name: string) => Builder;
  readonly jsonb: (name: string) => Builder;
  readonly timestamp: (name: string, config: {
    readonly mode: "date"; readonly withTimezone: true }) => Builder;
};
const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });
const identity = (table: Table) =>
  [table.organizationId, table.workspaceId, table.websiteProjectId] as const;
const candidateReference = () => ({
  prospectId: pg.uuid("prospect_id").notNull(),
  recommendationContextVersionId: pg.uuid("recommendation_context_version_id").notNull(),
});
const invalidation = () => ({
  invalidatedAt: timestamp("invalidated_at"), invalidationReason: pg.text("invalidation_reason"),
});

export const backlinkContactCandidates = pg.pgTable(
  "backlink_contact_candidates",
  {
    id: pg.uuid("id").primaryKey(), ...versionedProjectAuditColumns(),
    ...candidateReference(),
    normalizedEmail: pg.text("normalized_email").notNull(),
    emailDomainAscii: pg.text("email_domain_ascii").notNull(),
    domainRelation: pg.text("domain_relation").notNull(),
    syntaxValidatorVersion: pg.text("syntax_validator_version").notNull(),
    confidence: pg.integer("confidence").notNull(),
    observedRole: pg.text("observed_role"),
    inferredPurpose: pg.text("inferred_purpose").notNull().default("unknown"),
    purposeConfidence: pg.integer("purpose_confidence").notNull().default(0),
    purposeRuleVersion: pg.text("purpose_rule_version").notNull()
      .default("contact-purpose-rules.v1"),
    purposeEvidence: pg.jsonb("purpose_evidence").notNull().default([]),
    guessed: pg.boolean("guessed").notNull().default(false),
    status: pg.text("status").notNull().default("candidate"), ...invalidation(),
  },
  (table) => [
    pg.uniqueIndex("backlink_contact_candidate_tenant_identity_uq").on(
      ...identity(table), table.id,
    ),
    pg.uniqueIndex("backlink_contact_candidate_email_uq").on(
      ...identity(table), table.prospectId, table.recommendationContextVersionId,
      table.normalizedEmail,
    ),
    pg.uniqueIndex("backlink_contact_candidate_parent_uq").on(
      ...identity(table), table.id, table.prospectId, table.recommendationContextVersionId,
    ),
    pg.foreignKey({
      name: "backlink_contact_candidate_prospect_fk",
      columns: [...identity(table), table.prospectId, table.recommendationContextVersionId],
      foreignColumns: [...identity(backlinkProspects), backlinkProspects.id,
        backlinkProspects.recommendationContextVersionId],
    }),
  ],
);

export const backlinkContactEvidence = pg.pgTable(
  "backlink_contact_evidence",
  {
    id: pg.uuid("id").primaryKey(), ...projectIdentityColumns(),
    candidateId: pg.uuid("candidate_id").notNull(),
    sourceUrl: pg.text("source_url").notNull(),
    observedAt: timestamp("observed_at").notNull(),
    extractionMethod: pg.text("extraction_method").notNull(),
    evidenceSnippet: pg.text("evidence_snippet").notNull(),
    parserVersion: pg.text("parser_version").notNull(),
    contentSha256: pg.text("content_sha256").notNull(),
    confidence: pg.integer("confidence").notNull(), expiresAt: timestamp("expires_at").notNull(),
    ...invalidation(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.foreignKey({
      name: "backlink_contact_evidence_candidate_fk",
      columns: [...identity(table), table.candidateId],
      foreignColumns: [...identity(backlinkContactCandidates), backlinkContactCandidates.id],
    }),
  ],
);

export const backlinkContacts = pg.pgTable(
  "backlink_contacts",
  {
    id: pg.uuid("id").primaryKey(), ...versionedProjectAuditColumns(),
    ...candidateReference(),
    sourceCandidateId: pg.uuid("source_candidate_id").notNull(),
    normalizedEmail: pg.text("normalized_email").notNull(),
    contactRole: pg.text("contact_role").notNull(),
    confidence: pg.integer("confidence").notNull(),
    observedRole: pg.text("observed_role"),
    inferredPurpose: pg.text("inferred_purpose").notNull().default("unknown"),
    purposeConfidence: pg.integer("purpose_confidence").notNull().default(0),
    purposeRuleVersion: pg.text("purpose_rule_version").notNull()
      .default("contact-purpose-rules.v1"),
    purposeEvidence: pg.jsonb("purpose_evidence").notNull().default([]),
    guessed: pg.boolean("guessed").notNull().default(false),
    confirmedAt: timestamp("confirmed_at").notNull(), confirmedBy: pg.text("confirmed_by").notNull(),
    status: pg.text("status").notNull().default("active"), ...invalidation(),
  },
  (table) => [
    pg.uniqueIndex("backlink_contact_tenant_identity_uq").on(
      ...identity(table), table.id,
    ),
    pg.uniqueIndex("backlink_contact_email_uq").on(
      ...identity(table), table.prospectId, table.recommendationContextVersionId,
      table.normalizedEmail,
    ),
    pg.uniqueIndex("backlink_contact_source_candidate_uq").on(
      ...identity(table), table.sourceCandidateId,
    ),
    pg.foreignKey({
      name: "backlink_contact_source_candidate_fk",
      columns: [...identity(table), table.sourceCandidateId, table.prospectId,
        table.recommendationContextVersionId],
      foreignColumns: [...identity(backlinkContactCandidates), backlinkContactCandidates.id,
        backlinkContactCandidates.prospectId,
        backlinkContactCandidates.recommendationContextVersionId],
    }),
  ],
);
