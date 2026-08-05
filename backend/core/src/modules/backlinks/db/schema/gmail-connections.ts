import { createRequire } from "node:module";

type Builder = {
  notNull(): Builder;
  primaryKey(): unknown;
  default(value: unknown): Builder;
  defaultNow(): unknown;
};
type IndexBuilder = {
  where(condition: unknown): unknown;
};
type Table = Readonly<Record<string, unknown>>;

const require = createRequire(import.meta.url);
const { sql } = require("drizzle-orm") as {
  readonly sql: (
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ) => unknown;
};
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (
    name: string,
    columns: Record<string, unknown>,
    extra: (table: Table) => readonly unknown[],
  ) => Table;
  readonly uniqueIndex: (name: string) => {
    on(...columns: readonly unknown[]): IndexBuilder;
  };
  readonly index: (name: string) => {
    on(...columns: readonly unknown[]): unknown;
  };
  readonly foreignKey: (config: {
    readonly name: string;
    readonly columns: readonly unknown[];
    readonly foreignColumns: readonly unknown[];
  }) => unknown;
  readonly uuid: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly boolean: (name: string) => Builder;
  readonly jsonb: (name: string) => Builder;
  readonly timestamp: (
    name: string,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => Builder;
};

const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });

export const backlinkSecretReferences = pg.pgTable(
  "backlink_secret_references",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    provider: pg.text("provider").notNull(),
    secretKind: pg.text("secret_kind").notNull(),
    externalSecretId: pg.text("external_secret_id").notNull(),
    externalSecretVersion: pg.text("external_secret_version").notNull(),
    status: pg.text("status").notNull().default("ACTIVE"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_secret_reference_tenant_identity_uq").on(
      table.organizationId,
      table.id,
      table.secretKind,
    ),
    pg.uniqueIndex("backlink_secret_reference_external_uq").on(
      table.organizationId,
      table.provider,
      table.externalSecretId,
      table.externalSecretVersion,
    ),
  ],
);

export const backlinkOauthAttempts = pg.pgTable(
  "backlink_oauth_attempts",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id").notNull(),
    websiteProjectId: pg.uuid("website_project_id").notNull(),
    initiatedByUserId: pg.text("initiated_by_user_id").notNull(),
    stateHash: pg.text("state_hash").notNull(),
    sessionBindingHash: pg.text("session_binding_hash").notNull(),
    pkceVerifierSecretReferenceId: pg
      .uuid("pkce_verifier_secret_reference_id")
      .notNull(),
    pkceVerifierSecretKind: pg
      .text("pkce_verifier_secret_kind")
      .notNull()
      .default("OAUTH_PKCE_VERIFIER"),
    requestedScopes: pg.jsonb("requested_scopes").notNull(),
    redirectUri: pg.text("redirect_uri").notNull(),
    returnPath: pg.text("return_path"),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_oauth_attempt_tenant_identity_uq").on(
      table.organizationId,
      table.workspaceId,
      table.websiteProjectId,
      table.id,
    ),
    pg.uniqueIndex("backlink_oauth_attempt_state_hash_uq").on(table.stateHash),
    pg.foreignKey({
      name: "backlink_oauth_attempt_pkce_secret_fk",
      columns: [
        table.organizationId,
        table.pkceVerifierSecretReferenceId,
        table.pkceVerifierSecretKind,
      ],
      foreignColumns: [
        backlinkSecretReferences.organizationId,
        backlinkSecretReferences.id,
        backlinkSecretReferences.secretKind,
      ],
    }),
  ],
);

