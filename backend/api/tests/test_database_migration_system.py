import ast
import hashlib
import importlib.util
import json
from pathlib import Path

from alembic.script import ScriptDirectory


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ALEMBIC_VERSIONS = REPOSITORY_ROOT / "backend" / "api" / "migrations" / "versions"
BACKLINKS_MIGRATIONS = (
    REPOSITORY_ROOT / "backend" / "core" / "src" / "modules" / "backlinks" / "db" / "migrations"
)
BOOTSTRAP = REPOSITORY_ROOT / "backend" / "database" / "roles" / "0001_growthos_schema_roles.sql"
MANIFEST = REPOSITORY_ROOT / "backend" / "database" / "deployment-manifest.v1.json"

SOURCE_ALEMBIC_REVISIONS = [
    "20260720_0001_crawler_storage.py",
    "20260721_0002_projects.py",
    "20260721_0003_site_understanding.py",
    "20260721_0004_audit_parity.py",
    "20260722_0005_audit_run_state.py",
    "20260722_0006_audit_external_resources.py",
]
BRIDGE_REVISION = "20260724_0007_schema_ownership.py"
BACKLINKS_REVISIONS = [
    "0001_backlink_foundation.sql",
    "0002_backlink_provider_seo.sql",
    "0003_backlink_recommendations.sql",
    "0004_backlink_contacts_opportunities.sql",
    "0005_backlink_schema_role_ownership.sql",
    "0006_backlink_opportunities.sql",
    "0007_backlink_opportunity_counter.sql",
    "0010_backlink_assessments.sql",
    "0011_backlink_contact_purpose_correction.sql",
    "0012_backlink_gmail_connections.sql",
    "0013_backlink_drafts.sql",
    "0014_backlink_send_intents.sql",
    "0015_backlink_gmail_sync_capabilities.sql",
    "0016_backlink_mail_sync.sql",
    "0022_backlink_draft_documents.sql",
    "0023_backlink_send_quota_connection_scope.sql",
    "0024_backlink_send_attempt_settlement.sql",
    "0025_backlink_send_reconciliation.sql",
    "0026_backlink_suppression_feedback.sql",
    "0027_backlink_negotiation_facts.sql",
    "0028_backlink_placements.sql",
    "0029_backlink_monitoring.sql",
    "0030_backlink_metrics_reports.sql",
    "0031_backlink_tasks_notifications.sql",
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def test_imports_the_frozen_source_alembic_chain_and_adds_one_bridge() -> None:
    expected = SOURCE_ALEMBIC_REVISIONS + [BRIDGE_REVISION]
    actual = {path.name for path in ALEMBIC_VERSIONS.glob("*.py")}
    assert set(expected) <= actual

    bridge = (ALEMBIC_VERSIONS / BRIDGE_REVISION).read_text(encoding="utf-8")
    assert 'down_revision: str | Sequence[str] | None = "20260722_0006"' in bridge
    assert "SET SCHEMA platform" in bridge
    assert "SET SCHEMA crawling" in bridge
    assert "SET SCHEMA audit" in bridge
    assert "ENABLE ROW LEVEL SECURITY" in bridge
    assert "FORCE ROW LEVEL SECURITY" in bridge
    assert "DROP TABLE" not in bridge.upper()


def test_alembic_revision_graph_has_unique_ids_and_one_head() -> None:
    revision_ids: list[str] = []
    down_revisions: list[str] = []
    for path in ALEMBIC_VERSIONS.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        values: dict[str, object] = {}
        for node in tree.body:
            if (
                isinstance(node, ast.AnnAssign)
                and isinstance(node.target, ast.Name)
                and node.target.id in {"revision", "down_revision"}
                and node.value is not None
            ):
                values[node.target.id] = ast.literal_eval(node.value)
        revision = values.get("revision")
        assert isinstance(revision, str), f"missing revision in {path.name}"
        revision_ids.append(revision)
        parents = values.get("down_revision")
        if isinstance(parents, str):
            down_revisions.append(parents)
        elif isinstance(parents, tuple):
            down_revisions.extend(parents)

    assert len(revision_ids) == len(set(revision_ids))
    assert set(down_revisions) <= set(revision_ids)

    scripts = ScriptDirectory(str(ALEMBIC_VERSIONS.parent))
    heads = scripts.get_heads()
    assert len(heads) == 1
    assert heads[0] in revision_ids


def test_onboarding_timeline_migration_tolerates_missing_legacy_constraint() -> None:
    migration = (
        ALEMBIC_VERSIONS / "20260812_0060_onboarding_agent_timeline.py"
    ).read_text(encoding="utf-8")

    assert migration.count(
        "DROP CONSTRAINT IF EXISTS ck_agent_timeline_events_status"
    ) == 2
    assert "status IN ('running','waiting','completed','failed','cancelled')" in migration


def test_publication_migration_backfills_only_provable_wordpress_targets() -> None:
    path = ALEMBIC_VERSIONS / "20260810_0048_article_preview_publication_orchestration.py"
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    statements = [str(statement) for statement in migration.legacy_wordpress_backfill_statements()]
    assert len(statements) == 2
    insert_target, bind_publications = statements
    assert "FROM wordpress_project_connections" in insert_target
    assert "JOIN projects" in insert_target
    assert "connection.verified_at IS NOT NULL" in insert_target
    assert "'legacy-wordpress-' || md5(connection.project_id)" in insert_target
    assert "'wordpress-project:' || connection.project_id" in insert_target
    assert "ON CONFLICT (project_id, adapter_type) DO NOTHING" in insert_target
    assert "publication.organization_id = target.organization_id" in bind_publications
    assert "publication.target_id IS NULL" in bind_publications


def test_shared_bootstrap_declares_crawling_roles_and_schema() -> None:
    sql = BOOTSTRAP.read_text(encoding="utf-8")
    for fragment in (
        "'growthos_crawling_owner'",
        "'growthos_crawling_writer'",
        "CREATE SCHEMA IF NOT EXISTS crawling AUTHORIZATION growthos_crawling_owner",
        "GRANT USAGE ON SCHEMA crawling TO growthos_crawling_writer",
    ):
        assert fragment in sql


def test_frozen_deployment_manifest_keeps_fixed_checksums() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == 1
    assert manifest["postgresql"]["requiredMajor"] == 18
    assert manifest["postgresql"]["image"].startswith("postgres:18-bookworm@sha256:")
    assert manifest["recoveryPolicy"] == "restore-or-forward-only"
    assert manifest["schemaOwners"] == {
        "audit": "ROLE-AUDIT",
        "backlinks": "ROLE-BACKLINKS",
        "crawling": "ROLE-CRAWLER",
        "platform": "ROLE-PLATFORM-CONTEXT",
    }

    steps = manifest["steps"]
    assert [step["order"] for step in steps] == sorted(step["order"] for step in steps)
    assert len({step["migrationId"] for step in steps}) == len(steps)

    expected_paths = {
        "backend/database/roles/0001_growthos_schema_roles.sql",
        *{
            f"backend/api/migrations/versions/{name}"
            for name in SOURCE_ALEMBIC_REVISIONS + [BRIDGE_REVISION]
        },
        *{
            "backend/core/src/modules/backlinks/db/migrations/" + name
            for name in BACKLINKS_REVISIONS
        },
    }
    assert {step["path"] for step in steps} == expected_paths

    for step in steps:
        path = REPOSITORY_ROOT / step["path"]
        assert path.is_file()
        assert step["sha256"] == sha256(path)
        assert step["executionOwner"]
        assert step["schemas"]
        assert isinstance(step["prerequisites"], list)
        assert step["recovery"] in {"restore", "forward-only"}
        assert all(
            schema == "public" or schema in manifest["schemaOwners"] for schema in step["schemas"]
        )

    assert manifest["heads"] == {
        "alembic": "20260724_0007",
        "backlinks": "0031",
    }


def test_manifest_keeps_each_business_schema_with_one_migration_owner() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["schemaOwners"] == {
        "audit": "ROLE-AUDIT",
        "backlinks": "ROLE-BACKLINKS",
        "crawling": "ROLE-CRAWLER",
        "platform": "ROLE-PLATFORM-CONTEXT",
    }

    covered_schemas = {
        schema for step in manifest["steps"] for schema in step["schemas"] if schema != "public"
    }
    assert covered_schemas == set(manifest["schemaOwners"])
