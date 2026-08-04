"""Add durable keyword metric refresh jobs.

Revision ID: 20260803_0019
Revises: 20260731_0018
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260803_0019"
down_revision: str | Sequence[str] | None = "20260731_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "keyword_metric_refresh_jobs",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("workflow_id", sa.Text(), nullable=False),
        sa.Column("task_payload", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error_code", sa.Text()),
        sa.Column("last_error_detail", sa.Text()),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("last_checked_at", sa.DateTime(timezone=True)),
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
        sa.CheckConstraint(
            "status IN ("
            "'pending', 'dispatched', 'running', 'waiting', "
            "'completed', 'exhausted'"
            ")",
            name="ck_keyword_metric_refresh_jobs_status",
        ),
        sa.CheckConstraint(
            "attempt_count BETWEEN 0 AND 3",
            name="ck_keyword_metric_refresh_jobs_attempt_count",
        ),
        sa.UniqueConstraint(
            "workflow_id",
            name="uq_keyword_metric_refresh_jobs_workflow_id",
        ),
    )
    op.create_index(
        "ix_keyword_metric_refresh_jobs_due",
        "keyword_metric_refresh_jobs",
        ["status", "next_attempt_at"],
    )
    op.create_index(
        "ix_keyword_metric_refresh_jobs_organization",
        "keyword_metric_refresh_jobs",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_metric_refresh_jobs_project",
        "keyword_metric_refresh_jobs",
        ["project_id"],
    )

    op.execute(
        """
        INSERT INTO keyword_metric_refresh_jobs (
            run_id,
            organization_id,
            project_id,
            workflow_id,
            task_payload,
            status,
            next_attempt_at
        )
        SELECT
            run.id,
            run.organization_id,
            run.project_id,
            'keyword-metrics:' || run.id || ':1:migrated',
            jsonb_build_object(
                'organization_id', run.organization_id,
                'project_id', run.project_id,
                'run_id', run.id,
                'kind', run.kind,
                'round_number', run.round_number,
                '_metric_workflow_id',
                    'keyword-metrics:' || run.id || ':1:migrated'
            ),
            'pending',
            now()
        FROM keyword_build_runs AS run
        WHERE run.status IN ('partial', 'completed')
            AND EXISTS (
                SELECT 1
                FROM keywords AS keyword
                WHERE keyword.last_build_run_id = run.id
                    AND keyword.metrics_status = 'pending'
            )
        ON CONFLICT (run_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_keyword_metric_refresh_jobs_project",
        table_name="keyword_metric_refresh_jobs",
    )
    op.drop_index(
        "ix_keyword_metric_refresh_jobs_organization",
        table_name="keyword_metric_refresh_jobs",
    )
    op.drop_index(
        "ix_keyword_metric_refresh_jobs_due",
        table_name="keyword_metric_refresh_jobs",
    )
    op.drop_table("keyword_metric_refresh_jobs")
