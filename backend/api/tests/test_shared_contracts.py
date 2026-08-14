import json
import hashlib
from pathlib import Path

import pytest

from app.core.openapi_aggregation import (
    ContractConflictError,
    ModuleOpenApi,
    aggregate_openapi_documents,
    validate_crawler_evidence_contract,
    validate_event_registry,
    validate_temporal_registry,
)
from app.main import app


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


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def operation_count(document: dict[str, object]) -> int:
    return sum(
        1
        for path_item in document.get("paths", {}).values()
        for method in path_item
        if method in {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
    )


def module_document(
    *,
    path: str = "/api/v1/example",
    operation_id: str = "exampleGetV1",
    schema_name: str = "ExampleResponse",
) -> dict[str, object]:
    return {
        "openapi": "3.1.0",
        "info": {"title": "Example", "version": "1.0.0"},
        "paths": {
            path: {
                "get": {
                    "operationId": operation_id,
                    "responses": {"200": {"description": "OK"}},
                }
            }
        },
        "components": {
            "schemas": {
                schema_name: {
                    "type": "object",
                    "properties": {"status": {"type": "string"}},
                }
            }
        },
    }


def test_rejects_method_path_operation_id_and_schema_conflicts() -> None:
    platform = module_document()

    platform_with_duplicate_operation_id = module_document()
    platform_with_duplicate_operation_id["paths"]["/api/v1/other"] = {
        "get": {
            "operationId": "exampleGetV1",
            "responses": {"200": {"description": "OK"}},
        }
    }
    with pytest.raises(ContractConflictError, match="operationId exampleGetV1"):
        aggregate_openapi_documents(platform_with_duplicate_operation_id, [])

    with pytest.raises(ContractConflictError, match="GET /api/v1/example"):
        aggregate_openapi_documents(
            platform,
            [ModuleOpenApi("backlinks", module_document(operation_id="backlinksGetV1"))],
        )

    with pytest.raises(ContractConflictError, match="operationId exampleGetV1"):
        aggregate_openapi_documents(
            platform,
            [
                ModuleOpenApi(
                    "backlinks",
                    module_document(
                        path="/api/v1/backlinks",
                        operation_id="exampleGetV1",
                        schema_name="BacklinksResponse",
                    ),
                )
            ],
        )

    identical_schema = module_document(
        path="/api/v1/backlinks",
        operation_id="backlinksGetV1",
    )
    aggregate_openapi_documents(
        platform,
        [ModuleOpenApi("backlinks", identical_schema)],
    )

    module_with_upstream_503 = module_document(
        path="/api/v1/provider",
        operation_id="providerGetV1",
        schema_name="ProviderResponse",
    )
    module_with_upstream_503["paths"]["/api/v1/provider"]["get"]["responses"]["503"] = {
        "description": "The upstream provider is unavailable."
    }
    with_upstream_503 = aggregate_openapi_documents(
        platform,
        [ModuleOpenApi("backlinks", module_with_upstream_503)],
    )
    assert (
        with_upstream_503["paths"]["/api/v1/provider"]["get"]["responses"]["503"][
            "x-growthos-upstream-response"
        ]["description"]
        == "The upstream provider is unavailable."
    )

    conflicting_schema = module_document(
        path="/api/v1/backlinks",
        operation_id="backlinksGetV1",
    )
    conflicting_schema["components"]["schemas"]["ExampleResponse"]["properties"] = {
        "status": {"type": "integer"}
    }
    with pytest.raises(ContractConflictError, match="schema ExampleResponse"):
        aggregate_openapi_documents(
            platform,
            [
                ModuleOpenApi(
                    "backlinks",
                    conflicting_schema,
                )
            ],
        )


def test_builds_real_platform_audit_and_backlinks_public_contract() -> None:
    seo4_path = CONTRACTS_ROOT / "openapi" / "seo4-platform-audit.v1.json"
    provenance_path = CONTRACTS_ROOT / "openapi" / "seo4-platform-audit.v1.provenance.json"
    backlinks_path = CONTRACTS_ROOT / "openapi" / "backlinks.v1.json"
    aggregate_path = CONTRACTS_ROOT / "openapi" / "platform.v1.json"
    seo4 = load_json(seo4_path)
    provenance = load_json(provenance_path)
    backlinks = load_json(backlinks_path)

    aggregate = aggregate_openapi_documents(
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

    assert provenance["sourceCommit"] == "8261ea91a881948e3982a0eb96383c4c8bfa2523"
    assert provenance["documentSha256"] == hashlib.sha256(seo4_path.read_bytes()).hexdigest()
    assert len(seo4["paths"]) == 23
    assert operation_count(seo4) == 27
    assert "/health" in aggregate["paths"]
    assert aggregate["paths"]["/health"]["get"]["operationId"] == "platformHealthV1"
    assert len(backlinks["paths"]) == 72
    assert len(aggregate["paths"]) == 92
    assert operation_count(aggregate) == 98
    modules = [
        operation["x-growthos-module"]
        for path, path_item in aggregate["paths"].items()
        if path != "/health"
        for method, operation in path_item.items()
        if method in {"get", "post", "put", "patch", "delete"}
    ]
    assert modules.count("platform") == 6
    assert modules.count("audit") == 18
    assert modules.count("backlinks") == 73
    assert all(
        "application/problem+json" in operation["responses"]["503"]["content"]
        for path, path_item in aggregate["paths"].items()
        if path != "/health"
        for method, operation in path_item.items()
        if method in {"get", "post", "put", "patch", "delete"}
    )
    operation_ids = [
        operation["operationId"]
        for path_item in aggregate["paths"].values()
        for method, operation in path_item.items()
        if method in {"get", "post", "put", "patch", "delete"}
    ]
    assert len(operation_ids) == len(set(operation_ids))
    assert "platformListWebsiteProjectsV1" in operation_ids
    assert "create_audit_run_api_v1_projects__project_id__audit_runs_post" in operation_ids
    assert load_json(aggregate_path) == aggregate


def test_accepts_the_repository_event_and_temporal_registries() -> None:
    events = load_json(CONTRACTS_ROOT / "events" / "registry.v1.json")
    temporal = load_json(CONTRACTS_ROOT / "temporal" / "registry.v1.json")

    assert validate_event_registry(events) == []
    assert validate_temporal_registry(temporal) == []
    assert events["crossModuleCommands"] == ["crawling.evidence.requested.v1"]
    assert events["crossModuleEvents"] == ["crawling.evidence.recorded.v1"]
    assert {
        event["name"] for event in events["events"]
    } >= {
        "backlinks.gmail-incremental-sync.requested.v1",
        "backlinks.placement-monitoring.requested.v1",
        "backlinks.placement-monitoring.lifecycle.v1",
    }
    gmail_incremental_sync_event = next(
        event
        for event in events["events"]
        if event["name"] == "backlinks.gmail-incremental-sync.requested.v1"
    )
    assert gmail_incremental_sync_event == {
        "name": "backlinks.gmail-incremental-sync.requested.v1",
        "ownerModule": "backlinks",
        "publicationMode": "outbox",
        "outboxOwner": "backlinks",
        "consumerModules": ["backlinks"],
        "scope": "module-internal",
        "payloadSchemaVersion": 1,
        "dedupeKey": "idempotencyKey",
        "consumerWritePolicy": "owner-only",
    }
    assert [module["moduleId"] for module in temporal["modules"]] == [
        "platform",
        "audit",
        "crawling",
        "backlinks",
    ]
    crawling = temporal["modules"][2]
    assert crawling["implementationStatus"] == "executable"
    assert crawling["databaseAccess"] == "none"
    assert crawling["databaseRole"] is None
    assert crawling["allowedSchemas"] == []
    invalid_temporal = json.loads(json.dumps(temporal))
    invalid_temporal["modules"][2]["implementationStatus"] = "source-legacy"
    assert any(
        "crawling implementation status is invalid" in error
        for error in validate_temporal_registry(invalid_temporal)
    )
    assert {
        provider["killSwitch"] for module in temporal["modules"] for provider in module["providers"]
    } == {
        "platform.business-profile-ai.v1",
        "audit.google-pagespeed.v1",
        "backlinks.dataforseo.v1",
        "backlinks.browser.v1",
    }


def test_crawler_contract_is_evidence_only_and_rejects_final_business_state() -> None:
    request = load_json(CONTRACTS_ROOT / "json-schema" / "crawler-evidence-request.v1.schema.json")
    evidence = load_json(CONTRACTS_ROOT / "json-schema" / "crawler-evidence.v1.schema.json")

    assert validate_crawler_evidence_contract(request, evidence) == []
    assert evidence["properties"]["version"]["const"] == "crawler.evidence.v1"
    assert evidence["properties"]["policyVersion"]["const"] == "safefetch.gold.v1"
    assert (
        evidence["properties"]["artifactRefs"]["items"]["properties"]["key"]["pattern"]
        == "^crawler/[^/]+/[^/]+/[^/]+/.+$"
    )
    for observation_name in ("pages", "backlinkObservations"):
        required = set(evidence["properties"][observation_name]["items"]["required"])
        assert {
            "renderMode",
            "robotsDecision",
            "securityDecision",
            "resolvedIps",
            "redirectChain",
            "noindex",
            "error",
        } <= required
    assert "inferredPurpose" not in json.dumps(evidence, ensure_ascii=True)

    invalid = json.loads(json.dumps(evidence))
    invalid["properties"]["placementStatus"] = {
        "type": "string",
        "enum": ["active", "lost"],
    }
    errors = validate_crawler_evidence_contract(request, invalid)
    assert any("placementStatus" in error for error in errors)
