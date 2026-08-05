import { randomUUID } from "node:crypto";

import type {
  GmailConnectionReader,
  GmailConnectionView,
} from "../../application/gmail-connection.gateway.js";
import type {
  GmailConnectionSecretPersistence,
  GmailConnectionSecretPersistenceCreateInput,
  GmailConnectionSecretPersistenceRefreshState,
  GmailConnectionSecretPersistenceReplaceInput,
} from "../../application/services/gmail-connection-secret.repository.js";
import type {
  GmailConnectionDisconnectPersistence,
  GmailConnectionRevocationFailureCode,
  GmailConnectionRevocationScope,
  PendingGmailConnectionRevocation,
} from "../../application/workflows/gmail-connection-disconnect.workflow.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  secretKinds,
  type SecretStoreReference,
} from "../../ports/secret-store.port.js";
import { withGmailTenantTransaction } from "../gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../tenant-transaction.js";

type PostgresqlGmailConnectionRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
  now?: () => Date;
}>;

type RefreshLookup = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  connectionId: string;
}>;

class LostRefreshRace extends Error {}

const asIso = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  throw new TypeError("Gmail persistence returned an invalid timestamp.");
};

const asStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError("Gmail persistence returned invalid scopes.");
  }
  return Object.freeze([...value]);
};

const viewFromRow = (row: Record<string, unknown>): GmailConnectionView => {
  const connectionId = row.connectionId;
  const version = row.version;
  const primaryEmail = row.primaryEmail;
  const displayName = row.displayName;
  const hostedDomain = row.hostedDomain;
  const connectionStatus = row.connectionStatus;
  const sendAvailability = row.sendAvailability;
  const mailSyncCapability = row.mailSyncCapability;
  if (
    typeof connectionId !== "string"
    || typeof version !== "number"
    || typeof primaryEmail !== "string"
    || (displayName !== null && typeof displayName !== "string")
    || (hostedDomain !== null && typeof hostedDomain !== "string")
    || ![
      "CONNECTING",
      "CONNECTED",
      "REAUTH_REQUIRED",
      "TOKEN_REVOKED",
      "DISCONNECTED",
    ].includes(String(connectionStatus))
    || !["AVAILABLE", "PAUSED"].includes(String(sendAvailability))
    || typeof mailSyncCapability !== "boolean"
  ) {
    throw new TypeError("Gmail persistence returned an invalid connection.");
  }
  return {
    connectionId,
    version,
    primaryEmail,
    displayName,
    hostedDomain,
    grantedScopes: asStringArray(row.grantedScopes),
    connectionStatus: connectionStatus as GmailConnectionView["connectionStatus"],
    sendAvailability: sendAvailability as GmailConnectionView["sendAvailability"],
    mailSyncCapability,
    tokenExpiresAt: asIso(row.tokenExpiresAt),
    connectedAt: asIso(row.connectedAt),
  };
};

const referenceFromRow = (
  row: Record<string, unknown>,
): SecretStoreReference => {
  const provider = row.provider;
  const secretKind = row.secretKind;
  const externalSecretId = row.externalSecretId;
  const externalSecretVersion = row.externalSecretVersion;
  if (
    typeof provider !== "string"
    || secretKind !== secretKinds.gmailTokenSet
    || typeof externalSecretId !== "string"
    || typeof externalSecretVersion !== "string"
  ) {
    throw new TypeError("Gmail persistence returned an invalid Secret Ref.");
  }
  return { provider, secretKind, externalSecretId, externalSecretVersion };
};

const selectView = `
  connection.id AS "connectionId",
  connection.version,
  connection.primary_email AS "primaryEmail",
  connection.display_name AS "displayName",
  connection.hosted_domain AS "hostedDomain",
  connection.granted_scopes AS "grantedScopes",
  connection.connection_status AS "connectionStatus",
  connection.send_availability AS "sendAvailability",
  connection.mail_sync_capability AS "mailSyncCapability",
  connection.token_expires_at AS "tokenExpiresAt",
  connection.connected_at AS "connectedAt"`;

