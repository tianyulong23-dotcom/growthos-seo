export const backlinkProfileHealthModelVersion =
  "backlink-profile-health.v1" as const;

export type BacklinkProfileHealthInput = Readonly<{
  inventoryCoverage: number;
  totalBacklinks: number;
  referringDomains: number;
  dofollow: number;
  nofollow: number;
  sponsored: number;
  ugc: number;
  spamHighRisk: number;
  commercialAnchorCount: number;
  largestAnchorCount: number;
  newBacklinks: number;
  lostBacklinks: number;
  relevantCountryCount: number;
  knownCountryCount: number;
  targetPageCount: number;
  brokenTargetCount: number;
  qualityDomainCount: number;
  knownPlacementCount: number;
  validatedPlacementCount: number;
}>;

export type BacklinkProfileHealthComponentId =
  | "referring_domain_diversity"
  | "rel_structure"
  | "spam_risk"
  | "anchor_concentration"
  | "new_lost_velocity"
  | "market_relevance"
  | "target_page_distribution"
  | "quality_domain_ratio"
  | "known_placement_validation";

export type BacklinkProfileHealthResult = Readonly<{
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "E" | "INSUFFICIENT_DATA";
  modelVersion: typeof backlinkProfileHealthModelVersion;
  components: readonly Readonly<{
    id: BacklinkProfileHealthComponentId;
    score: number | null;
  }>[];
  risks: readonly string[];
  positives: readonly string[];
}>;

const bounded = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value)));

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

function component(
  id: BacklinkProfileHealthComponentId,
  score: number | null,
) {
  return Object.freeze({ id, score });
}

export function calculateBacklinkProfileHealth(
  input: BacklinkProfileHealthInput,
): BacklinkProfileHealthResult {
  if (
    !Number.isFinite(input.inventoryCoverage)
    || input.inventoryCoverage < 0.5
    || input.totalBacklinks <= 0
  ) {
    return Object.freeze({
      score: null,
      grade: "INSUFFICIENT_DATA",
      modelVersion: backlinkProfileHealthModelVersion,
      components: Object.freeze([
        component("referring_domain_diversity", null),
        component("rel_structure", null),
        component("spam_risk", null),
        component("anchor_concentration", null),
        component("new_lost_velocity", null),
        component("market_relevance", null),
        component("target_page_distribution", null),
        component("quality_domain_ratio", null),
        component("known_placement_validation", null),
      ]),
      risks: Object.freeze(["INVENTORY_COVERAGE_LOW"]),
      positives: Object.freeze([]),
    });
  }

  const pulled = Math.max(
    1,
    input.dofollow + input.nofollow + input.sponsored + input.ugc,
  );
  const diversity = bounded(
    (input.referringDomains / input.totalBacklinks) * 150,
  );
  const dofollowShare = input.dofollow / pulled;
  const nofollowShare = input.nofollow / pulled;
  const relStructure = bounded(
    100
      - Math.abs(dofollowShare - 0.65) * 80
      - Math.abs(nofollowShare - 0.25) * 40
      - ((input.sponsored + input.ugc) / pulled) * 200,
  );
  const spamRisk = bounded(100 - (input.spamHighRisk / pulled) * 100);
  const anchorConcentration = bounded(
    100
      - (input.largestAnchorCount / pulled) * 100
      - (input.commercialAnchorCount / pulled) * 100,
  );
  const velocity = bounded(
    input.newBacklinks >= input.lostBacklinks
      ? 90
      : 70 - Math.min(70, (input.lostBacklinks - input.newBacklinks) * 5),
  );
  const marketRelevanceRatio = ratio(
    input.relevantCountryCount,
    input.knownCountryCount,
  );
  const marketRelevance = marketRelevanceRatio === null
    ? 50
    : bounded(marketRelevanceRatio * 100);
  const brokenTargetRatio = ratio(
    input.brokenTargetCount,
    input.targetPageCount,
  );
  const targetDistribution = brokenTargetRatio === null
    ? 50
    : bounded(100 - brokenTargetRatio * 200);
  const qualityRatio = ratio(
    input.qualityDomainCount,
    input.referringDomains,
  );
  const qualityDomains = qualityRatio === null
    ? 50
    : bounded(qualityRatio * 100);
  const placementRatio = ratio(
    input.validatedPlacementCount,
    input.knownPlacementCount,
  );
  const placementValidation = placementRatio === null
    ? 50
    : bounded(placementRatio * 100);
  const components = Object.freeze([
    component("referring_domain_diversity", diversity),
    component("rel_structure", relStructure),
    component("spam_risk", spamRisk),
    component("anchor_concentration", anchorConcentration),
    component("new_lost_velocity", velocity),
    component("market_relevance", marketRelevance),
    component("target_page_distribution", targetDistribution),
    component("quality_domain_ratio", qualityDomains),
    component("known_placement_validation", placementValidation),
  ]);
  const score = Math.round(
    components.reduce((total, item) => total + (item.score ?? 0), 0)
      / components.length,
  );
  const risks: string[] = [];
  const positives: string[] = [];
  if (spamRisk < 80) risks.push("SPAM_RISK_ELEVATED");
  if (anchorConcentration < 70) risks.push("ANCHOR_CONCENTRATION_HIGH");
  if (input.lostBacklinks > input.newBacklinks) risks.push("NET_LINK_LOSS");
  if (targetDistribution < 70) risks.push("BROKEN_TARGETS_ELEVATED");
  if (diversity >= 75) {
    positives.push("REFERRING_DOMAIN_DIVERSITY_HEALTHY");
  }
  if (qualityDomains >= 70) positives.push("QUALITY_DOMAIN_RATIO_HEALTHY");
  if (placementValidation >= 80) {
    positives.push("KNOWN_PLACEMENTS_VALIDATED");
  }
  const grade = score >= 90
    ? "A"
    : score >= 80
      ? "B"
      : score >= 70
        ? "C"
        : score >= 60
          ? "D"
          : "E";
  return Object.freeze({
    score,
    grade,
    modelVersion: backlinkProfileHealthModelVersion,
    components,
    risks: Object.freeze(risks),
    positives: Object.freeze(positives),
  });
}
