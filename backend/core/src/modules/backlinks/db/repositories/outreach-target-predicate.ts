import { nonOutreachTargetDomains } from "../../domain/recommendations/outreach-target-policy.js";

// Only internal column identifiers and the static policy registry enter SQL.
export function allowedOutreachTargetSql(
  column: "item.canonical_domain" | "authority.canonical_domain",
): string {
  const domains = nonOutreachTargetDomains
    .map((domain) => `'${domain.replaceAll("'", "''")}'`)
    .join(",");
  const normalized = `lower(rtrim(btrim(${column}),'.'))`;
  return `NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[${domains}]::text[]) AS blocked(domain)
     WHERE ${normalized}=blocked.domain
        OR right(${normalized},length(blocked.domain)+1)='.' || blocked.domain
  )`;
}
