import type { RecommendationScore } from "./scoring.js";

export type RankableRecommendation = Readonly<{
  hostnameAscii: string;
  sourceReleaseId: string;
  evidencePolicyVersion: string;
  score: Pick<
    RecommendationScore,
    | "scoreModelVersion"
    | "weightPolicyVersion"
    | "ruleVersion"
    | "evidencePolicyVersion"
    | "sourceReleaseId"
    | "total"
  >;
}>;

function compareHostnameAscii(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function assertRankableRecommendation(
  candidate: RankableRecommendation,
): void {
  if (
    candidate.hostnameAscii.length === 0 ||
    candidate.hostnameAscii.trim() !== candidate.hostnameAscii ||
    candidate.sourceReleaseId.trim().length === 0 ||
    candidate.evidencePolicyVersion.trim().length === 0
  ) {
    throw new TypeError("ranking identity fields must be non-blank");
  }

  if (
    !Number.isFinite(candidate.score.total) ||
    candidate.score.total < 0 ||
    candidate.score.total > 100
  ) {
    throw new TypeError("score.total must be a finite number from 0 to 100");
  }

  if (
    candidate.score.scoreModelVersion.trim().length === 0 ||
    candidate.score.weightPolicyVersion.trim().length === 0 ||
    candidate.score.ruleVersion.trim().length === 0 ||
    candidate.score.sourceReleaseId !== candidate.sourceReleaseId ||
    candidate.score.evidencePolicyVersion !== candidate.evidencePolicyVersion
  ) {
    throw new TypeError("scoring contract versions must be non-blank");
  }
}

export function rankRecommendations<T extends RankableRecommendation>(
  candidates: readonly T[],
): readonly T[] {
  const seenHostnames = new Set<string>();
  const first = candidates[0];

  for (const candidate of candidates) {
    assertRankableRecommendation(candidate);

    if (seenHostnames.has(candidate.hostnameAscii)) {
      throw new TypeError(
        `duplicate hostnameAscii in ranking input: ${candidate.hostnameAscii}`,
      );
    }
    seenHostnames.add(candidate.hostnameAscii);

    if (
      first !== undefined &&
      (candidate.score.scoreModelVersion !== first.score.scoreModelVersion ||
        candidate.score.weightPolicyVersion !== first.score.weightPolicyVersion ||
        candidate.score.ruleVersion !== first.score.ruleVersion ||
        candidate.sourceReleaseId !== first.sourceReleaseId ||
        candidate.evidencePolicyVersion !== first.evidencePolicyVersion)
    ) {
      throw new TypeError("ranking input mixes scoring contract versions");
    }
  }

  return Object.freeze(
    [...candidates].sort(
      (left, right) =>
        right.score.total - left.score.total ||
        compareHostnameAscii(left.hostnameAscii, right.hostnameAscii),
    ),
  );
}
