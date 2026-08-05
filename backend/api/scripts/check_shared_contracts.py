import argparse
import hashlib
import json
from pathlib import Path
import sys


API_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_ROOT = REPOSITORY_ROOT / "backend" / "contracts"
PLATFORM_PROJECT_PATHS = frozenset(
    {
        "/health",
        "/api/v1/projects",
        "/api/v1/projects/{project_id}",
        "/api/v1/projects/{project_id}/business-profile",
        "/api/v1/projects/{project_id}/business-profile/runs",
        "/api/v1/projects/{project_id}/favicon",
        "/api/v1/projects/{project_id}/business-profile/refresh",
    }
)
sys.path.insert(0, str(API_ROOT))

from app.core.openapi_aggregation import (  # noqa: E402
    ContractConflictError,
    ModuleOpenApi,
    aggregate_openapi_documents,
    validate_crawler_evidence_contract,
    validate_event_registry,
    validate_temporal_registry,
)
from app.main import app  # noqa: E402


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_aggregate() -> dict[str, object]:
    seo4 = load_json(
        CONTRACTS_ROOT / "openapi" / "seo4-platform-audit.v1.json"
    )
    backlinks = load_json(CONTRACTS_ROOT / "openapi" / "backlinks.v1.json")
    return aggregate_openapi_documents(
        app.openapi(),
        [
            ModuleOpenApi(
                "platform",
                seo4,
                PLATFORM_PROJECT_PATHS,
                (("projects", "platform"), ("audits", "audit")),
            ),
            ModuleOpenApi("backlinks", backlinks, frozenset({"/health"})),
        ],
    )


def operation_count(document: dict[str, object]) -> int:
    return sum(
        1
        for path_item in document.get("paths", {}).values()
        for method in path_item
        if method in {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
    )


def repository_contract_errors() -> list[str]:
    errors: list[str] = []
    events = load_json(CONTRACTS_ROOT / "events" / "registry.v1.json")
    temporal = load_json(CONTRACTS_ROOT / "temporal" / "registry.v1.json")
    crawler_request = load_json(
        CONTRACTS_ROOT / "json-schema" / "crawler-evidence-request.v1.schema.json"
    )
    crawler_evidence = load_json(
        CONTRACTS_ROOT / "json-schema" / "crawler-evidence.v1.schema.json"
    )
    seo4_path = CONTRACTS_ROOT / "openapi" / "seo4-platform-audit.v1.json"
    seo4 = load_json(seo4_path)
    provenance = load_json(
        CONTRACTS_ROOT / "openapi" / "seo4-platform-audit.v1.provenance.json"
    )

    errors.extend(validate_event_registry(events))
    errors.extend(validate_temporal_registry(temporal))
    errors.extend(validate_crawler_evidence_contract(crawler_request, crawler_evidence))

    actual_sha = hashlib.sha256(seo4_path.read_bytes()).hexdigest()
    if provenance.get("documentSha256") != actual_sha:
        errors.append("SEO V4 OpenAPI snapshot differs from its provenance hash")
    if provenance.get("sourceCommit") != "8261ea91a881948e3982a0eb96383c4c8bfa2523":
        errors.append("SEO V4 OpenAPI source commit is not the approved fetched baseline")
    if len(seo4.get("paths", {})) != 23 or operation_count(seo4) != 27:
        errors.append("SEO V4 OpenAPI snapshot does not contain the proven 23 paths/27 operations")

    module_ids = [module.get("moduleId") for module in temporal.get("modules", [])]
    if module_ids != ["platform", "audit", "crawling", "backlinks"]:
        errors.append("Temporal registry does not register all four modules in authority order")
    for registry_entry in [
        *events.get("commands", []),
        *events.get("events", []),
    ]:
        payload_schema = registry_entry.get("payloadSchema")
        if payload_schema and not (CONTRACTS_ROOT / payload_schema).is_file():
            errors.append(f"missing payload schema: {payload_schema}")
    if any(
        binding.get("status") != "replacement-required"
        for binding in temporal.get("legacyBindings", [])
    ):
        errors.append("a legacy Temporal binding is still marked active")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    aggregate_path = CONTRACTS_ROOT / "openapi" / "platform.v1.json"

    try:
        aggregate = build_aggregate()
        errors = repository_contract_errors()
        if errors:
            raise ContractConflictError("\n".join(errors))
        if args.write:
            aggregate_path.write_text(
                f"{json.dumps(aggregate, indent=2, ensure_ascii=True)}\n",
                encoding="utf-8",
            )
        elif not aggregate_path.exists() or load_json(aggregate_path) != aggregate:
            raise ContractConflictError(
                "aggregate OpenAPI is stale; run scripts/check_shared_contracts.py --write"
            )
    except (ContractConflictError, FileNotFoundError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1

    print(
        "Shared contracts valid: "
        f"{len(aggregate.get('paths', {}))} public paths, "
        f"{operation_count(aggregate)} operations, "
        "1 cross-module command, 1 cross-module event, "
        "4 module Task Queues"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
