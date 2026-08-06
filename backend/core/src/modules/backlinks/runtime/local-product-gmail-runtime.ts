import { randomUUID } from "node:crypto";

import { createSendIntentCommands } from "../application/commands/send-intent.command.js";
import { GmailSendActivity } from "../application/activities/send-activity.js";
import { SecretBackedGmailConnectionRepository } from "../application/services/gmail-connection-secret.repository.js";
import { PostgresqlSendAttemptRepository } from "../application/services/send-attempt.repository.js";
import { PostgresqlSendIntentRepository } from "../application/services/send-intent.repository.js";
import { GmailSendClientAdapter } from "../adapters/gmail/send-client.js";
import { GoogleGmailProviderClient } from "../adapters/gmail/google-gmail-provider-client.js";
import { buildGmailMimeMessage } from "../adapters/gmail/message-builder.js";
import { GoogleAuthClientAdapter } from "../adapters/gmail/auth-client.js";
import { GoogleAuthLibraryClient } from "../adapters/gmail/google-auth-library-client.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { SecretStoreClientAdapter } from "../adapters/security/secret-store-client.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../domain/context/index.js";
import {
  authorizeSendIdentity,
  type SendIdentity,
} from "../domain/sending/identity.js";
import {
  PostgresqlGmailConnectionRefreshLock,
  PostgresqlGmailConnectionRepository,
} from "../db/repositories/gmail-connection.repository.js";
import { createOutboxRelayRepository } from "../db/repositories/outbox.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../db/tenant-transaction.js";
import type {
  GmailSendCommand,
  GmailSendPort,
} from "../ports/gmail-send.port.js";
import type { ResolvedProjectContext } from "../ports/project-context.port.js";
import { secretKinds } from "../ports/secret-store.port.js";
import {
  createGmailSendOutboxRelay,
  createTemporalGmailSendConsumer,
} from "../workflows/outbox-relay.js";
import type { BacklinksLiveCapabilities } from "./live-capabilities.js";

export function createLocalProductSendIntentCommands(
  pool: BacklinkTenantPool,
  capabilities: BacklinksLiveCapabilities,
) {
  return createSendIntentCommands({
    repository: new PostgresqlSendIntentRepository({ pool }),
    newId: randomUUID,
    now: () => new Date(),
    quotaProfile: {
      rolling24HourSendLimit: capabilities.gmailRolling24HourSendLimit,
      minimumIntervalSeconds: capabilities.gmailMinimumIntervalSeconds,
    },
  });
}

type TemporalWorkflowClient = Parameters<
  typeof createTemporalGmailSendConsumer
>[0];
type OutboxRelayClient = Parameters<typeof createOutboxRelayRepository>[0];

type SendRuntimeOptions = Readonly<{
  pool: BacklinkTenantPool;
  outboxClient: OutboxRelayClient;
  workflowClient: TemporalWorkflowClient;
  taskQueue: string;
  capabilities: BacklinksLiveCapabilities;
}>;

