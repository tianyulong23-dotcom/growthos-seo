"""Persist exact human-confirmed batch manifests, not blanket send authority."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260914_0069"
down_revision = "20260914_0068"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_backlinks_send_batches",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("consent_id", sa.Text(),
                  sa.ForeignKey("agent_backlinks_consents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("run_id", sa.Text(), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), unique=True),
        sa.Column("roles_json", postgresql.JSONB(), nullable=False),
        sa.Column("request_json", postgresql.JSONB(), nullable=False),
        sa.Column("items_json", postgresql.JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("lease_id", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("consent_id", "request_id", name="uq_agent_send_batch_request"),
    )


def downgrade():
    raise RuntimeError("Forward-only migration; preserve send confirmation evidence.")
