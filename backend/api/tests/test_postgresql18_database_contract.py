import os
import psycopg
import pytest


DATABASE_URL = os.getenv("SEO4_INT_004_DATABASE_URL")

PLATFORM_TABLES = {
    "project_audit_events",
    "project_outbox_events",
    "projects",
    "promotion_target_versions",
    "site_profiles",
    "website_profile_versions",
}
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
    "backlink_website_project_mailbox_bindings",
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
COST_CONTROL_TABLES = {
    "provider_artifact_usages",
    "provider_artifacts",
    "provider_batch_requests",
    "provider_fetch_leases",
    "workspace_evidence_projections",
}
COMMERCIAL_DISCOVERY_TABLES = {
    "backlink_commercial_candidates",
    "backlink_commercial_discovery_artifacts",
    "backlink_commercial_discovery_batches",
    "backlink_commercial_discovery_blueprints",
    "backlink_commercial_gold_labels",
    "backlink_commercial_gold_sets",
    "backlink_commercial_inventory_policies",
}
CONTACT_PUBLICATION_TABLES = {
    "backlink_contact_enrichment_batches",
    "backlink_contact_evidence_snapshots",
}
DRAFT_REQUEST_TABLES = {"backlink_draft_request_snapshots"}
GMAIL_REPLY_LOOP_TABLES = {"backlink_gmail_connection_sync_cursors"}
PROFILE_INVENTORY_TABLES = {
    "backlink_inventory_items",
    "backlink_inventory_observations",
    "backlink_profile_health_snapshots",
    "backlink_profile_provider_artifacts",
    "backlink_profile_snapshots",
    "backlink_profile_sync_cursors",
    "backlink_profile_sync_jobs",
}
INVENTORY_MONITORING_TABLES = {
    "backlink_inventory_monitor_observations",
    "backlink_inventory_monitor_policies",
    "backlink_inventory_monitor_requests",
    "backlink_inventory_monitor_runs",
}
RESOURCE_LIBRARY_TABLES = {"backlink_resource_library_items"}
CONTACT_PURPOSE_COLUMNS = {
    "observed_role",
    "inferred_purpose",
    "purpose_confidence",
    "purpose_rule_version",
    "purpose_evidence",
}
PROJECT_RECOMMENDATION_CONTEXT_COLUMNS = {
    "partnership_goals",
    "products",
    "keywords",
    "target_audiences",
    "target_market",
    "target_urls",
}

