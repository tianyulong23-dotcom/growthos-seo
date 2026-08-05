export const sendIdentityAuthorizationErrorCodes = Object.freeze({
  invalidIdentity: "SEND_IDENTITY_INVALID",
  identityNotVerified: "SEND_IDENTITY_NOT_VERIFIED",
  connectionUnavailable: "SEND_IDENTITY_CONNECTION_UNAVAILABLE",
  fromNotAuthorized: "SEND_FROM_NOT_AUTHORIZED",
  replyToNotAuthorized: "SEND_REPLY_TO_NOT_AUTHORIZED",
} as const);

export type SendIdentityAuthorizationErrorCode =
  (typeof sendIdentityAuthorizationErrorCodes)[keyof typeof sendIdentityAuthorizationErrorCodes];

const errorMessages: Readonly<
  Record<SendIdentityAuthorizationErrorCode, string>
> = Object.freeze({
  SEND_IDENTITY_INVALID: "The send identity is invalid.",
  SEND_IDENTITY_NOT_VERIFIED: "The send identity is not verified.",
  SEND_IDENTITY_CONNECTION_UNAVAILABLE:
    "The Gmail connection is unavailable for sending.",
  SEND_FROM_NOT_AUTHORIZED:
    "The requested From identity is not authorized.",
  SEND_REPLY_TO_NOT_AUTHORIZED:
    "The requested Reply-To identity is not authorized.",
});

export class SendIdentityAuthorizationError extends Error {
  readonly code: SendIdentityAuthorizationErrorCode;

  constructor(code: SendIdentityAuthorizationErrorCode) {
    super(errorMessages[code]);
    this.name = "SendIdentityAuthorizationError";
    this.code = code;
  }
}

export type SendIdentityVerificationStatus = "accepted" | "pending";
export type SendIdentitySource = "OIDC_PRIMARY" | "GMAIL_SEND_AS";

export type SendIdentity = Readonly<{
  identityId: string;
  organizationId: string;
  gmailConnectionId: string;
  emailAddress: string;
  displayName: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  verificationStatus: SendIdentityVerificationStatus;
  treatAsAlias: boolean;
  source: SendIdentitySource;
  observedAt: string;
  version: number;
}>;

export type SendIdentityConnection = Readonly<{
  organizationId: string;
  gmailConnectionId: string;
  connectionStatus:
    | "CONNECTING"
    | "CONNECTED"
    | "REAUTH_REQUIRED"
    | "TOKEN_REVOKED"
    | "DISCONNECTED";
  sendAvailability: "AVAILABLE" | "PAUSED";
}>;

export type CreateOidcPrimarySendIdentityInput = Readonly<{
  identityId: string;
  organizationId: string;
  gmailConnectionId: string;
  emailAddress: string;
  displayName: string | null;
  emailVerified: boolean;
  observedAt: string;
  version: number;
}>;

export type CreateGoogleSendAsIdentityInput = Readonly<{
  identityId: string;
  organizationId: string;
  gmailConnectionId: string;
  emailAddress: string;
  displayName: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  verificationStatus: SendIdentityVerificationStatus;
  treatAsAlias: boolean;
  observedAt: string;
  version: number;
}>;

export type AuthorizeSendIdentityInput = Readonly<{
  connection: SendIdentityConnection;
  identities: readonly SendIdentity[];
  fromIdentityId: string;
  requestedFromAddress?: string | null;
  requestedReplyTo?: string | null;
}>;

export type AuthorizedSendIdentity = Readonly<{
  from: Readonly<{
    identityId: string;
    emailAddress: string;
    displayName: string | null;
    identityVersion: number;
  }>;
  replyTo: Readonly<{
    identityId: string;
    emailAddress: string;
    identityVersion: number;
  }> | null;
}>;

const invalidIdentity = () =>
  new SendIdentityAuthorizationError(
    sendIdentityAuthorizationErrorCodes.invalidIdentity,
  );

const assertNonBlank = (value: string) => {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidIdentity();
  }
};

const normalizeDisplayName = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw invalidIdentity();
  }
  return normalized;
};

export const normalizeSendIdentityEmail = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > 254
    || /[\u0000-\u0020\u007f]/u.test(normalized)
  ) {
    throw invalidIdentity();
  }

  const separatorIndex = normalized.indexOf("@");
  if (
    separatorIndex <= 0
    || separatorIndex !== normalized.lastIndexOf("@")
  ) {
    throw invalidIdentity();
  }

  const localPart = normalized.slice(0, separatorIndex);
  const domain = normalized.slice(separatorIndex + 1);
  if (
    localPart.length > 64
    || localPart.startsWith(".")
    || localPart.endsWith(".")
    || localPart.includes("..")
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(localPart)
  ) {
    throw invalidIdentity();
  }

  const domainLabels = domain.split(".");
  if (
    domainLabels.length < 2
    || domainLabels.some(
      (label) =>
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    throw invalidIdentity();
  }

  return normalized;
};

const normalizeObservedAt = (value: string): string => {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw invalidIdentity();
  }
  return timestamp.toISOString();
};

const assertVersion = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidIdentity();
  }
};

