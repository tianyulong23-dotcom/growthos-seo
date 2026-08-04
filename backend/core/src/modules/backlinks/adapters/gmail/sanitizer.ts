import { createRequire } from "node:module";

type SanitizerPolicy = Readonly<{
  ALLOWED_TAGS: readonly string[];
  ALLOWED_ATTR: readonly string[];
  ALLOWED_URI_REGEXP: RegExp;
  ALLOW_ARIA_ATTR: boolean;
  ALLOW_DATA_ATTR: boolean;
  ALLOW_UNKNOWN_PROTOCOLS: boolean;
  FORBID_ATTR: readonly string[];
  FORBID_TAGS: readonly string[];
  KEEP_CONTENT: boolean;
  RETURN_DOM: false;
  RETURN_DOM_FRAGMENT: false;
  RETURN_TRUSTED_TYPE: false;
}>;

type DomPurifyRuntime = Readonly<{
  sanitize: (dirty: string, config: SanitizerPolicy) => string;
}>;

const require = createRequire(import.meta.url);
const domPurifyModule = require("isomorphic-dompurify") as DomPurifyRuntime;

export const gmailHtmlSanitizerIdentity = Object.freeze({
  name: "dompurify",
  wrapperVersion: "3.18.0",
  engineVersion: "3.4.12",
  policyVersion: "growthos-gmail-html-v1",
} as const);

export type SanitizedGmailHtml = Readonly<{
  content: string;
  trust: "SANITIZED";
  sanitized: true;
  fallback: "NONE" | "ESCAPED_PLAIN_TEXT";
  sanitizer: typeof gmailHtmlSanitizerIdentity;
}>;

const sanitizerPolicy: SanitizerPolicy = Object.freeze({
  ALLOWED_TAGS: [
    "a",
    "b",
    "blockquote",
    "br",
    "caption",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  ALLOWED_ATTR: ["colspan", "href", "rowspan", "title"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#)/iu,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_ATTR: ["src", "srcset", "style"],
  FORBID_TAGS: [
    "embed",
    "form",
    "iframe",
    "math",
    "object",
    "script",
    "style",
    "svg",
    "template",
  ],
  KEEP_CONTENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_TRUSTED_TYPE: false,
});

const escapePlainText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const result = (
  content: string,
  fallback: SanitizedGmailHtml["fallback"],
): SanitizedGmailHtml =>
  Object.freeze({
    content,
    trust: "SANITIZED" as const,
    sanitized: true as const,
    fallback,
    sanitizer: gmailHtmlSanitizerIdentity,
  });

export function sanitizeGmailHtml(rawHtml: string): SanitizedGmailHtml {
  try {
    return result(domPurifyModule.sanitize(rawHtml, sanitizerPolicy), "NONE");
  } catch {
    return result(escapePlainText(rawHtml), "ESCAPED_PLAIN_TEXT");
  }
}
