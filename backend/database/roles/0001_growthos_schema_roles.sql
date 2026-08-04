DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'growthos_platform_owner',
    'growthos_platform_writer',
    'growthos_audit_owner',
    'growthos_audit_writer',
    'growthos_crawling_owner',
    'growthos_crawling_writer',
    'growthos_keywords_owner',
    'growthos_keywords_writer',
    'growthos_content_owner',
    'growthos_content_writer',
    'growthos_backlinks_owner',
    'growthos_backlinks_writer',
    'growthos_reporting_owner',
    'growthos_reporting_reader',
    'growthos_gateway'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I WITH NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE ' ||
      'NOLOGIN NOREPLICATION NOBYPASSRLS',
      role_name
    );
  END LOOP;
END;
$roles$;

CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION growthos_platform_owner;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION growthos_audit_owner;
CREATE SCHEMA IF NOT EXISTS crawling AUTHORIZATION growthos_crawling_owner;
CREATE SCHEMA IF NOT EXISTS keywords AUTHORIZATION growthos_keywords_owner;
CREATE SCHEMA IF NOT EXISTS content AUTHORIZATION growthos_content_owner;
CREATE SCHEMA IF NOT EXISTS backlinks AUTHORIZATION growthos_backlinks_owner;
CREATE SCHEMA IF NOT EXISTS reporting AUTHORIZATION growthos_reporting_owner;

ALTER SCHEMA platform OWNER TO growthos_platform_owner;
ALTER SCHEMA audit OWNER TO growthos_audit_owner;
ALTER SCHEMA crawling OWNER TO growthos_crawling_owner;
ALTER SCHEMA keywords OWNER TO growthos_keywords_owner;
ALTER SCHEMA content OWNER TO growthos_content_owner;
ALTER SCHEMA backlinks OWNER TO growthos_backlinks_owner;
ALTER SCHEMA reporting OWNER TO growthos_reporting_owner;

REVOKE ALL ON SCHEMA
  platform, audit, crawling, keywords, content, backlinks, reporting
  FROM PUBLIC;

GRANT USAGE ON SCHEMA platform TO growthos_platform_writer;
GRANT USAGE ON SCHEMA audit TO growthos_audit_writer;
GRANT USAGE ON SCHEMA crawling TO growthos_crawling_writer;
GRANT USAGE ON SCHEMA keywords TO growthos_keywords_writer;
GRANT USAGE ON SCHEMA content TO growthos_content_writer;
GRANT USAGE ON SCHEMA backlinks TO growthos_backlinks_writer;
GRANT USAGE ON SCHEMA reporting TO growthos_reporting_reader;

ALTER ROLE growthos_platform_owner SET search_path = platform, pg_catalog;
ALTER ROLE growthos_platform_writer SET search_path = platform, pg_catalog;
ALTER ROLE growthos_audit_owner SET search_path = audit, pg_catalog;
ALTER ROLE growthos_audit_writer SET search_path = audit, crawling, pg_catalog;
ALTER ROLE growthos_crawling_owner SET search_path = crawling, pg_catalog;
ALTER ROLE growthos_crawling_writer SET search_path = crawling, platform, pg_catalog;
ALTER ROLE growthos_keywords_owner SET search_path = keywords, pg_catalog;
ALTER ROLE growthos_keywords_writer SET search_path = keywords, pg_catalog;
ALTER ROLE growthos_content_owner SET search_path = content, pg_catalog;
ALTER ROLE growthos_content_writer SET search_path = content, pg_catalog;
ALTER ROLE growthos_backlinks_owner SET search_path = backlinks, pg_catalog;
ALTER ROLE growthos_backlinks_writer SET search_path = backlinks, pg_catalog;
ALTER ROLE growthos_reporting_owner SET search_path = reporting, pg_catalog;
ALTER ROLE growthos_reporting_reader
  SET search_path = reporting, platform, audit, crawling, backlinks, pg_catalog;
ALTER ROLE growthos_gateway SET search_path = pg_catalog;