const createIdentity = (
  input: CreateGoogleSendAsIdentityInput,
  source: SendIdentitySource,
): SendIdentity => {
  assertNonBlank(input.identityId);
  assertNonBlank(input.organizationId);
  assertNonBlank(input.gmailConnectionId);
  assertVersion(input.version);

  return Object.freeze({
    identityId: input.identityId,
    organizationId: input.organizationId,
    gmailConnectionId: input.gmailConnectionId,
    emailAddress: normalizeSendIdentityEmail(input.emailAddress),
    displayName: normalizeDisplayName(input.displayName),
    isPrimary: input.isPrimary,
    isDefault: input.isDefault,
    verificationStatus: input.verificationStatus,
    treatAsAlias: input.treatAsAlias,
    source,
    observedAt: normalizeObservedAt(input.observedAt),
    version: input.version,
  });
};

export const createOidcPrimarySendIdentity = (
  input: CreateOidcPrimarySendIdentityInput,
): SendIdentity => {
  if (!input.emailVerified) {
    throw new SendIdentityAuthorizationError(
      sendIdentityAuthorizationErrorCodes.identityNotVerified,
    );
  }

  return createIdentity(
    {
      identityId: input.identityId,
      organizationId: input.organizationId,
      gmailConnectionId: input.gmailConnectionId,
      emailAddress: input.emailAddress,
      displayName: input.displayName,
      isPrimary: true,
      isDefault: true,
      verificationStatus: "accepted",
      treatAsAlias: false,
      observedAt: input.observedAt,
      version: input.version,
    },
    "OIDC_PRIMARY",
  );
};

export const createGoogleSendAsIdentity = (
  input: CreateGoogleSendAsIdentityInput,
): SendIdentity => createIdentity(input, "GMAIL_SEND_AS");

type UsableIdentity = Readonly<{
  identity: SendIdentity;
  emailAddress: string;
  displayName: string | null;
}>;

const resolveUsableIdentity = (
  identity: SendIdentity,
  connection: SendIdentityConnection,
): UsableIdentity | null => {
  if (
    identity.organizationId !== connection.organizationId
    || identity.gmailConnectionId !== connection.gmailConnectionId
    || identity.verificationStatus !== "accepted"
    || !Number.isSafeInteger(identity.version)
    || identity.version < 1
  ) {
    return null;
  }

  try {
    assertNonBlank(identity.identityId);
    return Object.freeze({
      identity,
      emailAddress: normalizeSendIdentityEmail(identity.emailAddress),
      displayName: normalizeDisplayName(identity.displayName),
    });
  } catch (error) {
    if (error instanceof SendIdentityAuthorizationError) {
      return null;
    }
    throw error;
  }
};

const normalizeRequestedAddress = (
  value: string,
  code: SendIdentityAuthorizationErrorCode,
): string => {
  try {
    return normalizeSendIdentityEmail(value);
  } catch (error) {
    if (error instanceof SendIdentityAuthorizationError) {
      throw new SendIdentityAuthorizationError(code);
    }
    throw error;
  }
};

export const authorizeSendIdentity = (
  input: AuthorizeSendIdentityInput,
): AuthorizedSendIdentity => {
  if (
    input.connection.connectionStatus !== "CONNECTED"
    || input.connection.sendAvailability !== "AVAILABLE"
  ) {
    throw new SendIdentityAuthorizationError(
      sendIdentityAuthorizationErrorCodes.connectionUnavailable,
    );
  }

  const usableIdentities = input.identities
    .map((identity) => resolveUsableIdentity(identity, input.connection))
    .filter((identity): identity is UsableIdentity => identity !== null);
  const selectedFrom = usableIdentities.find(
    ({ identity }) => identity.identityId === input.fromIdentityId,
  );
  if (selectedFrom === undefined) {
    throw new SendIdentityAuthorizationError(
      sendIdentityAuthorizationErrorCodes.fromNotAuthorized,
    );
  }

  if (input.requestedFromAddress !== undefined && input.requestedFromAddress !== null) {
    const requestedFromAddress = normalizeRequestedAddress(
      input.requestedFromAddress,
      sendIdentityAuthorizationErrorCodes.fromNotAuthorized,
    );
    if (requestedFromAddress !== selectedFrom.emailAddress) {
      throw new SendIdentityAuthorizationError(
        sendIdentityAuthorizationErrorCodes.fromNotAuthorized,
      );
    }
  }

  const from = Object.freeze({
    identityId: selectedFrom.identity.identityId,
    emailAddress: selectedFrom.emailAddress,
    displayName: selectedFrom.displayName,
    identityVersion: selectedFrom.identity.version,
  });

  let replyTo: AuthorizedSendIdentity["replyTo"] = null;
  if (input.requestedReplyTo !== undefined && input.requestedReplyTo !== null) {
    const requestedReplyTo = normalizeRequestedAddress(
      input.requestedReplyTo,
      sendIdentityAuthorizationErrorCodes.replyToNotAuthorized,
    );
    const replyToIdentity = usableIdentities.find(
      ({ emailAddress }) => emailAddress === requestedReplyTo,
    );
    if (replyToIdentity === undefined) {
      throw new SendIdentityAuthorizationError(
        sendIdentityAuthorizationErrorCodes.replyToNotAuthorized,
      );
    }
    replyTo = Object.freeze({
      identityId: replyToIdentity.identity.identityId,
      emailAddress: replyToIdentity.emailAddress,
      identityVersion: replyToIdentity.identity.version,
    });
  }

  return Object.freeze({ from, replyTo });
};
