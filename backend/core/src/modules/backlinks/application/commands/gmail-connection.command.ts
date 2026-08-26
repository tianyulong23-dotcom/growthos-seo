import type {
  GmailConnectionCompletionGateway,
  GmailConnectionSelector,
  GmailProjectMailboxState,
  GmailConnectionView,
} from "../gmail-connection.gateway.js";
import {
  GmailConnectionDisconnectError,
  gmailConnectionDisconnectErrorCodes,
  type GmailConnectionDisconnectResult,
  type GmailConnectionDisconnectWorkflow,
} from "../workflows/gmail-connection-disconnect.workflow.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  InvalidOAuthStateError,
  OAuthAttemptService,
  gmailOAuthScopes,
} from "../../domain/sending/oauth-attempt.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  ActorContext,
  TenantContext,
} from "../../domain/context/index.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
  type GoogleAuthFailureCode,
  type GoogleAuthPort,
} from "../../ports/google-auth.port.js";

type GmailConnectionCommandDependencies = Readonly<{
  oauthAttempts: OAuthAttemptService;
  googleAuth: GoogleAuthPort;
  completion: GmailConnectionCompletionGateway;
  selector: GmailConnectionSelector;
  disconnectWorkflow: Pick<GmailConnectionDisconnectWorkflow, "disconnect">;
  redirectUri: string;
}>;

export type ConnectGmailInput = Readonly<{
  context: ResolvedProjectContext;
  websiteProjectKey: string;
  returnPath?: string | null;
}>;

export type ConnectGmailResult = Readonly<{
  authorizationUrl: string;
  expiresAt: string;
}>;

export type CompleteGmailConnectionInput = Readonly<{
  actor: ActorContext;
  tenant: TenantContext;
  authorizationCode: string;
  state: string;
}>;

export type CompleteGmailConnectionResult = Readonly<{
  connection: GmailConnectionView;
  returnPath: string | null;
  websiteProjectId: string;
}>;

export type SelectGmailConnectionInput = Readonly<{
  context: ResolvedProjectContext;
  connectionId: string;
}>;

export type DisconnectGmailConnectionInput = Readonly<{
  context: ResolvedProjectContext;
  connectionId: string;
  expectedVersion: number;
}>;

const connectionRoles = new Set(["owner", "admin", "member"]);

function authorize(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) => connectionRoles.has(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Gmail connection permission is required.",
    });
  }
}

const oauthContext = (
  context: ResolvedProjectContext,
  websiteProjectKey: string,
) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  websiteProjectKey,
  initiatedByUserId: context.actor.userId,
  sessionBinding: context.actor.sessionId,
});

function authorizeActor(actor: ActorContext): void {
  if (!actor.roles.some((role) => connectionRoles.has(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Gmail connection permission is required.",
    });
  }
}

function translateOAuthError(error: unknown): never {
  if (error instanceof InvalidOAuthStateError) {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message: "OAuth callback is invalid or unavailable.",
    });
  }
  if (error instanceof GoogleAuthError) {
    const clientFailureCodes = new Set<GoogleAuthFailureCode>([
      googleAuthFailureCodes.invalidRequest,
      googleAuthFailureCodes.authorizationDenied,
      googleAuthFailureCodes.authExpired,
    ]);
    const providerUnavailableCodes = new Set<GoogleAuthFailureCode>([
      googleAuthFailureCodes.rateLimited,
      googleAuthFailureCodes.temporaryFailure,
    ]);
    const clientError = clientFailureCodes.has(error.code);
    const providerUnavailable = providerUnavailableCodes.has(error.code);
    throw new BacklinkError({
      code:
        clientError
          ? backlinkErrorCodes.invalidRequest
          : providerUnavailable
            ? backlinkErrorCodes.gmailOAuthProviderUnavailable
            : backlinkErrorCodes.internal,
      message:
        clientError
          ? "Google authorization could not be completed."
          : providerUnavailable
            ? "Google authorization is temporarily unavailable."
            : "Google authorization could not be completed.",
      retryable: error.retryable,
      cause: error,
    });
  }
  throw error;
}

