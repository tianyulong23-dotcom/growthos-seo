import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import {
  calculateResourceAuthorityScore,
} from "../src/modules/backlinks/domain/recommendations/resource-library-authority.js";

type ResourceRecord = Readonly<Record<string, unknown>>;

const prohibitedKeyTokens = [
  "apikey",
  "credential",
  "password",
  "secret",
  "suppliercontact",
  "suppliernote",
  "supplierprice",
  "token",
] as const;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required argument ${name}`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).trim().replaceAll(",", "")
    .match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?$/iu);
  if (match === null) return null;
  const base = Number(match[1]);
  const multiplier = match[2]?.toUpperCase() === "K"
    ? 1_000
    : match[2]?.toUpperCase() === "M"
      ? 1_000_000
      : match[2]?.toUpperCase() === "B"
        ? 1_000_000_000
        : 1;
  return Number.isFinite(base) ? base * multiplier : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeGeneratedAt(value: unknown): string {
  const normalized = String(value ?? "").trim();
  const compactDate = /^(\d{4})(\d{2})(\d{2})$/u.exec(normalized);
  const candidate = compactDate === null
    ? normalized
    : `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}T00:00:00.000Z`;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Resource library manifest generatedAt is invalid");
  }
  return new Date(timestamp).toISOString();
}

function assertSanitized(value: unknown, path = "resource"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSanitized(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
    if (prohibitedKeyTokens.some((token) => normalizedKey.includes(token))) {
      throw new Error(`Resource library contains prohibited field: ${path}.${key}`);
    }
    assertSanitized(nested, `${path}.${key}`);
  }
}

async function main(): Promise<void> {
  const databaseUrlFile = resolve(argument("--database-url-file"));
  const resourcesPath = resolve(
    process.argv.includes("--resources")
      ? argument("--resources")
      : "resources/resource-library/20260728/resources.json",
  );
  const manifestPath = resolve(
    process.argv.includes("--manifest")
      ? argument("--manifest")
      : "resources/resource-library/20260728/manifest.json",
  );
  const organizationId = argument("--organization-id");
  const workspaceId = argument("--workspace-id");
  const actorId = argument("--actor-id");
  const [databaseUrl, resourcesText, manifestText] = await Promise.all([
    readFile(databaseUrlFile, "utf8"),
    readFile(resourcesPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  const resources = JSON.parse(resourcesText) as ResourceRecord[];
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const generatedAt = normalizeGeneratedAt(
    manifest.generatedAt ?? manifest.generated_at,
  );
  const sourceHash = createHash("sha256")
    .update(resourcesText, "utf8")
    .digest("hex");
  const expectedHash = (
    manifest.files as Record<string, Record<string, unknown>> | undefined
  )?.["resources.json"]?.sha256;
  if (sourceHash !== expectedHash) {
    throw new Error("Resource library resources.json hash mismatch");
  }
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error("Resource library is empty");
  }
  assertSanitized(resources);
  const pool = new pg.Pool({
    connectionString: databaseUrl.trim(),
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.current_organization_id',$1,true),
              set_config('app.current_workspace_id',$2,true),
              set_config('app.current_website_project_id','',true)`,
      [organizationId, workspaceId],
    );
    for (const resource of resources) {
      const domain = String(resource.domain ?? "").trim().toLowerCase();
      const url = String(resource.url ?? `https://${domain}`).trim();
      const qualityBucket = ["recommend", "review", "avoid"].includes(
          String(resource.qualityBucket),
        )
        ? String(resource.qualityBucket)
        : "unclassified";
      const profileHealthScore = nullableNumber(resource.profileHealthScore);
      const dataForSeoRank = nullableNumber(resource.dataforseoRank);
      const referringDomains = nullableNumber(resource.referringDomains);
      const authorityScore = calculateResourceAuthorityScore({
        profileHealthScore,
        dataForSeoRank,
        referringDomains,
      });
      const categories = [
        ...stringList(resource.resourceCategories),
        ...stringList(resource.category === undefined
          ? []
          : [resource.category]),
        ...stringList(resource.resourceCategory === undefined
          ? []
          : [resource.resourceCategory]),
      ];
      await client.query(
        `INSERT INTO backlink_resource_library_items (
           id,organization_id,workspace_id,resource_key,canonical_domain,
           canonical_url,website_name,resource_type,categories,tags,
           country_language,domain_authority,monthly_organic_traffic,
           dataforseo_rank,spam_score,profile_health_score,authority_score,
           quality_bucket,quality_reviewed,risk_level,recommendation,
           referring_domains,backlinks,active,source_bundle_sha256,
           source_generated_at,raw_resource,created_by,updated_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,
           $15,$16,$17,$18,$19,$20,$21,$22,$23,true,$24,$25,$26::jsonb,
           $27,$27
         )
         ON CONFLICT (organization_id,workspace_id,resource_key)
         DO UPDATE SET
           canonical_domain=EXCLUDED.canonical_domain,
           canonical_url=EXCLUDED.canonical_url,
           website_name=EXCLUDED.website_name,
           resource_type=EXCLUDED.resource_type,
           categories=EXCLUDED.categories,
           tags=EXCLUDED.tags,
           country_language=EXCLUDED.country_language,
           domain_authority=EXCLUDED.domain_authority,
           monthly_organic_traffic=EXCLUDED.monthly_organic_traffic,
           dataforseo_rank=EXCLUDED.dataforseo_rank,
           spam_score=EXCLUDED.spam_score,
           profile_health_score=EXCLUDED.profile_health_score,
           authority_score=EXCLUDED.authority_score,
           quality_bucket=EXCLUDED.quality_bucket,
           quality_reviewed=EXCLUDED.quality_reviewed,
           risk_level=EXCLUDED.risk_level,
           recommendation=EXCLUDED.recommendation,
           referring_domains=EXCLUDED.referring_domains,
           backlinks=EXCLUDED.backlinks,
           active=true,
           source_bundle_sha256=EXCLUDED.source_bundle_sha256,
           source_generated_at=EXCLUDED.source_generated_at,
           raw_resource=EXCLUDED.raw_resource,
           updated_at=now(),updated_by=EXCLUDED.updated_by,
           version=backlink_resource_library_items.version+1`,
        [
          randomUUID(),
          organizationId,
          workspaceId,
          String(resource.key),
          domain,
          url,
          String(resource.websiteName ?? domain),
          String(resource.resourceType) === "paid" ? "paid" : "free",
          JSON.stringify([...new Set(categories)]),
          JSON.stringify(stringList(resource.tags)),
          resource.countryLanguage ?? null,
          nullableNumber(resource.domainAuthority),
          nullableNumber(resource.monthlyOrganicTraffic),
          dataForSeoRank,
          nullableNumber(resource.spamScore),
          profileHealthScore,
          authorityScore,
          qualityBucket,
          resource.qualityReviewed === true,
          resource.riskLevel ?? null,
          resource.recommendation ?? null,
          referringDomains,
          nullableNumber(resource.backlinks),
          sourceHash,
          generatedAt,
          JSON.stringify(resource),
          actorId,
        ],
      );
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({
      imported: resources.length,
      sourceSha256: sourceHash,
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
