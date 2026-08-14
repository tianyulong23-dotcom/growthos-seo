"""Add durable, auditable article AI edit operations.

Revision ID: 20260810_0049
Revises: 20260810_0048
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260810_0049"
down_revision: str | Sequence[str] | None = "20260810_0048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.create_table(
        "article_ai_edit_operations",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "article_id",
            sa.Text(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_operation_id",
            sa.Text(),
            sa.ForeignKey("article_ai_edit_operations.id", ondelete="RESTRICT"),
        ),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("accepted_by", sa.Text()),
        sa.Column("command", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("base_review_version", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.Text(), nullable=False),
        sa.Column("anchor_node_id", sa.Text()),
        sa.Column("selection_from", sa.Integer()),
        sa.Column("selection_to", sa.Integer()),
        sa.Column("selected_text_hash", sa.Text()),
        sa.Column(
            "input_payload_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text()),
        sa.Column("model", sa.Text()),
        sa.Column(
            "model_config_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("input_hash", sa.Text(), nullable=False),
        sa.Column("output_hash", sa.Text()),
        sa.Column("candidate_text", sa.Text()),
        sa.Column("candidate_slice_json", jsonb),
        sa.Column("candidate_metadata_json", jsonb),
        sa.Column("candidate_kind", sa.Text(), nullable=False),
        sa.Column(
            "allowed_modes_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column("stream_token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("stream_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("stream_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("accept_idempotency_key", sa.Text()),
        sa.Column("accept_request_hash", sa.Text()),
        sa.Column("accepted_mode", sa.Text()),
        sa.Column("accepted_result_json", jsonb),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('queued','streaming','ready','accepted','rejected','cancelled','failed','stale')",
            name="ck_article_ai_edit_operations_status",
        ),
        sa.CheckConstraint(
            "candidate_kind IN ('text','metadata','slice')",
            name="ck_article_ai_edit_operations_candidate_kind",
        ),
        sa.CheckConstraint(
            "scope IN ('selection','block','cursor','metadata')",
            name="ck_article_ai_edit_operations_scope",
        ),
        sa.CheckConstraint(
            "accepted_mode IS NULL OR accepted_mode IN ('replace','insert_after','apply_metadata')",
            name="ck_article_ai_edit_operations_accepted_mode",
        ),
        sa.UniqueConstraint(
            "article_id",
            "created_by",
            "idempotency_key",
            name="uq_article_ai_edit_operations_create_idempotency",
        ),
    )
    op.create_index(
        "ix_article_ai_edit_operations_organization_id",
        "article_ai_edit_operations",
        ["organization_id"],
    )
    op.create_index(
        "ix_article_ai_edit_operations_project_status_created",
        "article_ai_edit_operations",
        ["project_id", "status", "created_at"],
    )
    op.create_index(
        "ix_article_ai_edit_operations_article_created",
        "article_ai_edit_operations",
        ["article_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_article_ai_edit_operations_article_created", table_name="article_ai_edit_operations"
    )
    op.drop_index(
        "ix_article_ai_edit_operations_project_status_created",
        table_name="article_ai_edit_operations",
    )
    op.drop_index(
        "ix_article_ai_edit_operations_organization_id", table_name="article_ai_edit_operations"
    )
    op.drop_table("article_ai_edit_operations")
