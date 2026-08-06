import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { domainToASCII } from "node:url";
import { load } from "cheerio";
import { parse as parseDomain } from "tldts";
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
const bracketedObfuscatedEmailPattern =
  /([\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+)\s*(?:\[at\]|\(at\))\s*((?:[\p{L}\p{N}-]+\s*(?:\.|\[dot\]|\(dot\)|\sdot\s)\s*)+[\p{L}]{2,63})/giu;
const wordObfuscatedEmailPattern =
  /([\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+)\s+at\s+((?:[\p{L}\p{N}-]+\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*)+[\p{L}]{2,63})/giu;
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxNodes = 20_000;

export type ContactCandidate = Readonly<{
  email: string;
  status: "candidate";
  syntaxValid: true;
  confirmed: false;
  evidence: Readonly<{
    pageUrl: string;
    source: "mailto" | "visible_text" | "obfuscated_text" | "json_ld";
    snippet: string;
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
  if (!validateEmail(value, { ...emailOptions })) return false;
  const separator = value.lastIndexOf("@");
  const domain = domainToASCII(value.slice(separator + 1)).toLowerCase();
  if (domain === "") return false;
  const parsed = parseDomain(domain, { allowPrivateDomains: true });
  return parsed.domain !== null &&
    (parsed.isIcann === true || parsed.isPrivate === true);
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
    snippet = raw,
    nearbyText?: string,
  ) => {
    const email = raw.trim().toLowerCase();
    if (!isCandidateEmail(email) || candidates.has(email)) return;
    const purposeDecision = classifyContactPurpose({
      email,
      source,
      ...(mailtoLabel === undefined || mailtoLabel.trim() === ""
        ? {}
        : { mailtoLabel }),
      ...(nearbyText === undefined || nearbyText.trim() === ""
        ? {}
        : { nearbyText }),
      ...(title === "" ? {} : { pageTitle: title }),
    });
    candidates.set(email, Object.freeze({
      email,
      status: "candidate",
      syntaxValid: true,
      confirmed: false,
      evidence: Object.freeze({
        pageUrl: page.finalUrl,
        source,
        snippet: snippet.replace(/\s+/gu, " ").trim().slice(0, 500),
      }),
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
        `${$(element).text()} ${href}`,
        $(element).parent().text(),
      );
    } catch {
      // Invalid percent encoding cannot provide trustworthy evidence.
    }
  });
  const textNodes = [
    ...visible.contents().toArray(),
    ...visible.find("*").contents().toArray(),
  ];
  for (const node of textNodes) {
    if (node.type !== "text") continue;
    const visibleText = $(node).text();
    for (const match of visibleText.matchAll(emailPattern)) {
      add(
        match[0],
        "visible_text",
        undefined,
        match[0],
        $(node).parent().text(),
      );
    }
    for (const pattern of [
      bracketedObfuscatedEmailPattern,
      wordObfuscatedEmailPattern,
    ]) {
      for (const match of visibleText.matchAll(pattern)) {
        const local = match[1];
        const rawDomain = match[2];
        if (local === undefined || rawDomain === undefined) continue;
        const domain = rawDomain
          .replace(/\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*/giu, ".")
          .replace(/\s+/gu, "");
        add(
          `${local}@${domain}`,
          "obfuscated_text",
          undefined,
          match[0],
          $(node).parent().text(),
        );
      }
    }
  }
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      const walk = (value: unknown): void => {
        if (typeof value === "string") {
          for (const match of value.matchAll(emailPattern)) {
            add(match[0], "json_ld", undefined, value);
          }
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (value !== null && typeof value === "object") {
          Object.values(value).forEach(walk);
        }
      };
      walk(JSON.parse(raw));
    } catch {
      // Invalid JSON-LD is not contact evidence.
    }
  });

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
