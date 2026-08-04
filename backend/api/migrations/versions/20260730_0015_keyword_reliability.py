"""Add durable recovery and paid-request outcome states.

Revision ID: 20260730_0015
Revises: 20260729_0014
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260730_k015"
down_revision: str | Sequence[str] | None = "20260729_k014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_build_runs",
        sa.Column(
            "recovery_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "keyword_build_runs",
        sa.Column("next_retry_at", sa.DateTime(timezone=True)),
    )

    op.drop_index(
        "uq_keyword_build_runs_active_project",
        table_name="keyword_build_runs",
    )
    op.drop_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        "status IN ("
        "'queued', 'running', 'waiting', 'partial', 'completed', 'failed', 'cancelled'"
        ")",
    )
    op.create_index(
        "uq_keyword_build_runs_active_project",
        "keyword_build_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running', 'waiting')"),
    )

    op.add_column(
        "keyword_external_requests",
        sa.Column(
            "attempt_count",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )
    op.drop_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        type_="check",
    )
    op.execute(
        """
        UPDATE keyword_external_requests
        SET status = 'retryable_failed'
        WHERE status = 'failed'
        """
    )
    op.create_check_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        "status IN ("
        "'running', 'completed', 'retryable_failed', 'charged_failed', 'uncertain'"
        ")",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        type_="check",
    )
    op.execute(
        """
        UPDATE keyword_external_requests
        SET status = 'failed'
        WHERE status IN ('retryable_failed', 'charged_failed', 'uncertain')
        """
    )
    op.create_check_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        "status IN ('running', 'completed', 'failed')",
    )
    op.drop_column("keyword_external_requests", "attempt_count")

    op.drop_index(
        "uq_keyword_build_runs_active_project",
        table_name="keyword_build_runs",
    )
    op.execute(
        """
        UPDATE keyword_build_runs
        SET status = 'failed',
            stage = 'failed',
            message = '关键词任务在旧版本中无法继续恢复',
            finished_at = COALESCE(finished_at, now())
        WHERE status = 'waiting'
        """
    )
    op.drop_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        "status IN ('queued', 'running', 'partial', 'completed', 'failed', 'cancelled')",
    )
    op.create_index(
        "uq_keyword_build_runs_active_project",
        "keyword_build_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.drop_column("keyword_build_runs", "next_retry_at")
    op.drop_column("keyword_build_runs", "recovery_count")