export async function createLocalProductGmailSendRuntime(
  options: SendRuntimeOptions,
) {
  const { capabilities, pool } = options;
  if (
    !capabilities.gmailSendEnabled ||
    capabilities.secretStoreRoot === null ||
    capabilities.googleOauthClientId === null ||
    capabilities.googleOauthClientSecretReference === null
  ) {
    throw new Error("BACKLINK_LOCAL_PRODUCT_GMAIL_SEND_CONFIGURATION_INVALID");
  }

  const secretStoreClient = new LocalProductSecretStoreClient({
    rootDirectory: capabilities.secretStoreRoot,
  });
  const secretStore = new SecretStoreClientAdapter({
    config: { enabled: true, provider: "platform-secret-store" },
    client: secretStoreClient,
  });
  const googleAuth = new GoogleAuthClientAdapter({
    config: {
      enabled: true,
      redirectUris: [
        capabilities.googleOauthRedirectUri ??
          (() => {
            throw new Error("BACKLINK_GOOGLE_OAUTH_REDIRECT_URI_MISSING");
          })(),
      ],
    },
    client: new GoogleAuthLibraryClient({
      clientId: capabilities.googleOauthClientId,
      clientSecret: await secretStore.resolve({
        reference: parseLocalProductSecretReference(
          capabilities.googleOauthClientSecretReference,
          secretKinds.googleOauthClientSecret,
        ),
        context: {
          organizationId: "local-product",
          subjectProvider: "google",
        },
      }),
    }),
  });
  const connectionPersistence = new PostgresqlGmailConnectionRepository({
    pool,
  });
  const tokenRepository = new SecretBackedGmailConnectionRepository({
    secretStore,
    googleAuth,
    persistence: connectionPersistence,
    refreshLock: new PostgresqlGmailConnectionRefreshLock(pool),
  });
  const contexts = new Map<string, ResolvedProjectContext>();

  const commandLoader = {
    async load(
      input: Readonly<{
        context: {
          organizationId: string;
          workspaceId: string;
          websiteProjectId: string;
          gmailConnectionId: string;
          actorId: string;
        };
        attempt: {
          attemptId: string;
          sendIntentId: string;
          rfcMessageId: string;
        };
      }>,
    ): Promise<GmailSendCommand> {
      const scope = {
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId,
        websiteProjectId: input.context.websiteProjectId,
      };
      const loaded = await withBacklinkTenantTransaction(
        pool,
        scope,
        async (client) => {
          const aggregate = await client.query(
            `SELECT
               intent.gmail_connection_id AS "gmailConnectionId",
               snapshot.recipient,
               snapshot.subject_text AS "subjectText",
               snapshot.body_text AS "bodyText",
               identity.id AS "identityId",
               identity.organization_id AS "identityOrganizationId",
               identity.gmail_connection_id AS "identityGmailConnectionId",
               identity.normalized_email AS "identityEmailAddress",
               identity.display_name AS "identityDisplayName",
               identity.is_primary AS "identityIsPrimary",
               identity.is_default AS "identityIsDefault",
               identity.verification_status AS "identityVerificationStatus",
               identity.treat_as_alias AS "identityTreatAsAlias",
               identity.source AS "identitySource",
               identity.observed_at AS "identityObservedAt",
               identity.version AS "identityVersion",
               connection.connection_status AS "connectionStatus",
               connection.send_availability AS "sendAvailability",
               context.canonical_domain AS "canonicalDomain",
               context.locale,
               context.country_code AS "countryCode",
               context.profile_version_id AS "profileVersionId",
               context.promotion_target_version_id
                 AS "promotionTargetVersionId"
             FROM backlinks.backlink_send_intents AS intent
             JOIN backlinks.backlink_send_snapshots AS snapshot
               ON snapshot.organization_id=intent.organization_id
              AND snapshot.workspace_id=intent.workspace_id
              AND snapshot.website_project_id=intent.website_project_id
              AND snapshot.id=intent.send_snapshot_id
              AND snapshot.send_intent_id=intent.id
             JOIN backlinks.backlink_gmail_connections AS connection
               ON connection.organization_id=intent.organization_id
              AND connection.id=snapshot.gmail_connection_id
             JOIN backlinks.backlink_gmail_send_identities AS identity
               ON identity.organization_id=snapshot.organization_id
              AND identity.gmail_connection_id=snapshot.gmail_connection_id
              AND identity.id=snapshot.gmail_identity_id
              AND identity.version=snapshot.gmail_identity_version
             JOIN backlinks.backlink_gmail_workspace_bindings AS binding
                ON binding.organization_id=intent.organization_id
               AND binding.workspace_id=intent.workspace_id
               AND binding.gmail_connection_id=intent.gmail_connection_id
              AND binding.binding_status='ACTIVE'
             JOIN backlinks.backlink_website_project_mailbox_bindings AS project_binding
               ON project_binding.organization_id=binding.organization_id
              AND project_binding.workspace_id=binding.workspace_id
              AND project_binding.website_project_id=intent.website_project_id
              AND project_binding.gmail_workspace_binding_id=binding.id
              AND project_binding.binding_status='ACTIVE'
              AND project_binding.is_selected=true
             JOIN LATERAL (
               SELECT snapshot.*
                 FROM backlinks.backlink_project_context_snapshots AS snapshot
                WHERE snapshot.organization_id=intent.organization_id
                  AND snapshot.workspace_id=intent.workspace_id
                  AND snapshot.website_project_id=intent.website_project_id
                ORDER BY snapshot.snapshot_version DESC
                LIMIT 1
             ) AS context ON true
            WHERE intent.organization_id=$1 AND intent.workspace_id=$2
              AND intent.website_project_id=$3 AND intent.id=$4
              AND intent.gmail_connection_id=$5`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.attempt.sendIntentId,
              input.context.gmailConnectionId,
            ],
          );
          return aggregate.rows[0];
        },
      );
      const row = loaded;
      if (row === undefined) {
        throw new Error("BACKLINK_LOCAL_PRODUCT_GMAIL_SEND_FACTS_MISSING");
      }
      const context = Object.freeze({
        actor: createActorContext({
          userId: input.context.actorId,
          sessionId: `gmail-send:${input.attempt.attemptId}`,
          roles: ["member"],
        }),
        tenant: createTenantContext({
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
        }),
        project: createProjectContext({
          websiteProjectId: scope.websiteProjectId,
          canonicalDomain: String(row.canonicalDomain),
          locale: String(row.locale),
          countryCode: String(row.countryCode),
          profileVersionId: String(row.profileVersionId),
          promotionTargetVersionId: String(row.promotionTargetVersionId),
        }),
      });
      const selected = {
        identityId: String(row.identityId),
        organizationId: String(row.identityOrganizationId),
        gmailConnectionId: String(row.identityGmailConnectionId),
        emailAddress: String(row.identityEmailAddress),
        displayName:
          row.identityDisplayName === null
            ? null
            : String(row.identityDisplayName),
        isPrimary: row.identityIsPrimary === true,
        isDefault: row.identityIsDefault === true,
        verificationStatus: row.identityVerificationStatus,
        treatAsAlias: row.identityTreatAsAlias === true,
        source: row.identitySource,
        observedAt: new Date(String(row.identityObservedAt)).toISOString(),
        version: Number(row.identityVersion),
      } as SendIdentity;
      const identities = [selected] as const;
      const authorized = authorizeSendIdentity({
        connection: {
          organizationId: scope.organizationId,
          gmailConnectionId: input.context.gmailConnectionId,
          connectionStatus: row.connectionStatus as
            "CONNECTED" | "DISCONNECTED",
          sendAvailability: row.sendAvailability as "AVAILABLE" | "PAUSED",
        },
        identities,
        fromIdentityId: selected.identityId,
      });
      const mime = await buildGmailMimeMessage({
        identity: authorized,
        recipient: { emailAddress: String(row.recipient) },
        rfcMessageId: input.attempt.rfcMessageId,
        subject: String(row.subjectText),
        bodyText: String(row.bodyText),
      });
      contexts.set(input.attempt.attemptId, context);
      return {
        gmailConnectionId: input.context.gmailConnectionId,
        rawBase64Url: mime.rawBase64Url,
        rfcMessageId: input.attempt.rfcMessageId,
        requestId: input.attempt.attemptId,
      };
    },
  };

  const gmail: GmailSendPort = {
    async send(command) {
      const context = contexts.get(command.requestId);
      if (context === undefined) {
        throw new Error("BACKLINK_LOCAL_PRODUCT_GMAIL_SEND_CONTEXT_MISSING");
      }
      try {
        return await new GmailSendClientAdapter({
          config: { enabled: true },
          client: new GoogleGmailProviderClient({
            resolveAccessToken: async (connectionId) =>
              tokenRepository.resolveAccessToken({
                context,
                connectionId,
              }),
          }),
        }).send(command);
      } finally {
        contexts.delete(command.requestId);
      }
    },
  };

  const policyInputLoader = {
    async load(
      input: Readonly<{
        context: {
          organizationId: string;
          workspaceId: string;
          websiteProjectId: string;
          gmailConnectionId: string;
        };
        attempt: { sendIntentId: string };
      }>,
    ) {
      const scope = {
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId,
        websiteProjectId: input.context.websiteProjectId,
      };
      return withBacklinkTenantTransaction(pool, scope, async (client) => {
        const result = await client.query(
          `SELECT
             draft.status AS "draftStatus",
             draft.approved_version_id AS "approvedVersionId",
             intent.approved_draft_version_id AS "requestedVersionId",
             snapshot.contact_id AS "snapshotContactId",
             snapshot.contact_version AS "snapshotContactVersion",
             connection.connection_status AS "connectionStatus",
             connection.send_availability AS "sendAvailability",
             reservation.status AS "reservationStatus",
             reservation.eligible_at AS "eligibleAt",
             reservation.expires_at AS "expiresAt",
             EXISTS (
               SELECT 1 FROM backlinks.backlink_suppression_entries AS entry
                WHERE entry.organization_id=intent.organization_id
                  AND entry.status='ACTIVE'
                  AND (
                    entry.workspace_id IS NULL
                    OR (
                      entry.workspace_id=intent.workspace_id
                      AND entry.website_project_id=intent.website_project_id
                    )
                  )
             ) AS suppressed,
             (
               SELECT switch.blocked
                 FROM backlinks.backlink_kill_switch_versions AS switch
                WHERE switch.organization_id=intent.organization_id
                  AND switch.workspace_id=intent.workspace_id
                  AND switch.website_project_id=intent.website_project_id
                  AND switch.capability='GMAIL_SEND'
                ORDER BY switch.version DESC
                LIMIT 1
             ) AS "sendBlocked"
           FROM backlinks.backlink_send_intents AS intent
           JOIN backlinks.backlink_send_snapshots AS snapshot
             ON snapshot.organization_id=intent.organization_id
            AND snapshot.workspace_id=intent.workspace_id
            AND snapshot.website_project_id=intent.website_project_id
            AND snapshot.id=intent.send_snapshot_id
            AND snapshot.send_intent_id=intent.id
           JOIN backlinks.backlink_email_drafts AS draft
             ON draft.organization_id=intent.organization_id
            AND draft.workspace_id=intent.workspace_id
            AND draft.website_project_id=intent.website_project_id
            AND draft.id=intent.draft_id
            AND draft.contact_id=snapshot.contact_id
            AND draft.contact_version=snapshot.contact_version
           JOIN backlinks.backlink_contacts AS contact
             ON contact.organization_id=snapshot.organization_id
            AND contact.workspace_id=snapshot.workspace_id
            AND contact.website_project_id=snapshot.website_project_id
            AND contact.id=snapshot.contact_id
            AND contact.version=snapshot.contact_version
            AND contact.normalized_email=snapshot.recipient
            AND contact.status='active'
            AND contact.guessed=false
            AND contact.invalidated_at IS NULL
           JOIN backlinks.backlink_gmail_connections AS connection
             ON connection.organization_id=intent.organization_id
            AND connection.id=intent.gmail_connection_id
           JOIN backlinks.backlink_gmail_send_identities AS identity
             ON identity.organization_id=snapshot.organization_id
            AND identity.gmail_connection_id=snapshot.gmail_connection_id
            AND identity.id=snapshot.gmail_identity_id
            AND identity.version=snapshot.gmail_identity_version
            AND identity.verification_status='accepted'
           JOIN backlinks.backlink_rate_limit_reservations AS reservation
             ON reservation.organization_id=intent.organization_id
            AND reservation.workspace_id=intent.workspace_id
            AND reservation.website_project_id=intent.website_project_id
            AND reservation.send_intent_id=intent.id
          WHERE intent.organization_id=$1 AND intent.workspace_id=$2
            AND intent.website_project_id=$3 AND intent.id=$4
            AND intent.gmail_connection_id=$5`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.attempt.sendIntentId,
            input.context.gmailConnectionId,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error("BACKLINK_LOCAL_PRODUCT_GMAIL_SEND_POLICY_MISSING");
        }
        const now = new Date();
        const quota =
          row.reservationStatus === "RESERVED"
            ? {
                status: "RESERVED" as const,
                eligibleAt: new Date(String(row.eligibleAt)).toISOString(),
                expiresAt: new Date(String(row.expiresAt)).toISOString(),
              }
            : { status: "EXCEEDED" as const, retryAt: null };
        return {
          evaluatedAt: now.toISOString(),
          draft: {
            status: row.draftStatus as
              "generating" | "draft" | "approved" | "rejected" | "sent",
            approvedVersionId:
              row.approvedVersionId === null
                ? null
                : String(row.approvedVersionId),
            requestedVersionId: String(row.requestedVersionId),
          },
          suppression: { suppressed: row.suppressed === true },
          connection: {
            connectionStatus: row.connectionStatus as
              "CONNECTED" | "DISCONNECTED",
            sendAvailability: row.sendAvailability as "AVAILABLE" | "PAUSED",
          },
          quota,
          killSwitches: {
            GLOBAL: false,
            ORGANIZATION: false,
            WORKSPACE: false,
            WEBSITE_PROJECT: false,
            GMAIL_SEND:
              !capabilities.gmailSendEnabled || row.sendBlocked !== false,
          },
          cooldownUntil: null,
        };
      });
    },
  };

  const activity = new GmailSendActivity({
    repository: new PostgresqlSendAttemptRepository({ pool }),
    commandLoader,
    policyInputLoader,
    gmail,
  });
  const relay = createGmailSendOutboxRelay({
    repository: createOutboxRelayRepository(options.outboxClient),
    consumer: createTemporalGmailSendConsumer(
      options.workflowClient,
      options.taskQueue,
    ),
  });

  return Object.freeze({
    activity,
    relay,
    async findSelectedConnection(context: ResolvedProjectContext) {
      return (await connectionPersistence.findProjectMailboxState(context))
        .selectedConnection;
    },
    async refreshTokenHealth(
      input: Readonly<{
        context: ResolvedProjectContext;
        connectionId: string;
        expectedVersion: number;
      }>,
    ) {
      return tokenRepository.refresh(input);
    },
  });
}
