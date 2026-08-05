export const replyClassificationCodes = Object.freeze({
  positive: "POSITIVE",
  negative: "NEGATIVE",
  question: "QUESTION",
  outOfOffice: "OUT_OF_OFFICE",
  unknown: "UNKNOWN",
} as const);

export type ReplyClassificationCode =
  (typeof replyClassificationCodes)[keyof typeof replyClassificationCodes];

export type ReplyClassificationInput = Readonly<{
  subject: string | null;
  text: string | null;
}>;

export type ReplyClassificationEvidence = Readonly<{
  ruleId: string;
  source: "SUBJECT" | "BODY" | "NONE";
  matchedText: string | null;
  start: number | null;
  end: number | null;
  explanation: string;
}>;

export type ReplyClassificationResult = Readonly<{
  classificationCode: ReplyClassificationCode;
  classifierType: "RULE";
  classifierVersion: "reply-classification-rules-v1";
  confidenceScore: number;
  evidence: readonly ReplyClassificationEvidence[];
  autoSendAllowed: false;
}>;

type ClassificationRule = Readonly<{
  ruleId: string;
  pattern: RegExp;
  explanation: string;
  confidenceScore: number;
}>;

type ClassificationRuleGroup = Readonly<{
  classificationCode: Exclude<
    ReplyClassificationCode,
    typeof replyClassificationCodes.unknown
  >;
  rules: readonly ClassificationRule[];
  sourceOrder: readonly ("SUBJECT" | "BODY")[];
}>;

const outOfOfficeRules = Object.freeze([
  {
    ruleId: "OUT_OF_OFFICE_EXPLICIT",
    pattern:
      /\b(?:out of (?:the )?office|vacation responder)\b/iu,
    explanation:
      "The reply contains an explicit out-of-office phrase.",
    confidenceScore: 0.99,
  },
  {
    ruleId: "OUT_OF_OFFICE_AWAY",
    pattern:
      /\b(?:away from (?:the )?office|on (?:annual )?leave|away until|returning on)\b/iu,
    explanation:
      "The reply states that the sender is away or on leave.",
    confidenceScore: 0.95,
  },
] satisfies readonly ClassificationRule[]);

const negativeRules = Object.freeze([
  {
    ruleId: "NEGATIVE_OPT_OUT",
    pattern:
      /\b(?:unsubscribe|remove me|do not contact(?: me)?|don['\u2019]t contact(?: me)?|stop emailing(?: me)?|stop contacting(?: me)?)\b/iu,
    explanation:
      "The reply contains an explicit request to stop future contact.",
    confidenceScore: 0.99,
  },
  {
    ruleId: "NEGATIVE_REJECTION",
    pattern:
      /\b(?:not interested|no thanks|not a fit|decline(?: this)?|(?:we(?:['\u2019]re| are)|i(?:['\u2019]ll| will)) (?:have to )?pass)\b/iu,
    explanation: "The reply contains an explicit rejection.",
    confidenceScore: 0.95,
  },
] satisfies readonly ClassificationRule[]);

const questionRules = Object.freeze([
  {
    ruleId: "QUESTION_WORD",
    pattern: /^\s*(?:what|when|where|why|how|who|which)\b/imu,
    explanation: "The reply contains a direct question word.",
    confidenceScore: 0.85,
  },
  {
    ruleId: "QUESTION_AUXILIARY",
    pattern:
      /^\s*(?:can|could|would|will|do|does|did|is|are|have|has)\s+(?:you|your|we|there|it)\b/imu,
    explanation: "The reply contains a direct auxiliary-question phrase.",
    confidenceScore: 0.8,
  },
  {
    ruleId: "QUESTION_MARK",
    pattern: /\?/u,
    explanation: "The reply contains an explicit question mark.",
    confidenceScore: 0.7,
  },
] satisfies readonly ClassificationRule[]);

const positiveRules = Object.freeze([
  {
    ruleId: "POSITIVE_INTEREST",
    pattern:
      /\b(?:interested|sounds good|happy to proceed|ready to proceed|let['\u2019]s proceed|lets proceed|open to this|would like to proceed)\b/iu,
    explanation:
      "The reply contains an explicit expression of interest or intent to proceed.",
    confidenceScore: 0.9,
  },
  {
    ruleId: "POSITIVE_AGREEMENT",
    pattern:
      /\b(?:that works for (?:me|us)|we can proceed|please send (?:the )?next steps)\b/iu,
    explanation: "The reply contains an explicit agreement signal.",
    confidenceScore: 0.9,
  },
] satisfies readonly ClassificationRule[]);

const ruleGroups = Object.freeze([
  {
    classificationCode: replyClassificationCodes.outOfOffice,
    rules: outOfOfficeRules,
    sourceOrder: ["SUBJECT", "BODY"],
  },
  {
    classificationCode: replyClassificationCodes.negative,
    rules: negativeRules,
    sourceOrder: ["BODY", "SUBJECT"],
  },
  {
    classificationCode: replyClassificationCodes.question,
    rules: questionRules,
    sourceOrder: ["BODY", "SUBJECT"],
  },
  {
    classificationCode: replyClassificationCodes.positive,
    rules: positiveRules,
    sourceOrder: ["BODY", "SUBJECT"],
  },
] satisfies readonly ClassificationRuleGroup[]);

const sourceValue = (
  input: ReplyClassificationInput,
  source: "SUBJECT" | "BODY",
): string | null => source === "SUBJECT" ? input.subject : input.text;

const classified = (
  classificationCode: ReplyClassificationCode,
  confidenceScore: number,
  evidence: ReplyClassificationEvidence,
): ReplyClassificationResult =>
  Object.freeze({
    classificationCode,
    classifierType: "RULE" as const,
    classifierVersion: "reply-classification-rules-v1" as const,
    confidenceScore,
    evidence: Object.freeze([Object.freeze(evidence)]),
    autoSendAllowed: false as const,
  });

export function classifyReplyWithRules(
  input: ReplyClassificationInput,
): ReplyClassificationResult {
  for (const group of ruleGroups) {
    for (const rule of group.rules) {
      for (const source of group.sourceOrder) {
        const value = sourceValue(input, source);
        if (value === null || value.length === 0) continue;

        const match = rule.pattern.exec(value);
        if (match === null) continue;

        return classified(
          group.classificationCode,
          rule.confidenceScore,
          {
            ruleId: rule.ruleId,
            source,
            matchedText: match[0],
            start: match.index,
            end: match.index + match[0].length,
            explanation: rule.explanation,
          },
        );
      }
    }
  }

  return classified(
    replyClassificationCodes.unknown,
    0,
    {
      ruleId: "NO_RULE_MATCH",
      source: "NONE",
      matchedText: null,
      start: null,
      end: null,
      explanation: "No deterministic reply classification rule matched.",
    },
  );
}
