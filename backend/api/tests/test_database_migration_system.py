import hashlib
import json
from pathlib import Path


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
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_imports_the_frozen_source_alembic_chain_and_adds_one_bridge() -> None:
    expected = SOURCE_ALEMBIC_REVISIONS + [BRIDGE_REVISION]
    actual = sorted(path.name for path in ALEMBIC_VERSIONS.glob("*.py"))
    assert actual == expected

    bridge = (ALEMBIC_VERSIONS / BRIDGE_REVISION).read_text(encoding="utf-8")
    assert 'down_revision: str | Sequence[str] | None = "20260722_0006"' in bridge
    assert "SET SCHEMA platform" in bridge
    assert "SET SCHEMA crawling" in bridge
    assert "SET SCHEMA audit" in bridge
    assert "ENABLE ROW LEVEL SECURITY" in bridge
    assert "FORCE ROW LEVEL SECURITY" in bridge
    assert "DROP TABLE" not in bridge.upper()


def test_shared_bootstrap_declares_crawling_roles_and_schema() -> None:
    sql = BOOTSTRAP.read_text(encoding="utf-8")
    for fragment in (
        "'growthos_crawling_owner'",
        "'growthos_crawling_writer'",
        "CREATE SCHEMA IF NOT EXISTS crawling AUTHORIZATION growthos_crawling_owner",
        "GRANT USAGE ON SCHEMA crawling TO growthos_crawling_writer",
    ):
        assert fragment in sql


def test_deployment_manifest_covers_both_heads_with_fixed_checksums() -> None:
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
        "backlinks": "0029",
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
