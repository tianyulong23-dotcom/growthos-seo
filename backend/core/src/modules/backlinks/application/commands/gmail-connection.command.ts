import type {
  GmailConnectionCompletionGateway,
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
  disconnectWorkflow: Pick<GmailConnectionDisconnectWorkflow, "disconnect">;
  redirectUri: string;
}>;

export type ConnectGmailInput = Readonly<{
  context: ResolvedProjectContext;
  returnPath?: string | null;
}>;

export type ConnectGmailResult = Readonly<{
  authorizationUrl: string;
  expiresAt: string;
}>;

export type CompleteGmailConnectionInput = Readonly<{
  context: ResolvedProjectContext;
  authorizationCode: string;
  state: string;
}>;

export type CompleteGmailConnectionResult = Readonly<{
  connection: GmailConnectionView;
  returnPath: string | null;
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

const oauthContext = (context: ResolvedProjectContext) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  initiatedByUserId: context.actor.userId,
  sessionBinding: context.actor.sessionId,
});

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
    const clientError = clientFailureCodes.has(error.code);
    throw new BacklinkError({
      code: clientError
        ? backlinkErrorCodes.invalidRequest
        : backlinkErrorCodes.internal,
      message: clientError
        ? "Google authorization could not be completed."
        : "Google authorization is temporarily unavailable.",
      retryable: error.retryable,
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
    gmailOAuthScopes.every((scope) => grantedScopeSet.has(scope));
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
          ...oauthContext(input.context),
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
      authorize(input.context);
      try {
        const attempt = await dependencies.oauthAttempts.consume({
          ...oauthContext(input.context),
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
          context: input.context,
          identity: authorized.identity,
          tokens: authorized.tokens,
        });
        return {
          connection,
          returnPath: attempt.returnPath,
        };
      } catch (error) {
        translateOAuthError(error);
      }
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
