"""Add bounded delivery control to Website Project outbox events.

Revision ID: 20260825_0066
Revises: 20260815_0065
Create Date: 2026-08-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260825_0066"
down_revision: str | Sequence[str] | None = "20260815_0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE platform.project_outbox_events
          ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
          ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
          ADD COLUMN retryable boolean NOT NULL DEFAULT true,
          ADD COLUMN failure_code text,
          ADD CONSTRAINT project_outbox_attempt_count_check
            CHECK (attempt_count >= 0);

        UPDATE platform.project_outbox_events
           SET attempt_count = GREATEST(attempt_count, 1),
               retryable = CASE
                 WHEN last_error ~ '^HTTP (408|425|429|5[0-9]{2}):'
                   THEN true
                 WHEN last_error ~ '^HTTP 4[0-9]{2}:'
                   THEN false
                 ELSE true
               END,
               failure_code = CASE
                 WHEN last_error ~ '^HTTP (408|425|429|5[0-9]{2}):'
                   THEN 'upstream_retryable'
                 WHEN last_error ~ '^HTTP 4[0-9]{2}:'
                   THEN 'upstream_rejected'
                 ELSE 'delivery_error'
               END,
               next_attempt_at = now()
         WHERE status = 'failed';

        CREATE INDEX ix_project_outbox_events_delivery_due
          ON platform.project_outbox_events
            (next_attempt_at, created_at, id)
          WHERE status = 'pending'
             OR (status = 'failed' AND retryable);
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "Forward-only migration: restore the verified pre-migration backup instead."
    )
