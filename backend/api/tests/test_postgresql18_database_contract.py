import os
import psycopg
import pytest


DATABASE_URL = os.getenv("SEO4_INT_004_DATABASE_URL")

PLATFORM_TABLES = {"projects", "site_profiles"}
CRAWLING_TABLES = {
    "backlink_checks",
    "crawl_checkpoints",
    "crawl_runs",
    "external_resources",
    "link_edges",
    "page_snapshots",
    "pages",
}
AUDIT_TABLES = {"audit_issues", "pagespeed_results"}
ASSESSMENT_TABLES = {
    "backlink_assessment_runs",
    "backlink_assessment_snapshots",
}
DRAFT_TABLES = {
    "backlink_draft_versions",
    "backlink_email_drafts",
    "backlink_evidence_snapshots",
    "backlink_model_runs",
}
GMAIL_AUTH_TABLES = {
    "backlink_gmail_connection_revocations",
    "backlink_gmail_connections",
    "backlink_gmail_send_identities",
    "backlink_gmail_workspace_bindings",
    "backlink_oauth_attempts",
    "backlink_secret_references",
}
SEND_PERSISTENCE_TABLES = {
    "backlink_rate_limit_reservations",
    "backlink_send_attempts",
    "backlink_send_intents",
    "backlink_send_reconciliations",
    "backlink_suppression_entries",
    "backlink_suppression_feedback_events",
}
MAIL_SYNC_TABLES = {
    "backlink_inbound_messages",
    "backlink_mail_messages",
    "backlink_mail_raw_message_references",
    "backlink_mail_sync_cursors",
    "backlink_mail_threads",
    "backlink_negotiation_fact_versions",
    "backlink_reply_classification_versions",
    "backlink_reply_match_candidates",
}
PLACEMENT_TABLES = {
    "backlink_monitor_observations",
    "backlink_monitor_policies",
    "backlink_monitor_runs",
    "backlink_placement_candidates",
    "backlink_placement_validation_runs",
    "backlink_placements",
}
CONTACT_PURPOSE_COLUMNS = {
    "observed_role",
    "inferred_purpose",
    "purpose_confidence",
    "purpose_rule_version",
    "purpose_evidence",
}

ORGANIZATION_ID = "seo4-int-004-organization"
PROJECT_ID = "seo4-int-004-project"
OTHER_PROJECT_ID = "seo4-int-004-other-project"
RUN_ID = "seo4-int-004-run"
BACKLINKS_ORGANIZATION_ID = "018f0000-0000-7000-8000-000000000801"
BACKLINKS_WORKSPACE_ID = "018f0000-0000-7000-8000-000000000802"
BACKLINKS_PROJECT_ID = "018f0000-0000-7000-8000-000000000803"


@pytest.fixture
def connection() -> psycopg.Connection:
    if DATABASE_URL is None:
        pytest.skip("SEO4_INT_004_DATABASE_URL is required for the PostgreSQL 18 gate")

    with psycopg.connect(DATABASE_URL, autocommit=True) as opened:
        yield opened


def fetch_scalar(connection: psycopg.Connection, query: str) -> object:
    row = connection.execute(query).fetchone()
    assert row is not None
    return row[0]


def expect_sqlstate(
    connection: psycopg.Connection,
    query: str,
    sqlstate: str = "42501",
) -> None:
    with pytest.raises(psycopg.Error) as caught:
        connection.execute(query)
    assert caught.value.sqlstate == sqlstate


def set_tenant_context(
    connection: psycopg.Connection,
    organization_id: str = ORGANIZATION_ID,
    project_id: str = PROJECT_ID,
) -> None:
    connection.execute(
        "SELECT set_config('app.current_organization_id', %s, false)",
        (organization_id,),
    )
    connection.execute(
        "SELECT set_config('app.current_project_id', %s, false)",
        (project_id,),
    )


def reset_session(connection: psycopg.Connection) -> None:
    connection.execute("RESET ROLE")
    connection.execute("RESET app.current_organization_id")
    connection.execute("RESET app.current_project_id")


