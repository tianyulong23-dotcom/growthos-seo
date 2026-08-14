"""Add the versioned article editor, autosave, and asset foundation.

Revision ID: 20260808_0041
Revises: 20260808_0040
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260808_0041"
down_revision: str | Sequence[str] | None = "20260808_0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.add_column(
        "articles",
        sa.Column(
            "document_schema_version", sa.Integer(), nullable=False, server_default="2"
        ),
    )
    op.add_column(
        "articles",
        sa.Column("current_content_hash", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "articles",
        sa.Column("current_version_number", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("articles", sa.Column("approved_version_number", sa.Integer()))

    op.add_column(
        "article_versions",
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default="2"),
    )
    op.add_column(
        "article_versions",
        sa.Column(
            "document_snapshot", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )
    op.add_column(
        "article_versions",
        sa.Column(
            "metadata_snapshot", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )
    op.add_column(
        "article_versions",
        sa.Column(
            "asset_manifest", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
    )
    op.add_column(
        "article_versions",
        sa.Column("content_hash", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column("article_versions", sa.Column("parent_version_number", sa.Integer()))
    op.add_column("article_versions", sa.Column("source_version_number", sa.Integer()))
    op.add_column("article_versions", sa.Column("reason", sa.Text()))
    op.add_column(
        "article_versions",
        sa.Column(
            "retention_protected", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.execute(
        """
        UPDATE article_versions
        SET document_snapshot = COALESCE(content_json->'document', '{}'::jsonb),
            metadata_snapshot = jsonb_strip_nulls(jsonb_build_object(
                'title', content_json->'title',
                'slug', content_json->'slug',
                'meta_title', content_json->'meta_title',
                'meta_description', content_json->'meta_description',
                'publication_status', content_json->'publication_status'
            )),
            retention_protected = version_type IN ('final', 'generated', 'review_submitted', 'review_decision', 'restored', 'published')
        """
    )
    op.execute(
        """
        UPDATE articles AS a
        SET current_version_number = COALESCE(v.max_version, 0)
        FROM (
            SELECT article_id, MAX(version_number) AS max_version
            FROM article_versions
            GROUP BY article_id
        ) AS v
        WHERE v.article_id = a.id
        """
    )

    op.create_table(
        "article_autosaves",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "article_id",
            sa.Text(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("base_version_number", sa.Integer(), nullable=False),
        sa.Column("base_review_version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("document_snapshot", jsonb, nullable=False),
        sa.Column("metadata_snapshot", jsonb, nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("promoted_version_number", sa.Integer()),
        sa.CheckConstraint("sequence > 0", name="ck_article_autosaves_sequence"),
        sa.CheckConstraint(
            "base_version_number >= 0", name="ck_article_autosaves_base_version"
        ),
        sa.UniqueConstraint(
            "article_id",
            "user_id",
            "client_id",
            "sequence",
            name="uq_article_autosaves_client_sequence",
        ),
        sa.UniqueConstraint(
            "article_id",
            "user_id",
            "idempotency_key",
            name="uq_article_autosaves_idempotency",
        ),
    )
    op.create_index(
        "ix_article_autosaves_latest",
        "article_autosaves",
        ["article_id", "user_id", "client_id", sa.text("sequence DESC")],
    )
    op.create_index("ix_article_autosaves_expiry", "article_autosaves", ["expires_at"])

    op.create_table(
        "content_assets",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("asset_type", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("original_filename", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.Text()),
        sa.Column("detected_mime_type", sa.Text()),
        sa.Column("byte_size", sa.Integer()),
        sa.Column("content_hash", sa.Text()),
        sa.Column("storage_key", sa.Text()),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("duration_ms", sa.Integer()),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text()),
        sa.Column("final_source_url", sa.Text()),
        sa.Column("failure_code", sa.Text()),
        sa.Column("failure_detail", sa.Text()),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("ready_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "asset_type IN ('image','video','audio','file')",
            name="ck_content_assets_type",
        ),
        sa.CheckConstraint(
            "status IN ('pending','uploading','uploaded','processing','ready','failed','quarantined','deleted')",
            name="ck_content_assets_status",
        ),
        sa.UniqueConstraint(
            "project_id", "content_hash", name="uq_content_assets_project_hash"
        ),
    )
    op.create_index(
        "ix_content_assets_project_created",
        "content_assets",
        ["project_id", sa.text("created_at DESC")],
    )

    op.create_table(
        "asset_variants",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey("content_assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("variant_type", sa.Text(), nullable=False),
        sa.Column("transform_version", sa.Integer(), nullable=False),
        sa.Column("format", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.UniqueConstraint(
            "asset_id",
            "variant_type",
            "transform_version",
            name="uq_asset_variants_transform",
        ),
    )
    op.create_index("ix_asset_variants_asset", "asset_variants", ["asset_id"])

    op.create_table(
        "article_asset_bindings",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "article_id",
            sa.Text(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version_number", sa.Integer()),
        sa.Column("node_id", sa.Text(), nullable=False),
        sa.Column("item_id", sa.Text()),
        sa.Column(
            "asset_id",
            sa.Text(),
            sa.ForeignKey("content_assets.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("binding_role", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("removed_at", sa.DateTime(timezone=True)),
    )
    op.create_index(
        "uq_article_asset_bindings_active",
        "article_asset_bindings",
        [
            "article_id",
            sa.text("COALESCE(version_number, 0)"),
            "node_id",
            sa.text("COALESCE(item_id, '')"),
            "asset_id",
            "binding_role",
        ],
        unique=True,
        postgresql_where=sa.text("removed_at IS NULL"),
    )
    op.create_index(
        "ix_article_asset_bindings_asset", "article_asset_bindings", ["asset_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_article_asset_bindings_asset", table_name="article_asset_bindings")
    op.drop_index("uq_article_asset_bindings_active", table_name="article_asset_bindings")
    op.drop_table("article_asset_bindings")
    op.drop_index("ix_asset_variants_asset", table_name="asset_variants")
    op.drop_table("asset_variants")
    op.drop_index("ix_content_assets_project_created", table_name="content_assets")
    op.drop_table("content_assets")
    op.drop_index("ix_article_autosaves_expiry", table_name="article_autosaves")
    op.drop_index("ix_article_autosaves_latest", table_name="article_autosaves")
    op.drop_table("article_autosaves")

    op.drop_column("article_versions", "retention_protected")
    op.drop_column("article_versions", "reason")
    op.drop_column("article_versions", "source_version_number")
    op.drop_column("article_versions", "parent_version_number")
    op.drop_column("article_versions", "content_hash")
    op.drop_column("article_versions", "asset_manifest")
    op.drop_column("article_versions", "metadata_snapshot")
    op.drop_column("article_versions", "document_snapshot")
    op.drop_column("article_versions", "schema_version")
    op.drop_column("articles", "approved_version_number")
    op.drop_column("articles", "current_version_number")
    op.drop_column("articles", "current_content_hash")
    op.drop_column("articles", "document_schema_version")
