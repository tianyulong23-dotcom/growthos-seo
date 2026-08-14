import { domainToASCII } from "node:url";
import { getDomain } from "tldts";
import { parseContactPage } from "../../adapters/html/contact-parser.adapter.js";
import {
  contactEvidenceConfidence,
  contactEvidenceConfidenceRuleVersion,
  type ContactDomainRelation,
} from "../../domain/contacts/contact-evidence-confidence.js";
import type {
  SafeFetchPort,
  SafeFetchResult,
} from "../../ports/safe-fetch.port.js";

export type ContactDiscoveryResult = Readonly<{
  candidateCount: number; evidenceInserted: number; evidenceMerged: number;
}>;
export type ContactDiscoveryInput = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
  recommendationContextVersionId: string; prospectId: string;
  prospectRegistrableDomain: string; targetUrl: string; actorId: string;
}>;
type DiscoveryRecord = Readonly<{
  candidateId: string; evidenceId: string; normalizedEmail: string;
  emailDomainAscii: string; domainRelation: ContactDomainRelation;
  syntaxValidatorVersion: string; confidence: number; sourceUrl: string;
  observedAt: Date;
  extractionMethod: "mailto" | "visible_text" | "obfuscated_text" | "json_ld";
  evidenceSnippet: string; parserVersion: string; contentSha256: string; expiresAt: Date;
  observedRole: string | null; inferredPurpose: string; purposeConfidence: number;
  purposeRuleVersion: string; purposeEvidence: readonly Readonly<Record<string, string>>[];
  evidenceRuleVersion: string;
}>;
export type ContactDiscoveryWrite = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
  recommendationContextVersionId: string; prospectId: string; actorId: string;
  records: readonly DiscoveryRecord[];
}>;
export interface ContactDiscoveryRepository {
  merge(input: ContactDiscoveryWrite): Promise<ContactDiscoveryResult>;
}

const ignoredMailbox = /^(?:no-?reply|do-?not-?reply|noreply)$/iu;
const relation = (emailDomain: string, prospectDomain: string) => {
  const emailRegistrable = getDomain(emailDomain, { allowPrivateDomains: true });
  const prospectRegistrable = getDomain(
    prospectDomain,
    { allowPrivateDomains: true },
  );
  if (emailRegistrable === null || prospectRegistrable === null) {
    return "unknown" as const;
  }
  return emailRegistrable === prospectRegistrable
    ? "same_registrable_domain" as const
    : "external_domain" as const;
};

export class ContactDiscoveryService {
  constructor(private readonly dependencies: Readonly<{
    safeFetch: SafeFetchPort; repository: ContactDiscoveryRepository; newId(): string;
  }>) {}

  async discover(input: ContactDiscoveryInput): Promise<ContactDiscoveryResult> {
    const page = await this.dependencies.safeFetch.fetch({
      url: input.targetUrl, purpose: "contact-enrichment",
      workspaceId: input.workspaceId, websiteProjectId: input.websiteProjectId,
      maxBytes: 2_000_000, maxRedirects: 5,
    });
    if (page.status < 200 || page.status >= 300) {
      throw new Error(`Contact discovery fetch returned HTTP ${page.status}.`);
    }
    return this.discoverFetched(input, page);
  }

  async discoverFetched(
    input: ContactDiscoveryInput,
    page: SafeFetchResult,
  ): Promise<ContactDiscoveryResult> {
    const parsed = parseContactPage(page);
    const observedAt = new Date(parsed.fetchedAt);
    const expiresAt = new Date(observedAt);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
    const prospectDomain = domainToASCII(input.prospectRegistrableDomain).toLowerCase();
    const records = parsed.candidates.flatMap((candidate): DiscoveryRecord[] => {
      const [localPart = "", rawDomain = ""] = candidate.email.split("@");
      if (ignoredMailbox.test(localPart)) return [];
      const emailDomainAscii = domainToASCII(rawDomain).toLowerCase();
      const domainRelation = emailDomainAscii && prospectDomain
        ? relation(emailDomainAscii, prospectDomain) : "unknown";
      const confidence = contactEvidenceConfidence({
        source: candidate.evidence.source,
        domainRelation,
      });
      return [{
        candidateId: this.dependencies.newId(), evidenceId: this.dependencies.newId(),
        normalizedEmail: candidate.email, emailDomainAscii, domainRelation,
        syntaxValidatorVersion: parsed.syntaxValidator, confidence,
        sourceUrl: candidate.evidence.pageUrl, observedAt,
        extractionMethod: candidate.evidence.source,
        evidenceSnippet: candidate.evidence.snippet || candidate.email,
        parserVersion: parsed.parser, contentSha256: parsed.contentSha256, expiresAt,
        observedRole: candidate.purposeDecision.observedRole,
        inferredPurpose: candidate.purposeDecision.inferredPurpose,
        purposeConfidence: candidate.purposeDecision.confidence,
        purposeRuleVersion: candidate.purposeDecision.ruleVersion,
        purposeEvidence: candidate.purposeDecision.evidence,
        evidenceRuleVersion: contactEvidenceConfidenceRuleVersion,
      }];
    });
    if (records.length === 0) {
      return { candidateCount: 0, evidenceInserted: 0, evidenceMerged: 0 };
    }
    return this.dependencies.repository.merge({
      organizationId: input.organizationId, workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      recommendationContextVersionId: input.recommendationContextVersionId,
      prospectId: input.prospectId, actorId: input.actorId, records,
    });
  }
}
