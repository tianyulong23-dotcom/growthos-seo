export const replyMatchDecisions = Object.freeze({
  autoMatched: "AUTO_MATCHED",
  reviewRequired: "REVIEW_REQUIRED",
  unmatched: "UNMATCHED",
  conflicted: "CONFLICTED",
} as const);

export type ReplyMatchDecision =
  (typeof replyMatchDecisions)[keyof typeof replyMatchDecisions];

export const replyMatchEvidenceKinds = Object.freeze({
  providerThreadExact: "PROVIDER_THREAD_EXACT",
  inReplyToExact: "IN_REPLY_TO_EXACT",
  referencesExact: "REFERENCES_EXACT",
  quotedBodyFingerprint: "QUOTED_BODY_FINGERPRINT",
  knownContact: "KNOWN_CONTACT",
  normalizedSubject: "NORMALIZED_SUBJECT",
  participantOverlap: "PARTICIPANT_OVERLAP",
  timeWindow: "TIME_WINDOW",
} as const);

export type ReplyMatchEvidence =
  | Readonly<{
    kind: "PROVIDER_THREAD_EXACT";
    providerThreadId: string;
  }>
  | Readonly<{
    kind: "IN_REPLY_TO_EXACT" | "REFERENCES_EXACT";
    outboundMessageId: string;
  }>
  | Readonly<{
    kind: "QUOTED_BODY_FINGERPRINT";
    fingerprint: string;
  }>
  | Readonly<{
    kind: "KNOWN_CONTACT";
    address: string;
  }>
  | Readonly<{
    kind: "NORMALIZED_SUBJECT";
    value: string;
  }>
  | Readonly<{
    kind: "PARTICIPANT_OVERLAP";
    addresses: readonly string[];
  }>
  | Readonly<{
    kind: "TIME_WINDOW";
    hours: number;
  }>;

type ReplyMatchScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
}>;

export type InboundReplyReference = ReplyMatchScope & Readonly<{
  providerThreadId: string | null;
  inReplyToMessageId: string | null;
  referenceMessageIds: readonly string[];
  quotedBodyFingerprints?: readonly string[];
  fromAddress: string | null;
  participantAddresses: readonly string[];
  subject: string | null;
  receivedAt: Date;
}>;

export type OutboundReplyReference = ReplyMatchScope & Readonly<{
  opportunityId: string;
  mailThreadId: string;
  providerThreadId: string | null;
  rfcMessageId: string | null;
  bodyFingerprint?: string | null;
  contactAddress: string | null;
  participantAddresses: readonly string[];
  subject: string | null;
  sentAt: Date;
}>;

export type ReplyMatchConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type ReplyMatchCandidate = Readonly<{
  opportunityId: string;
  mailThreadId: string;
  confidence: Exclude<ReplyMatchConfidence, "NONE">;
  requiresManualConfirmation: boolean;
  evidence: readonly ReplyMatchEvidence[];
}>;

export type ReplyMatchResult = Readonly<{
  decision: ReplyMatchDecision;
  confidence: ReplyMatchConfidence;
  matchedOpportunityId: string | null;
  matchedMailThreadId: string | null;
  candidates: readonly ReplyMatchCandidate[];
  ruleVersion: "reply-matcher-v1";
}>;

type MutableCandidate = {
  opportunityId: string;
  mailThreadId: string;
  evidence: ReplyMatchEvidence[];
  strong: boolean;
  weakScore: number;
  order: number;
};

const maxTimeWindowHours = 120 * 24;

const normalizeMessageId = (value: string | null): string | null => {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
};

const normalizeAddress = (value: string | null): string | null => {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
};

const normalizeSubject = (value: string | null): string | null => {
  if (value === null) return null;
  const normalized = value
    .trim()
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return normalized.length === 0 ? null : normalized;
};

const sameScope = (
  inbound: InboundReplyReference,
  outbound: OutboundReplyReference,
): boolean =>
  inbound.organizationId === outbound.organizationId
  && inbound.workspaceId === outbound.workspaceId
  && inbound.websiteProjectId === outbound.websiteProjectId
  && inbound.gmailConnectionId === outbound.gmailConnectionId;

const hasEvidence = (
  evidence: readonly ReplyMatchEvidence[],
  candidate: ReplyMatchEvidence,
): boolean =>
  evidence.some((item) => JSON.stringify(item) === JSON.stringify(candidate));

const addEvidence = (
  target: ReplyMatchEvidence[],
  evidence: ReplyMatchEvidence,
): void => {
  if (!hasEvidence(target, evidence)) target.push(evidence);
};

const confidenceFor = (
  candidate: MutableCandidate,
): Exclude<ReplyMatchConfidence, "NONE"> => {
  if (candidate.strong) return "HIGH";
  return candidate.weakScore >= 3 ? "MEDIUM" : "LOW";
};

const immutableCandidate = (
  candidate: MutableCandidate,
): ReplyMatchCandidate =>
  Object.freeze({
    opportunityId: candidate.opportunityId,
    mailThreadId: candidate.mailThreadId,
    confidence: confidenceFor(candidate),
    requiresManualConfirmation: !candidate.strong,
    evidence: Object.freeze([...candidate.evidence]),
  });

