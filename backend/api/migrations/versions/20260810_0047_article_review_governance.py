"""Add article review governance, locks, and typed diff cache.

Revision ID: 20260810_0047
Revises: 20260809_0046
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260810_0047"
down_revision: str | Sequence[str] | None = "20260809_0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.create_table(
        "article_review_policies",
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("allow_self_review", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_by", sa.Text(), nullable=False, server_default="system"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("version > 0", name="ck_article_review_policies_version"),
    )
    op.create_table(
        "article_review_tasks",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("article_id", sa.Text(), sa.ForeignKey("articles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_id", sa.Text(), sa.ForeignKey("article_versions.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("assigned_to", sa.Text()),
        sa.Column("assigned_group", sa.Text()),
        sa.Column("submitted_by", sa.Text(), nullable=False),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("claimed_by", sa.Text()),
        sa.Column("claimed_at", sa.DateTime(timezone=True)),
        sa.Column("decided_by", sa.Text()),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("decision_comment", sa.Text()),
        sa.Column("policy_version", sa.Text(), nullable=False),
        sa.Column("submission_idempotency_key", sa.Text(), nullable=False),
        sa.Column("submission_request_hash", sa.Text(), nullable=False),
        sa.Column("decision_idempotency_key", sa.Text()),
        sa.Column("decision_request_hash", sa.Text()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('pending','in_review','approved','needs_changes','cancelled')", name="ck_article_review_tasks_status"),
        sa.CheckConstraint("version_number > 0", name="ck_article_review_tasks_version"),
        sa.UniqueConstraint("organization_id", "project_id", "submission_idempotency_key", name="uq_article_review_tasks_submission_idempotency"),
    )
    op.create_index("ix_article_review_tasks_article_id", "article_review_tasks", ["article_id"])
    op.create_index("uq_article_review_tasks_active_version", "article_review_tasks", ["article_id", "version_number"], unique=True, postgresql_where=sa.text("status IN ('pending','in_review')"))
    op.create_index("ix_article_review_tasks_inbox", "article_review_tasks", ["organization_id", "project_id", "status", sa.text("submitted_at DESC")])
    op.create_table(
        "article_review_comments",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("task_id", sa.Text(), sa.ForeignKey("article_review_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("node_id", sa.Text()),
        sa.Column("position_json", jsonb),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_article_review_comments_task_created", "article_review_comments", ["task_id", "created_at"])
    op.create_table(
        "article_locks",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("article_id", sa.Text(), sa.ForeignKey("articles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("lock_type", sa.Text(), nullable=False),
        sa.Column("version_number", sa.Integer()),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("fence", sa.Integer(), nullable=False),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("renewed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True)),
        sa.Column("released_by", sa.Text()),
        sa.Column("release_reason", sa.Text()),
        sa.CheckConstraint("lock_type IN ('edit_lock')", name="ck_article_locks_type"),
        sa.CheckConstraint("fence > 0", name="ck_article_locks_fence"),
        sa.CheckConstraint("expires_at > acquired_at", name="ck_article_locks_expiry"),
    )
    op.create_index("uq_article_locks_active_type", "article_locks", ["article_id", "lock_type"], unique=True, postgresql_where=sa.text("released_at IS NULL"))
    op.create_index("ix_article_locks_expiry", "article_locks", ["expires_at"])
    op.create_table(
        "article_version_diff_cache",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("article_id", sa.Text(), sa.ForeignKey("articles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("from_version_number", sa.Integer(), nullable=False),
        sa.Column("to_version_number", sa.Integer(), nullable=False),
        sa.Column("from_content_hash", sa.Text(), nullable=False),
        sa.Column("to_content_hash", sa.Text(), nullable=False),
        sa.Column("algorithm_version", sa.Text(), nullable=False),
        sa.Column("result_json", jsonb, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("article_id", "from_version_number", "to_version_number", "algorithm_version", name="uq_article_version_diff_cache_key"),
    )
    op.create_index("ix_article_version_diff_cache_article", "article_version_diff_cache", ["article_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_article_version_diff_cache_article", table_name="article_version_diff_cache")
    op.drop_table("article_version_diff_cache")
    op.drop_index("ix_article_locks_expiry", table_name="article_locks")
    op.drop_index("uq_article_locks_active_type", table_name="article_locks")
    op.drop_table("article_locks")
    op.drop_index("ix_article_review_comments_task_created", table_name="article_review_comments")
    op.drop_table("article_review_comments")
    op.drop_index("ix_article_review_tasks_inbox", table_name="article_review_tasks")
    op.drop_index("uq_article_review_tasks_active_version", table_name="article_review_tasks")
    op.drop_index("ix_article_review_tasks_article_id", table_name="article_review_tasks")
    op.drop_table("article_review_tasks")
    op.drop_table("article_review_policies")
