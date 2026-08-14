export const contactEvidenceConfidenceRuleVersion =
  "contact-evidence-confidence.v2";

export type ContactEvidenceSource =
  | "mailto"
  | "visible_text"
  | "obfuscated_text"
  | "json_ld";

export type ContactDomainRelation =
  | "same_registrable_domain"
  | "external_domain"
  | "unknown";

export function contactEvidenceConfidence(input: Readonly<{
  source: ContactEvidenceSource;
  domainRelation: ContactDomainRelation;
}>): number {
  const sourceConfidence: Readonly<Record<ContactEvidenceSource, number>> = {
    mailto: 90,
    visible_text: 80,
    obfuscated_text: 80,
    json_ld: 85,
  };
  if (input.domainRelation === "same_registrable_domain") {
    return sourceConfidence[input.source];
  }
  const domainPenalty = input.source === "mailto" ? 10 : 15;
  return sourceConfidence[input.source] - domainPenalty;
}
