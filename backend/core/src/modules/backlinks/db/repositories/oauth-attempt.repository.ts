import { randomUUID } from "node:crypto";

import type {
  ConsumedOAuthAttempt,
  NewOAuthAttempt,
  OAuthAttemptConsumeInput,
  OAuthAttemptRepository,
} from "../../domain/sending/oauth-attempt-repository.js";
import {
  secretKinds,
  type SecretStorePort,
  type SecretStoreReference,
} from "../../ports/secret-store.port.js";
import { withGmailTenantTransaction } from "../gmail-tenant-transaction.js";
import type { BacklinkTenantPool } from "../tenant-transaction.js";

type PostgresqlOAuthAttemptRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  secretStore: SecretStorePort;
  newId?: () => string;
}>;

const secretContext = (input: Readonly<{
  organizationId: string;
  workspaceId: string;
  oauthAttemptId: string;
}>) => ({
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  subjectProvider: "google" as const,
  oauthAttemptId: input.oauthAttemptId,
});

const referenceFromRow = (
  row: Record<string, unknown>,
): SecretStoreReference | null => {
  const provider = row.provider;
  const secretKind = row.secretKind;
  const externalSecretId = row.externalSecretId;
  const externalSecretVersion = row.externalSecretVersion;
  if (
    typeof provider !== "string"
    || secretKind !== secretKinds.oauthPkceVerifier
    || typeof externalSecretId !== "string"
    || typeof externalSecretVersion !== "string"
  ) {
    return null;
  }
  return {
    provider,
    secretKind,
    externalSecretId,
    externalSecretVersion,
  };
};

export class PostgresqlOAuthAttemptRepository
implements OAuthAttemptRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #secretStore: SecretStorePort;
  readonly #newId: () => string;

  constructor(dependencies: PostgresqlOAuthAttemptRepositoryDependencies) {
    this.#pool = dependencies.pool;
    this.#secretStore = dependencies.secretStore;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async create(input: NewOAuthAttempt): Promise<void> {
    const context = secretContext({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      oauthAttemptId: input.id,
    });
    const reference = await this.#secretStore.create({
      secretKind: secretKinds.oauthPkceVerifier,
      plaintext: input.pkceVerifier,
      context,
    });
    const referenceId = this.#newId();

    try {
      await withGmailTenantTransaction(this.#pool, input, async (transaction) => {
        await transaction.query(
          `INSERT INTO backlinks.backlink_secret_references (
             id, organization_id, provider, secret_kind, external_secret_id,
             external_secret_version, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            referenceId,
            input.organizationId,
            reference.provider,
            reference.secretKind,
            reference.externalSecretId,
            reference.externalSecretVersion,
            input.initiatedByUserId,
          ],
        );
        await transaction.query(
          `INSERT INTO backlinks.backlink_oauth_attempts (
             id, organization_id, workspace_id, website_project_id,
             initiated_by_user_id, state_hash, session_binding_hash,
             pkce_verifier_secret_reference_id, requested_scopes,
             redirect_uri, return_path, created_at, expires_at,
             created_by, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
             $12, $13, $5, $5
           )`,
          [
            input.id,
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.initiatedByUserId,
            input.stateHash,
            input.sessionBindingHash,
            referenceId,
            JSON.stringify(input.requestedScopes),
            input.redirectUri,
            input.returnPath,
            input.createdAt,
            input.expiresAt,
          ],
        );
      });
    } catch (error) {
      await this.#secretStore.destroy({ reference, context }).catch(() => undefined);
      throw error;
    }
  }

  async consume(
    input: OAuthAttemptConsumeInput,
  ): Promise<ConsumedOAuthAttempt | null> {
    const row = await withGmailTenantTransaction(
      this.#pool,
      input,
      async (transaction) => {
        const result = await transaction.query(
          `WITH consumed AS (
             UPDATE backlinks.backlink_oauth_attempts
                SET consumed_at = $7, version = version + 1,
                    updated_at = $7, updated_by = $4
              WHERE organization_id = $1
                AND workspace_id = $2
                AND website_project_id = $3
                AND initiated_by_user_id = $4
                AND state_hash = $5
                AND session_binding_hash = $6
                AND consumed_at IS NULL
                AND created_at <= $7
                AND expires_at >= $7
            RETURNING id, pkce_verifier_secret_reference_id,
                      requested_scopes, redirect_uri, return_path
           )
           SELECT consumed.id AS "attemptId",
                  consumed.requested_scopes AS "requestedScopes",
                  consumed.redirect_uri AS "redirectUri",
                  consumed.return_path AS "returnPath",
                  secret.id AS "referenceId",
                  secret.provider,
                  secret.secret_kind AS "secretKind",
                  secret.external_secret_id AS "externalSecretId",
                  secret.external_secret_version AS "externalSecretVersion"
             FROM consumed
             JOIN backlinks.backlink_secret_references AS secret
               ON secret.organization_id = $1
              AND secret.id = consumed.pkce_verifier_secret_reference_id
              AND secret.secret_kind = 'OAUTH_PKCE_VERIFIER'
              AND secret.status = 'ACTIVE'`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.initiatedByUserId,
            input.stateHash,
            input.sessionBindingHash,
            input.consumedAt,
          ],
        );
        return result.rows[0] ?? null;
      },
    );
    if (row === null) {
      return null;
    }

    const attemptId = row.attemptId;
    const requestedScopes = row.requestedScopes;
    const redirectUri = row.redirectUri;
    const returnPath = row.returnPath;
    const referenceId = row.referenceId;
    const reference = referenceFromRow(row);
    if (
      typeof attemptId !== "string"
      || !Array.isArray(requestedScopes)
      || !requestedScopes.every((scope) => typeof scope === "string")
      || typeof redirectUri !== "string"
      || (returnPath !== null && typeof returnPath !== "string")
      || typeof referenceId !== "string"
      || reference === null
    ) {
      throw new TypeError("OAuth attempt persistence returned an invalid row.");
    }

    const context = secretContext({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      oauthAttemptId: attemptId,
    });
    const pkceVerifier = await this.#secretStore.resolve({ reference, context });
    await this.#secretStore.destroy({ reference, context });
    await withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `UPDATE backlinks.backlink_secret_references
            SET status = 'DESTROYED', version = version + 1,
                updated_at = $3, updated_by = $2
          WHERE organization_id = $1 AND id = $4
            AND secret_kind = 'OAUTH_PKCE_VERIFIER'`,
        [
          input.organizationId,
          input.initiatedByUserId,
          input.consumedAt,
          referenceId,
        ],
      );
    });
    return {
      attemptId,
      pkceVerifier,
      requestedScopes: Object.freeze([...requestedScopes]),
      redirectUri,
      returnPath,
    };
  }
}
