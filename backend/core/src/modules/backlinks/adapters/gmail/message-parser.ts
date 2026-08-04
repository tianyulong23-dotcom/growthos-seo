import { createHash } from "node:crypto";

import PostalMime, {
  type Address,
  type Attachment,
  type Email,
  type Mailbox,
} from "postal-mime";

export const gmailMessageParserIdentity = Object.freeze({
  name: "postal-mime",
  version: "2.7.5",
} as const);

export const gmailMessageParserLimits = Object.freeze({
  maxRawBytes: 32 * 1_024 * 1_024,
  maxHeadersBytes: 256 * 1_024,
  maxNestingDepth: 64,
} as const);

export const gmailMessageParseErrorCodes = Object.freeze({
  invalidInput: "GMAIL_MESSAGE_PARSE_INVALID_INPUT",
  inputTooLarge: "GMAIL_MESSAGE_PARSE_INPUT_TOO_LARGE",
  parseFailed: "GMAIL_MESSAGE_PARSE_FAILED",
} as const);

export type GmailMessageParseErrorCode =
  (typeof gmailMessageParseErrorCodes)[keyof typeof gmailMessageParseErrorCodes];

const errorMessages: Readonly<Record<GmailMessageParseErrorCode, string>> =
  Object.freeze({
    GMAIL_MESSAGE_PARSE_INVALID_INPUT:
      "The raw Gmail message input is invalid.",
    GMAIL_MESSAGE_PARSE_INPUT_TOO_LARGE:
      "The raw Gmail message exceeds the parser size limit.",
    GMAIL_MESSAGE_PARSE_FAILED:
      "The raw Gmail message could not be parsed.",
  });

export class GmailMessageParseError extends Error {
  readonly code: GmailMessageParseErrorCode;

  constructor(code: GmailMessageParseErrorCode) {
    super(errorMessages[code]);
    this.name = "GmailMessageParseError";
    this.code = code;
  }
}

export type MailAddress = Readonly<{
  address: string;
  displayName: string | null;
}>;

export type MailAttachmentMetadata = Readonly<{
  filename: string | null;
  mimeType: string;
  disposition: "attachment" | "inline" | null;
  contentId: string | null;
  sizeBytes: number;
  contentSha256: string;
  untrusted: true;
}>;

export type MailMessage = Readonly<{
  parser: typeof gmailMessageParserIdentity;
  rawSizeBytes: number;
  rawContentSha256: string;
  rfcMessageId: string | null;
  inReplyToMessageId: string | null;
  referenceMessageIds: readonly string[];
  from: MailAddress | null;
  to: readonly MailAddress[];
  cc: readonly MailAddress[];
  replyTo: readonly MailAddress[];
  subject: string | null;
  sentAt: string | null;
  body: Readonly<{
    text: string | null;
    html: Readonly<{
      content: string;
      trust: "UNTRUSTED";
      sanitized: false;
    }> | null;
  }>;
  attachments: readonly MailAttachmentMetadata[];
}>;

export type GmailMimeRawInput = string | Uint8Array;

const invalid = (code: GmailMessageParseErrorCode) =>
  new GmailMessageParseError(code);

const rawSize = (raw: GmailMimeRawInput): number =>
  typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const mailboxToAddress = (mailbox: Mailbox): MailAddress | null => {
  const address = mailbox.address.trim();
  if (address.length === 0) return null;
  const displayName = mailbox.name.trim();
  return Object.freeze({
    address,
    displayName: displayName.length === 0 ? null : displayName,
  });
};

const flattenAddress = (address: Address): readonly MailAddress[] => {
  if (address.group !== undefined) {
    return address.group.flatMap((mailbox) => {
      const mapped = mailboxToAddress(mailbox);
      return mapped === null ? [] : [mapped];
    });
  }
  const mapped = mailboxToAddress(address);
  return mapped === null ? [] : [mapped];
};

const mapAddresses = (
  addresses: readonly Address[] | undefined,
): readonly MailAddress[] =>
  Object.freeze((addresses ?? []).flatMap(flattenAddress));

const mapFromAddress = (address: Address | undefined): MailAddress | null =>
  address === undefined ? null : (flattenAddress(address)[0] ?? null);

const nullableText = (value: string | undefined): string | null =>
  value === undefined ? null : value;

const messageIds = (value: string | undefined): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  const ids = value.match(/<[^<>\s]+>/gu) ?? [];
  return Object.freeze([...new Set(ids)]);
};

const firstMessageId = (value: string | undefined): string | null =>
  messageIds(value)[0] ?? null;

const sentAt = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const attachmentBytes = (attachment: Attachment): Uint8Array => {
  if (typeof attachment.content === "string") {
    return Buffer.from(
      attachment.content,
      attachment.encoding === "base64" ? "base64" : "utf8",
    );
  }
  if (attachment.content instanceof Uint8Array) {
    return attachment.content;
  }
  return new Uint8Array(attachment.content);
};

const mapAttachment = (
  attachment: Attachment,
): MailAttachmentMetadata => {
  const content = attachmentBytes(attachment);
  return Object.freeze({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    disposition: attachment.disposition,
    contentId: attachment.contentId ?? null,
    sizeBytes: content.byteLength,
    contentSha256: hash(content),
    untrusted: true as const,
  });
};

const mapMessage = (
  raw: GmailMimeRawInput,
  parsed: Email,
): MailMessage => {
  const html = parsed.html === undefined
    ? null
    : Object.freeze({
        content: parsed.html,
        trust: "UNTRUSTED" as const,
        sanitized: false as const,
      });
  return Object.freeze({
    parser: gmailMessageParserIdentity,
    rawSizeBytes: rawSize(raw),
    rawContentSha256: hash(raw),
    rfcMessageId: firstMessageId(parsed.messageId),
    inReplyToMessageId: firstMessageId(parsed.inReplyTo),
    referenceMessageIds: messageIds(parsed.references),
    from: mapFromAddress(parsed.from),
    to: mapAddresses(parsed.to),
    cc: mapAddresses(parsed.cc),
    replyTo: mapAddresses(parsed.replyTo),
    subject: nullableText(parsed.subject),
    sentAt: sentAt(parsed.date),
    body: Object.freeze({
      text: nullableText(parsed.text),
      html,
    }),
    attachments: Object.freeze(parsed.attachments.map(mapAttachment)),
  });
};

export async function parseGmailMimeMessage(
  raw: GmailMimeRawInput,
): Promise<MailMessage> {
  const size = rawSize(raw);
  if (size === 0) {
    throw invalid(gmailMessageParseErrorCodes.invalidInput);
  }
  if (size > gmailMessageParserLimits.maxRawBytes) {
    throw invalid(gmailMessageParseErrorCodes.inputTooLarge);
  }

  try {
    const parsed = await PostalMime.parse(raw, {
      forceRfc822Attachments: true,
      attachmentEncoding: "arraybuffer",
      maxHeadersSize: gmailMessageParserLimits.maxHeadersBytes,
      maxNestingDepth: gmailMessageParserLimits.maxNestingDepth,
    });
    return mapMessage(raw, parsed);
  } catch {
    throw invalid(gmailMessageParseErrorCodes.parseFailed);
  }
}
