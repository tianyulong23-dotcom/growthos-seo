"""Persist bounded, drafts-only Agent automation consent."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260914_0067"
down_revision = "20260825_0066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_backlinks_consents",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("policy_json", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("expires_at > created_at", name="ck_agent_backlinks_consents_expiry"),
        sa.UniqueConstraint(
            "organization_id", "workspace_id", "project_id", "user_id", "request_id",
            name="uq_agent_backlinks_consents_request",
        ),
    )
    op.create_index(
        "ix_agent_backlinks_consents_scope", "agent_backlinks_consents",
        ["organization_id", "workspace_id", "project_id", "user_id"],
    )


def downgrade() -> None:
    raise RuntimeError("Forward-only migration: restore the verified pre-migration backup.")
