"""Move shared-platform tables to their owned schemas.

Revision ID: 20260724_0007
Revises: 20260722_0006
Create Date: 2026-07-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260724_0007"
down_revision: str | Sequence[str] | None = "20260722_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE public.projects SET SCHEMA platform;
        ALTER TABLE public.site_profiles SET SCHEMA platform;

        ALTER TABLE public.crawl_runs SET SCHEMA crawling;
        ALTER TABLE public.pages SET SCHEMA crawling;
        ALTER TABLE public.page_snapshots SET SCHEMA crawling;
        ALTER TABLE public.link_edges SET SCHEMA crawling;
        ALTER TABLE public.backlink_checks SET SCHEMA crawling;
        ALTER TABLE public.crawl_checkpoints SET SCHEMA crawling;
        ALTER TABLE public.external_resources SET SCHEMA crawling;

        ALTER TABLE public.audit_issues SET SCHEMA audit;
        ALTER TABLE public.pagespeed_results SET SCHEMA audit;

        ALTER TABLE platform.projects OWNER TO growthos_platform_owner;
        ALTER TABLE platform.site_profiles OWNER TO growthos_platform_owner;

        ALTER TABLE crawling.crawl_runs OWNER TO growthos_crawling_owner;
        ALTER TABLE crawling.pages OWNER TO growthos_crawling_owner;
        ALTER TABLE crawling.page_snapshots OWNER TO growthos_crawling_owner;
        ALTER TABLE crawling.link_edges OWNER TO growthos_crawling_owner;
        ALTER TABLE crawling.backlink_checks OWNER TO growthos_crawling_owner;
        ALTER TABLE crawling.crawl_checkpoints OWNER TO growthos_crawling_owner;
        ALTER TABLE crawling.external_resources OWNER TO growthos_crawling_owner;

        ALTER TABLE audit.audit_issues OWNER TO growthos_audit_owner;
        ALTER TABLE audit.pagespeed_results OWNER TO growthos_audit_owner;

        ALTER SEQUENCE crawling.pages_id_seq OWNER TO growthos_crawling_owner;
        ALTER SEQUENCE crawling.link_edges_id_seq
          OWNER TO growthos_crawling_owner;
        ALTER SEQUENCE crawling.external_resources_id_seq
          OWNER TO growthos_crawling_owner;
        ALTER SEQUENCE audit.audit_issues_id_seq OWNER TO growthos_audit_owner;
        ALTER SEQUENCE audit.pagespeed_results_id_seq
          OWNER TO growthos_audit_owner;

        REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA platform FROM PUBLIC;
        REVOKE ALL ON ALL TABLES IN SCHEMA crawling FROM PUBLIC;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA crawling FROM PUBLIC;
        REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA audit FROM PUBLIC;

        GRANT USAGE ON SCHEMA platform TO growthos_platform_writer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform
          TO growthos_platform_writer;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform
          TO growthos_platform_writer;

        GRANT USAGE ON SCHEMA crawling TO growthos_crawling_writer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crawling
          TO growthos_crawling_writer;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA crawling
          TO growthos_crawling_writer;

        GRANT USAGE ON SCHEMA audit TO growthos_audit_writer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA audit
          TO growthos_audit_writer;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit
          TO growthos_audit_writer;

        GRANT USAGE ON SCHEMA platform TO growthos_crawling_writer;
        GRANT SELECT ON ALL TABLES IN SCHEMA platform
          TO growthos_crawling_writer;
        GRANT USAGE ON SCHEMA crawling TO growthos_audit_writer;
        GRANT SELECT ON ALL TABLES IN SCHEMA crawling
          TO growthos_audit_writer;

        GRANT USAGE ON SCHEMA platform, crawling, audit
          TO growthos_reporting_reader;
        GRANT SELECT ON ALL TABLES IN SCHEMA platform, crawling, audit
          TO growthos_reporting_reader;

        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_platform_owner
          IN SCHEMA platform REVOKE ALL ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_platform_owner
          IN SCHEMA platform REVOKE ALL ON SEQUENCES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_platform_owner
          IN SCHEMA platform
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
          TO growthos_platform_writer;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_platform_owner
          IN SCHEMA platform
          GRANT USAGE, SELECT ON SEQUENCES TO growthos_platform_writer;

        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_crawling_owner
          IN SCHEMA crawling REVOKE ALL ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_crawling_owner
          IN SCHEMA crawling REVOKE ALL ON SEQUENCES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_crawling_owner
          IN SCHEMA crawling
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
          TO growthos_crawling_writer;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_crawling_owner
          IN SCHEMA crawling
          GRANT USAGE, SELECT ON SEQUENCES TO growthos_crawling_writer;

        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_audit_owner
          IN SCHEMA audit REVOKE ALL ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_audit_owner
          IN SCHEMA audit REVOKE ALL ON SEQUENCES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_audit_owner
          IN SCHEMA audit
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
          TO growthos_audit_writer;
        ALTER DEFAULT PRIVILEGES FOR ROLE growthos_audit_owner
          IN SCHEMA audit
          GRANT USAGE, SELECT ON SEQUENCES TO growthos_audit_writer;

        ALTER TABLE platform.projects ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.projects FORCE ROW LEVEL SECURITY;
        ALTER TABLE platform.site_profiles ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.site_profiles FORCE ROW LEVEL SECURITY;

        ALTER TABLE crawling.crawl_runs ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.crawl_runs FORCE ROW LEVEL SECURITY;
        ALTER TABLE crawling.pages ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.pages FORCE ROW LEVEL SECURITY;
        ALTER TABLE crawling.page_snapshots ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.page_snapshots FORCE ROW LEVEL SECURITY;
        ALTER TABLE crawling.link_edges ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.link_edges FORCE ROW LEVEL SECURITY;
        ALTER TABLE crawling.backlink_checks ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.backlink_checks FORCE ROW LEVEL SECURITY;
        ALTER TABLE crawling.crawl_checkpoints ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.crawl_checkpoints FORCE ROW LEVEL SECURITY;
        ALTER TABLE crawling.external_resources ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.external_resources FORCE ROW LEVEL SECURITY;

        ALTER TABLE audit.audit_issues ENABLE ROW LEVEL SECURITY;
        ALTER TABLE audit.audit_issues FORCE ROW LEVEL SECURITY;
        ALTER TABLE audit.pagespeed_results ENABLE ROW LEVEL SECURITY;
        ALTER TABLE audit.pagespeed_results FORCE ROW LEVEL SECURITY;

        CREATE POLICY platform_projects_tenant_policy
          ON platform.projects
          USING (
            organization_id =
              NULLIF(
                current_setting('app.current_organization_id', true),
                ''
              )
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          )
          WITH CHECK (
            organization_id =
              NULLIF(
                current_setting('app.current_organization_id', true),
                ''
              )
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          );

        CREATE POLICY platform_site_profiles_tenant_policy
          ON platform.site_profiles
          USING (
            EXISTS (
              SELECT 1
              FROM platform.projects
              WHERE projects.id = site_profiles.project_id
                AND projects.organization_id =
                  NULLIF(
                    current_setting('app.current_organization_id', true),
                    ''
                  )
                AND (
                  NULLIF(
                    current_setting('app.current_project_id', true),
                    ''
                  ) IS NULL
                  OR projects.id =
                    NULLIF(
                      current_setting('app.current_project_id', true),
                      ''
                    )
                )
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM platform.projects
              WHERE projects.id = site_profiles.project_id
                AND projects.organization_id =
                  NULLIF(
                    current_setting('app.current_organization_id', true),
                    ''
                  )
                AND (
                  NULLIF(
                    current_setting('app.current_project_id', true),
                    ''
                  ) IS NULL
                  OR projects.id =
                    NULLIF(
                      current_setting('app.current_project_id', true),
                      ''
                    )
                )
            )
          );

        CREATE POLICY crawling_crawl_runs_tenant_policy
          ON crawling.crawl_runs
          USING (
            organization_id =
              NULLIF(
                current_setting('app.current_organization_id', true),
                ''
              )
            AND project_id =
              NULLIF(current_setting('app.current_project_id', true), '')
          )
          WITH CHECK (
            organization_id =
              NULLIF(
                current_setting('app.current_organization_id', true),
                ''
              )
            AND project_id =
              NULLIF(current_setting('app.current_project_id', true), '')
          );

        CREATE POLICY crawling_pages_tenant_policy
          ON crawling.pages
          USING (
            organization_id =
              NULLIF(
                current_setting('app.current_organization_id', true),
                ''
              )
            AND project_id =
              NULLIF(current_setting('app.current_project_id', true), '')
          )
          WITH CHECK (
            organization_id =
              NULLIF(
                current_setting('app.current_organization_id', true),
                ''
              )
            AND project_id =
              NULLIF(current_setting('app.current_project_id', true), '')
          );

        CREATE POLICY crawling_page_snapshots_tenant_policy
          ON crawling.page_snapshots
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = page_snapshots.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = page_snapshots.run_id
            )
          );

        CREATE POLICY crawling_link_edges_tenant_policy
          ON crawling.link_edges
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = link_edges.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = link_edges.run_id
            )
          );

        CREATE POLICY crawling_backlink_checks_tenant_policy
          ON crawling.backlink_checks
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = backlink_checks.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = backlink_checks.run_id
            )
          );

        CREATE POLICY crawling_checkpoints_tenant_policy
          ON crawling.crawl_checkpoints
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = crawl_checkpoints.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = crawl_checkpoints.run_id
            )
          );

        CREATE POLICY crawling_external_resources_tenant_policy
          ON crawling.external_resources
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = external_resources.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = external_resources.run_id
            )
          );

        CREATE POLICY audit_issues_tenant_policy
          ON audit.audit_issues
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = audit_issues.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = audit_issues.run_id
            )
          );

        CREATE POLICY audit_pagespeed_results_tenant_policy
          ON audit.pagespeed_results
          USING (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = pagespeed_results.run_id
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = pagespeed_results.run_id
            )
          );
        """
    )


def downgrade() -> None:
    raise RuntimeError("20260724_0007 is forward-only; restore a verified backup to roll back")
