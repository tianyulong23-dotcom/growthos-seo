import { z } from "zod";

export const gmailPushWebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  expectedAudience: z.string().trim().url().max(2_048).optional(),
  authorizedServiceAccountEmail: z.string().trim().email().max(320)
    .optional(),
}).strict();

export const gmailPushIdentityFailureCodes = {
  disabled: "GMAIL_PUSH_IDENTITY_DISABLED",
  misconfigured: "GMAIL_PUSH_IDENTITY_MISCONFIGURED",
  unauthenticated: "GMAIL_PUSH_IDENTITY_UNAUTHENTICATED",
} as const;

export type GmailPushIdentityFailureCode =
  (typeof gmailPushIdentityFailureCodes)[
    keyof typeof gmailPushIdentityFailureCodes
  ];

const identityFailureMessages = {
  [gmailPushIdentityFailureCodes.disabled]:
    "Gmail Push identity verification is disabled.",
  [gmailPushIdentityFailureCodes.misconfigured]:
    "Gmail Push identity verification is misconfigured.",
  [gmailPushIdentityFailureCodes.unauthenticated]:
    "Gmail Push identity verification failed.",
} satisfies Record<GmailPushIdentityFailureCode, string>;

export class GmailPushIdentityError extends Error {
  readonly code: GmailPushIdentityFailureCode;
  readonly retryable = false;

  constructor(code: GmailPushIdentityFailureCode, options?: ErrorOptions) {
    super(identityFailureMessages[code], options);
    this.name = "GmailPushIdentityError";
    this.code = code;
  }
}

export interface GmailPushSignedTokenVerifier {
  verifySignedIdToken(token: string): Promise<unknown>;
}

export type GmailPushIdentityVerifierOptions = Readonly<{
  config?: Readonly<{
    enabled?: boolean;
    expectedAudience?: string;
    authorizedServiceAccountEmail?: string;
  }>;
  verifier?: GmailPushSignedTokenVerifier;
  now?: () => Date;
}>;

const verifiedIdentityClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().trim().min(1).max(255),
  aud: z.string().trim().min(1).max(2_048),
  email: z.string().trim().email().max(320),
  email_verified: z.literal(true),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).passthrough();

const jwtPattern =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const allowedIssuers = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

const fail = (
  code: GmailPushIdentityFailureCode,
  cause?: unknown,
) => new GmailPushIdentityError(
  code,
  cause === undefined ? undefined : { cause },
);

const bearerToken = (
  authorizationHeader: string | readonly string[] | undefined,
): string => {
  if (typeof authorizationHeader !== "string") {
    throw fail(gmailPushIdentityFailureCodes.unauthenticated);
  }
  const match = /^Bearer ([^\s]+)$/u.exec(authorizationHeader);
  const token = match?.[1];
  if (token === undefined || !jwtPattern.test(token)) {
    throw fail(gmailPushIdentityFailureCodes.unauthenticated);
  }
  return token;
};

export class GmailPushIdentityVerifier {
  readonly #enabled: boolean;
  readonly #expectedAudience: string | undefined;
  readonly #authorizedEmail: string | undefined;
  readonly #verifier: GmailPushSignedTokenVerifier | undefined;
  readonly #now: () => Date;

  constructor(options: GmailPushIdentityVerifierOptions = {}) {
    const config = gmailPushWebhookConfigSchema.parse(options.config ?? {});
    if (
      config.enabled
      && (
        config.expectedAudience === undefined
        || config.authorizedServiceAccountEmail === undefined
        || options.verifier === undefined
      )
    ) {
      throw fail(gmailPushIdentityFailureCodes.misconfigured);
    }
    this.#enabled = config.enabled;
    this.#expectedAudience = config.expectedAudience;
    this.#authorizedEmail =
      config.authorizedServiceAccountEmail?.toLowerCase();
    this.#verifier = options.verifier;
    this.#now = options.now ?? (() => new Date());
  }

  async verify(
    authorizationHeader: string | readonly string[] | undefined,
  ): Promise<void> {
    if (!this.#enabled) {
      throw fail(gmailPushIdentityFailureCodes.disabled);
    }
    const token = bearerToken(authorizationHeader);
    const verifier = this.#verifier;
    if (
      verifier === undefined
      || this.#expectedAudience === undefined
      || this.#authorizedEmail === undefined
    ) {
      throw fail(gmailPushIdentityFailureCodes.misconfigured);
    }

    let untrustedClaims: unknown;
    try {
      untrustedClaims = await verifier.verifySignedIdToken(token);
    } catch (error) {
      throw fail(gmailPushIdentityFailureCodes.unauthenticated, error);
    }
    const parsed = verifiedIdentityClaimsSchema.safeParse(untrustedClaims);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (
      !parsed.success
      || !Number.isFinite(nowSeconds)
      || !allowedIssuers.has(parsed.data.iss)
      || parsed.data.aud !== this.#expectedAudience
      || parsed.data.email.toLowerCase() !== this.#authorizedEmail
      || parsed.data.exp <= nowSeconds
      || parsed.data.iat > nowSeconds + 60
      || parsed.data.iat >= parsed.data.exp
    ) {
      throw fail(gmailPushIdentityFailureCodes.unauthenticated);
    }
  }
}