function translateDisconnectError(error: unknown): never {
  if (error instanceof GmailConnectionDisconnectError) {
    if (error.code === gmailConnectionDisconnectErrorCodes.notFound) {
      throw new BacklinkError({
        code: backlinkErrorCodes.notFound,
        message: "Gmail connection was not found.",
      });
    }
    if (error.code === gmailConnectionDisconnectErrorCodes.versionConflict) {
      throw new BacklinkError({
        code: backlinkErrorCodes.conflict,
        message: "Gmail connection version is stale.",
      });
    }
    throw new BacklinkError({
      code: backlinkErrorCodes.internal,
      message: "Gmail connection could not be disconnected locally.",
      retryable: true,
    });
  }
  throw error;
}

function assertUsableGrant(
  emailVerified: boolean,
  requestedScopes: readonly string[],
  grantedScopes: readonly string[],
): void {
  const requestedScopeSet = new Set(requestedScopes);
  const canonicalAttempt =
    requestedScopeSet.size === gmailOAuthScopes.length
    && gmailOAuthScopes.every((scope) => requestedScopeSet.has(scope));
  const grantedScopeSet = new Set(grantedScopes);
  const completeGrant =
    grantedScopeSet.size === gmailOAuthScopes.length
    && gmailOAuthScopes.every((scope) => grantedScopeSet.has(scope));
  if (!emailVerified || !canonicalAttempt || !completeGrant) {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message: "Google account verification or required Gmail scopes are missing.",
    });
  }
}

export function createGmailConnectionCommands(
  dependencies: GmailConnectionCommandDependencies,
) {
  return {
    async connect(input: ConnectGmailInput): Promise<ConnectGmailResult> {
      authorize(input.context);
      try {
        const attemptContext = {
          ...oauthContext(input.context, input.websiteProjectKey),
          redirectUri: dependencies.redirectUri,
        };
        const attempt = await dependencies.oauthAttempts.begin(
          input.returnPath === undefined
            ? attemptContext
            : { ...attemptContext, returnPath: input.returnPath },
        );
        const authorization = await dependencies.googleAuth.authorize({
          redirectUri: dependencies.redirectUri,
          state: attempt.state,
          codeChallenge: attempt.codeChallenge,
          codeChallengeMethod: attempt.codeChallengeMethod,
          requestedScopes: attempt.requestedScopes,
        });
        return {
          authorizationUrl: authorization.authorizationUrl,
          expiresAt: attempt.expiresAt.toISOString(),
        };
      } catch (error) {
        translateOAuthError(error);
      }
    },

    async complete(
      input: CompleteGmailConnectionInput,
    ): Promise<CompleteGmailConnectionResult> {
      authorizeActor(input.actor);
      try {
        const attempt = await dependencies.oauthAttempts.consume({
          organizationId: input.tenant.organizationId,
          workspaceId: input.tenant.workspaceId,
          initiatedByUserId: input.actor.userId,
          sessionBinding: input.actor.sessionId,
          state: input.state,
        });
        const authorized = await dependencies.googleAuth.callback({
          authorizationCode: input.authorizationCode,
          codeVerifier: attempt.pkceVerifier,
          redirectUri: attempt.redirectUri,
        });
        assertUsableGrant(
          authorized.identity.emailVerified,
          attempt.requestedScopes,
          authorized.tokens.grantedScopes,
        );
        const connection = await dependencies.completion.complete({
          context: {
            organizationId: attempt.organizationId,
            workspaceId: attempt.workspaceId,
            websiteProjectId: attempt.websiteProjectId,
            actorId: input.actor.userId,
          },
          identity: authorized.identity,
          tokens: authorized.tokens,
        });
        return {
          connection,
          returnPath: attempt.returnPath,
          websiteProjectId: attempt.websiteProjectId,
        };
      } catch (error) {
        translateOAuthError(error);
      }
    },

    async select(
      input: SelectGmailConnectionInput,
    ): Promise<GmailProjectMailboxState> {
      authorize(input.context);
      const selected = await dependencies.selector.selectForProject(
        input.context,
        input.connectionId,
      );
      if (selected === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Gmail connection was not found.",
        });
      }
      return selected;
    },

    async disconnect(
      input: DisconnectGmailConnectionInput,
    ): Promise<GmailConnectionDisconnectResult> {
      authorize(input.context);
      try {
        return await dependencies.disconnectWorkflow.disconnect(input);
      } catch (error) {
        translateDisconnectError(error);
      }
    },
  };
}
