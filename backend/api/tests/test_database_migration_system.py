import ast
import hashlib
import importlib.util
import json
from pathlib import Path

from alembic.script import ScriptDirectory

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ALEMBIC_VERSIONS = REPOSITORY_ROOT / "backend" / "api" / "migrations" / "versions"
ALEMBIC_ENV = REPOSITORY_ROOT / "backend" / "api" / "migrations" / "env.py"
BACKLINKS_MIGRATIONS = (
    REPOSITORY_ROOT / "backend" / "core" / "src" / "modules" / "backlinks" / "db" / "migrations"
)
BOOTSTRAP = REPOSITORY_ROOT / "backend" / "database" / "roles" / "0001_growthos_schema_roles.sql"
MANIFEST = REPOSITORY_ROOT / "backend" / "database" / "deployment-manifest.v1.json"
LOCAL_PROJECT_TENANT_RECONCILIATION = (
    REPOSITORY_ROOT
    / "backend"
    / "database"
    / "operations"
    / "reconcile_local_project_tenants.sql"
)
DEV_UP = REPOSITORY_ROOT / "scripts" / "dev-up.ps1"

FROZEN_ALEMBIC_REVISIONS = [
    "20260720_0001_crawler_storage.py",
    "20260721_0002_projects.py",
    "20260721_0003_site_understanding.py",
    "20260721_0004_audit_parity.py",
    "20260722_0005_audit_run_state.py",
    "20260722_0006_audit_external_resources.py",
    "20260724_0007_schema_ownership.py",
    "20260805_0008_website_project_authority.py",
    "20260806_0009_backlinks_project_scope_authority.py",
    "20260813_0010_website_project_audiences_goals.py",
]
FROZEN_CHECKSUMS = {
    "backend/database/roles/0001_growthos_schema_roles.sql": (
        "7bd126a5d8ada43c7580cc7641102b7f494226ed1cd35c3608ddab455dd0dfea"
    ),
    "backend/api/migrations/versions/20260720_0001_crawler_storage.py": (
        "45f6a112a036d1fef919e885cdaddbf06b297377e807e2699dbc46ecee01a6ea"
    ),
    "backend/api/migrations/versions/20260721_0002_projects.py": (
        "2a6bb8356280ff65465bbcecf5d4890834b8c8a6502c9237535943f2a6897419"
    ),
    "backend/api/migrations/versions/20260721_0003_site_understanding.py": (
        "4d62ed3742765af0da799a78d678261e40a2da304aa934058c2668d2d78f78d4"
    ),
    "backend/api/migrations/versions/20260721_0004_audit_parity.py": (
        "7b9350d5ade9b03450fb6a83c305f767e0346528a8b4b683ec54fa7609045bdc"
    ),
    "backend/api/migrations/versions/20260722_0005_audit_run_state.py": (
        "9984120ce365c80c4288359d126cc5ddd8a2ee063b88f5c1a850c5d5afa684bc"
    ),
    "backend/api/migrations/versions/20260722_0006_audit_external_resources.py": (
        "5078cba4d9247214817b8cb97a909bfb97f6573b243620af74fe3368471ee87a"
    ),
    "backend/api/migrations/versions/20260724_0007_schema_ownership.py": (
        "b5cff45936a384971ac9c872d6b85e08b03599882a1fd84241a6b15cc444fe08"
    ),
    "backend/api/migrations/versions/20260805_0008_website_project_authority.py": (
        "f47eab47d20ff1e21e78d4a68f4c47cfdf8a4b16cca955421643fdc647545966"
    ),
    "backend/api/migrations/versions/20260806_0009_backlinks_project_scope_authority.py": (
        "9c534474ea3d248cf3619749d588e596e01028da8bd72bc0493af45cee631033"
    ),
    "backend/api/migrations/versions/20260813_0010_website_project_audiences_goals.py": (
        "4820206f7b54ec9b8e65cc06faa327131920acedb02e68770ba9a8b0741c5564"
    ),
    (
        "backend/core/src/modules/backlinks/db/migrations/"
        "0044_backlink_platform_project_authority.sql"
    ): "2c0f22d0e55e89d203e872baa4e55ba1b086ae38b5b457606ec1ad4824ce6e3f",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def revision_metadata(path: Path) -> tuple[str, tuple[str, ...]]:
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
    down_revision = values.get("down_revision")
    if down_revision is None:
        return revision, ()
    if isinstance(down_revision, str):
        return revision, (down_revision,)
    assert isinstance(down_revision, tuple)
    assert all(isinstance(parent, str) for parent in down_revision)
    return revision, down_revision


def alembic_migration_id(revision: str) -> str:
    return f"alembic-{revision.replace('_', '-')}"


def test_keeps_the_frozen_alembic_revisions_and_bridge_semantics() -> None:
    actual = {path.name for path in ALEMBIC_VERSIONS.glob("*.py")}
    assert set(FROZEN_ALEMBIC_REVISIONS) <= actual

    bridge = (ALEMBIC_VERSIONS / "20260724_0007_schema_ownership.py").read_text(
        encoding="utf-8"
    )
    assert 'down_revision: str | Sequence[str] | None = "20260722_0006"' in bridge
    assert "SET SCHEMA platform" in bridge
    assert "SET SCHEMA crawling" in bridge
    assert "SET SCHEMA audit" in bridge
    assert "ENABLE ROW LEVEL SECURITY" in bridge
    assert "FORCE ROW LEVEL SECURITY" in bridge
    assert "DROP TABLE" not in bridge.upper()


def test_alembic_revision_graph_has_unique_ids_and_one_head() -> None:
    graph: dict[str, tuple[str, ...]] = {}
    for path in ALEMBIC_VERSIONS.glob("*.py"):
        revision, parents = revision_metadata(path)
        assert revision not in graph
        graph[revision] = parents

    assert {parent for parents in graph.values() for parent in parents} <= set(graph)
    assert graph["20260805_0008"] == ("20260724_0007",)
    assert graph["20260806_0009"] == ("20260805_0008",)
    assert graph["20260813_0010"] == ("20260806_0009",)
    assert graph["20260815_0065"] == ("20260814_0064", "20260813_0010")
    assert graph["20260825_0066"] == ("20260815_0065",)

    scripts = ScriptDirectory(str(ALEMBIC_VERSIONS.parent))
    heads = scripts.get_heads()
    assert heads == ["20260825_0066"]


def test_alembic_connection_can_resolve_tables_moved_by_the_frozen_branch() -> None:
    migration_environment = ALEMBIC_ENV.read_text(encoding="utf-8")

    assert "SET search_path TO public, platform, crawling, audit" in migration_environment


def test_local_project_tenant_reconciliation_is_generic_and_fail_closed() -> None:
    sql = LOCAL_PROJECT_TENANT_RECONCILIATION.read_text(encoding="utf-8")
    startup = DEV_UP.read_text(encoding="utf-8")

    for marker in (
        "LOCAL_PROJECT_TENANT_PARTIAL_MISMATCH",
        "LOCAL_PROJECT_BACKLINKS_TENANT_MISMATCH",
        "LOCAL_PROJECT_CONTEXT_VERSION_MISMATCH",
        "LOCAL_PROJECT_RELATED_TENANT_MISMATCH",
        "LOCAL_PROJECT_TENANT_RECONCILIATION_INCOMPLETE",
        "backlinks.backlink_project_context_snapshots",
        "information_schema.tables",
        "FOR UPDATE",
        "BEGIN;",
        "COMMIT;",
    ):
        assert marker in sql
    assert "68299b17-33d6-4993-b106-cf24f1f880bc" not in sql
    assert "LOCAL_PRODUCT_WEBSITE_PROJECT_ID" not in sql
    assert '$platformLocalDevelopmentAuthEnabled -eq "true"' in startup
    assert "reconcile_local_project_tenants.sql" in startup
    assert "canonical_organization_id=$localProductOrganizationId" in startup
    assert "canonical_workspace_id=$localProductWorkspaceId" in startup


def test_project_persistence_merge_backfills_complete_archive_state() -> None:
    migration = (
        ALEMBIC_VERSIONS / "20260815_0065_backlinks_project_persistence_merge.py"
    ).read_text(encoding="utf-8")

    assert "WHEN status = 'ARCHIVED' THEN 'LEGACY_ARCHIVE'" in migration
    assert "status = 'ARCHIVED'" in migration
    assert "archived_at IS NOT NULL" in migration
    assert "length(trim(archive_reason)) > 0" in migration
    assert (
        """status = 'ARCHIVED'
                AND archived_at IS NOT NULL
                AND length(trim(archive_reason)) > 0"""
        in migration
    )


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


def test_deployment_manifest_covers_the_complete_current_graph() -> None:
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
    steps_by_id = {step["migrationId"]: step for step in steps}
    steps_by_path = {step["path"]: step for step in steps}

    expected_paths = {
        "backend/database/roles/0001_growthos_schema_roles.sql",
        *{
            f"backend/api/migrations/versions/{path.name}"
            for path in ALEMBIC_VERSIONS.glob("*.py")
        },
        *{
            f"backend/core/src/modules/backlinks/db/migrations/{path.name}"
            for path in BACKLINKS_MIGRATIONS.glob("*.sql")
        },
    }
    assert set(steps_by_path) == expected_paths

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
        for prerequisite in step["prerequisites"]:
            assert prerequisite in steps_by_id
            assert steps_by_id[prerequisite]["order"] < step["order"]

    assert manifest["heads"] == {
        "alembic": "20260825_0066",
        "backlinks": "0076",
    }

    for path in ALEMBIC_VERSIONS.glob("*.py"):
        revision, parents = revision_metadata(path)
        step = steps_by_path[f"backend/api/migrations/versions/{path.name}"]
        assert step["migrationId"] == alembic_migration_id(revision)
        expected_prerequisites = (
            [alembic_migration_id(parent) for parent in parents]
            if parents
            else ["shared-bootstrap-0001"]
        )
        assert step["prerequisites"] == expected_prerequisites

    backlinks_paths = sorted(BACKLINKS_MIGRATIONS.glob("*.sql"))
    previous_migration_id = "shared-bootstrap-0001"
    for path in backlinks_paths:
        step = steps_by_path[
            f"backend/core/src/modules/backlinks/db/migrations/{path.name}"
        ]
        assert step["migrationId"] == f"backlinks-{path.name[:4]}"
        assert step["prerequisites"] == [previous_migration_id]
        previous_migration_id = step["migrationId"]


def test_frozen_migrations_keep_fixed_checksums() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    steps_by_path = {step["path"]: step for step in manifest["steps"]}

    for relative_path, expected_checksum in FROZEN_CHECKSUMS.items():
        assert sha256(REPOSITORY_ROOT / relative_path) == expected_checksum
        assert steps_by_path[relative_path]["sha256"] == expected_checksum


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