ORGANIZATION_ID = "seo4-int-004-organization"
PROJECT_ID = "seo4-int-004-project"
OTHER_PROJECT_ID = "seo4-int-004-other-project"
WORKSPACE_ID = "seo4-int-004-workspace"
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
    connection.execute("RESET app.current_workspace_id")


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
        == "20260813_0010"
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
    assert len(by_schema["backlinks"]) == 99
    assert ASSESSMENT_TABLES <= by_schema["backlinks"]
    assert DRAFT_TABLES <= by_schema["backlinks"]
    assert GMAIL_AUTH_TABLES <= by_schema["backlinks"]
    assert SEND_PERSISTENCE_TABLES <= by_schema["backlinks"]
    assert MAIL_SYNC_TABLES <= by_schema["backlinks"]
    assert PLACEMENT_TABLES <= by_schema["backlinks"]
    assert COST_CONTROL_TABLES <= by_schema["backlinks"]
    assert COMMERCIAL_DISCOVERY_TABLES <= by_schema["backlinks"]
    assert CONTACT_PUBLICATION_TABLES <= by_schema["backlinks"]
    assert DRAFT_REQUEST_TABLES <= by_schema["backlinks"]
    assert GMAIL_REPLY_LOOP_TABLES <= by_schema["backlinks"]
    assert PROFILE_INVENTORY_TABLES <= by_schema["backlinks"]
    assert INVENTORY_MONITORING_TABLES <= by_schema["backlinks"]
    assert RESOURCE_LIBRARY_TABLES <= by_schema["backlinks"]

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

    project_context_columns = {
        row[0]
        for row in connection.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'backlinks'
              AND table_name = 'backlink_project_context_snapshots'
            """
        ).fetchall()
    }
    assert PROJECT_RECOMMENDATION_CONTEXT_COLUMNS <= project_context_columns
    assert fetch_scalar(
        connection,
        """
        SELECT to_regprocedure(
          'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'
        ) IS NOT NULL
        """,
    )
    project_scope_function = fetch_scalar(
        connection,
        """
        SELECT pg_get_functiondef(
          'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'::regprocedure
        )
        """,
    )
    assert "platform.backlink_list_active_website_projects" in project_scope_function

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
    for table in (
        "project_outbox_events",
        "project_audit_events",
        "promotion_target_versions",
        "website_profile_versions",
    ):
        connection.execute(
            f"DELETE FROM platform.{table} WHERE project_id IN (%s, %s)",
            (PROJECT_ID, OTHER_PROJECT_ID),
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
          id, organization_id, workspace_id, project_key, name, domain,
          country, target_market, language
        ) VALUES (
          %s, %s, %s, 'seo4-int-004', 'SEO4 INT 004',
          'seo4-int-004.example', 'US', 'United States', 'en'
        )
        """,
        (PROJECT_ID, ORGANIZATION_ID, WORKSPACE_ID),
    )
    connection.execute(
        """
        INSERT INTO platform.website_profile_versions (
          id, organization_id, workspace_id, project_id, version, name,
          canonical_domain, country_code, target_market, locale, products,
          input_required, created_by
        ) VALUES (
          'seo4-int-004-profile-v1', %s, %s, %s, 1, 'SEO4 INT 004',
          'seo4-int-004.example', 'US', 'United States', 'en',
          '["SEO"]'::jsonb, '[]'::jsonb, 'seo4-int-004'
        )
        """,
        (ORGANIZATION_ID, WORKSPACE_ID, PROJECT_ID),
    )
    connection.execute(
        """
        INSERT INTO platform.promotion_target_versions (
          id, organization_id, workspace_id, project_id, version, keywords,
          target_urls, target_audiences, partnership_goals, input_required,
          created_by
        ) VALUES (
          'seo4-int-004-promotion-v1', %s, %s, %s, 1,
          '["technical seo"]'::jsonb,
          '["https://seo4-int-004.example/"]'::jsonb,
          '["SEO teams"]'::jsonb,
          '["Earn editorial links"]'::jsonb,
          '[]'::jsonb, 'seo4-int-004'
        )
        """,
        (ORGANIZATION_ID, WORKSPACE_ID, PROJECT_ID),
    )
    connection.execute(
        """
        UPDATE platform.projects
           SET current_profile_version_id = 'seo4-int-004-profile-v1',
               current_promotion_target_version_id =
                 'seo4-int-004-promotion-v1'
         WHERE id = %s
        """,
        (PROJECT_ID,),
    )
    expect_sqlstate(
        connection,
        """
        INSERT INTO platform.projects (
          id, organization_id, workspace_id, project_key, name, domain,
          country, target_market, language
        ) VALUES (
          'seo4-int-004-other-project',
          'seo4-int-004-organization',
          'seo4-int-004-workspace',
          'seo4-int-004-other',
          'Wrong project',
          'seo4-int-004-other.example',
          'US',
          'United States',
          'en'
        )
        """,
    )
    reset_session(connection)

    connection.execute("SET ROLE growthos_backlinks_owner")
    connection.execute(
        "SELECT set_config('app.current_organization_id', %s, false)",
        (ORGANIZATION_ID,),
    )
    connection.execute(
        "SELECT set_config('app.current_workspace_id', %s, false)",
        (WORKSPACE_ID,),
    )
    connection.execute(
        "SELECT set_config('app.current_project_id', '', false)",
    )
    assert fetch_scalar(
        connection,
        """
        SELECT count(*)
          FROM platform.backlink_list_active_website_projects(
            'seo4-int-004-organization',
            'seo4-int-004-workspace'
          )
         WHERE website_project_id = 'seo4-int-004-project'
           AND context_version = 1
        """,
    ) == 1
    expect_sqlstate(connection, "SELECT count(*) FROM platform.projects")
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
          id, organization_id, workspace_id, project_key, name, domain,
          country, target_market, language
        ) VALUES (
          'seo4-int-004-other-project',
          'seo4-int-004-organization',
          'seo4-int-004-workspace',
          'seo4-int-004-cross-schema',
          'Cross schema write',
          'seo4-int-004-cross-schema.example',
          'US',
          'United States',
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
