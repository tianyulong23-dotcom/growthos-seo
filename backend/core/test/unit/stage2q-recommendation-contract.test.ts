import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = async (relativePath: string) =>
  readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

describe("STAGE2Q recommendation production contract", () => {
  it("does not require target URLs when products or promotion semantics exist", async () => {
    const [inventoryRefill, supplyOperation] = await Promise.all([
      source(
        "src/modules/backlinks/application/services/commercial-inventory-refill.service.ts",
      ),
      source(
        "src/modules/backlinks/application/services/commercial-supply-operation.service.ts",
      ),
    ]);

    for (const text of [inventoryRefill, supplyOperation]) {
      expect(text).not.toMatch(
        /jsonb_array_length\(context\.target_urls\)>0/,
      );
      expect(text).toMatch(
        /jsonb_array_length\(context\.(products|keywords)\)>0/,
      );
    }
  });

  it("keeps an active visible pool active while an explicit refill appends work", async () => {
    const [command, discovery, evaluation] = await Promise.all([
      source(
        "src/modules/backlinks/application/commands/recommendations.command.ts",
      ),
      source(
        "src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts",
      ),
      source(
        "src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.ts",
      ),
    ]);

    expect(command).toContain(
      "visible_pool_state IN ('idle','building','active','awaiting_refresh')",
    );
    expect(command).toContain(
      "visible_pool_state=CASE WHEN policy.visible_pool_state='active' THEN 'active' ELSE 'building' END",
    );
    expect(discovery).toMatch(
      /project_context_version_id,visible_pool_generation,\s*canonical_domain,score_model_version\s*\)\s*DO UPDATE/,
    );
    expect(evaluation).toContain("existing_backlink_or_opportunity");
  });

  it("validates active discovery work against the corrected V4 generation contract", async () => {
    const discovery = await source(
      "src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts",
    );

    expect(
      discovery.match(/\$\{currentV4VisiblePoolPredicate\}/g),
    ).toHaveLength(3);
    expect(
      discovery.match(/policy\.visible_pool_state='active'/g),
    ).toHaveLength(1);
    expect(discovery).toContain(
      "FROM backlink_recommendation_generation_contracts AS contract",
    );
    for (const contractVersion of [
      "recommendation-qualification.v1",
      "recommendation-visibility.v1",
      "recommendation-commercial-fit.v4",
    ]) {
      expect(discovery.split(contractVersion)).toHaveLength(2);
    }
  });

  it("keeps the last visible generation readable during a V4 contract recalculation", async () => {
    const query = await source(
      "src/modules/backlinks/application/queries/recommendations.query.ts",
    );

    expect(query).toContain("visible_generation_candidates");
    expect(query).toContain("last_visible_generation");
    expect(query).toContain("'legacy_stale'");
    expect(query).toContain("'recommendation-commercial-fit.v3'");
    expect(query).toContain("recommendation-commercial-fit.v4");
    expect(query).toContain(
      "visible_generation.presentation_state='legacy_stale'",
    );
    expect(query).toContain(
      "visible_generation.score_model_version=i.fit_score_model_version",
    );
    expect(query).toContain("model_priority DESC");
  });

  it("counts only currently published V4 recommendations as visible matches", async () => {
    const query = await source(
      "src/modules/backlinks/application/queries/recommendations.query.ts",
    );

    expect(query).toMatch(
      /COALESCE\(publication_counts\.published_count,0\)\s+"visibleMatchCount"/,
    );
    expect(query).not.toContain(
      "ELSE COALESCE(corrected_visibility_counts.visible_count,0)",
    );
  });

  it("does not couple same-pool append to opportunity, mail, or placement state", async () => {
    const command = await source(
      "src/modules/backlinks/application/commands/recommendations.command.ts",
    );
    const refillSection = command.slice(
      command.indexOf("requestRecommendationRefill"),
      command.indexOf("archiveRecommendationPool"),
    );

    expect(refillSection).not.toContain("backlink_opportunities");
    expect(refillSection).not.toContain("backlink_mail");
    expect(refillSection).not.toContain("backlink_placements");
  });
});