export const backlinkGmailConnections = pg.pgTable(
  "backlink_gmail_connections",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    connectedByUserId: pg.text("connected_by_user_id").notNull(),
    googleSubject: pg.text("google_subject").notNull(),
    primaryEmail: pg.text("primary_email").notNull(),
    displayName: pg.text("display_name"),
    hostedDomain: pg.text("hosted_domain"),
    grantedScopes: pg.jsonb("granted_scopes").notNull(),
    tokenSecretReferenceId: pg.uuid("token_secret_reference_id"),
    tokenSecretKind: pg
      .text("token_secret_kind")
      .default("GMAIL_TOKEN_SET"),
    tokenExpiresAt: timestamp("token_expires_at").notNull(),
    connectionStatus: pg.text("connection_status").notNull().default("CONNECTED"),
    reauthReason: pg.text("reauth_reason"),
    sendAvailability: pg.text("send_availability").notNull().default("AVAILABLE"),
    mailSyncCapability: pg.boolean("mail_sync_capability").notNull(),
    connectedAt: timestamp("connected_at").notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at"),
    lastApiErrorCode: pg.text("last_api_error_code"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_gmail_connection_tenant_identity_uq").on(
      table.organizationId,
      table.id,
    ),
    pg
      .index("backlink_gmail_connection_subject_idx")
      .on(table.organizationId, table.googleSubject),
    pg.foreignKey({
      name: "backlink_gmail_connection_token_secret_fk",
      columns: [
        table.organizationId,
        table.tokenSecretReferenceId,
        table.tokenSecretKind,
      ],
      foreignColumns: [
        backlinkSecretReferences.organizationId,
        backlinkSecretReferences.id,
        backlinkSecretReferences.secretKind,
      ],
    }),
  ],
);

export const backlinkGmailWorkspaceBindings = pg.pgTable(
  "backlink_gmail_workspace_bindings",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id").notNull(),
    websiteProjectId: pg.uuid("website_project_id").notNull(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    bindingStatus: pg.text("binding_status").notNull().default("ACTIVE"),
    isPrimary: pg.boolean("is_primary").notNull().default(true),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_gmail_workspace_binding_identity_uq").on(
      table.organizationId,
      table.workspaceId,
      table.websiteProjectId,
      table.gmailConnectionId,
    ),
    pg
      .uniqueIndex("backlink_gmail_workspace_primary_active_uq")
      .on(
        table.organizationId,
        table.workspaceId,
        table.websiteProjectId,
      )
      .where(
        sql`${table.bindingStatus} = 'ACTIVE' AND ${table.isPrimary} = true`,
      ),
    pg
      .uniqueIndex("backlink_gmail_connection_single_active_binding_uq")
      .on(table.organizationId, table.gmailConnectionId)
      .where(sql`${table.bindingStatus} = 'ACTIVE'`),
    pg.foreignKey({
      name: "backlink_gmail_workspace_binding_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
  ],
);

export const backlinkGmailSendIdentities = pg.pgTable(
  "backlink_gmail_send_identities",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    normalizedEmail: pg.text("normalized_email").notNull(),
    displayName: pg.text("display_name"),
    isPrimary: pg.boolean("is_primary").notNull(),
    isDefault: pg.boolean("is_default").notNull(),
    verificationStatus: pg.text("verification_status").notNull(),
    treatAsAlias: pg.boolean("treat_as_alias").notNull(),
    source: pg.text("source").notNull(),
    observedAt: timestamp("observed_at").notNull(),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_gmail_send_identity_tenant_identity_uq").on(
      table.organizationId,
      table.id,
      table.gmailConnectionId,
    ),
    pg.uniqueIndex("backlink_gmail_send_identity_email_uq").on(
      table.organizationId,
      table.gmailConnectionId,
      table.normalizedEmail,
    ),
    pg.foreignKey({
      name: "backlink_gmail_send_identity_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
  ],
);

export const backlinkGmailConnectionRevocations = pg.pgTable(
  "backlink_gmail_connection_revocations",
  {
    gmailConnectionId: pg.uuid("gmail_connection_id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id").notNull(),
    websiteProjectId: pg.uuid("website_project_id").notNull(),
    tokenSecretReferenceId: pg.uuid("token_secret_reference_id").notNull(),
    tokenSecretKind: pg
      .text("token_secret_kind")
      .notNull()
      .default("GMAIL_TOKEN_SET"),
    googleRevoked: pg.boolean("google_revoked").notNull().default(false),
    failureCode: pg.text("failure_code"),
    attemptCount: pg.integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_gmail_revocation_tenant_identity_uq").on(
      table.organizationId,
      table.workspaceId,
      table.websiteProjectId,
      table.gmailConnectionId,
    ),
    pg.foreignKey({
      name: "backlink_gmail_revocation_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_gmail_revocation_token_secret_fk",
      columns: [
        table.organizationId,
        table.tokenSecretReferenceId,
        table.tokenSecretKind,
      ],
      foreignColumns: [
        backlinkSecretReferences.organizationId,
        backlinkSecretReferences.id,
        backlinkSecretReferences.secretKind,
      ],
    }),
  ],
);
