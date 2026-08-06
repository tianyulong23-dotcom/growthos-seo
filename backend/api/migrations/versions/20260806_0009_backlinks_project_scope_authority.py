"""Expose active Website Project authority to the Backlinks scheduler.

Revision ID: 20260806_0009
Revises: 20260805_0008
Create Date: 2026-08-06
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260806_0009"
down_revision: str | Sequence[str] | None = "20260805_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION platform.backlink_list_active_website_projects(
          p_organization_id text,
          p_workspace_id text
        )
        RETURNS TABLE (
          website_project_id text,
          context_version integer
        )
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = platform, pg_catalog
        AS $function$
          SELECT project.id,
                 project.context_version
            FROM platform.projects AS project
           WHERE p_organization_id =
             NULLIF(
               current_setting('app.current_organization_id', true),
               ''
             )
             AND p_workspace_id =
               NULLIF(
                 current_setting('app.current_workspace_id', true),
                 ''
               )
             AND project.organization_id = p_organization_id
             AND project.workspace_id = p_workspace_id
             AND project.status = 'ACTIVE'
           ORDER BY project.id;
        $function$;

        ALTER FUNCTION platform.backlink_list_active_website_projects(
          text, text
        ) OWNER TO growthos_platform_owner;
        REVOKE ALL
          ON FUNCTION platform.backlink_list_active_website_projects(
            text, text
          )
          FROM PUBLIC;
        GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
        GRANT EXECUTE
          ON FUNCTION platform.backlink_list_active_website_projects(
            text, text
          )
          TO growthos_backlinks_owner;
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "20260806_0009 is forward-only; restore a verified backup or apply a reviewed repair."
    )
