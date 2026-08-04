import type {
  ReplyMailContentReader,
  SafeReplyMailBody,
} from "../../application/queries/reply-mail.query.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import { parseGmailMimeMessage } from "./message-parser.js";
import {
  gmailHtmlSanitizerIdentity,
  sanitizeGmailHtml,
} from "./sanitizer.js";

export type ReplyMailRawObjectReader = Readonly<{
  get(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    rawObjectKey: string;
  }>): Promise<Uint8Array | null>;
}>;

const emptyBody = Object.freeze({
  plainText: null,
  sanitizedHtml: null,
} satisfies SafeReplyMailBody);

const projectObjectPrefix = (input: Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>): string => [
  "backlinks",
  "mail",
  "raw",
  input.organizationId,
  input.workspaceId,
  input.websiteProjectId,
  "",
].join("/");

export function createSanitizedReplyMailContentReader(
  dependencies: Readonly<{
    rawObjectReader: ReplyMailRawObjectReader;
  }>,
): ReplyMailContentReader {
  return Object.freeze({
    async read(input) {
      if (!input.rawObjectKey.startsWith(projectObjectPrefix(input))) {
        throw new BacklinkError({
          code: backlinkErrorCodes.accessDenied,
          message: "Mail content is not available in this project.",
        });
      }

      const raw = await dependencies.rawObjectReader.get(input);
      if (raw === null) return emptyBody;

      const message = await parseGmailMimeMessage(raw);
      const sanitized = message.body.html === null
        ? null
        : sanitizeGmailHtml(message.body.html.content);
      return Object.freeze({
        plainText: message.body.text,
        sanitizedHtml: sanitized === null
          ? null
          : Object.freeze({
              content: sanitized.content,
              trust: sanitized.trust,
              sanitized: sanitized.sanitized,
              policyVersion: gmailHtmlSanitizerIdentity.policyVersion,
            }),
      });
    },
  });
}