export const matchInboundReply = (
  inbound: InboundReplyReference,
  outboundReferences: readonly OutboundReplyReference[],
): ReplyMatchResult => {
  const candidates = new Map<string, MutableCandidate>();
  const inboundMessageId = normalizeMessageId(inbound.inReplyToMessageId);
  const references = new Set(
    inbound.referenceMessageIds
      .map((value) => normalizeMessageId(value))
      .filter((value): value is string => value !== null),
  );
  const fingerprints = new Set(inbound.quotedBodyFingerprints ?? []);
  const inboundSender = normalizeAddress(inbound.fromAddress);
  const inboundParticipants = new Set(
    inbound.participantAddresses
      .map((value) => normalizeAddress(value))
      .filter((value): value is string => value !== null),
  );
  const inboundSubject = normalizeSubject(inbound.subject);

  for (const [order, outbound] of outboundReferences.entries()) {
    if (!sameScope(inbound, outbound)) continue;

    const evidence: ReplyMatchEvidence[] = [];
    let strong = false;
    let weakScore = 0;
    const outboundMessageId = normalizeMessageId(outbound.rfcMessageId);

    if (
      inbound.providerThreadId !== null
      && outbound.providerThreadId === inbound.providerThreadId
    ) {
      strong = true;
      evidence.push({
        kind: replyMatchEvidenceKinds.providerThreadExact,
        providerThreadId: inbound.providerThreadId,
      });
    }
    if (
      inboundMessageId !== null
      && outboundMessageId === inboundMessageId
    ) {
      strong = true;
      evidence.push({
        kind: replyMatchEvidenceKinds.inReplyToExact,
        outboundMessageId: inboundMessageId,
      });
    }
    if (
      outboundMessageId !== null
      && references.has(outboundMessageId)
    ) {
      strong = true;
      evidence.push({
        kind: replyMatchEvidenceKinds.referencesExact,
        outboundMessageId,
      });
    }

    if (
      outbound.bodyFingerprint
      && fingerprints.has(outbound.bodyFingerprint)
    ) {
      weakScore += 2;
      evidence.push({
        kind: replyMatchEvidenceKinds.quotedBodyFingerprint,
        fingerprint: outbound.bodyFingerprint,
      });
    }

    const contactAddress = normalizeAddress(outbound.contactAddress);
    if (
      inboundSender !== null
      && contactAddress === inboundSender
    ) {
      weakScore += 2;
      evidence.push({
        kind: replyMatchEvidenceKinds.knownContact,
        address: inboundSender,
      });
    }

    const outboundSubject = normalizeSubject(outbound.subject);
    if (
      inboundSubject !== null
      && outboundSubject === inboundSubject
    ) {
      weakScore += 1;
      evidence.push({
        kind: replyMatchEvidenceKinds.normalizedSubject,
        value: inboundSubject,
      });
    }

    const participantOverlap = [...new Set(
      outbound.participantAddresses
        .map((value) => normalizeAddress(value))
        .filter((value): value is string =>
          value !== null && inboundParticipants.has(value)),
    )].sort();
    if (participantOverlap.length > 0) {
      weakScore += 2;
      evidence.push({
        kind: replyMatchEvidenceKinds.participantOverlap,
        addresses: Object.freeze(participantOverlap),
      });
    }

    const elapsedHours =
      (inbound.receivedAt.getTime() - outbound.sentAt.getTime())
      / (60 * 60 * 1_000);
    if (
      evidence.length > 0
      &&
      Number.isFinite(elapsedHours)
      && elapsedHours >= 0
      && elapsedHours <= maxTimeWindowHours
    ) {
      weakScore += 1;
      evidence.push({
        kind: replyMatchEvidenceKinds.timeWindow,
        hours: elapsedHours,
      });
    }

    if (evidence.length === 0) continue;

    const existing = candidates.get(outbound.opportunityId);
    if (existing === undefined) {
      candidates.set(outbound.opportunityId, {
        opportunityId: outbound.opportunityId,
        mailThreadId: outbound.mailThreadId,
        evidence,
        strong,
        weakScore,
        order,
      });
      continue;
    }

    const wasStrong = existing.strong;
    for (const item of evidence) addEvidence(existing.evidence, item);
    existing.strong ||= strong;
    existing.weakScore = Math.max(existing.weakScore, weakScore);
    if (strong && !wasStrong) {
      existing.mailThreadId = outbound.mailThreadId;
    }
  }

  const sorted = [...candidates.values()].sort((left, right) => {
    if (left.strong !== right.strong) return left.strong ? -1 : 1;
    if (left.weakScore !== right.weakScore) {
      return right.weakScore - left.weakScore;
    }
    return left.order - right.order;
  });
  const resultCandidates = Object.freeze(sorted.map(immutableCandidate));
  const strongCandidates = sorted.filter((candidate) => candidate.strong);

  if (strongCandidates.length === 1) {
    const matched = strongCandidates[0];
    if (matched === undefined) throw new Error("Reply match result is invalid.");
    return Object.freeze({
      decision: replyMatchDecisions.autoMatched,
      confidence: "HIGH",
      matchedOpportunityId: matched.opportunityId,
      matchedMailThreadId: matched.mailThreadId,
      candidates: resultCandidates,
      ruleVersion: "reply-matcher-v1",
    });
  }

  if (strongCandidates.length > 1) {
    return Object.freeze({
      decision: replyMatchDecisions.conflicted,
      confidence: "NONE",
      matchedOpportunityId: null,
      matchedMailThreadId: null,
      candidates: resultCandidates,
      ruleVersion: "reply-matcher-v1",
    });
  }

  if (sorted.length > 0) {
    return Object.freeze({
      decision: replyMatchDecisions.reviewRequired,
      confidence: confidenceFor(sorted[0] as MutableCandidate),
      matchedOpportunityId: null,
      matchedMailThreadId: null,
      candidates: resultCandidates,
      ruleVersion: "reply-matcher-v1",
    });
  }

  return Object.freeze({
    decision: replyMatchDecisions.unmatched,
    confidence: "NONE",
    matchedOpportunityId: null,
    matchedMailThreadId: null,
    candidates: Object.freeze([]),
    ruleVersion: "reply-matcher-v1",
  });
};
