"""Harden keyword workflow recovery and external request ownership.

Revision ID: 20260730_0016
Revises: 20260730_0015
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260730_k016"
down_revision: str | Sequence[str] | None = "20260730_k015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_workflow_dispatches",
        sa.Column("last_checked_at", sa.DateTime(timezone=True)),
    )

    op.add_column(
        "keyword_external_requests",
        sa.Column("claim_token", sa.Text()),
    )
    op.add_column(
        "keyword_external_requests",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
    )
    op.add_column(
        "keyword_external_requests",
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
    )
    op.drop_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        type_="check",
    )
    op.execute(
        """
        UPDATE keyword_external_requests
        SET status = 'charged_failed'
        WHERE status = 'retryable_failed'
            AND cost_usd > 0
        """
    )
    op.execute(
        """
        UPDATE keyword_external_requests
        SET status = 'uncertain',
            error_code = 'external_request_outcome_unknown',
            error_detail = '升级时发现未结束的外部请求，系统不会自动重复提交',
            finished_at = COALESCE(finished_at, now())
        WHERE status = 'running'
        """
    )
    op.create_check_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        "status IN ("
        "'prepared', 'submitted', 'completed', "
        "'retryable_failed', 'charged_failed', 'uncertain'"
        ")",
    )
    op.create_index(
        "ix_keyword_external_requests_lease",
        "keyword_external_requests",
        ["status", "lease_expires_at"],
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
    op.execute(
        """
        WITH recoverable AS (
            SELECT id
            FROM (
                SELECT
                    failed.id,
                    row_number() OVER (
                        PARTITION BY failed.project_id
                        ORDER BY failed.created_at DESC, failed.id DESC
                    ) AS project_rank
                FROM keyword_build_runs AS failed
                WHERE failed.kind = 'initial'
                    AND failed.status = 'failed'
                    AND failed.keyword_count = 0
                    AND failed.error_code IN (
                        'google_ads_not_configured',
                        'dataforseo_not_configured',
                        'dataforseo_auth_failed'
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM keyword_build_runs AS active
                        WHERE active.project_id = failed.project_id
                            AND active.id <> failed.id
                            AND active.status IN ('queued', 'running', 'waiting')
                    )
            ) AS ranked
            WHERE project_rank = 1
        )
        UPDATE keyword_build_runs
        SET status = 'blocked',
            stage = 'waiting_for_configuration',
            message = CASE
                WHEN error_code = 'dataforseo_auth_failed'
                    THEN '搜索数据服务凭证需要更新'
                ELSE '等待搜索数据服务配置后自动继续'
            END,
            error_code = CASE
                WHEN error_code = 'google_ads_not_configured'
                    THEN 'dataforseo_not_configured'
                ELSE error_code
            END,
            next_retry_at = NULL
        WHERE id IN (SELECT id FROM recoverable)
        """
    )
    op.create_check_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        "status IN ("
        "'queued', 'running', 'waiting', 'blocked', "
        "'partial', 'completed', 'failed', 'cancelled'"
        ")",
    )
    op.create_index(
        "uq_keyword_build_runs_active_project",
        "keyword_build_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('queued', 'running', 'waiting', 'blocked')"
        ),
    )

    op.create_table(
        "keyword_worker_heartbeats",
        sa.Column("worker_id", sa.Text(), primary_key=True),
        sa.Column("task_queue", sa.Text(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_index(
        "ix_keyword_worker_heartbeats_last_seen",
        "keyword_worker_heartbeats",
        ["last_seen_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_keyword_worker_heartbeats_last_seen",
        table_name="keyword_worker_heartbeats",
    )
    op.drop_table("keyword_worker_heartbeats")

    op.drop_index(
        "uq_keyword_build_runs_active_project",
        table_name="keyword_build_runs",
    )
    op.drop_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        type_="check",
    )
    op.execute(
        """
        UPDATE keyword_build_runs
        SET status = 'failed',
            stage = 'failed',
            message = '关键词任务需要在旧版本中重新创建',
            finished_at = COALESCE(finished_at, now())
        WHERE status = 'blocked'
        """
    )
    op.create_check_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        "status IN ("
        "'queued', 'running', 'waiting', "
        "'partial', 'completed', 'failed', 'cancelled'"
        ")",
    )
    op.create_index(
        "uq_keyword_build_runs_active_project",
        "keyword_build_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running', 'waiting')"),
    )

    op.drop_index(
        "ix_keyword_external_requests_lease",
        table_name="keyword_external_requests",
    )
    op.drop_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        type_="check",
    )
    op.execute(
        """
        UPDATE keyword_external_requests
        SET status = CASE
                WHEN status = 'prepared' THEN 'retryable_failed'
                WHEN status = 'submitted' THEN 'uncertain'
                ELSE status
            END,
            finished_at = CASE
                WHEN status IN ('prepared', 'submitted')
                    THEN COALESCE(finished_at, now())
                ELSE finished_at
            END
        WHERE status IN ('prepared', 'submitted')
        """
    )
    op.create_check_constraint(
        "ck_keyword_external_requests_status",
        "keyword_external_requests",
        "status IN ("
        "'running', 'completed', 'retryable_failed', 'charged_failed', 'uncertain'"
        ")",
    )
    op.drop_column("keyword_external_requests", "submitted_at")
    op.drop_column("keyword_external_requests", "lease_expires_at")
    op.drop_column("keyword_external_requests", "claim_token")

    op.drop_column("keyword_workflow_dispatches", "last_checked_at")
