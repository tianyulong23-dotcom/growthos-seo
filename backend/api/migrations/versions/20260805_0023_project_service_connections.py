"""Add project service connections.

Revision ID: 20260805_0023
Revises: 20260804_0022
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260805_0023"
down_revision: str | Sequence[str] | None = "20260804_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gsc_project_connections",
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("property_url", sa.Text(), nullable=False),
        sa.Column("service_account_email", sa.Text(), nullable=False),
        sa.Column("private_key_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_table(
        "wordpress_project_connections",
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("site_url", sa.Text(), nullable=False),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("application_password_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("verified_user", sa.Text(), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    op.drop_table("wordpress_project_connections")
    op.drop_table("gsc_project_connections")
