"""Store complete business profile AI invocation records.

Revision ID: 20260811_0053
Revises: 20260811_0052
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260811_0053"
down_revision: str | Sequence[str] | None = "20260811_0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "business_profile_ai_calls",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawling.crawl_runs.run_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("request_json", postgresql.JSONB(), nullable=False),
        sa.Column("http_status", sa.Integer()),
        sa.Column("raw_response_json", postgresql.JSONB()),
        sa.Column("raw_response_body", sa.Text()),
        sa.Column("raw_model_output", sa.Text()),
        sa.Column("parsed_output_json", postgresql.JSONB()),
        sa.Column("elapsed_ms", sa.BigInteger(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer()),
        sa.Column("completion_tokens", sa.Integer()),
        sa.Column("total_tokens", sa.Integer()),
        sa.Column("cost_usd", sa.Numeric(18, 8)),
        sa.Column("error_type", sa.Text()),
        sa.Column("error_message", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        schema="crawling",
    )
    op.create_index(
        "ix_business_profile_ai_calls_run_id",
        "business_profile_ai_calls",
        ["run_id"],
        schema="crawling",
    )
    op.execute(
        """
        ALTER TABLE crawling.business_profile_ai_calls
          OWNER TO growthos_crawling_owner;
        ALTER SEQUENCE crawling.business_profile_ai_calls_id_seq
          OWNER TO growthos_crawling_owner;
        REVOKE ALL ON crawling.business_profile_ai_calls FROM PUBLIC;
        REVOKE ALL ON SEQUENCE crawling.business_profile_ai_calls_id_seq
          FROM PUBLIC;
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON crawling.business_profile_ai_calls
          TO growthos_crawling_writer;
        GRANT USAGE, SELECT
          ON SEQUENCE crawling.business_profile_ai_calls_id_seq
          TO growthos_crawling_writer;
        GRANT SELECT ON crawling.business_profile_ai_calls
          TO growthos_reporting_reader;

        ALTER TABLE crawling.business_profile_ai_calls
          ENABLE ROW LEVEL SECURITY;
        ALTER TABLE crawling.business_profile_ai_calls
          FORCE ROW LEVEL SECURITY;

        CREATE POLICY crawling_business_profile_ai_calls_tenant_policy
          ON crawling.business_profile_ai_calls
          USING (
            organization_id = NULLIF(
              current_setting('app.current_organization_id', true), ''
            )
            AND project_id = NULLIF(
              current_setting('app.current_project_id', true), ''
            )
          )
          WITH CHECK (
            organization_id = NULLIF(
              current_setting('app.current_organization_id', true), ''
            )
            AND project_id = NULLIF(
              current_setting('app.current_project_id', true), ''
            )
            AND EXISTS (
              SELECT 1
              FROM crawling.crawl_runs
              WHERE crawl_runs.run_id = business_profile_ai_calls.run_id
            )
          );
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_business_profile_ai_calls_run_id",
        table_name="business_profile_ai_calls",
        schema="crawling",
    )
    op.drop_table("business_profile_ai_calls", schema="crawling")
