import { describe, expect, it } from "vitest";

import {
  classifyReplyWithRules,
  replyClassificationCodes,
} from "../../src/modules/backlinks/domain/replies/classification.js";

describe("BL-AI-137 Rule-based reply classification", () => {
  it.each([
    {
      input: {
        subject: "Re: GrowthOS collaboration",
        text: "Sounds good. I am interested in moving forward.",
      },
      expected: replyClassificationCodes.positive,
    },
    {
      input: {
        subject: "Re: GrowthOS collaboration",
        text: "No thanks. We are not interested.",
      },
      expected: replyClassificationCodes.negative,
    },
    {
      input: {
        subject: "Re: GrowthOS collaboration",
        text: "What is your budget for this placement?",
      },
      expected: replyClassificationCodes.question,
    },
    {
      input: {
        subject: "Automatic reply: Out of office",
        text: "I am away from the office until Monday.",
      },
      expected: replyClassificationCodes.outOfOffice,
    },
    {
      input: {
        subject: "Re: GrowthOS collaboration",
        text: "Thanks for your email.",
      },
      expected: replyClassificationCodes.unknown,
    },
  ])("classifies $expected without allowing an automatic send", ({
    input,
    expected,
  }) => {
    const result = classifyReplyWithRules(input);

    expect(result.classificationCode).toBe(expected);
    expect(result.classifierType).toBe("RULE");
    expect(result.classifierVersion).toBe("reply-classification-rules-v1");
    expect(result.autoSendAllowed).toBe(false);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.explanation.length).toBeGreaterThan(0);
  });

  it("gives out-of-office and rejection rules precedence over lower signals", () => {
    expect(classifyReplyWithRules({
      subject: "Automatic reply: Out of office",
      text: "I am interested, but I am away until Monday.",
    }).classificationCode).toBe(replyClassificationCodes.outOfOffice);

    expect(classifyReplyWithRules({
      subject: "Re: GrowthOS collaboration",
      text: "I am not interested. Can you remove me from future emails?",
    }).classificationCode).toBe(replyClassificationCodes.negative);
  });

  it("gives a direct question precedence over a positive phrase", () => {
    const result = classifyReplyWithRules({
      subject: "Re: GrowthOS collaboration",
      text: "I am interested. What is your budget?",
    });

    expect(result.classificationCode).toBe(replyClassificationCodes.question);
    expect(result.evidence[0]).toMatchObject({
      source: "BODY",
      ruleId: "QUESTION_MARK",
    });
  });

  it("does not confuse statements or generic auto-replies with supported classes", () => {
    expect(classifyReplyWithRules({
      subject: "Re: GrowthOS collaboration",
      text: "This is what we need from a partner.",
    }).classificationCode).toBe(replyClassificationCodes.unknown);

    expect(classifyReplyWithRules({
      subject: "Automatic reply: ticket received",
      text: "We received your support request.",
    }).classificationCode).toBe(replyClassificationCodes.unknown);
  });

  it("returns source offsets for the winning explainable rule", () => {
    const text = "Hello. Please remove me from future emails.";
    const result = classifyReplyWithRules({
      subject: null,
      text,
    });

    expect(result.classificationCode).toBe(replyClassificationCodes.negative);
    expect(result.evidence[0]).toMatchObject({
      ruleId: "NEGATIVE_OPT_OUT",
      source: "BODY",
      matchedText: "remove me",
      start: text.indexOf("remove me"),
      end: text.indexOf("remove me") + "remove me".length,
    });
  });

  it("is deterministic and explains empty input as unknown", () => {
    const first = classifyReplyWithRules({ subject: null, text: null });
    const second = classifyReplyWithRules({ subject: null, text: null });

    expect(first).toEqual(second);
    expect(first).toEqual({
      classificationCode: replyClassificationCodes.unknown,
      classifierType: "RULE",
      classifierVersion: "reply-classification-rules-v1",
      confidenceScore: 0,
      evidence: [{
        ruleId: "NO_RULE_MATCH",
        source: "NONE",
        matchedText: null,
        start: null,
        end: null,
        explanation: "No deterministic reply classification rule matched.",
      }],
      autoSendAllowed: false,
    });
  });
});
