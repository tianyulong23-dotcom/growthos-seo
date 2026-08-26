"""Merge current Platform head with frozen Website Project authority.

Revision ID: 20260815_0065
Revises: 20260814_0064, 20260813_0010
Create Date: 2026-08-15
"""

from collections.abc import Sequence

from alembic import op


revision: str = "20260815_0065"
down_revision: str | Sequence[str] | None = (
    "20260814_0064",
    "20260813_0010",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE platform.projects
          ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1,
          ADD COLUMN archive_reason text;

        UPDATE platform.projects
           SET workspace_id = COALESCE(workspace_id, 'local'),
               archived_at = CASE
                 WHEN status = 'ARCHIVED'
                   THEN COALESCE(archived_at, updated_at, created_at, now())
                 ELSE NULL
               END,
               archive_reason = CASE
                 WHEN status = 'ARCHIVED' THEN 'LEGACY_ARCHIVE'
                 ELSE NULL
               END;

        ALTER TABLE platform.projects
          ALTER COLUMN workspace_id SET NOT NULL,
          ADD CONSTRAINT projects_workspace_id_not_blank_check
            CHECK (length(trim(workspace_id)) > 0),
          ADD CONSTRAINT projects_lifecycle_version_check
            CHECK (lifecycle_version > 0),
          ADD CONSTRAINT projects_archive_state_check
            CHECK (
              (
                status = 'ACTIVE'
                AND archived_at IS NULL
                AND archive_reason IS NULL
              )
              OR (
                status = 'ARCHIVED'
                AND archived_at IS NOT NULL
                AND length(trim(archive_reason)) > 0
              )
            );
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "Forward-only merge: restore the verified pre-migration backup instead."
    )
