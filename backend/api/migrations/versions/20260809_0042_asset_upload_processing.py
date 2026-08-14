"""Add resumable asset uploads and persistent processing jobs.

Revision ID: 20260809_0042
Revises: 20260808_0041
Create Date: 2026-08-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260809_0042"
down_revision: str | Sequence[str] | None = "20260808_0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.drop_constraint("ck_content_assets_status", "content_assets", type_="check")
    op.create_check_constraint(
        "ck_content_assets_status",
        "content_assets",
        "status IN ('pending','uploading','uploaded','processing','ready','pending_delete','failed','quarantined','deleted')",
    )
    op.add_column(
        "content_assets",
        sa.Column(
            "canonical_asset_id",
            sa.Text(),
            sa.ForeignKey("content_assets.id", ondelete="SET NULL"),
        ),
    )
    op.add_column("content_assets", sa.Column("idempotency_key", sa.Text()))
    op.add_column("content_assets", sa.Column("request_hash", sa.Text()))
    op.create_unique_constraint(
        "uq_content_assets_source_idempotency",
        "content_assets",
        ["project_id", "created_by", "source_type", "idempotency_key"],
    )
    op.create_table(
        "asset_upload_sessions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey("content_assets.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="initiated"),
        sa.Column("multipart_upload_id", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("expected_size", sa.BigInteger(), nullable=False),
        sa.Column("expected_sha256", sa.Text()),
        sa.Column("part_size", sa.Integer(), nullable=False),
        sa.Column("uploaded_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("failure_code", sa.Text()),
        sa.Column("failure_detail", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('initiated','uploading','completing','completed','cancelled','failed','expired')",
            name="ck_asset_upload_sessions_status",
        ),
        sa.CheckConstraint("expected_size > 0", name="ck_asset_upload_sessions_expected_size"),
        sa.CheckConstraint("part_size > 0", name="ck_asset_upload_sessions_part_size"),
        sa.CheckConstraint("uploaded_bytes >= 0", name="ck_asset_upload_sessions_uploaded_bytes"),
        sa.UniqueConstraint(
            "project_id", "created_by", "idempotency_key", name="uq_asset_upload_sessions_idempotency"
        ),
    )
    op.create_index("ix_asset_upload_sessions_expiry", "asset_upload_sessions", ["expires_at"])

    op.create_table(
        "asset_upload_parts",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "upload_session_id",
            sa.Text(),
            sa.ForeignKey("asset_upload_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("part_number", sa.Integer(), nullable=False),
        sa.Column("etag", sa.Text(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("checksum_sha256", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("part_number > 0", name="ck_asset_upload_parts_number"),
        sa.CheckConstraint("byte_size > 0", name="ck_asset_upload_parts_size"),
        sa.UniqueConstraint("upload_session_id", "part_number", name="uq_asset_upload_parts_number"),
    )
    op.create_index("ix_asset_upload_parts_upload_session_id", "asset_upload_parts", ["upload_session_id"])

    op.create_table(
        "asset_processing_jobs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey("content_assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("job_type", sa.Text(), nullable=False, server_default="inspect_and_transform"),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("worker_id", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('queued','running','completed','failed','cancelled')",
            name="ck_asset_processing_jobs_status",
        ),
        sa.CheckConstraint("attempt >= 0", name="ck_asset_processing_jobs_attempt"),
        sa.CheckConstraint("max_attempts > 0", name="ck_asset_processing_jobs_max_attempts"),
    )
    op.create_index("ix_asset_processing_jobs_asset_id", "asset_processing_jobs", ["asset_id"])
    op.create_index(
        "uq_asset_processing_jobs_active",
        "asset_processing_jobs",
        ["asset_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued','running')"),
    )
    op.create_index(
        "ix_asset_processing_jobs_dispatch", "asset_processing_jobs", ["status", "available_at"]
    )

    op.create_table(
        "asset_cleanup_jobs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey("content_assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("cleanup_type", sa.Text(), nullable=False),
        sa.Column("object_keys", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("worker_id", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('queued','running','completed','failed','cancelled')",
            name="ck_asset_cleanup_jobs_status",
        ),
        sa.CheckConstraint("attempt >= 0", name="ck_asset_cleanup_jobs_attempt"),
        sa.CheckConstraint("max_attempts > 0", name="ck_asset_cleanup_jobs_max_attempts"),
    )
    op.create_index("ix_asset_cleanup_jobs_asset_id", "asset_cleanup_jobs", ["asset_id"])
    op.create_index(
        "ix_asset_cleanup_jobs_dispatch", "asset_cleanup_jobs", ["status", "available_at"]
    )

    op.create_table(
        "content_audit_events",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("article_id", sa.Text()),
        sa.Column("actor_id", sa.Text(), nullable=False),
        sa.Column("effective_role", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=False),
        sa.Column("version_number", sa.Integer()),
        sa.Column("before_state", jsonb),
        sa.Column("after_state", jsonb),
        sa.Column("reason", sa.Text()),
        sa.Column("policy_version", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text()),
        sa.Column("correlation_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_content_audit_events_project_created",
        "content_audit_events",
        ["project_id", "created_at"],
    )
    op.create_index(
        "ix_content_audit_events_target",
        "content_audit_events",
        ["target_type", "target_id", "created_at"],
    )
    op.execute(
        """
        CREATE FUNCTION reject_content_audit_event_mutation() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'content_audit_events are append-only';
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER content_audit_events_append_only
        BEFORE UPDATE OR DELETE ON content_audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_content_audit_event_mutation()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_article_asset_binding_ready() RETURNS trigger AS $$
        DECLARE
            bound_asset_project_id text;
            bound_asset_status text;
            bound_article_project_id text;
        BEGIN
            IF NEW.removed_at IS NOT NULL THEN
                RETURN NEW;
            END IF;

            SELECT project_id, status
            INTO bound_asset_project_id, bound_asset_status
            FROM content_assets
            WHERE id = NEW.asset_id
            FOR KEY SHARE;

            IF bound_asset_project_id IS NULL THEN
                RAISE EXCEPTION 'article_asset_binding_asset_not_found';
            END IF;
            IF bound_asset_status <> 'ready' THEN
                RAISE EXCEPTION 'article_asset_binding_asset_not_ready';
            END IF;

            SELECT project_id
            INTO bound_article_project_id
            FROM articles
            WHERE id = NEW.article_id;

            IF bound_article_project_id IS NULL THEN
                RAISE EXCEPTION 'article_asset_binding_article_not_found';
            END IF;
            IF bound_asset_project_id <> bound_article_project_id THEN
                RAISE EXCEPTION 'article_asset_binding_cross_project';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER article_asset_bindings_require_ready_asset
        BEFORE INSERT OR UPDATE OF asset_id, article_id, removed_at
        ON article_asset_bindings
        FOR EACH ROW EXECUTE FUNCTION enforce_article_asset_binding_ready()
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS article_asset_bindings_require_ready_asset "
        "ON article_asset_bindings"
    )
    op.execute("DROP FUNCTION IF EXISTS enforce_article_asset_binding_ready()")
    op.execute("DROP TRIGGER IF EXISTS content_audit_events_append_only ON content_audit_events")
    op.execute("DROP FUNCTION IF EXISTS reject_content_audit_event_mutation()")
    op.drop_index("ix_content_audit_events_target", table_name="content_audit_events")
    op.drop_index("ix_content_audit_events_project_created", table_name="content_audit_events")
    op.drop_table("content_audit_events")
    op.drop_index("ix_asset_cleanup_jobs_dispatch", table_name="asset_cleanup_jobs")
    op.drop_index("ix_asset_cleanup_jobs_asset_id", table_name="asset_cleanup_jobs")
    op.drop_table("asset_cleanup_jobs")
    op.drop_index("ix_asset_processing_jobs_dispatch", table_name="asset_processing_jobs")
    op.drop_index("uq_asset_processing_jobs_active", table_name="asset_processing_jobs")
    op.drop_index("ix_asset_processing_jobs_asset_id", table_name="asset_processing_jobs")
    op.drop_table("asset_processing_jobs")
    op.drop_index("ix_asset_upload_parts_upload_session_id", table_name="asset_upload_parts")
    op.drop_table("asset_upload_parts")
    op.drop_index("ix_asset_upload_sessions_expiry", table_name="asset_upload_sessions")
    op.drop_table("asset_upload_sessions")
    op.drop_constraint(
        "uq_content_assets_source_idempotency", "content_assets", type_="unique"
    )
    op.drop_column("content_assets", "request_hash")
    op.drop_column("content_assets", "idempotency_key")
    op.drop_column("content_assets", "canonical_asset_id")
    op.drop_constraint("ck_content_assets_status", "content_assets", type_="check")
    op.create_check_constraint(
        "ck_content_assets_status",
        "content_assets",
        "status IN ('pending','uploading','uploaded','processing','ready','failed','quarantined','deleted')",
    )
