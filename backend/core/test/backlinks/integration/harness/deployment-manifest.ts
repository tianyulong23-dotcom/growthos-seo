import { readFile } from "node:fs/promises";

import { applyBacklinksDeploymentManifest } from "../../../../src/modules/backlinks/db/deployment-manifest-runner.mjs";

type MigrationClient = Readonly<{
  query(sql: string): Promise<unknown>;
}>;

const rolesUrl = new URL(
  "../../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);

const platformProjectAuthoritySql = `
  SET ROLE growthos_platform_owner;
  SET search_path = platform, pg_catalog;
  CREATE TABLE projects (id text PRIMARY KEY);
  CREATE FUNCTION backlink_list_active_website_projects(text, text)
  RETURNS TABLE (website_project_id text, context_version integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = platform, pg_catalog
  AS $function$ SELECT NULL::text, NULL::integer WHERE false; $function$;
  REVOKE ALL
    ON FUNCTION backlink_list_active_website_projects(text, text)
    FROM PUBLIC;
  GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
  GRANT EXECUTE
    ON FUNCTION backlink_list_active_website_projects(text, text)
    TO growthos_backlinks_owner;
  RESET ROLE;
  RESET search_path;
`;

export async function installBacklinksManifestAfterFoundation(
  client: MigrationClient,
  targetRevision = "0095",
): Promise<void> {
  await client.query(await readFile(rolesUrl, "utf8"));
  await client.query(platformProjectAuthoritySql);
  await applyBacklinksDeploymentManifest({
    query: (sql) => client.query(sql),
    startRevision: "0002",
    targetRevision,
  });
}
