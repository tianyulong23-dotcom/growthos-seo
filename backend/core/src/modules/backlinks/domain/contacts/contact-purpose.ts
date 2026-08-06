export const contactPurposeRuleVersion = "contact-purpose-rules.v2";

export const contactPurposes = [
  "press",
  "editorial",
  "partnerships",
  "advertising",
  "business",
  "marketing",
  "site_owner",
  "support",
  "privacy",
  "legal",
  "abuse",
  "security",
  "billing",
  "jobs",
  "no_reply",
  "general",
  "unknown",
] as const;

export type ContactPurpose = (typeof contactPurposes)[number];
export type ContactPurposeEvidence = Readonly<{
  tier: "high" | "medium" | "low";
  field: "email_local_part" | "mailto_label" | "nearby_text" | "page_title";
  value: string;
  matchedToken: string;
  ruleId: string;
}>;
export type ContactPurposeDecision = Readonly<{
  observedRole: string | null;
  inferredPurpose: ContactPurpose;
  confidence: number;
  ruleVersion: typeof contactPurposeRuleVersion;
  evidence: readonly ContactPurposeEvidence[];
}>;
export type ContactPurposeInput = Readonly<{
  email: string;
  source: "mailto" | "visible_text" | "obfuscated_text" | "json_ld";
  mailtoLabel?: string;
  nearbyText?: string;
  pageTitle?: string;
}>;

type Rule = Readonly<{
  id: string;
  purpose: Exclude<ContactPurpose, "unknown">;
  observedRole: string;
  tokens: readonly string[];
  highTrustOnly?: true;
}>;
type Field = Readonly<{
  field: ContactPurposeEvidence["field"];
  tier: ContactPurposeEvidence["tier"];
  confidence: number;
  value: string;
  highTrust: boolean;
}>;

const rules: readonly Rule[] = [
  { id: "restricted.no-reply", purpose: "no_reply",
    observedRole: "no reply", tokens: ["no", "reply"] },
  { id: "restricted.noreply", purpose: "no_reply",
    observedRole: "no reply", tokens: ["noreply"], highTrustOnly: true },
  { id: "restricted.privacy", purpose: "privacy",
    observedRole: "privacy", tokens: ["privacy"] },
  { id: "restricted.legal", purpose: "legal",
    observedRole: "legal", tokens: ["legal"] },
  { id: "restricted.abuse", purpose: "abuse",
    observedRole: "abuse", tokens: ["abuse"] },
  { id: "restricted.security", purpose: "security",
    observedRole: "security", tokens: ["security"] },
  { id: "restricted.billing", purpose: "billing",
    observedRole: "billing", tokens: ["billing"] },
  { id: "restricted.jobs", purpose: "jobs",
    observedRole: "jobs", tokens: ["jobs"] },
  { id: "restricted.careers", purpose: "jobs",
    observedRole: "careers", tokens: ["careers"] },
  { id: "press.public-relations", purpose: "press",
    observedRole: "public relations", tokens: ["public", "relations"] },
  { id: "press.media-relations", purpose: "press",
    observedRole: "media relations", tokens: ["media", "relations"] },
  { id: "press.press-office", purpose: "press",
    observedRole: "press office", tokens: ["press", "office"] },
  { id: "press.press", purpose: "press", observedRole: "press", tokens: ["press"] },
  { id: "press.pr", purpose: "press", observedRole: "pr",
    tokens: ["pr"], highTrustOnly: true },
  { id: "editorial.editorial", purpose: "editorial",
    observedRole: "editorial", tokens: ["editorial"] },
  { id: "editorial.editor", purpose: "editorial",
    observedRole: "editor", tokens: ["editor"] },
  { id: "editorial.newsroom", purpose: "editorial",
    observedRole: "newsroom", tokens: ["newsroom"] },
  { id: "editorial.submissions", purpose: "editorial",
    observedRole: "submissions", tokens: ["submissions"] },
  { id: "partnerships.partnerships", purpose: "partnerships",
    observedRole: "partnerships", tokens: ["partnerships"] },
  { id: "partnerships.partnership", purpose: "partnerships",
    observedRole: "partnership", tokens: ["partnership"] },
  { id: "partnerships.partner", purpose: "partnerships",
    observedRole: "partner", tokens: ["partner"] },
  { id: "partnerships.collaboration", purpose: "partnerships",
    observedRole: "collaboration", tokens: ["collaboration"] },
  { id: "advertising.advertising", purpose: "advertising",
    observedRole: "advertising", tokens: ["advertising"] },
  { id: "advertising.sponsorship", purpose: "advertising",
    observedRole: "sponsorship", tokens: ["sponsorship"] },
  { id: "advertising.ads", purpose: "advertising",
    observedRole: "ads", tokens: ["ads"] },
  { id: "business.sales", purpose: "business",
    observedRole: "sales", tokens: ["sales"] },
  { id: "business.business", purpose: "business",
    observedRole: "business", tokens: ["business"] },
  { id: "business.commercial", purpose: "business",
    observedRole: "commercial", tokens: ["commercial"] },
  { id: "marketing.marketing", purpose: "marketing",
    observedRole: "marketing", tokens: ["marketing"] },
  { id: "site-owner.owner", purpose: "site_owner",
    observedRole: "site owner", tokens: ["owner"], highTrustOnly: true },
  { id: "site-owner.webmaster", purpose: "site_owner",
    observedRole: "webmaster", tokens: ["webmaster"] },
  { id: "support.customer-support", purpose: "support",
    observedRole: "customer support", tokens: ["customer", "support"] },
  { id: "support.support", purpose: "support",
    observedRole: "support", tokens: ["support"] },
  { id: "support.helpdesk", purpose: "support",
    observedRole: "helpdesk", tokens: ["helpdesk"] },
  { id: "general.contact", purpose: "general",
    observedRole: "contact", tokens: ["contact"] },
  { id: "general.info", purpose: "general", observedRole: "info", tokens: ["info"] },
  { id: "general.hello", purpose: "general", observedRole: "hello", tokens: ["hello"] },
  { id: "general.office", purpose: "general", observedRole: "office", tokens: ["office"] },
  { id: "general.admin", purpose: "general", observedRole: "admin", tokens: ["admin"] },
];