def set_backlinks_context(
    connection: psycopg.Connection,
    project_id: str = BACKLINKS_PROJECT_ID,
) -> None:
    connection.execute(
        "SELECT set_config('app.current_workspace_id', %s, false)",
        (BACKLINKS_WORKSPACE_ID,),
    )
    connection.execute(
        "SELECT set_config('app.current_website_project_id', %s, false)",
        (project_id,),
    )


def reset_backlinks_session(connection: psycopg.Connection) -> None:
    connection.execute("RESET ROLE")
    connection.execute("RESET app.current_workspace_id")
    connection.execute("RESET app.current_website_project_id")


def test_postgresql18_dual_migration_contract(connection: psycopg.Connection) -> None:
    assert int(fetch_scalar(connection, "SHOW server_version_num")) // 10000 == 18
    assert (
        fetch_scalar(connection, "SELECT version_num FROM public.alembic_version")
        == "20260724_0007"
    )

    rows = connection.execute(
        """
        SELECT namespace.nspname, relation.relname, owner.rolname,
          relation.relrowsecurity, relation.relforcerowsecurity
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid = relation.relowner
        WHERE namespace.nspname IN ('platform', 'crawling', 'audit', 'backlinks')
          AND relation.relkind = 'r'
        ORDER BY namespace.nspname, relation.relname
        """
    ).fetchall()
    by_schema: dict[str, set[str]] = {}
    expected_owners = {
        "platform": "growthos_platform_owner",
        "crawling": "growthos_crawling_owner",
        "audit": "growthos_audit_owner",
        "backlinks": "growthos_backlinks_owner",
    }
    for schema, table, owner, rls_enabled, rls_forced in rows:
        by_schema.setdefault(schema, set()).add(table)
        assert owner == expected_owners[schema]
        assert rls_enabled is True
        assert rls_forced is True

    assert by_schema["platform"] == PLATFORM_TABLES
    assert by_schema["crawling"] == CRAWLING_TABLES
    assert by_schema["audit"] == AUDIT_TABLES
    assert len(by_schema["backlinks"]) == 57
    assert ASSESSMENT_TABLES <= by_schema["backlinks"]
    assert DRAFT_TABLES <= by_schema["backlinks"]
    assert GMAIL_AUTH_TABLES <= by_schema["backlinks"]
    assert SEND_PERSISTENCE_TABLES <= by_schema["backlinks"]
    assert MAIL_SYNC_TABLES <= by_schema["backlinks"]
    assert PLACEMENT_TABLES <= by_schema["backlinks"]

    for table in ("backlink_contact_candidates", "backlink_contacts"):
        columns = {
            row[0]
            for row in connection.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'backlinks'
                  AND table_name = %s
                """,
                (table,),
            ).fetchall()
        }
        assert CONTACT_PURPOSE_COLUMNS <= columns

    hardened_roles = connection.execute(
        """
        SELECT rolname
        FROM pg_roles
        WHERE rolname LIKE 'growthos_%'
          AND NOT rolsuper
          AND NOT rolinherit
          AND NOT rolcreaterole
          AND NOT rolcreatedb
          AND NOT rolcanlogin
          AND NOT rolreplication
          AND NOT rolbypassrls
        ORDER BY rolname
        """
    ).fetchall()
    assert len(hardened_roles) == 15

    search_paths = dict(
        connection.execute(
            """
            SELECT roles.rolname, setting
            FROM pg_db_role_setting AS role_setting
            JOIN pg_roles AS roles ON roles.oid = role_setting.setrole
            CROSS JOIN LATERAL unnest(role_setting.setconfig) AS setting
            WHERE setting LIKE 'search_path=%'
            """
        ).fetchall()
    )
    assert search_paths["growthos_platform_writer"] == "search_path=platform, pg_catalog"
    assert search_paths["growthos_crawling_writer"] == (
        "search_path=crawling, platform, pg_catalog"
    )
    assert search_paths["growthos_audit_writer"] == ("search_path=audit, crawling, pg_catalog")
    assert search_paths["growthos_gateway"] == "search_path=pg_catalog"

    connection.execute(
        "DELETE FROM audit.audit_issues WHERE run_id = %s",
        (RUN_ID,),
    )
    connection.execute(
        "DELETE FROM crawling.crawl_runs WHERE run_id = %s",
        (RUN_ID,),
    )
    connection.execute(
        "DELETE FROM platform.projects WHERE id IN (%s, %s)",
        (PROJECT_ID, OTHER_PROJECT_ID),
    )

    connection.execute("SET ROLE growthos_platform_writer")
    set_tenant_context(connection)
    connection.execute(
        """
        INSERT INTO platform.projects (
          id, organization_id, name, domain, country, language
        ) VALUES (%s, %s, 'SEO4 INT 004', 'seo4-int-004.example', 'US', 'en')
        """,
        (PROJECT_ID, ORGANIZATION_ID),
    )
    expect_sqlstate(
        connection,
        """
        INSERT INTO platform.projects (
          id, organization_id, name, domain, country, language
        ) VALUES (
          'seo4-int-004-other-project',
          'seo4-int-004-organization',
          'Wrong project',
          'seo4-int-004-other.example',
          'US',
          'en'
        )
        """,
    )
    reset_session(connection)

    connection.execute("SET ROLE growthos_crawling_writer")
    set_tenant_context(connection)
    connection.execute(
        """
        INSERT INTO crawling.crawl_runs (
          run_id, organization_id, project_id, task_type, status
        ) VALUES (%s, %s, %s, 'technical_audit', 'running')
        """,
        (RUN_ID, ORGANIZATION_ID, PROJECT_ID),
    )
    expect_sqlstate(
        connection,
        """
        INSERT INTO platform.projects (
          id, organization_id, name, domain, country, language
        ) VALUES (
          'seo4-int-004-other-project',
          'seo4-int-004-organization',
          'Cross schema write',
          'seo4-int-004-cross-schema.example',
          'US',
          'en'
        )
        """,
    )
    reset_session(connection)

    connection.execute("SET ROLE growthos_audit_writer")
    set_tenant_context(connection)
    connection.execute(
        """
        INSERT INTO audit.audit_issues (
          run_id, url, severity, category, code, issue, details
        ) VALUES (
          %s,
          'https://seo4-int-004.example/',
          'warning',
          'ownership',
          'SEO4_INT_004',
          'Contract probe',
          'PostgreSQL 18 role and RLS verification'
        )
        """,
        (RUN_ID,),
    )
    expect_sqlstate(
        connection,
        f"UPDATE crawling.crawl_runs SET status = 'completed' WHERE run_id = '{RUN_ID}'",
    )
    reset_session(connection)

    connection.execute("SET ROLE growthos_reporting_reader")
    set_tenant_context(connection)
    assert (
        fetch_scalar(
            connection,
            f"SELECT count(*) FROM platform.projects WHERE id = '{PROJECT_ID}'",
        )
        == 1
    )
    assert (
        fetch_scalar(
            connection,
            f"SELECT count(*) FROM crawling.crawl_runs WHERE run_id = '{RUN_ID}'",
        )
        == 1
    )
    assert (
        fetch_scalar(
            connection,
            f"SELECT count(*) FROM audit.audit_issues WHERE run_id = '{RUN_ID}'",
        )
        == 1
    )
    expect_sqlstate(
        connection,
        f"DELETE FROM audit.audit_issues WHERE run_id = '{RUN_ID}'",
    )
    reset_session(connection)

    connection.execute("SET ROLE growthos_gateway")
    expect_sqlstate(connection, "SELECT count(*) FROM platform.projects")
    reset_session(connection)

    connection.execute("SET ROLE growthos_platform_owner")
    assert fetch_scalar(connection, "SELECT count(*) FROM platform.projects") == 0
    reset_session(connection)
