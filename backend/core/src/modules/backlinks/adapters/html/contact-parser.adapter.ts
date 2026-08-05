import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { load } from "cheerio";
import {
  classifyContactPurpose,
  type ContactPurposeDecision,
} from "../../domain/contacts/contact-purpose.js";
import type { SafeFetchResult } from "../../ports/safe-fetch.port.js";

type EmailOptions = Readonly<{
  allow_display_name: false;
  require_display_name: false;
  allow_utf8_local_part: false;
  require_tld: true;
  allow_ip_domain: false;
  allow_underscores: false;
  ignore_max_length: false;
  domain_specific_validation: false;
  blacklisted_chars: string;
}>;
const require = createRequire(import.meta.url);
const validateEmail = require("validator/lib/isEmail") as (
  value: string, options: EmailOptions,
) => boolean;
const emailOptions: EmailOptions = Object.freeze({
  allow_display_name: false,
  require_display_name: false,
  allow_utf8_local_part: false,
  require_tld: true,
  allow_ip_domain: false,
  allow_underscores: false,
  ignore_max_length: false,
  domain_specific_validation: false,
  blacklisted_chars: "\\x00-\\x1F\\x7F",
});
const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const emailPattern =
  /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}/gu;
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxNodes = 20_000;

export type ContactCandidate = Readonly<{
  email: string;
  status: "candidate";
  syntaxValid: true;
  confirmed: false;
  evidence: Readonly<{
    pageUrl: string;
    source: "mailto" | "visible_text";
  }>;
  purposeDecision: ContactPurposeDecision;
}>;
export type ContactPageEvidence = Readonly<{
  pageUrl: string;
  fetchedAt: string;
  title: string;
  parser: "cheerio@1.1.2";
  syntaxValidator: "validator@13.15.35";
  contentSha256: string;
  canonicalUrls: readonly string[];
  candidates: readonly ContactCandidate[];
}>;

export function isCandidateEmail(value: string): boolean {
  return validateEmail(value, { ...emailOptions });
}

export function parseContactPage(page: SafeFetchResult): ContactPageEvidence {
  const mediaType = page.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || !htmlTypes.has(mediaType)) {
    throw new Error("Contact parser requires HTML content.");
  }
  const $ = load(decoder.decode(page.body));
  if ($("*").length > maxNodes) {
    throw new Error("Contact parser node limit exceeded.");
  }

  const baseValue = $("base[href]").first().attr("href");
  let baseUrl = page.finalUrl;
  try {
    if (baseValue !== undefined) baseUrl = new URL(baseValue, page.finalUrl).toString();
  } catch {
    baseUrl = page.finalUrl;
  }
  const canonicalSet = new Set<string>();
  $("link[rel][href]").each((_, element) => {
    const rel = ($(element).attr("rel") ?? "").toLowerCase().split(/\s+/u);
    const href = $(element).attr("href");
    if (!rel.includes("canonical") || href === undefined) return;
    try {
      canonicalSet.add(new URL(href, baseUrl).toString());
    } catch {
      // Invalid canonical evidence is omitted rather than repaired.
    }
  });

  const visible = $("body").clone();
  visible.find("[hidden], [aria-hidden='true']").remove();
  visible.find("[style]").each((_, element) => {
    const style = $(element).attr("style") ?? "";
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(style)) {
      $(element).remove();
    }
  });
  const candidates = new Map<string, ContactCandidate>();
  const title = $("title").first().text().replace(/\s+/gu, " ").trim();
  const add = (
    raw: string,
    source: ContactCandidate["evidence"]["source"],
    mailtoLabel?: string,
  ) => {
    const email = raw.trim().toLowerCase();
    if (!isCandidateEmail(email) || candidates.has(email)) return;
    const purposeDecision = classifyContactPurpose({
      email,
      source,
      ...(mailtoLabel === undefined || mailtoLabel.trim() === ""
        ? {}
        : { mailtoLabel }),
      ...(title === "" ? {} : { pageTitle: title }),
    });
    candidates.set(email, Object.freeze({
      email,
      status: "candidate",
      syntaxValid: true,
      confirmed: false,
      evidence: Object.freeze({ pageUrl: page.finalUrl, source }),
      purposeDecision,
    }));
  };
  visible.find("a[href]").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    if (!href.toLowerCase().startsWith("mailto:")) return;
    try {
      add(
        decodeURIComponent(href.slice(7).split("?", 1)[0] ?? ""),
        "mailto",
        $(element).text(),
      );
    } catch {
      // Invalid percent encoding cannot provide trustworthy evidence.
    }
  });
  for (const match of visible.text().matchAll(emailPattern)) add(match[0], "visible_text");

  return Object.freeze({
    pageUrl: page.finalUrl,
    fetchedAt: page.fetchedAt,
    title,
    parser: "cheerio@1.1.2",
    syntaxValidator: "validator@13.15.35",
    contentSha256: createHash("sha256").update(page.body).digest("hex"),
    canonicalUrls: Object.freeze([...canonicalSet]),
    candidates: Object.freeze([...candidates.values()]),
  });
}
