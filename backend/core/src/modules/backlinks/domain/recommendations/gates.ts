import type { EvidenceValue } from "../evidence/evidence.js";
import {
  copyRecommendationEvidenceValue,
  recommendationEvidenceIsUsable,
} from "./evidence-value.js";

export const recommendationGateRuleVersion =
  "recommendation-open-evidence-gates.v1";

export const recommendationGateRuleIds = [
  "unsafe_or_malicious",
  "high_confidence_pbn_or_link_farm",
  "crawl_not_permitted",
  "user_suppressed",
  "workspace_suppressed",
  "platform_suppressed",
  "existing_backlink",
  "already_joined",
  "previously_excluded",
  "market_mismatch",
  "duplicate_domain",
] as const;

export type RecommendationGateRuleId =
  (typeof recommendationGateRuleIds)[number];

export type RecommendationGateFact = Readonly<{
  evidenceKey: string;
  result: EvidenceValue<boolean>;
}>;

export type RecommendationRuleFacts = Readonly<
  Record<RecommendationGateRuleId, RecommendationGateFact>
>;

export type RuleHit = Readonly<{
  ruleId: RecommendationGateRuleId;
  evidenceKey: string;
  evidence: EvidenceValue<boolean>;
}>;

export type RuleDecision = Readonly<{
  decision: "ready" | "excluded" | "insufficient_data";
  ruleVersion: typeof recommendationGateRuleVersion;
  hitRules: readonly RuleHit[];
  missingEvidenceKeys: readonly string[];
}>;

function copyFact(
  ruleId: RecommendationGateRuleId,
  fact: RecommendationGateFact,
  expectedSourceReleaseId?: string,
): RecommendationGateFact {
  if (fact.evidenceKey.trim().length === 0) {
    throw new TypeError(`Recommendation gate ${ruleId} requires evidenceKey`);
  }
  const result = copyRecommendationEvidenceValue(
    `Recommendation gate ${ruleId}`,
    fact.result,
    (value): value is boolean => typeof value === "boolean",
  );
  if (
    expectedSourceReleaseId !== undefined &&
    result.sourceReleaseId !== expectedSourceReleaseId
  ) {
    throw new TypeError(
      `Recommendation gate ${ruleId} has mixed source release`,
    );
  }
  return Object.freeze({
    evidenceKey: fact.evidenceKey.trim(),
    result,
  });
}

export function evaluateRecommendationGates(
  facts: RecommendationRuleFacts,
  expectedSourceReleaseId?: string,
): RuleDecision {
  const hitRules: RuleHit[] = [];
  const missingEvidenceKeys: string[] = [];

  for (const ruleId of recommendationGateRuleIds) {
    const fact = copyFact(ruleId, facts[ruleId], expectedSourceReleaseId);
    if (!recommendationEvidenceIsUsable(fact.result)) {
      missingEvidenceKeys.push(fact.evidenceKey);
    } else if (fact.result.value) {
      hitRules.push(Object.freeze({
        ruleId,
        evidenceKey: fact.evidenceKey,
        evidence: fact.result,
      }));
    }
  }

  return Object.freeze({
    decision: hitRules.length > 0
      ? "excluded"
      : missingEvidenceKeys.length > 0
      ? "insufficient_data"
      : "ready",
    ruleVersion: recommendationGateRuleVersion,
    hitRules: Object.freeze(hitRules),
    missingEvidenceKeys: Object.freeze(missingEvidenceKeys),
  });
}
