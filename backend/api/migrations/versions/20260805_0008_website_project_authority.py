"""Add multi-project authority and immutable Website Project versions.

Revision ID: 20260805_0008
Revises: 20260724_0007
Create Date: 2026-08-05
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260805_0008"
down_revision: str | Sequence[str] | None = "20260724_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE platform.projects
          ADD COLUMN workspace_id text,
          ADD COLUMN project_key text,
          ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
          ADD COLUMN archived_at timestamptz,
          ADD COLUMN target_market text,
          ADD COLUMN context_version integer NOT NULL DEFAULT 1,
          ADD COLUMN current_profile_version_id text,
          ADD COLUMN current_promotion_target_version_id text;

        UPDATE platform.projects
           SET project_key = id,
               target_market = country
         WHERE project_key IS NULL OR target_market IS NULL;

        ALTER TABLE platform.projects
          ALTER COLUMN project_key SET NOT NULL,
          ALTER COLUMN target_market SET NOT NULL,
          ADD CONSTRAINT projects_status_check
            CHECK (status IN ('ACTIVE', 'ARCHIVED')),
          ADD CONSTRAINT projects_context_version_check
            CHECK (context_version > 0),
          ADD CONSTRAINT uq_projects_organization_project_key
            UNIQUE (organization_id, project_key);

        CREATE INDEX ix_projects_workspace_id
          ON platform.projects (workspace_id);
        CREATE INDEX ix_projects_active_workspace
          ON platform.projects (organization_id, workspace_id, updated_at DESC)
          WHERE status = 'ACTIVE';

        CREATE TABLE platform.website_profile_versions (
          id text PRIMARY KEY,
          organization_id text NOT NULL,
          workspace_id text NOT NULL,
          project_id text NOT NULL
            REFERENCES platform.projects(id) ON DELETE RESTRICT,
          version integer NOT NULL CHECK (version > 0),
          name text NOT NULL,
          canonical_domain text NOT NULL,
          country_code text NOT NULL,
          target_market text NOT NULL,
          locale text NOT NULL,
          products jsonb NOT NULL,
          input_required jsonb NOT NULL,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_website_profile_versions_scope_version
            UNIQUE (organization_id, workspace_id, project_id, version),
          CONSTRAINT website_profile_versions_products_array
            CHECK (jsonb_typeof(products) = 'array'),
          CONSTRAINT website_profile_versions_input_required_array
            CHECK (jsonb_typeof(input_required) = 'array')
        );

        CREATE TABLE platform.promotion_target_versions (
          id text PRIMARY KEY,
          organization_id text NOT NULL,
          workspace_id text NOT NULL,
          project_id text NOT NULL
            REFERENCES platform.projects(id) ON DELETE RESTRICT,
          version integer NOT NULL CHECK (version > 0),
          keywords jsonb NOT NULL,
          target_urls jsonb NOT NULL,
          input_required jsonb NOT NULL,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_promotion_target_versions_scope_version
            UNIQUE (organization_id, workspace_id, project_id, version),
          CONSTRAINT promotion_target_versions_keywords_array
            CHECK (jsonb_typeof(keywords) = 'array'),
          CONSTRAINT promotion_target_versions_target_urls_array
            CHECK (jsonb_typeof(target_urls) = 'array'),
          CONSTRAINT promotion_target_versions_input_required_array
            CHECK (jsonb_typeof(input_required) = 'array')
        );

        CREATE TABLE platform.project_audit_events (
          id text PRIMARY KEY,
          organization_id text NOT NULL,
          workspace_id text NOT NULL,
          project_id text NOT NULL
            REFERENCES platform.projects(id) ON DELETE RESTRICT,
          event_type text NOT NULL,
          context_version integer NOT NULL CHECK (context_version > 0),
          payload jsonb NOT NULL,
          actor_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE platform.project_outbox_events (
          id text PRIMARY KEY,
          organization_id text NOT NULL,
          workspace_id text NOT NULL,
          project_id text NOT NULL
            REFERENCES platform.projects(id) ON DELETE RESTRICT,
          event_type text NOT NULL,
          aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
          payload jsonb NOT NULL,
          status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'published', 'failed')),
          last_error text,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          published_at timestamptz
        );

        CREATE INDEX ix_website_profile_versions_project
          ON platform.website_profile_versions
            (organization_id, workspace_id, project_id, version DESC);
        CREATE INDEX ix_promotion_target_versions_project
          ON platform.promotion_target_versions
            (organization_id, workspace_id, project_id, version DESC);
        CREATE INDEX ix_project_audit_events_project
          ON platform.project_audit_events
            (organization_id, workspace_id, project_id, created_at DESC);
        CREATE INDEX ix_project_outbox_events_pending
          ON platform.project_outbox_events (status, created_at)
          WHERE status IN ('pending', 'failed');

        ALTER TABLE platform.website_profile_versions
          OWNER TO growthos_platform_owner;
        ALTER TABLE platform.promotion_target_versions
          OWNER TO growthos_platform_owner;
        ALTER TABLE platform.project_audit_events
          OWNER TO growthos_platform_owner;
        ALTER TABLE platform.project_outbox_events
          OWNER TO growthos_platform_owner;

        REVOKE ALL ON platform.website_profile_versions FROM PUBLIC;
        REVOKE ALL ON platform.promotion_target_versions FROM PUBLIC;
        REVOKE ALL ON platform.project_audit_events FROM PUBLIC;
        REVOKE ALL ON platform.project_outbox_events FROM PUBLIC;
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON platform.website_profile_versions,
             platform.promotion_target_versions,
             platform.project_audit_events,
             platform.project_outbox_events
          TO growthos_platform_writer;
        GRANT SELECT
          ON platform.website_profile_versions,
             platform.promotion_target_versions,
             platform.project_audit_events,
             platform.project_outbox_events
          TO growthos_reporting_reader;
        GRANT SELECT, INSERT, UPDATE
          ON platform.projects,
             platform.website_profile_versions,
             platform.promotion_target_versions,
             platform.project_audit_events,
             platform.project_outbox_events
          TO growthos_gateway;

        DO $gateway_membership$
        BEGIN
          IF EXISTS (
            SELECT 1
              FROM pg_roles
             WHERE rolname = 'growthos_gateway_canary'
          ) THEN
            GRANT growthos_gateway TO growthos_gateway_canary;
          END IF;
        END
        $gateway_membership$;

        ALTER TABLE platform.website_profile_versions
          ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.website_profile_versions
          FORCE ROW LEVEL SECURITY;
        ALTER TABLE platform.promotion_target_versions
          ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.promotion_target_versions
          FORCE ROW LEVEL SECURITY;
        ALTER TABLE platform.project_audit_events
          ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.project_audit_events
          FORCE ROW LEVEL SECURITY;
        ALTER TABLE platform.project_outbox_events
          ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.project_outbox_events
          FORCE ROW LEVEL SECURITY;

        CREATE POLICY platform_website_profile_versions_tenant_policy
          ON platform.website_profile_versions
          USING (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          )
          WITH CHECK (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          );

        CREATE POLICY platform_promotion_target_versions_tenant_policy
          ON platform.promotion_target_versions
          USING (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          )
          WITH CHECK (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          );

        CREATE POLICY platform_project_audit_events_tenant_policy
          ON platform.project_audit_events
          USING (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          )
          WITH CHECK (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          );

        CREATE POLICY platform_project_outbox_events_tenant_policy
          ON platform.project_outbox_events
          USING (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          )
          WITH CHECK (
            organization_id =
              NULLIF(current_setting('app.current_organization_id', true), '')
            AND (
              NULLIF(current_setting('app.current_project_id', true), '')
                IS NULL
              OR project_id =
                NULLIF(current_setting('app.current_project_id', true), '')
            )
          );
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "20260805_0008 is forward-only; restore a verified backup or apply a reviewed repair."
    )
