"""Add permanent failure status to content-plan external requests.

Revision ID: 20260807_0026
Revises: 20260806_0025
Create Date: 2026-08-07
"""

from collections.abc import Sequence

from alembic import op


revision: str = "20260807_0026"
down_revision: str | Sequence[str] | None = "20260806_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_content_plan_external_requests_status",
        "content_plan_external_requests",
        type_="check",
        schema="public",
    )
    op.create_check_constraint(
        "ck_content_plan_external_requests_status",
        "content_plan_external_requests",
        "status IN ('prepared','submitted','completed','retryable_failed',"
        "'charged_failed','uncertain','failed')",
        schema="public",
    )


def downgrade() -> None:
    op.execute(
        "UPDATE public.content_plan_external_requests "
        "SET status = 'charged_failed' WHERE status = 'failed'"
    )
    op.drop_constraint(
        "ck_content_plan_external_requests_status",
        "content_plan_external_requests",
        type_="check",
        schema="public",
    )
    op.create_check_constraint(
        "ck_content_plan_external_requests_status",
        "content_plan_external_requests",
        "status IN ('prepared','submitted','completed','retryable_failed',"
        "'charged_failed','uncertain')",
        schema="public",
    )