function tokenize(value: string): readonly string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  return normalized.match(/[a-z0-9]+/gu) ?? [];
}

function includesSequence(
  values: readonly string[],
  expected: readonly string[],
): boolean {
  return values.some((_, start) =>
    expected.every((token, offset) => values[start + offset] === token),
  );
}

function bounded(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 160);
}

export function classifyContactPurpose(
  input: ContactPurposeInput,
): ContactPurposeDecision {
  const localPart = input.email.split("@", 1)[0] ?? "";
  const fields: Field[] = [
    { field: "email_local_part", tier: "high", confidence: 98,
      value: localPart, highTrust: true },
  ];
  if (input.mailtoLabel !== undefined && input.mailtoLabel.trim() !== "") {
    fields.push({ field: "mailto_label", tier: "high", confidence: 96,
      value: input.mailtoLabel, highTrust: true });
  }
  if (input.nearbyText !== undefined && input.nearbyText.trim() !== "") {
    fields.push({ field: "nearby_text", tier: "medium", confidence: 86,
      value: input.nearbyText, highTrust: false });
  }
  if (input.pageTitle !== undefined && input.pageTitle.trim() !== "") {
    fields.push({ field: "page_title", tier: "low", confidence: 72,
      value: input.pageTitle, highTrust: false });
  }

  const matches = fields.flatMap((field) => {
    const tokens = tokenize(field.value);
    return rules.flatMap((rule) => {
      if (rule.highTrustOnly === true && !field.highTrust) return [];
      if (!includesSequence(tokens, rule.tokens)) return [];
      return [{
        rule,
        confidence: field.confidence,
        evidence: Object.freeze({
          tier: field.tier,
          field: field.field,
          value: bounded(field.value),
          matchedToken: rule.tokens.join(" "),
          ruleId: rule.id,
        }),
      }];
    });
  });
  const selected = matches.reduce<(typeof matches)[number] | undefined>(
    (best, match) =>
      best === undefined || match.confidence > best.confidence ? match : best,
    undefined,
  );

  return Object.freeze({
    observedRole: selected?.rule.observedRole ?? null,
    inferredPurpose: selected?.rule.purpose ?? "unknown",
    confidence: selected?.confidence ?? 0,
    ruleVersion: contactPurposeRuleVersion,
    evidence: Object.freeze(matches.map(({ evidence }) => evidence)),
  });
}
