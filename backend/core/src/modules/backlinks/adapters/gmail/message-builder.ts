import { createRequire } from "node:module";

import {
  normalizeSendIdentityEmail,
  type AuthorizedSendIdentity,
} from "../../domain/sending/identity.js";

export const gmailMimeMessageVersion = "gmail-mime.v1";
export const gmailMimeSubjectMaxCharacters = 255;

export const gmailMimeBuildErrorCodes = Object.freeze({
  invalidFrom: "GMAIL_MIME_INVALID_FROM",
  invalidReplyTo: "GMAIL_MIME_INVALID_REPLY_TO",
  invalidRecipient: "GMAIL_MIME_INVALID_RECIPIENT",
  invalidDisplayName: "GMAIL_MIME_INVALID_DISPLAY_NAME",
  invalidMessageId: "GMAIL_MIME_INVALID_MESSAGE_ID",
  invalidSubject: "GMAIL_MIME_INVALID_SUBJECT",
  invalidBody: "GMAIL_MIME_INVALID_BODY",
  buildFailed: "GMAIL_MIME_BUILD_FAILED",
} as const);

export type GmailMimeBuildErrorCode =
  (typeof gmailMimeBuildErrorCodes)[keyof typeof gmailMimeBuildErrorCodes];

const errorMessages: Readonly<Record<GmailMimeBuildErrorCode, string>> =
  Object.freeze({
    GMAIL_MIME_INVALID_FROM: "The authorized From address is invalid.",
    GMAIL_MIME_INVALID_REPLY_TO:
      "The authorized Reply-To address is invalid.",
    GMAIL_MIME_INVALID_RECIPIENT: "The recipient address is invalid.",
    GMAIL_MIME_INVALID_DISPLAY_NAME: "A display name is invalid.",
    GMAIL_MIME_INVALID_MESSAGE_ID: "The RFC Message-ID is invalid.",
    GMAIL_MIME_INVALID_SUBJECT: "The message subject is invalid.",
    GMAIL_MIME_INVALID_BODY: "The message body is invalid.",
    GMAIL_MIME_BUILD_FAILED: "The MIME message could not be built.",
  });

export class GmailMimeBuildError extends Error {
  readonly code: GmailMimeBuildErrorCode;

  constructor(code: GmailMimeBuildErrorCode) {
    super(errorMessages[code]);
    this.name = "GmailMimeBuildError";
    this.code = code;
  }
}

export type GmailMimeRecipient = Readonly<{
  emailAddress: string;
  displayName?: string | null;
}>;

export type GmailMimeBuildInput = Readonly<{
  identity: AuthorizedSendIdentity;
  recipient: GmailMimeRecipient;
  rfcMessageId: string;
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references?: readonly string[];
}>;

export type GmailMimeMessage = Readonly<{
  mimeVersion: typeof gmailMimeMessageVersion;
  contentType: "message/rfc822";
  raw: Buffer;
  rawBase64Url: string;
  sizeBytes: number;
}>;

type MailComposerAddress = {
  address: string;
  name?: string;
};

type MailComposerOptions = {
  newline: "windows";
  disableFileAccess: true;
  disableUrlAccess: true;
  from: MailComposerAddress;
  to: MailComposerAddress;
  replyTo?: MailComposerAddress;
  messageId: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
};

type MailComposerMessage = {
  build(
    callback: (error: Error | null | undefined, message?: Buffer) => void,
  ): void;
};

type MailComposerInstance = {
  compile(): MailComposerMessage;
};

type MailComposerConstructor = new (
  options: MailComposerOptions,
) => MailComposerInstance;

const isMailComposerConstructor = (
  value: unknown,
): value is MailComposerConstructor => typeof value === "function";

const loadModule = createRequire(import.meta.url);
const loadedMailComposer: unknown = loadModule(
  "nodemailer/lib/mail-composer/index.js",
);
if (!isMailComposerConstructor(loadedMailComposer)) {
  throw new TypeError("Nodemailer MailComposer is unavailable.");
}
const MailComposer = loadedMailComposer;

const controlCharacters = /[\u0000-\u001f\u007f]/u;
const rfcMessageIdPattern = /^<[^<>\s@]+@[^<>\s@]+>$/u;

