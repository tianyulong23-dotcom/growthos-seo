"""Add durable onboarding orchestration runs and steps.

Revision ID: 20260812_0059
Revises: 20260812_0058
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260812_0059"
down_revision: str | Sequence[str] | None = "20260812_0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "onboarding_runs",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
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
            "status IN ('running','waiting_for_confirmation','completed')",
            name="ck_onboarding_runs_status",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", name="uq_onboarding_runs_project"),
    )
    op.create_index(
        "ix_onboarding_runs_organization_id",
        "onboarding_runs",
        ["organization_id"],
    )
    op.create_index(
        "ix_onboarding_runs_active",
        "onboarding_runs",
        ["status", "updated_at"],
    )

    op.create_table(
        "onboarding_steps",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("step_key", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("external_run_id", sa.Text()),
        sa.Column("last_error_code", sa.Text()),
        sa.Column("last_error_message", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
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
            "status IN ('blocked','ready','running','completed','failed','skipped')",
            name="ck_onboarding_steps_status",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_onboarding_steps_attempts"),
        sa.ForeignKeyConstraint(
            ["run_id"], ["onboarding_runs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "run_id", "step_key", name="uq_onboarding_steps_run_key"
        ),
    )
    op.create_index(
        "ix_onboarding_steps_run_position",
        "onboarding_steps",
        ["run_id", "position"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_onboarding_steps_run_position",
        table_name="onboarding_steps",
    )
    op.drop_table("onboarding_steps")
    op.drop_index("ix_onboarding_runs_active", table_name="onboarding_runs")
    op.drop_index(
        "ix_onboarding_runs_organization_id",
        table_name="onboarding_runs",
    )
    op.drop_table("onboarding_runs")
