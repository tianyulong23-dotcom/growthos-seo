import {
  createHash,
  randomBytes as secureRandomBytes,
  randomUUID,
} from "node:crypto";

import type {
  ConsumedOAuthAttempt,
  OAuthAttemptRepository,
} from "./oauth-attempt-repository.js";

const oauthAttemptTtlMs = 10 * 60_000;
const oauthStatePattern = /^[A-Za-z0-9_-]{43}$/u;

export const gmailMailReadScope =
  "https://www.googleapis.com/auth/gmail.readonly";

export const gmailOAuthScopes: readonly string[] = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
  gmailMailReadScope,
]);

export type OAuthAttemptContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  initiatedByUserId: string;
  sessionBinding: string;
}>;

export type BeginOAuthAttemptInput = OAuthAttemptContext & Readonly<{
  redirectUri: string;
  returnPath?: string | null;
}>;

export type BeginOAuthAttemptResult = Readonly<{
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  requestedScopes: readonly string[];
  expiresAt: Date;
}>;

export type ConsumeOAuthAttemptInput = OAuthAttemptContext & Readonly<{
  state: string;
}>;

export class InvalidOAuthStateError extends Error {
  readonly code = "INVALID_OAUTH_STATE";

  constructor() {
    super("OAuth state is invalid or unavailable.");
    this.name = "InvalidOAuthStateError";
  }
}

type OAuthAttemptServiceDependencies = Readonly<{
  repository: OAuthAttemptRepository;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  newId?: () => string;
}>;

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sha256Base64Url = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

const assertNonBlank = (name: string, value: string) => {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

export class OAuthAttemptService {
  private readonly repository: OAuthAttemptRepository;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly newId: () => string;

  constructor(dependencies: OAuthAttemptServiceDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? (() => new Date());
    this.randomBytes = dependencies.randomBytes ?? secureRandomBytes;
    this.newId = dependencies.newId ?? randomUUID;
  }

  async begin(
    input: BeginOAuthAttemptInput,
  ): Promise<BeginOAuthAttemptResult> {
    this.assertContext(input);
    assertNonBlank("redirectUri", input.redirectUri);
    const returnPath = input.returnPath ?? null;
    if (
      returnPath !== null
      && (!returnPath.startsWith("/") || returnPath.startsWith("//"))
    ) {
      throw new TypeError("returnPath must be an application-relative path.");
    }

    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + oauthAttemptTtlMs);
    const state = this.randomBase64Url(32);
    const pkceVerifier = this.randomBase64Url(32);
    const codeChallenge = sha256Base64Url(pkceVerifier);

    await this.repository.cleanupExpired({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      cleanedByUserId: input.initiatedByUserId,
      expiredAt: createdAt,
    });
    await this.repository.create({
      id: this.newId(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      initiatedByUserId: input.initiatedByUserId,
      stateHash: sha256Hex(state),
      sessionBindingHash: sha256Hex(input.sessionBinding),
      pkceVerifier,
      requestedScopes: gmailOAuthScopes,
      redirectUri: input.redirectUri,
      returnPath,
      createdAt,
      expiresAt,
    });

    return Object.freeze({
      state,
      codeChallenge,
      codeChallengeMethod: "S256",
      requestedScopes: gmailOAuthScopes,
      expiresAt,
    });
  }

  async consume(
    input: ConsumeOAuthAttemptInput,
  ): Promise<ConsumedOAuthAttempt> {
    this.assertContext(input);
    if (!oauthStatePattern.test(input.state)) {
      throw new InvalidOAuthStateError();
    }

    const consumed = await this.repository.consume({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      initiatedByUserId: input.initiatedByUserId,
      stateHash: sha256Hex(input.state),
      sessionBindingHash: sha256Hex(input.sessionBinding),
      consumedAt: this.now(),
    });
    if (consumed === null) {
      throw new InvalidOAuthStateError();
    }

    return Object.freeze({
      ...consumed,
      requestedScopes: Object.freeze([...consumed.requestedScopes]),
    });
  }

  private assertContext(context: OAuthAttemptContext): void {
    assertNonBlank("organizationId", context.organizationId);
    assertNonBlank("workspaceId", context.workspaceId);
    assertNonBlank("websiteProjectId", context.websiteProjectId);
    assertNonBlank("initiatedByUserId", context.initiatedByUserId);
    assertNonBlank("sessionBinding", context.sessionBinding);
  }

  private randomBase64Url(size: number): string {
    const value = this.randomBytes(size);
    if (value.byteLength !== size) {
      throw new TypeError(`randomBytes must return exactly ${size} bytes.`);
    }
    return Buffer.from(value).toString("base64url");
  }
}