const insertSecretReference = async (
  transaction: BacklinkTransactionClient,
  input: Readonly<{
    id: string;
    organizationId: string;
    actorId: string;
    reference: SecretStoreReference;
  }>,
) => {
  await transaction.query(
    `INSERT INTO backlinks.backlink_secret_references (
       id, organization_id, provider, secret_kind, external_secret_id,
       external_secret_version, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      input.id,
      input.organizationId,
      input.reference.provider,
      input.reference.secretKind,
      input.reference.externalSecretId,
      input.reference.externalSecretVersion,
      input.actorId,
    ],
  );
};

export class PostgresqlGmailConnectionRepository
implements
  GmailConnectionSecretPersistence,
  GmailConnectionReader,
  GmailConnectionDisconnectPersistence {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: PostgresqlGmailConnectionRepositoryDependencies) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async createConnectionWithWorkspaceBinding(
    input: GmailConnectionSecretPersistenceCreateInput,
  ): Promise<GmailConnectionView> {
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const secretReferenceId = this.#newId();
      await insertSecretReference(transaction, {
        id: secretReferenceId,
        organizationId: input.organizationId,
        actorId: input.connectedByUserId,
        reference: input.tokenSecretReference,
      });
      const result = await transaction.query(
        `WITH connection AS (
           INSERT INTO backlinks.backlink_gmail_connections (
             id, organization_id, connected_by_user_id, google_subject,
             primary_email, display_name, hosted_domain, granted_scopes,
             token_secret_reference_id, token_secret_kind, token_expires_at,
             created_by, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
             'GMAIL_TOKEN_SET', $10, $3, $3
           )
           RETURNING *
         ),
         binding AS (
           INSERT INTO backlinks.backlink_gmail_workspace_bindings (
             id, organization_id, workspace_id, website_project_id,
             gmail_connection_id, created_by, updated_by
           ) SELECT $11, $2, $12, $13, id, $3, $3 FROM connection
           RETURNING id
         ),
         identity AS (
           INSERT INTO backlinks.backlink_gmail_send_identities (
             id, organization_id, gmail_connection_id, normalized_email,
             display_name, is_primary, is_default, verification_status,
             treat_as_alias, source, observed_at, created_by, updated_by
           ) SELECT
             $14, $2, id, primary_email, display_name, true, true,
             'accepted', false, 'OIDC_PRIMARY', connected_at, $3, $3
             FROM connection
           ON CONFLICT (
             organization_id, gmail_connection_id, normalized_email
           ) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             is_primary = true,
             is_default = true,
             verification_status = 'accepted',
             treat_as_alias = false,
             source = 'OIDC_PRIMARY',
             observed_at = EXCLUDED.observed_at,
             version = backlink_gmail_send_identities.version + 1,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
           RETURNING id
         )
         SELECT ${selectView}
           FROM connection
          WHERE EXISTS (SELECT 1 FROM binding)
            AND EXISTS (SELECT 1 FROM identity)`,
        [
          input.connectionId,
          input.organizationId,
          input.connectedByUserId,
          input.googleSubject,
          input.primaryEmail,
          input.displayName,
          input.hostedDomain,
          JSON.stringify(input.grantedScopes),
          secretReferenceId,
          input.tokenExpiresAt,
          this.#newId(),
          input.workspaceId,
          input.websiteProjectId,
          this.#newId(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new TypeError("Gmail connection creation returned no row.");
      }
      return viewFromRow(row);
    });
  }

  async findVisibleConnection(
    context: ResolvedProjectContext,
  ): Promise<GmailConnectionView | null> {
    return withGmailTenantTransaction(
      this.#pool,
      {
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
      },
      async (transaction) => {
        const result = await transaction.query(
          `SELECT ${selectView}
             FROM backlinks.backlink_gmail_connections AS connection
             JOIN backlinks.backlink_gmail_workspace_bindings AS binding
               ON binding.organization_id = connection.organization_id
              AND binding.gmail_connection_id = connection.id
            WHERE connection.organization_id = $1
              AND binding.workspace_id = $2
              AND binding.website_project_id = $3
              AND binding.binding_status = 'ACTIVE'
              AND binding.is_primary = true`,
          [
            context.tenant.organizationId,
            context.tenant.workspaceId,
            context.project.websiteProjectId,
          ],
        );
        const row = result.rows[0];
        return row === undefined ? null : viewFromRow(row);
      },
    );
  }

  async findRefreshState(
    input: RefreshLookup,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null> {
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const result = await transaction.query(
        `SELECT ${selectView},
                secret.provider,
                secret.secret_kind AS "secretKind",
                secret.external_secret_id AS "externalSecretId",
                secret.external_secret_version AS "externalSecretVersion"
           FROM backlinks.backlink_gmail_connections AS connection
           JOIN backlinks.backlink_gmail_workspace_bindings AS binding
             ON binding.organization_id = connection.organization_id
            AND binding.gmail_connection_id = connection.id
           JOIN backlinks.backlink_secret_references AS secret
             ON secret.organization_id = connection.organization_id
            AND secret.id = connection.token_secret_reference_id
            AND secret.secret_kind = connection.token_secret_kind
          WHERE connection.organization_id = $1
            AND connection.id = $2
            AND binding.workspace_id = $3
            AND binding.website_project_id = $4
            AND binding.binding_status = 'ACTIVE'
            AND connection.connection_status IN ('CONNECTED', 'REAUTH_REQUIRED')
            AND secret.status = 'ACTIVE'`,
        [
          input.organizationId,
          input.connectionId,
          input.workspaceId,
          input.websiteProjectId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const view = viewFromRow(row);
      return {
        organizationId: input.organizationId,
        connectionId: view.connectionId,
        version: view.version,
        tokenSecretReference: referenceFromRow(row),
        view,
      };
    });
  }

  async replaceTokenReference(
    input: GmailConnectionSecretPersistenceReplaceInput,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null> {
    try {
      return await withGmailTenantTransaction(
        this.#pool,
        input,
        async (transaction) => {
          const nextReferenceId = this.#newId();
          await insertSecretReference(transaction, {
            id: nextReferenceId,
            organizationId: input.organizationId,
            actorId: input.actorId,
            reference: input.tokenSecretReference,
          });
          const result = await transaction.query(
            `WITH current AS (
               SELECT connection.token_secret_reference_id
                 FROM backlinks.backlink_gmail_connections AS connection
                WHERE connection.organization_id = $1
                  AND connection.id = $2
                  AND connection.version = $4
                  AND EXISTS (
                    SELECT 1
                      FROM backlinks.backlink_gmail_workspace_bindings AS binding
                     WHERE binding.organization_id = $1
                       AND binding.workspace_id = $3
                       AND binding.website_project_id = $9
                       AND binding.gmail_connection_id = connection.id
                       AND binding.binding_status = 'ACTIVE'
                  )
                FOR UPDATE
             ),
             changed AS (
               UPDATE backlinks.backlink_gmail_connections AS connection
                  SET token_secret_reference_id = $5,
                      token_secret_kind = 'GMAIL_TOKEN_SET',
                      token_expires_at = $6,
                      granted_scopes = $7::jsonb,
                      connection_status = 'CONNECTED',
                      send_availability = 'AVAILABLE',
                      reauth_reason = NULL,
                      last_api_error_code = NULL,
                      version = version + 1,
                      updated_at = now(),
                      updated_by = $8
                 FROM current
                WHERE organization_id = $1
                  AND id = $2
              RETURNING connection.*,
                        connection.token_secret_reference_id AS new_reference_id
             ),
             retired AS (
               UPDATE backlinks.backlink_secret_references AS secret
                  SET status = 'RETIRED', version = secret.version + 1,
                      updated_at = now(), updated_by = $8
                 FROM current, changed
                WHERE secret.organization_id = $1
                  AND secret.id = current.token_secret_reference_id
              RETURNING secret.id
             )
             SELECT ${selectView}
               FROM changed AS connection
              WHERE EXISTS (SELECT 1 FROM retired)`,
            [
              input.organizationId,
              input.connectionId,
              input.workspaceId,
              input.expectedVersion,
              nextReferenceId,
              input.tokenExpiresAt,
              JSON.stringify(input.grantedScopes),
              input.actorId,
              input.websiteProjectId,
            ],
          );
          const row = result.rows[0];
          if (row === undefined) {
            throw new LostRefreshRace();
          }
          const view = viewFromRow(row);
          return {
            organizationId: input.organizationId,
            connectionId: view.connectionId,
            version: view.version,
            tokenSecretReference: input.tokenSecretReference,
            view,
          };
        },
      );
    } catch (error) {
      if (error instanceof LostRefreshRace) {
        return null;
      }
      throw error;
    }
  }

  async markReauthRequired(
    input: RefreshLookup & Readonly<{
      actorId: string;
      expectedVersion: number;
      reason: "GOOGLE_AUTH_EXPIRED";
    }>,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null> {
    const changed = await withGmailTenantTransaction(
      this.#pool,
      input,
      async (transaction) => {
        const result = await transaction.query(
          `UPDATE backlinks.backlink_gmail_connections AS connection
              SET connection_status = 'REAUTH_REQUIRED',
                  send_availability = 'PAUSED',
                  reauth_reason = $5,
                  last_api_error_code = $5,
                  version = version + 1,
                  updated_at = now(),
                  updated_by = $6
            WHERE organization_id = $1
              AND id = $2
              AND version = $4
              AND EXISTS (
                SELECT 1
                  FROM backlinks.backlink_gmail_workspace_bindings AS binding
                 WHERE binding.organization_id = $1
                   AND binding.workspace_id = $3
                   AND binding.website_project_id = $7
                   AND binding.gmail_connection_id = connection.id
                   AND binding.binding_status = 'ACTIVE'
              )
          RETURNING id`,
          [
            input.organizationId,
            input.connectionId,
            input.workspaceId,
            input.expectedVersion,
            input.reason,
            input.actorId,
            input.websiteProjectId,
          ],
        );
        return result.rows[0] !== undefined;
      },
    );
    return changed ? this.findRefreshState(input) : null;
  }

  async prepareDisconnect(
    input: GmailConnectionRevocationScope & Readonly<{
      actorId: string;
      expectedVersion: number;
    }>,
  ): Promise<PendingGmailConnectionRevocation | null> {
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const selected = await transaction.query(
        `SELECT ${selectView},
                connection.token_secret_reference_id AS "referenceId",
                secret.provider,
                secret.secret_kind AS "secretKind",
                secret.external_secret_id AS "externalSecretId",
                secret.external_secret_version AS "externalSecretVersion"
           FROM backlinks.backlink_gmail_connections AS connection
           JOIN backlinks.backlink_gmail_workspace_bindings AS binding
             ON binding.organization_id = connection.organization_id
            AND binding.gmail_connection_id = connection.id
           JOIN backlinks.backlink_secret_references AS secret
             ON secret.organization_id = connection.organization_id
            AND secret.id = connection.token_secret_reference_id
            AND secret.secret_kind = connection.token_secret_kind
          WHERE connection.organization_id = $1
            AND connection.id = $2
            AND connection.version = $3
            AND binding.workspace_id = $4
            AND binding.website_project_id = $5
            AND binding.binding_status = 'ACTIVE'
          FOR UPDATE OF connection`,
        [
          input.organizationId,
          input.connectionId,
          input.expectedVersion,
          input.workspaceId,
          input.websiteProjectId,
        ],
      );
      const row = selected.rows[0];
      if (row === undefined || typeof row.referenceId !== "string") {
        return null;
      }
      const reference = referenceFromRow(row);
      await transaction.query(
        `INSERT INTO backlinks.backlink_gmail_connection_revocations (
           gmail_connection_id, organization_id, workspace_id,
           website_project_id, token_secret_reference_id, token_secret_kind,
           created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, 'GMAIL_TOKEN_SET', $6, $6)`,
        [
          input.connectionId,
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          row.referenceId,
          input.actorId,
        ],
      );
      const disconnected = await transaction.query(
        `UPDATE backlinks.backlink_gmail_connections AS connection
            SET token_secret_reference_id = NULL,
                token_secret_kind = NULL,
                connection_status = 'DISCONNECTED',
                send_availability = 'PAUSED',
                reauth_reason = NULL,
                disconnected_at = $4,
                version = version + 1,
                updated_at = $4,
                updated_by = $3
          WHERE organization_id = $1 AND id = $2
        RETURNING ${selectView}`,
        [
          input.organizationId,
          input.connectionId,
          input.actorId,
          this.#now(),
        ],
      );
      await transaction.query(
        `UPDATE backlinks.backlink_gmail_workspace_bindings
            SET binding_status = 'INACTIVE', version = version + 1,
                updated_at = now(), updated_by = $3
          WHERE organization_id = $1 AND gmail_connection_id = $2
            AND workspace_id = $4
            AND website_project_id = $5
            AND binding_status = 'ACTIVE'`,
        [
          input.organizationId,
          input.connectionId,
          input.actorId,
          input.workspaceId,
          input.websiteProjectId,
        ],
      );
      const disconnectedRow = disconnected.rows[0];
      if (disconnectedRow === undefined) {
        throw new TypeError("Gmail disconnect returned no row.");
      }
      return {
        ...input,
        connection: viewFromRow(disconnectedRow),
        tokenSecretReference: reference,
        googleRevoked: false,
      };
    });
  }

  async loadPendingRevocation(
    input: GmailConnectionRevocationScope,
  ): Promise<PendingGmailConnectionRevocation | null> {
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const result = await transaction.query(
        `SELECT ${selectView},
                revocation.google_revoked AS "googleRevoked",
                secret.provider,
                secret.secret_kind AS "secretKind",
                secret.external_secret_id AS "externalSecretId",
                secret.external_secret_version AS "externalSecretVersion"
           FROM backlinks.backlink_gmail_connection_revocations AS revocation
           JOIN backlinks.backlink_gmail_connections AS connection
             ON connection.organization_id = revocation.organization_id
            AND connection.id = revocation.gmail_connection_id
           JOIN backlinks.backlink_secret_references AS secret
             ON secret.organization_id = revocation.organization_id
            AND secret.id = revocation.token_secret_reference_id
            AND secret.secret_kind = revocation.token_secret_kind
          WHERE revocation.organization_id = $1
            AND revocation.workspace_id = $2
            AND revocation.website_project_id = $3
            AND revocation.gmail_connection_id = $4`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.connectionId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined || typeof row.googleRevoked !== "boolean") {
        return null;
      }
      return {
        ...input,
        connection: viewFromRow(row),
        tokenSecretReference: referenceFromRow(row),
        googleRevoked: row.googleRevoked,
      };
    });
  }

  async markGoogleRevoked(input: GmailConnectionRevocationScope): Promise<void> {
    await this.updateRevocation(input, {
      googleRevoked: true,
      failureCode: null,
    });
  }

  async recordRevocationFailure(
    input: GmailConnectionRevocationScope & Readonly<{
      failureCode: GmailConnectionRevocationFailureCode;
    }>,
  ): Promise<void> {
    await this.updateRevocation(input, {
      googleRevoked: null,
      failureCode: input.failureCode,
    });
  }

  async completeCredentialDeletion(
    input: GmailConnectionRevocationScope,
  ): Promise<GmailConnectionView> {
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const result = await transaction.query(
        `WITH pending AS (
           DELETE FROM backlinks.backlink_gmail_connection_revocations
            WHERE organization_id = $1
              AND workspace_id = $2
              AND website_project_id = $3
              AND gmail_connection_id = $4
          RETURNING token_secret_reference_id
         ),
         destroyed AS (
           UPDATE backlinks.backlink_secret_references AS secret
              SET status = 'DESTROYED', version = version + 1,
                  updated_at = now(), updated_by = 'gmail-revocation'
             FROM pending
            WHERE secret.organization_id = $1
              AND secret.id = pending.token_secret_reference_id
          RETURNING secret.id
         )
         SELECT ${selectView}
           FROM backlinks.backlink_gmail_connections AS connection
          WHERE connection.organization_id = $1
            AND connection.id = $4
            AND EXISTS (SELECT 1 FROM destroyed)`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.connectionId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new TypeError("Pending Gmail credential deletion was not found.");
      }
      return viewFromRow(row);
    });
  }

  private async updateRevocation(
    input: GmailConnectionRevocationScope,
    update: Readonly<{
      googleRevoked: boolean | null;
      failureCode: GmailConnectionRevocationFailureCode | null;
    }>,
  ): Promise<void> {
    await withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `UPDATE backlinks.backlink_gmail_connection_revocations
            SET google_revoked = COALESCE($5, google_revoked),
                failure_code = $6,
                attempt_count = attempt_count + 1,
                updated_at = now(),
                updated_by = 'gmail-revocation'
          WHERE organization_id = $1
            AND workspace_id = $2
            AND website_project_id = $3
            AND gmail_connection_id = $4`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.connectionId,
          update.googleRevoked,
          update.failureCode,
        ],
      );
    });
  }
}

export class PostgresqlGmailConnectionRefreshLock {
  readonly #pool: BacklinkTenantPool;

  constructor(pool: BacklinkTenantPool) {
    this.#pool = pool;
  }

  async withLock<Result>(
    input: Readonly<{ organizationId: string; connectionId: string }>,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    const key = `gmail-refresh:${input.organizationId}:${input.connectionId}`;
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [key],
      );
      try {
        return await action();
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [key],
        );
      }
    } finally {
      client.release();
    }
  }
}
