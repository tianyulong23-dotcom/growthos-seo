"""Version-bound AI review evidence, separate from send authorization."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260915_0070"
down_revision = "20260914_0069"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_backlinks_quality_reviews",
        sa.Column("consent_id", sa.Text(), sa.ForeignKey(
            "agent_backlinks_consents.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("draft_id", sa.Text(), primary_key=True),
        sa.Column("fingerprint", sa.Text(), primary_key=True),
        sa.Column("version_id", sa.Text(), nullable=False),
        sa.Column("report_json", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    raise RuntimeError("Forward-only migration; preserve quality review evidence.")
