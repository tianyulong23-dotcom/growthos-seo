"""Persist consent-bound recommendation-to-draft continuation."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260914_0068"
down_revision = "20260914_0067"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_backlinks_continuations",
        sa.Column("run_id", sa.Text(), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("consent_id", sa.Text(),
                  sa.ForeignKey("agent_backlinks_consents.id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("roles_json", postgresql.JSONB(), nullable=False),
        sa.Column("request_json", postgresql.JSONB(), nullable=False),
        sa.Column("checkpoint_json", postgresql.JSONB(), nullable=False),
        sa.Column("lease_id", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
    )


def downgrade():
    raise RuntimeError("Forward-only migration; preserve automation evidence.")
