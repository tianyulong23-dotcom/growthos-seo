"""Add immutable previews and durable publication orchestration.

Revision ID: 20260810_0048
Revises: 20260810_0047
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260810_0048"
down_revision: str | Sequence[str] | None = "20260810_0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def legacy_wordpress_backfill_statements() -> tuple[sa.TextClause, sa.TextClause]:
    return (
        sa.text(
            """
            INSERT INTO publication_targets (
                id,
                organization_id,
                project_id,
                adapter_type,
                site_url,
                capabilities_json,
                credential_reference,
                status,
                created_at,
                updated_at
            )
            SELECT
                'legacy-wordpress-' || md5(connection.project_id),
                project.organization_id,
                connection.project_id,
                'wordpress',
                regexp_replace(connection.site_url, '/+$', ''),
                jsonb_build_object(
                    'media_upload', true,
                    'media_lookup', true,
                    'post_create', true,
                    'post_update_by_remote_id', true,
                    'post_reconcile', true,
                    'theme_preview', false
                ),
                'wordpress-project:' || connection.project_id,
                'verified',
                connection.created_at,
                connection.updated_at
            FROM wordpress_project_connections AS connection
            JOIN projects AS project ON project.id = connection.project_id
            WHERE connection.verified_at IS NOT NULL
            ON CONFLICT (project_id, adapter_type) DO NOTHING
            """
        ),
        sa.text(
            """
            UPDATE article_publications AS publication
            SET target_id = target.id
            FROM publication_targets AS target
            WHERE publication.project_id = target.project_id
              AND publication.organization_id = target.organization_id
              AND target.adapter_type = 'wordpress'
              AND publication.target_id IS NULL
            """
        ),
    )


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.create_table(
        "publication_targets",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("adapter_type", sa.Text(), nullable=False),
        sa.Column("site_url", sa.Text(), nullable=False),
        sa.Column("capabilities_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("credential_reference", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("adapter_type IN ('wordpress')", name="ck_publication_targets_adapter_type"),
        sa.CheckConstraint("status IN ('verified','disconnected','disabled')", name="ck_publication_targets_status"),
        sa.UniqueConstraint("project_id", "adapter_type", name="uq_publication_targets_project_adapter"),
    )
    op.create_table(
        "article_preview_snapshots",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("article_id", sa.Text(), sa.ForeignKey("articles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_version_id", sa.Text(), sa.ForeignKey("article_versions.id", ondelete="RESTRICT")),
        sa.Column("source_version_number", sa.Integer()),
        sa.Column("autosave_id", sa.Text(), sa.ForeignKey("article_autosaves.id", ondelete="SET NULL")),
        sa.Column("document_snapshot", jsonb, nullable=False),
        sa.Column("metadata_snapshot", jsonb, nullable=False),
        sa.Column("asset_manifest", jsonb, nullable=False),
        sa.Column("target_id", sa.Text(), sa.ForeignKey("publication_targets.id", ondelete="SET NULL")),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("audience", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_by", sa.Text()),
        sa.CheckConstraint("source_type IN ('version','autosave')", name="ck_article_preview_snapshots_source_type"),
        sa.CheckConstraint("audience IN ('creator','organization')", name="ck_article_preview_snapshots_audience"),
        sa.CheckConstraint("expires_at > created_at", name="ck_article_preview_snapshots_expiry"),
    )
    op.create_index("ix_article_preview_snapshots_expiry", "article_preview_snapshots", ["expires_at"])

    op.drop_index("uq_article_publications_active_article", table_name="article_publications")
    op.drop_constraint("ck_article_publications_status", "article_publications", type_="check")
    op.drop_constraint("ck_article_publications_attempt", "article_publications", type_="check")
    op.alter_column("article_publications", "attempt", new_column_name="attempt_count")
    op.alter_column("article_publications", "wordpress_post_id", new_column_name="remote_post_id")
    op.alter_column("article_publications", "wordpress_url", new_column_name="remote_url")
    op.add_column("article_publications", sa.Column("version_id", sa.Text(), sa.ForeignKey("article_versions.id", ondelete="RESTRICT")))
    op.add_column("article_publications", sa.Column("version_number", sa.Integer()))
    op.add_column("article_publications", sa.Column("target_id", sa.Text(), sa.ForeignKey("publication_targets.id", ondelete="RESTRICT")))
    op.add_column("article_publications", sa.Column("parent_publication_id", sa.Text(), sa.ForeignKey("article_publications.id", ondelete="RESTRICT")))
    op.add_column("article_publications", sa.Column("mode", sa.Text(), nullable=False, server_default="immediate"))
    op.add_column("article_publications", sa.Column("schedule_at_utc", sa.DateTime(timezone=True)))
    op.add_column("article_publications", sa.Column("source_timezone", sa.Text(), nullable=False, server_default="UTC"))
    op.add_column("article_publications", sa.Column("payload_hash", sa.Text(), nullable=False, server_default=""))
    op.add_column("article_publications", sa.Column("asset_manifest_hash", sa.Text(), nullable=False, server_default=""))
    op.add_column("article_publications", sa.Column("lease_owner", sa.Text()))
    op.add_column("article_publications", sa.Column("lease_expires_at", sa.DateTime(timezone=True)))
    op.add_column("article_publications", sa.Column("created_by", sa.Text(), nullable=False, server_default="system"))
    op.add_column("article_publications", sa.Column("checkpoint_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.add_column("article_publications", sa.Column("published_snapshot_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.add_column("article_publications", sa.Column("cancelled_at", sa.DateTime(timezone=True)))
    op.add_column("article_publications", sa.Column("cancelled_by", sa.Text()))
    op.add_column("article_publications", sa.Column("cancellation_reason", sa.Text()))
    for statement in legacy_wordpress_backfill_statements():
        op.execute(statement)
    op.create_check_constraint(
        "ck_article_publications_status",
        "article_publications",
        "status IN ('queued','scheduled','submitting','published','failed','uncertain','cancelled')",
    )
    op.create_check_constraint("ck_article_publications_attempt", "article_publications", "attempt_count >= 0")
    op.create_check_constraint("ck_article_publications_mode", "article_publications", "mode IN ('immediate','scheduled')")
    op.create_check_constraint(
        "ck_article_publications_schedule",
        "article_publications",
        "(mode = 'scheduled' AND schedule_at_utc IS NOT NULL) OR (mode = 'immediate' AND schedule_at_utc IS NULL)",
    )
    op.create_index(
        "uq_article_publications_active_article",
        "article_publications",
        ["article_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued','scheduled','submitting','uncertain')"),
    )
    op.create_index(
        "ix_article_publications_dispatch",
        "article_publications",
        ["status", "schedule_at_utc", "lease_expires_at"],
    )

    op.create_table(
        "publication_asset_mappings",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("target_id", sa.Text(), sa.ForeignKey("publication_targets.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey(
                "content_assets.id",
                deferrable=True,
                initially="DEFERRED",
            ),
            nullable=False,
        ),
        sa.Column("variant_id", sa.Text(), sa.ForeignKey("asset_variants.id", ondelete="SET NULL")),
        sa.Column("variant_hash", sa.Text(), nullable=False),
        sa.Column("remote_media_id", sa.Integer()),
        sa.Column("remote_source_url", sa.Text()),
        sa.Column("remote_hash", sa.Text()),
        sa.Column("remote_slug", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("lease_owner", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("last_verified_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('uploading','ready','stale','failed','uncertain')", name="ck_publication_asset_mappings_status"),
        sa.UniqueConstraint("target_id", "asset_id", "variant_hash", name="uq_publication_asset_mappings_identity"),
    )
    op.create_index("ix_publication_asset_mappings_asset", "publication_asset_mappings", ["asset_id"])
    op.create_table(
        "publication_asset_checkpoints",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("publication_id", sa.Text(), sa.ForeignKey("article_publications.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey(
                "content_assets.id",
                deferrable=True,
                initially="DEFERRED",
            ),
            nullable=False,
        ),
        sa.Column("node_id", sa.Text(), nullable=False),
        sa.Column("item_id", sa.Text()),
        sa.Column("item_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("binding_role", sa.Text(), nullable=False),
        sa.Column("variant_hash", sa.Text(), nullable=False),
        sa.Column("mapping_id", sa.Text(), sa.ForeignKey("publication_asset_mappings.id", ondelete="SET NULL")),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('pending','uploading','ready','failed','uncertain')", name="ck_publication_asset_checkpoints_status"),
        sa.UniqueConstraint("publication_id", "node_id", "item_key", "binding_role", name="uq_publication_asset_checkpoints_binding"),
    )
    op.create_index(
        "ix_publication_asset_checkpoints_publication",
        "publication_asset_checkpoints",
        ["publication_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_publication_asset_checkpoints_publication", table_name="publication_asset_checkpoints")
    op.drop_table("publication_asset_checkpoints")
    op.drop_index("ix_publication_asset_mappings_asset", table_name="publication_asset_mappings")
    op.drop_table("publication_asset_mappings")
    op.drop_index("ix_article_publications_dispatch", table_name="article_publications")
    op.drop_index("uq_article_publications_active_article", table_name="article_publications")
    op.drop_constraint("ck_article_publications_schedule", "article_publications", type_="check")
    op.drop_constraint("ck_article_publications_mode", "article_publications", type_="check")
    op.drop_constraint("ck_article_publications_attempt", "article_publications", type_="check")
    op.drop_constraint("ck_article_publications_status", "article_publications", type_="check")
    for column in (
        "cancellation_reason", "cancelled_by", "cancelled_at", "published_snapshot_json",
        "checkpoint_json", "created_by", "lease_expires_at", "lease_owner",
        "asset_manifest_hash", "payload_hash", "source_timezone", "schedule_at_utc",
        "mode", "parent_publication_id", "target_id", "version_number", "version_id",
    ):
        op.drop_column("article_publications", column)
    op.alter_column("article_publications", "remote_url", new_column_name="wordpress_url")
    op.alter_column("article_publications", "remote_post_id", new_column_name="wordpress_post_id")
    op.alter_column("article_publications", "attempt_count", new_column_name="attempt")
    op.create_check_constraint("ck_article_publications_status", "article_publications", "status IN ('submitting','published','failed','uncertain')")
    op.create_check_constraint("ck_article_publications_attempt", "article_publications", "attempt > 0")
    op.create_index(
        "uq_article_publications_active_article",
        "article_publications",
        ["article_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('submitting','uncertain')"),
    )
    op.drop_index("ix_article_preview_snapshots_expiry", table_name="article_preview_snapshots")
    op.drop_table("article_preview_snapshots")
    op.drop_table("publication_targets")
