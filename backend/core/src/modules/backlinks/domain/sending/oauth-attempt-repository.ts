export type NewOAuthAttempt = Readonly<{
  id: string;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  initiatedByUserId: string;
  stateHash: string;
  sessionBindingHash: string;
  pkceVerifier: string;
  requestedScopes: readonly string[];
  redirectUri: string;
  returnPath: string | null;
  createdAt: Date;
  expiresAt: Date;
}>;

export type OAuthAttemptConsumeInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  initiatedByUserId: string;
  stateHash: string;
  sessionBindingHash: string;
  consumedAt: Date;
}>;

export type OAuthAttemptCleanupInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  cleanedByUserId: string;
  expiredAt: Date;
}>;

export type ConsumedOAuthAttempt = Readonly<{
  attemptId: string;
  pkceVerifier: string;
  requestedScopes: readonly string[];
  redirectUri: string;
  returnPath: string | null;
}>;

export interface OAuthAttemptRepository {
  /**
   * The verifier is transient input. Implementations must store it in a
   * Secret Store and persist only its opaque reference in the business table.
   */
  create(input: NewOAuthAttempt): Promise<void>;

  /**
   * Implementations must destroy expired transient verifiers before marking
   * their references destroyed. A failed Secret Store deletion must fail
   * closed and leave the reference eligible for a later retry.
   */
  cleanupExpired(input: OAuthAttemptCleanupInput): Promise<number>;

  /**
   * Implementations must validate every binding, expiry, and consumed state,
   * then mark the attempt consumed in one atomic database operation.
   */
  consume(
    input: OAuthAttemptConsumeInput,
  ): Promise<ConsumedOAuthAttempt | null>;
}
