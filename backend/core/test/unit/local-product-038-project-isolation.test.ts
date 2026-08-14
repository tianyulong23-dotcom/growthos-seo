import { describe, expect, it } from "vitest";

import {
  buildCommercialDiscoveryBlueprint,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-blueprint.js";

const fixtures = [
  {
    slug: "industrial-heat-pump",
    country: "US",
    language: "en",
    product: "industrial heat pump controls",
    keyword: "factory heat recovery controls",
    audience: "US plant energy managers",
    goal: "industrial decarbonization field guide",
  },
  {
    slug: "warehouse-robotics",
    country: "DE",
    language: "de",
    product: "warehouse robotics orchestration",
    keyword: "lagerrobotik software",
    audience: "German logistics operators",
    goal: "warehouse automation integration guide",
  },
  {
    slug: "clinical-microscopy",
    country: "JP",
    language: "ja",
    product: "clinical microscopy workflow",
    keyword: "病理画像ワークフロー",
    audience: "Japanese pathology laboratories",
    goal: "digital pathology operations guide",
  },
  {
    slug: "aquaculture-sensors",
    country: "BR",
    language: "pt",
    product: "aquaculture water sensors",
    keyword: "sensores para piscicultura",
    audience: "Brazilian fish farm operators",
    goal: "aquaculture water quality handbook",
  },
  {
    slug: "legal-document-automation",
    country: "FR",
    language: "fr",
    product: "legal document automation",
    keyword: "automatisation documentaire juridique",
    audience: "French in-house legal teams",
    goal: "legal operations template guide",
  },
  {
    slug: "cold-chain-packaging",
    country: "MX",
    language: "es",
    product: "cold chain packaging",
    keyword: "embalaje cadena de frio",
    audience: "Mexican pharmaceutical distributors",
    goal: "temperature controlled shipping guide",
  },
  {
    slug: "accessibility-audit",
    country: "CA",
    language: "fr-CA",
    product: "web accessibility audit software",
    keyword: "audit accessibilite numerique",
    audience: "Canadian public sector web teams",
    goal: "accessible procurement checklist",
  },
  {
    slug: "ev-fleet-charging",
    country: "IN",
    language: "hi",
    product: "electric fleet charging management",
    keyword: "वाणिज्यिक ईवी चार्जिंग",
    audience: "Indian commercial fleet operators",
    goal: "fleet electrification planning guide",
  },
  {
    slug: "desalination-membranes",
    country: "AE",
    language: "ar",
    product: "desalination membrane monitoring",
    keyword: "مراقبة أغشية التحلية",
    audience: "Gulf water utility engineers",
    goal: "membrane maintenance field guide",
  },
  {
    slug: "semiconductor-yield",
    country: "KR",
    language: "ko",
    product: "semiconductor yield analytics",
    keyword: "반도체 수율 분석",
    audience: "Korean semiconductor process teams",
    goal: "fab yield improvement guide",
  },
] as const;

describe("LOCAL-PRODUCT-038 generated project isolation", () => {
  it("keeps ten unrelated project blueprints deterministic and isolated", () => {
    const blueprints = fixtures.map((fixture, index) =>
      buildCommercialDiscoveryBlueprint({
        context: {
          projectContextVersionId: `context-038-${index + 1}`,
          projectSettingsVersionId: `settings-038-${index + 1}`,
          projectSettingsVersion: index + 1,
          canonicalDomain: `${fixture.slug}038.com`,
          countries: [fixture.country],
          languages: [fixture.language],
          products: [fixture.product],
          keywords: [fixture.keyword],
          promotionTargetUrls: [
            `https://${fixture.slug}038.com/targets/${fixture.slug}`,
          ],
          declaredTargetAudiences: [fixture.audience],
          partnershipGoals: [fixture.goal],
          explicitCompetitorDomains: [
            `${fixture.slug}-competitor.com`,
          ],
          historicalFeedbackDomains: [
            `${fixture.slug}-approved.com`,
          ],
          evidenceRefs: [`project-context:038:${index + 1}`],
        },
      })
    );

    expect(new Set(
      blueprints.map((blueprint) => blueprint.inputSummary.fingerprint),
    ).size).toBe(fixtures.length);

    for (const [index, blueprint] of blueprints.entries()) {
      const fixture = fixtures[index];
      expect(blueprint.generationMode).toBe("DETERMINISTIC_FALLBACK");
      expect(blueprint.fallbackReason).toBe("AI_NOT_CONFIGURED");
      expect(blueprint.canonicalDomain).toBe(`${fixture.slug}038.com`);
      expect(blueprint.discoveryInputs).toMatchObject({
        countries: [fixture.country],
        languages: [fixture.language],
        products: [fixture.product],
        keywords: [fixture.keyword],
        promotionTargetUrls: [
          `https://${fixture.slug}038.com/targets/${fixture.slug}`,
        ],
        declaredTargetAudiences: [fixture.audience],
        partnershipGoals: [fixture.goal],
        explicitCompetitorDomains: [
          `${fixture.slug}-competitor.com`,
        ],
        historicalFeedbackDomains: [
          `${fixture.slug}-approved.com`,
        ],
      });

      const serialized = JSON.stringify(blueprint);
      for (const other of fixtures.filter((_, otherIndex) =>
        otherIndex !== index
      )) {
        expect(serialized).not.toContain(`${other.slug}038.com`);
        expect(serialized).not.toContain(other.product);
        expect(serialized).not.toContain(other.keyword);
      }

      const replay = buildCommercialDiscoveryBlueprint({
        context: {
          projectContextVersionId: `context-038-${index + 1}`,
          projectSettingsVersionId: `settings-038-${index + 1}`,
          projectSettingsVersion: index + 1,
          canonicalDomain: `${fixture.slug}038.com`,
          countries: [fixture.country],
          languages: [fixture.language],
          products: [fixture.product],
          keywords: [fixture.keyword],
          promotionTargetUrls: [
            `https://${fixture.slug}038.com/targets/${fixture.slug}`,
          ],
          declaredTargetAudiences: [fixture.audience],
          partnershipGoals: [fixture.goal],
          explicitCompetitorDomains: [
            `${fixture.slug}-competitor.com`,
          ],
          historicalFeedbackDomains: [
            `${fixture.slug}-approved.com`,
          ],
          evidenceRefs: [`project-context:038:${index + 1}`],
        },
      });
      expect(replay.inputSummary).toEqual(blueprint.inputSummary);
      expect(replay.discoveryInputs).toEqual(blueprint.discoveryInputs);
    }
  });
});
