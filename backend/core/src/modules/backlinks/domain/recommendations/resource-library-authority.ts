export type ProjectAuthorityBand =
  | "high"
  | "established"
  | "growing"
  | "emerging"
  | "unknown";

export type ProjectAuthority = Readonly<{
  score: number;
  band: ProjectAuthorityBand;
  confidence: "backlink_profile" | "neutral_default";
  referringDomains: number | null;
  minimumResourceAuthorityScore: number;
}>;

const clamp = (value: number) => Math.max(0, Math.min(100, value));

function logarithmicVolume(value: number | null, scale: number): number {
  return value === null
    ? 0
    : clamp(Math.log10(Math.max(0, value) + 1) / scale * 100);
}

export function calculateResourceAuthorityScore(input: Readonly<{
  profileHealthScore: number | null;
  dataForSeoRank: number | null;
  referringDomains: number | null;
}>): number {
  const health = input.profileHealthScore === null
    ? 50
    : clamp(input.profileHealthScore);
  const rank = input.dataForSeoRank === null
    ? 0
    : clamp(input.dataForSeoRank / 7.5);
  const referringDomains = logarithmicVolume(input.referringDomains, 6);
  return Math.round(health * 0.55 + referringDomains * 0.25 + rank * 0.2);
}

export function calculateProjectAuthority(
  referringDomains: number | null,
): ProjectAuthority {
  if (referringDomains === null) {
    return Object.freeze({
      score: 50,
      band: "unknown",
      confidence: "neutral_default",
      referringDomains: null,
      minimumResourceAuthorityScore: 35,
    });
  }
  const score = Math.round(logarithmicVolume(referringDomains, 6));
  const band: Exclude<ProjectAuthorityBand, "unknown"> = score >= 75
    ? "high"
    : score >= 60
      ? "established"
      : score >= 40
        ? "growing"
        : "emerging";
  return Object.freeze({
    score,
    band,
    confidence: "backlink_profile",
    referringDomains,
    minimumResourceAuthorityScore: Math.max(45, score - 5),
  });
}

export function resourceAuthorityMatch(
  resourceAuthorityScore: number,
  projectAuthority: ProjectAuthority,
): "stronger" | "matched" | "below" {
  if (resourceAuthorityScore >= projectAuthority.score + 8) return "stronger";
  if (
    resourceAuthorityScore >= projectAuthority.minimumResourceAuthorityScore
  ) {
    return "matched";
  }
  return "below";
}
