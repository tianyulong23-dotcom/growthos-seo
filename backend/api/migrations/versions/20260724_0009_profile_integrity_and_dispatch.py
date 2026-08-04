"""Protect business profiles and make workflow dispatch recoverable.

Revision ID: 20260724_0009
Revises: 20260723_0008
Create Date: 2026-07-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260724_0009"
down_revision: str | Sequence[str] | None = "20260723_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_profiles",
        sa.Column(
            "user_overrides",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.execute(
        """
        UPDATE site_profiles
        SET user_overrides = jsonb_strip_nulls(
            jsonb_build_object(
                'business_name',
                    CASE WHEN profile_json ? 'confirmed_at'
                        THEN profile_json->'business_name' END,
                'business_type',
                    CASE WHEN profile_json ? 'confirmed_at'
                        THEN profile_json->'business_type' END,
                'business_summary',
                    CASE WHEN profile_json ? 'confirmed_at'
                        THEN profile_json->'business_summary' END,
                'target_audiences',
                    CASE WHEN profile_json ? 'confirmed_at'
                        THEN profile_json->'target_audiences' END,
                'products_services',
                    CASE WHEN profile_json ? 'confirmed_at'
                        THEN profile_json->'products_services' END,
                'value_propositions',
                    CASE WHEN profile_json ? 'confirmed_at'
                        THEN profile_json->'value_propositions' END,
                'ai_content_rules',
                    CASE
                        WHEN COALESCE(profile_json->>'ai_content_rules', '') <> ''
                        THEN profile_json->'ai_content_rules'
                    END,
                'confirmed_at', profile_json->'confirmed_at'
            )
        )
        """
    )

    op.create_table(
        "site_profile_versions",
        sa.Column(
            "source_run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "profile_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_site_profile_versions_project_id",
        "site_profile_versions",
        ["project_id"],
    )
    op.execute(
        """
        INSERT INTO site_profile_versions (
            source_run_id,
            project_id,
            profile_json,
            confidence,
            created_at
        )
        SELECT
            source_run_id,
            project_id,
            profile_json,
            confidence,
            created_at
        FROM site_profiles
        ON CONFLICT (source_run_id) DO NOTHING
        """
    )

    op.create_table(
        "workflow_dispatches",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workflow_id", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "task_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("last_error", sa.Text()),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_workflow_dispatches_pending",
        "workflow_dispatches",
        ["status", "next_attempt_at"],
    )
    op.execute(
        """
        INSERT INTO workflow_dispatches (
            run_id,
            workflow_id,
            task_payload,
            status
        )
        SELECT
            run.run_id,
            'crawler:site_understanding:' || project.id || ':' || run.run_id,
            jsonb_build_object(
                'organization_id', run.organization_id,
                'project_id', run.project_id,
                'run_id', run.run_id,
                'type', 'site_understanding',
                'target_url', run.target_url,
                'country', run.country,
                'language', run.language,
                'max_pages', 5,
                'scope', 'domain',
                'rendering', 'auto',
                'ignored_parameters',
                    jsonb_build_array(
                        'utm_*', 'gclid', 'fbclid', 'msclkid', 'yclid'
                    )
            ),
            'pending'
        FROM crawl_runs AS run
        JOIN projects AS project
            ON project.id = run.project_id
            AND project.organization_id = run.organization_id
            AND project.understanding_run_id = run.run_id
        WHERE run.task_type = 'site_understanding'
            AND run.status IN ('queued', 'running')
        ON CONFLICT (run_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workflow_dispatches_pending",
        table_name="workflow_dispatches",
    )
    op.drop_table("workflow_dispatches")
    op.drop_index(
        "ix_site_profile_versions_project_id",
        table_name="site_profile_versions",
    )
    op.drop_table("site_profile_versions")
    op.drop_column("site_profiles", "user_overrides")
