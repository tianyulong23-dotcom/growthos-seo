import type {
  GmailConnectionReader,
  GmailProjectMailboxState,
} from "../gmail-connection.gateway.js";
import {
  evaluateGmailReadiness,
  type GmailProjectReadinessInfrastructureReader,
  type GmailReadinessProjection,
} from "../services/gmail-readiness.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type { SecretStoreReference } from "../../ports/secret-store.port.js";

type GmailConnectionQueryDependencies = Readonly<{
  reader: GmailConnectionReader;
  readiness: Readonly<{
    infrastructure: GmailProjectReadinessInfrastructureReader;
    sendRuntimeEnabled: boolean;
    syncRuntimeEnabled: boolean;
    workerAvailable(): Promise<boolean>;
    credentialAvailable(input: Readonly<{
      organizationId: string;
      gmailConnectionId: string;
      tokenSecretReference: SecretStoreReference;
    }>): Promise<boolean>;
    syncStatus(input: Readonly<{
      context: ResolvedProjectContext;
      connectionId: string;
    }>): Promise<Readonly<{
      state: "BLOCKED" | "WAITING_FOR_ACCEPTED_SEND" | "POLLING";
      killSwitchOpen: boolean;
      cursor: unknown | null;
    }>>;
    timeoutMilliseconds?: number;
    now?: () => Date;
  }>;
}>;

export type GmailConnectionStatusProjection = GmailProjectMailboxState &
  Readonly<{ readiness: GmailReadinessProjection }>;

const connectionRoles = new Set(["owner", "admin", "member"]);
const defaultReadinessTimeoutMilliseconds = 1_500;

function authorize(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) => connectionRoles.has(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Gmail connection permission is required.",
    });
  }
}

async function boundedRead<Result>(
  operation: () => Promise<Result>,
  timeoutMilliseconds: number,
): Promise<Result | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMilliseconds);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createGmailConnectionQuery(
  dependencies: GmailConnectionQueryDependencies,
) {
  return {
    async getStatus(
      context: ResolvedProjectContext,
    ): Promise<GmailConnectionStatusProjection> {
      authorize(context);
      const state = await dependencies.reader.findProjectMailboxState(context);
      const connection = state.selectedConnection;
      const timeoutMilliseconds =
        dependencies.readiness.timeoutMilliseconds
        ?? defaultReadinessTimeoutMilliseconds;
      if (connection === null) {
        return Object.freeze({
          ...state,
          readiness: evaluateGmailReadiness({
            connection: null,
            projectBindingActive: false,
            verifiedSendIdentity: false,
            secretResolvable: false,
            sendRuntimeEnabled:
              dependencies.readiness.sendRuntimeEnabled,
            syncRuntimeEnabled:
              dependencies.readiness.syncRuntimeEnabled,
            workerAvailable: false,
            sendContext: null,
            syncStatus: null,
          }, (dependencies.readiness.now?.() ?? new Date()).toISOString()),
        });
      }

      const [infrastructure, workerAvailable, syncStatus] = await Promise.all([
        boundedRead(
          () => dependencies.readiness.infrastructure
            .findProjectReadinessInfrastructure(
              context,
              connection.connectionId,
            ),
          timeoutMilliseconds,
        ),
        boundedRead(
          dependencies.readiness.workerAvailable,
          timeoutMilliseconds,
        ),
        connection.connectionStatus === "CONNECTED"
          && dependencies.readiness.syncRuntimeEnabled
          ? boundedRead(
              () => dependencies.readiness.syncStatus({
                context,
                connectionId: connection.connectionId,
              }),
              timeoutMilliseconds,
            )
          : Promise.resolve(null),
      ]);
      const secretResolvable =
        infrastructure?.tokenSecretReference === null
        || infrastructure?.tokenSecretReference === undefined
          ? false
          : await boundedRead(
              () => dependencies.readiness.credentialAvailable({
                organizationId: context.tenant.organizationId,
                gmailConnectionId: connection.connectionId,
                tokenSecretReference:
                  infrastructure.tokenSecretReference as SecretStoreReference,
              }),
              timeoutMilliseconds,
            ) === true;

      return Object.freeze({
        ...state,
        readiness: evaluateGmailReadiness({
          connection,
          projectBindingActive:
            infrastructure?.projectBindingActive === true,
          verifiedSendIdentity:
            infrastructure?.verifiedSendIdentity === true,
          secretResolvable,
          sendRuntimeEnabled: dependencies.readiness.sendRuntimeEnabled,
          syncRuntimeEnabled: dependencies.readiness.syncRuntimeEnabled,
          workerAvailable: workerAvailable === true,
          sendContext: null,
          syncStatus: syncStatus === null
            ? null
            : {
                state: syncStatus.state,
                killSwitchOpen: syncStatus.killSwitchOpen,
                cursorPresent: syncStatus.cursor !== null,
              },
        }, (dependencies.readiness.now?.() ?? new Date()).toISOString()),
      });
    },
  };
}
