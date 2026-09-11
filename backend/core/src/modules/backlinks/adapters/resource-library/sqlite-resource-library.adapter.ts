import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";
import { excludedOutreachTarget } from "../../domain/recommendations/outreach-target-policy.js";
import {
  ResourceLibraryError,
  type ResourceLibraryMatchInput,
  type ResourceLibraryPort,
  type ResourceLibraryPublisher,
} from "../../ports/resource-library.port.js";

const languages: Readonly<Record<string, string>> = {
  en: "English", de: "German", fr: "French", es: "Spanish",
  pt: "Portuguese", it: "Italian", uk: "Ukrainian", nl: "Dutch",
  pl: "Polish", ru: "Russian", tr: "Turkish", zh: "Chinese", ja: "Japanese",
};
const categoryAliases: Readonly<Record<string, readonly string[]>> = {
  "Home and Family": ["home", "family", "garden", "pool", "cleaning", "furniture"],
  Technology: ["technology", "software", "saas", "electronics", "robotic", "cybersecurity"],
  Health: ["health", "medical", "fitness", "wellness"],
  Fashion: ["fashion", "apparel", "clothing", "silk"],
  Business: ["business", "marketing", "commerce"],
  Finance: ["finance", "banking", "insurance"],
  Education: ["education", "learning", "school"],
  Automobiles: ["automobile", "automotive", "car"],
  Travelling: ["travelling", "travel", "tourism"],
  Entertainment: ["entertainment", "gaming", "cinema"],
};

function categoriesFor(topics: readonly string[]) {
  const normalized = topics.map((topic) => topic.trim().toLowerCase());
  return Object.entries(categoryAliases)
    .filter(([category, aliases]) => normalized.some((topic) =>
      topic === category.toLowerCase() || aliases.some((alias) =>
        new RegExp(`\\b${alias}\\b`, "u").test(topic))))
    .map(([category]) => category);
}

export function resourceLibraryDrPolicy(dr: number) {
  if (!Number.isFinite(dr) || dr < 0 || dr > 100) throw new TypeError("Project DR is invalid");
  if (dr < 20) return { minimum: 0, preferredMaximum: 30, highRatio: 0.1 };
  if (dr < 40) return { minimum: 10, preferredMaximum: 50, highRatio: 0.2 };
  if (dr < 60) return { minimum: 25, preferredMaximum: 60, highRatio: 0.3 };
  return { minimum: 40, preferredMaximum: 60, highRatio: 0.4 };
}

export function createSqliteResourceLibraryAdapter(path: string): ResourceLibraryPort {
  return Object.freeze({
    async match(input: ResourceLibraryMatchInput): Promise<readonly ResourceLibraryPublisher[]> {
      if (!isAbsolute(path)) throw new ResourceLibraryError("RESOURCE_LIBRARY_UNAVAILABLE");
      if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 1_000) {
        throw new TypeError("Resource library limit must be between 0 and 1000");
      }
      const policy = resourceLibraryDrPolicy(input.projectDr);
      if (input.limit === 0) return [];
      const language = languages[input.language.toLowerCase().replace("_", "-").split("-")[0] ?? ""]
        ?? Object.values(languages).find((value) => value.toLowerCase() === input.language.toLowerCase());
      if (language === undefined) throw new ResourceLibraryError("RESOURCE_LIBRARY_LANGUAGE_UNSUPPORTED");
      const related = categoriesFor(input.topics);
      const adjacent = related.length > 0 ? ["Lifestyle", "General", "All Niches"] : [];
      const excluded = new Set(input.excludedDomains.map((value) =>
        createRecommendationDomainKey(value).registrableDomain));
      excluded.add(createRecommendationDomainKey(input.projectDomain).registrableDomain);
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
        // Qualification and canonical dedup happen inside SQL before each bounded LIMIT.
        db.function("canonical_key", { deterministic: true }, (value) => {
          try {
            return createRecommendationDomainKey(String(value)).registrableDomain;
          } catch { return null; }
        });
        db.function("allowed_domain", { deterministic: true }, (value) => {
          if (value === null) return 0;
          const domain = String(value);
          return !excluded.has(domain) && excludedOutreachTarget(domain) === null ? 1 : 0;
        });
        const query = db.prepare(`
          WITH qualified AS (
            SELECT canonical_key(domain) canonical_domain, ahrefs_dr, monthly_traffic,
                   categories_json,
                   CASE WHEN EXISTS (
                     SELECT 1 FROM json_each(categories_json) c
                     WHERE c.value IN (SELECT value FROM json_each(?))
                   ) THEN 0 ELSE 1 END category_priority
            FROM publishers
            WHERE language=? AND ahrefs_dr>=? AND ahrefs_dr<? AND ahrefs_dr<=100
              AND allowed_domain(canonical_key(domain))=1
              AND json_valid(categories_json)
              AND (?=0 OR EXISTS (
                SELECT 1 FROM json_each(categories_json) c
                WHERE c.value IN (SELECT value FROM json_each(?))
              ))
          ), ranked AS (
            SELECT *, row_number() OVER (
              PARTITION BY canonical_domain ORDER BY category_priority,
                ahrefs_dr DESC, monthly_traffic DESC, categories_json
            ) domain_position FROM qualified
          )
          SELECT * FROM ranked WHERE domain_position=1
          ORDER BY category_priority, CASE WHEN ahrefs_dr>=? AND ahrefs_dr<? THEN 0 ELSE 1 END,
                   ahrefs_dr DESC, monthly_traffic DESC, canonical_domain
          LIMIT ?`);
        const read = (minimum: number, maximum: number) => query.all(
          JSON.stringify(related), language, minimum, maximum, related.length,
          JSON.stringify([...related, ...adjacent]), policy.minimum, policy.preferredMaximum, input.limit,
        ).map((row): ResourceLibraryPublisher => ({
          canonicalDomain: String(row.canonical_domain),
          websiteUrl: `https://${String(row.canonical_domain)}/`,
          ahrefsDr: Number(row.ahrefs_dr),
          monthlyTraffic: row.monthly_traffic === null ? null : Number(row.monthly_traffic),
          language,
          categories: (JSON.parse(String(row.categories_json)) as unknown[]).filter(
            (value): value is string => typeof value === "string"),
          categoryMatch: related.length === 0 ? "UNCONFIRMED"
            : Number(row.category_priority) === 0 ? "RELATED" : "ADJACENT",
        }));
        const low = read(input.projectDr < 40 ? 0 : policy.minimum, 60);
        const high = read(60, 101);
        // The ratio denominator is actual selected supply, not the requested limit.
        let total = Math.min(input.limit, low.length + high.length);
        while (total > 0 && low.length + Math.min(high.length, Math.floor(total * policy.highRatio)) < total) {
          total -= 1;
        }
        const highCount = Math.min(high.length, Math.floor(total * policy.highRatio));
        return [...low.slice(0, total - highCount), ...high.slice(0, highCount)];
      } catch {
        throw new ResourceLibraryError("RESOURCE_LIBRARY_UNAVAILABLE");
      } finally {
        db?.close();
      }
    },
  });
}