const invalid = (code: GmailMimeBuildErrorCode) =>
  new GmailMimeBuildError(code);

const normalizeEmailAddress = (
  value: string,
  code: GmailMimeBuildErrorCode,
): string => {
  if (typeof value !== "string") {
    throw invalid(code);
  }
  try {
    return normalizeSendIdentityEmail(value);
  } catch {
    throw invalid(code);
  }
};

const normalizeDisplayName = (
  value: string | null | undefined,
): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalid(gmailMimeBuildErrorCodes.invalidDisplayName);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || [...normalized].length > 255
    || controlCharacters.test(normalized)
  ) {
    throw invalid(gmailMimeBuildErrorCodes.invalidDisplayName);
  }
  return normalized;
};

const normalizeSubject = (value: string): string => {
  if (typeof value !== "string") {
    throw invalid(gmailMimeBuildErrorCodes.invalidSubject);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || [...normalized].length > gmailMimeSubjectMaxCharacters
    || controlCharacters.test(normalized)
  ) {
    throw invalid(gmailMimeBuildErrorCodes.invalidSubject);
  }
  return normalized;
};

const normalizeMessageId = (value: string): string => {
  if (
    typeof value !== "string"
    || value.length > 998
    || !rfcMessageIdPattern.test(value)
  ) {
    throw invalid(gmailMimeBuildErrorCodes.invalidMessageId);
  }
  return value;
};

const normalizeBody = (value: string): string => {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw invalid(gmailMimeBuildErrorCodes.invalidBody);
  }
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
};

const asMailComposerAddress = (
  emailAddress: string,
  displayName: string | undefined,
): MailComposerAddress =>
  displayName === undefined
    ? { address: emailAddress }
    : { address: emailAddress, name: displayName };

const buildRawMessage = async (
  options: MailComposerOptions,
): Promise<Buffer> => {
  let message: MailComposerMessage;
  try {
    message = new MailComposer(options).compile();
  } catch {
    throw invalid(gmailMimeBuildErrorCodes.buildFailed);
  }

  return new Promise<Buffer>((resolve, reject) => {
    message.build((error, raw) => {
      if (error !== null && error !== undefined) {
        reject(invalid(gmailMimeBuildErrorCodes.buildFailed));
        return;
      }
      if (!Buffer.isBuffer(raw)) {
        reject(invalid(gmailMimeBuildErrorCodes.buildFailed));
        return;
      }
      resolve(raw);
    });
  });
};

export async function buildGmailMimeMessage(
  input: GmailMimeBuildInput,
): Promise<GmailMimeMessage> {
  const fromAddress = normalizeEmailAddress(
    input.identity.from.emailAddress,
    gmailMimeBuildErrorCodes.invalidFrom,
  );
  const fromDisplayName = normalizeDisplayName(
    input.identity.from.displayName,
  );
  const recipientAddress = normalizeEmailAddress(
    input.recipient.emailAddress,
    gmailMimeBuildErrorCodes.invalidRecipient,
  );
  const recipientDisplayName = normalizeDisplayName(
    input.recipient.displayName,
  );
  const replyToAddress = input.identity.replyTo === null
    ? null
    : normalizeEmailAddress(
        input.identity.replyTo.emailAddress,
        gmailMimeBuildErrorCodes.invalidReplyTo,
      );

  const baseOptions = {
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
    from: asMailComposerAddress(fromAddress, fromDisplayName),
    to: asMailComposerAddress(recipientAddress, recipientDisplayName),
    messageId: normalizeMessageId(input.rfcMessageId),
    subject: normalizeSubject(input.subject),
    text: normalizeBody(input.bodyText),
    ...(input.inReplyTo === undefined ? {} : {
      inReplyTo: normalizeMessageId(input.inReplyTo),
      references: (input.references ?? []).map(normalizeMessageId),
    }),
  } as const;
  const options: MailComposerOptions = replyToAddress === null
    ? baseOptions
    : {
        ...baseOptions,
        replyTo: { address: replyToAddress },
      };
  const raw = await buildRawMessage(options);

  return Object.freeze({
    mimeVersion: gmailMimeMessageVersion,
    contentType: "message/rfc822",
    raw,
    rawBase64Url: raw.toString("base64url"),
    sizeBytes: raw.length,
  });
}
