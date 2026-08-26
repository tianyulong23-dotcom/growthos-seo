import hashlib
import json
import re
import subprocess
from copy import deepcopy
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
RECOMMENDATION_FROZEN_SEARCH_ROOTS = (
    "backend/core/src/modules/backlinks",
    "frontend/src/features/outreach/recommendations",
)
RECOMMENDATION_FROZEN_PATH_PATTERN = re.compile(
    r"(?i)(recommend|commercial-(candidate|discovery|qualification|inventory|refill|score|supply)"
    r"|contact-enrichment|cooperation-path)"
)
RECOMMENDATION_FROZEN_EXPLICIT_PATHS = (
    "backend/core/src/index.ts",
    "backend/core/src/modules/backlinks/api/private-server.ts",
    "backend/core/src/modules/backlinks/application/policies/dataforseo-call.policy.ts",
    "backend/core/src/modules/backlinks/db/repositories/provider-budget.repository.ts",
    "backend/core/src/modules/backlinks/adapters/dataforseo/commercial-official-runtime.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-ai-bootstrap.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-ai-runtime.ts",
    "backend/core/src/modules/backlinks/runtime/production-runtime.ts",
    "backend/core/src/modules/backlinks/workflows/worker.ts",
    "backend/core/src/modules/backlinks/workflows/outbox-relay.ts",
)
RECOMMENDATION_FROZEN_EXPECTED_PATHS = (
    "backend/core/src/index.ts",
    "backend/core/src/modules/backlinks/activities/contact-enrichment.activity.ts",
    "backend/core/src/modules/backlinks/adapters/ai/ai-sdk-commercial-discovery-blueprint.adapter.ts",
    "backend/core/src/modules/backlinks/adapters/dataforseo/commercial-official-runtime.ts",
    "backend/core/src/modules/backlinks/adapters/dataforseo/commercial-qualification-official-runtime.ts",
    "backend/core/src/modules/backlinks/api/contact-enrichment.route.ts",
    "backend/core/src/modules/backlinks/api/cooperation-path-opportunity-commands.route.ts",
    "backend/core/src/modules/backlinks/api/private-server.ts",
    "backend/core/src/modules/backlinks/api/recommendation-commands.route.ts",
    "backend/core/src/modules/backlinks/api/recommendations.route.ts",
    "backend/core/src/modules/backlinks/application/commands/contact-enrichment.command.ts",
    "backend/core/src/modules/backlinks/application/commands/cooperation-path-opportunities.command.ts",
    "backend/core/src/modules/backlinks/application/commands/recommendations.command.ts",
    "backend/core/src/modules/backlinks/application/policies/dataforseo-call.policy.ts",
    "backend/core/src/modules/backlinks/application/queries/recommendations.query.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-discovery-request.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-inventory-refill.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-qualification-bulk.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-qualification-production.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-qualification-request.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-qualification.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts",
    "backend/core/src/modules/backlinks/application/services/commercial-supply-operation.service.ts",
    "backend/core/src/modules/backlinks/application/services/current-commercial-candidate-enrichment.service.ts",
    "backend/core/src/modules/backlinks/application/services/current-commercial-candidate-reassessment.service.ts",
    "backend/core/src/modules/backlinks/application/services/recommendation-inventory.service.ts",
    "backend/core/src/modules/backlinks/application/services/recommendation-publication.service.ts",
    "backend/core/src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.ts",
    "backend/core/src/modules/backlinks/application/services/recommendation-refill-reservation.service.ts",
    "backend/core/src/modules/backlinks/application/services/recommendation-refill-supersession.service.ts",
    "backend/core/src/modules/backlinks/application/services/shared-seo-commercial-discovery.service.ts",
    "backend/core/src/modules/backlinks/db/migrations/0003_backlink_recommendations.sql",
    "backend/core/src/modules/backlinks/db/migrations/0042_backlink_project_recommendation_context.sql",
    "backend/core/src/modules/backlinks/db/migrations/0052_backlink_recommendation_publication_default.sql",
    "backend/core/src/modules/backlinks/db/migrations/0054_backlink_recommendation_fit_contact_contract.sql",
    "backend/core/src/modules/backlinks/db/migrations/0059_backlink_recommendation_pool_generations.sql",
    "backend/core/src/modules/backlinks/db/migrations/0062_backlink_recommendation_qualification_contract.sql",
    "backend/core/src/modules/backlinks/db/migrations/0063_backlink_recommendation_visibility_facts.sql",
    "backend/core/src/modules/backlinks/db/migrations/0065_backlink_recommendation_v3_2_qualification.sql",
    "backend/core/src/modules/backlinks/db/migrations/0070_backlink_recommendation_admission_threshold_50.sql",
    "backend/core/src/modules/backlinks/db/migrations/0073_backlink_recommendation_refill_contract.sql",
    "backend/core/src/modules/backlinks/db/repositories/commercial-qualification-request.repository.ts",
    "backend/core/src/modules/backlinks/db/repositories/cooperation-path-opportunity.repository.ts",
    "backend/core/src/modules/backlinks/db/repositories/provider-budget.repository.ts",
    "backend/core/src/modules/backlinks/db/repositories/recommendation-contract.repository.ts",
    "backend/core/src/modules/backlinks/db/repositories/recommendation-inventory.repository.ts",
    "backend/core/src/modules/backlinks/db/schema/recommendations.ts",
    "backend/core/src/modules/backlinks/domain/opportunities/cooperation-path.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-candidate-enrichment.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-discovery-blueprint.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-discovery-source.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-gold-set.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-inventory.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-qualification-v4.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-refill-cycle.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-score-v3.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-score-v4.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-score.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/commercial-static-assessment.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/domain-key.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/evaluation.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/evidence-value.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/gates.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/historical-commercial-reassessment.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/provider-operation-budget.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/ranking.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/recommendation-product-state.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/refill-failure.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/resource-library-authority.ts",
    "backend/core/src/modules/backlinks/domain/recommendations/scoring.ts",
    "backend/core/src/modules/backlinks/ports/ai-commercial-discovery-blueprint.port.ts",
    "backend/core/src/modules/backlinks/ports/recommendation-contract.port.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-ai-bootstrap.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-ai-runtime.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.ts",
    "backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
    "backend/core/src/modules/backlinks/runtime/production-runtime.ts",
    "backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts",
    "backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.workflow.ts",
    "backend/core/src/modules/backlinks/workflows/definitions/contact-enrichment.workflow.ts",
    "backend/core/src/modules/backlinks/workflows/outbox-relay.ts",
    "backend/core/src/modules/backlinks/workflows/worker.ts",
    "frontend/src/features/outreach/recommendations/api.ts",
    "frontend/src/features/outreach/recommendations/recommendation-inventory-identity.test.ts",
    "frontend/src/features/outreach/recommendations/recommendation-inventory-identity.ts",
    "frontend/src/features/outreach/recommendations/recommendation-operation-session.test.mjs",
    "frontend/src/features/outreach/recommendations/recommendation-operation-session.ts",
    "frontend/src/features/outreach/recommendations/recommendation-refill-polling.test.mjs",
    "frontend/src/features/outreach/recommendations/recommendation-refill-polling.ts",
    "frontend/src/features/outreach/recommendations/recommendations-source.test.mjs",
    "frontend/src/features/outreach/recommendations/recommendations-workspace.tsx",
    "frontend/src/features/outreach/recommendations/use-recommendation-refill.ts",
    "frontend/src/features/outreach/recommendations/use-recommendations.ts",
)
RECOMMENDATION_ORIGINAL_SOURCE_FINGERPRINT = (
    "11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689"
)
RECOMMENDATION_SHARED_HOTSPOT_PREIMAGES = {
    "backend/core/src/index.ts": {
        "raw": "840e31f28513465a87c22883eccd4bcf63beaf9bcb5f19b79404787915cdd5c3",
        "normalized": "719a2b1002151ec74d617cab784f220e96bbf7a7bea87e30900dc9ea4c8c922a",
    },
    "backend/core/src/modules/backlinks/api/private-server.ts": {
        "raw": "01421ceab80d79eef2e7fd536d6beaefcd7c2303045b8a6de86df828a070cb23",
        "normalized": "b12f21ab258a82e7ad80dc35881d1ab4d994a3ac24eb695e9dd1b4dbb98e4cf6",
    },
    "backend/core/src/modules/backlinks/runtime/production-runtime.ts": {
        "raw": "af54bea7add0ae9e7c980b8d9b35e3d805ee0d04296611022dfda33d227b5f58",
        "normalized": "d3ead933e9e90397714f690cec0109328d47e3b6fd152812450090cf2ce78cca",
    },
}
RECOMMENDATION_SHARED_HOTSPOT_ADDITIONS = {
    "backend/core/src/index.ts": (),
    "backend/core/src/modules/backlinks/api/private-server.ts": (
        (
            'import type { SendIntentListQuery } from '
            '"../application/queries/send-intent.query.js";\n'
        ),
        (
            'import { registerBacklinksSendIntentListRoute } from '
            '"./send-intent.route.js";\n'
        ),
        "  & SendIntentListQuery\n",
        (
            "  registerBacklinksSendIntentListRoute(app, {\n"
            "    module: options.dependencies.module,\n"
            "  });\n"
        ),
    ),
    "backend/core/src/modules/backlinks/runtime/production-runtime.ts": (
        (
            'import type { SendIntentListQuery } from '
            '"../application/queries/send-intent.query.js";\n'
        ),
        (
            "  const sendIntentListFactory: QueryFactory<SendIntentListQuery> = "
            "(client) =>\n"
            "    createSendIntentQuery(client, {\n"
            "      buildIdentity: context.buildIdentity.buildId,\n"
            "      workerMode: () => readGmailWorkerMode(),\n"
            "    });\n"
        ),
        (
            '    listSendIntents: scopedMethod(pool, sendIntentListFactory, '
            '"listSendIntents"),\n'
        ),
        "             reply_id,planned_placement_id,\n",
        "$26,$27,",
        (
            "              AND (\n"
            "                $26::uuid IS NULL\n"
            "                OR EXISTS (\n"
            "                  SELECT 1\n"
            "                    FROM backlink_inbound_messages inbound\n"
            "                    JOIN backlink_reply_match_candidates assignment\n"
            "                      ON (\n"
            "                        assignment.organization_id,\n"
            "                        assignment.workspace_id,\n"
            "                        assignment.website_project_id,\n"
            "                        assignment.inbound_message_id,\n"
            "                        assignment.opportunity_id\n"
            "                      )=(\n"
            "                        inbound.organization_id,\n"
            "                        inbound.workspace_id,\n"
            "                        inbound.website_project_id,\n"
            "                        inbound.id,\n"
            "                        $25::uuid\n"
            "                      )\n"
            "                   WHERE (\n"
            "                     inbound.organization_id,\n"
            "                     inbound.workspace_id,\n"
            "                     inbound.website_project_id,\n"
            "                     inbound.id\n"
            "                   )=($1,$2,$3,$26::uuid)\n"
            "                     AND inbound.match_status='MATCH_CONFIRMED'\n"
            "                     AND assignment.requires_manual_confirmation=false\n"
            "                )\n"
            "              )\n"
        ),
        ",\n                     reply_id,planned_placement_id",
        (
            "               'replyId',created.reply_id,\n"
            "               'placementId',created.planned_placement_id,\n"
            "               'lineageStatus',CASE\n"
            "                 WHEN created.reply_id IS NULL THEN 'UNATTRIBUTED'\n"
            "                 ELSE 'OUTREACH_DERIVED'\n"
            "               END,\n"
        ),
        (
            "          input.replyId ?? null,\n"
            "          input.plannedPlacementId,\n"
        ),
        (
            "              ...(rawResponse.replyId === null ||\n"
            "              rawResponse.replyId === undefined\n"
            "                ? {}\n"
            "                : { replyId: String(rawResponse.replyId) }),\n"
            "              placementId:\n"
            "                rawResponse.placementId === null ||\n"
            "                rawResponse.placementId === undefined\n"
            "                  ? String(rawResponse.candidateId)\n"
            "                  : String(rawResponse.placementId),\n"
            "              lineageStatus:\n"
            "                rawResponse.replyId === null ||\n"
            "                rawResponse.replyId === undefined\n"
            "                  ? \"UNATTRIBUTED\" as const\n"
            "                  : \"OUTREACH_DERIVED\" as const,\n"
        ),
    ),
}
RECOMMENDATION_NON_HOTSPOT_FINGERPRINT = (
    "8121016b68f7a92f3b7a2f7cad83e603a23c841b2be39d85a2e80bd3d2c575e3"
)
RECOMMENDATION_HOTSPOT_ANCHOR_COUNT = 119
RECOMMENDATION_HOTSPOT_ANCHOR_FINGERPRINT = (
    "7ce2c0bfb367d92ad8a28508c191c2fb97c517dd3e4991533b64df439abbff27"
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


def recommendation_semantic_snapshot(
    document: dict[str, object],
) -> tuple[dict[str, object], dict[str, int]]:
    paths = document.get("paths", {})
    assert isinstance(paths, dict)
    recommendation_paths = {
        path: path_item
        for path, path_item in paths.items()
        if "recommendation" in path.lower()
    }
    pending_refs: list[str] = []
    reachable_components: dict[str, object] = {}

    def collect_refs(value: object) -> None:
        if isinstance(value, list):
            for item in value:
                collect_refs(item)
            return
        if not isinstance(value, dict):
            return
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/components/"):
            pending_refs.append(reference)
        for item in value.values():
            collect_refs(item)

    collect_refs(recommendation_paths)
    while pending_refs:
        reference = pending_refs.pop(0)
        if reference in reachable_components:
            continue
        current: object = document
        tokens = [
            token.replace("~1", "/").replace("~0", "~")
            for token in reference.removeprefix("#/").split("/")
        ]
        for token in tokens:
            assert isinstance(current, dict)
            assert token in current, f"Unresolved OpenAPI reference: {reference}"
            current = current[token]
        reachable_components[reference] = current
        collect_refs(current)

    components: dict[str, dict[str, object]] = {}
    for reference, value in sorted(reachable_components.items()):
        tokens = [
            token.replace("~1", "/").replace("~0", "~")
            for token in reference.removeprefix("#/").split("/")
        ]
        assert tokens[0] == "components"
        section = tokens[1]
        name = "/".join(tokens[2:])
        components.setdefault(section, {})[name] = value

    return (
        {
            "paths": recommendation_paths,
            "components": components,
        },
        {
            section: len(values)
            for section, values in sorted(components.items())
        },
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
    platform = app.openapi()
    gateway = deepcopy(platform)
    gateway["paths"] = {
        path: path_item
        for path, path_item in platform.get("paths", {}).items()
        if path.startswith("/health")
    }

    aggregate = aggregate_openapi_documents(
        gateway,
        [
            ModuleOpenApi(
                "platform",
                platform,
                frozenset(gateway["paths"]),
                (
                    ("projects", "platform"),
                    ("audits", "audit"),
                    ("settings", "platform"),
                    ("agent", "agent"),
                    ("keywords", "keywords"),
                    ("content", "content"),
                    ("content-plan", "content"),
                    ("content-assets", "content"),
                    ("performance", "platform"),
                ),
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
    assert len(backlinks["paths"]) == 80
    assert len(aggregate["paths"]) == 241
    assert operation_count(aggregate) == 271
    send_intent_list_path = (
        "/api/v1/projects/{websiteProjectKey}/backlinks/send-intents"
    )
    assert {
        candidate
        for candidate in backlinks["paths"][send_intent_list_path]
        if candidate in {"get", "post", "put", "patch", "delete"}
    } == {"get"}
    assert (
        backlinks["paths"][send_intent_list_path]["get"]["operationId"]
        == "backlinksListSendIntentsV1"
    )
    expected_project_operations = {
        "/api/v1/projects/{project_id}/outreach-readiness": (
            "get",
            "get_project_outreach_readiness_api_v1_projects__project_id__outreach_readiness_get",
        ),
        "/api/v1/projects/{project_id}/promotion-target": (
            "post",
            "publish_project_promotion_target_api_v1_projects__project_id__promotion_target_post",
        ),
        "/api/v1/projects/{project_id}/performance/backlinks": (
            "get",
            "get_project_backlink_performance_v1",
        ),
    }
    for path, (method, operation_id) in expected_project_operations.items():
        assert {
            candidate
            for candidate in aggregate["paths"][path]
            if candidate in {"get", "post", "put", "patch", "delete"}
        } == {method}
        assert aggregate["paths"][path][method]["operationId"] == operation_id
        assert aggregate["paths"][path][method]["x-growthos-module"] == "platform"
    modules = [
        operation["x-growthos-module"]
        for path, path_item in aggregate["paths"].items()
        if not path.startswith("/health")
        for method, operation in path_item.items()
        if method in {"get", "post", "put", "patch", "delete"}
    ]
    assert modules.count("platform") == 53
    assert modules.count("audit") == 18
    assert modules.count("agent") == 14
    assert modules.count("keywords") == 15
    assert modules.count("content") == 87
    assert modules.count("backlinks") == 81
    assert all(
        "application/problem+json" in operation["responses"]["503"]["content"]
        for path, path_item in aggregate["paths"].items()
        if not path.startswith("/health")
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
    assert "list_projects_api_v1_projects_get" in operation_ids
    assert "create_audit_run_api_v1_projects__project_id__audit_runs_post" in operation_ids
    autosave_path = aggregate["paths"][
        "/api/v1/projects/{project_id}/articles/{article_id}/autosave"
    ]["put"]
    conflict_schema = autosave_path["responses"]["409"]["content"]["application/json"]["schema"]
    assert conflict_schema == {"$ref": "#/components/schemas/ContentProblemResponse"}
    problem_error = aggregate["components"]["schemas"]["ContentProblemError"]
    assert {
        "server_review_version",
        "server_version_number",
        "client_review_version",
        "client_version_number",
        "accepted_sequence",
        "recoverable_autosave",
    } <= set(problem_error["properties"])
    assert load_json(aggregate_path) == aggregate


def test_recommendation_openapi_semantic_closure_is_frozen() -> None:
    backlinks = load_json(CONTRACTS_ROOT / "openapi" / "backlinks.v1.json")
    snapshot, component_counts = recommendation_semantic_snapshot(backlinks)
    serialized = json.dumps(
        snapshot,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()

    assert len(snapshot["paths"]) == 9
    assert operation_count({"paths": snapshot["paths"]}) == 9
    # The current Backlinks generator inlines these operation schemas. The
    # recursive collector remains active so future component refs are included.
    assert component_counts == {}
    assert hashlib.sha256(serialized).hexdigest() == (
        "ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c"
    )


def test_recommendation_source_fingerprint_is_frozen() -> None:
    result = subprocess.run(
        ["rg", "--files", *RECOMMENDATION_FROZEN_SEARCH_ROOTS],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    raw_paths = {
        path
        for path in result.stdout.splitlines()
        if RECOMMENDATION_FROZEN_PATH_PATTERN.search(path)
    }
    raw_paths.update(RECOMMENDATION_FROZEN_EXPLICIT_PATHS)
    # The original P0 command sorted raw Windows rg paths together with the
    # explicit POSIX paths, then normalized separators while building entries.
    ordered_relative_paths = [Path(path).as_posix() for path in sorted(raw_paths)]
    expected_paths = set(RECOMMENDATION_FROZEN_EXPECTED_PATHS)
    actual_paths = set(ordered_relative_paths)
    missing_paths = sorted(expected_paths - actual_paths)
    unexpected_paths = sorted(actual_paths - expected_paths)

    assert not missing_paths and not unexpected_paths, (
        f"Recommendation frozen path set changed.\n"
        f"Missing paths:\n{'\n'.join(missing_paths) or '<none>'}\n"
        f"Unexpected paths:\n{'\n'.join(unexpected_paths) or '<none>'}"
    )
    path_list = "\n".join(ordered_relative_paths).encode()
    assert len(ordered_relative_paths) == 94
    assert hashlib.sha256(path_list).hexdigest() == (
        "06c6b93f65816e7fd011e5df869a2ec264d4324c6d018f700fc3ceef244edf5d"
    )

    non_hotspot_entries = [
        (
            relative_path.encode()
            + b"\0"
            + hashlib.sha256(
                (REPOSITORY_ROOT / relative_path).read_bytes()
            ).hexdigest().encode()
        )
        for relative_path in ordered_relative_paths
        if relative_path not in RECOMMENDATION_SHARED_HOTSPOT_PREIMAGES
    ]

    assert len(non_hotspot_entries) == 91
    assert hashlib.sha256(b"\n".join(non_hotspot_entries)).hexdigest() == (
        RECOMMENDATION_NON_HOTSPOT_FINGERPRINT
    )

    hotspot_anchors: list[str] = []
    for relative_path, preimage in RECOMMENDATION_SHARED_HOTSPOT_PREIMAGES.items():
        path = REPOSITORY_ROOT / relative_path
        raw = path.read_bytes()
        normalized = raw.decode("utf-8").replace("\r\n", "\n")
        additions = RECOMMENDATION_SHARED_HOTSPOT_ADDITIONS[relative_path]
        if not additions:
            assert hashlib.sha256(raw).hexdigest() == preimage["raw"]
        for addition in additions:
            assert normalized.count(addition) == 1, (
                f"Shared-hotspot addition changed or duplicated in {relative_path}: "
                f"{addition!r}"
            )
            normalized = normalized.replace(addition, "", 1)
        assert hashlib.sha256(normalized.encode()).hexdigest() == (
            preimage["normalized"]
        ), (
            f"Shared hotspot changed outside the additive symbol allowlist: "
            f"{relative_path}. Original P0 fingerprint remains "
            f"{RECOMMENDATION_ORIGINAL_SOURCE_FINGERPRINT}."
        )

        current_text = raw.decode("utf-8").replace("\r\n", "\n")
        hotspot_anchors.extend(
            f"{relative_path}\0{line.strip()}"
            for line in current_text.splitlines()
            if re.search(r"(?i)recommendation", line)
        )

    assert len(hotspot_anchors) == RECOMMENDATION_HOTSPOT_ANCHOR_COUNT
    assert hashlib.sha256("\n".join(hotspot_anchors).encode()).hexdigest() == (
        RECOMMENDATION_HOTSPOT_ANCHOR_FINGERPRINT
    )


def test_accepts_the_repository_event_and_temporal_registries() -> None:
    events = load_json(CONTRACTS_ROOT / "events" / "registry.v1.json")
    temporal = load_json(CONTRACTS_ROOT / "temporal" / "registry.v1.json")

    assert validate_event_registry(events) == []
    assert validate_temporal_registry(temporal) == []
    assert events["crossModuleCommands"] == ["crawling.evidence.requested.v1"]
    assert events["crossModuleEvents"] == ["crawling.evidence.recorded.v1"]
    assert {event["name"] for event in events["events"]} >= {
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
        "backlinks.browser.v1",
        "backlinks.dataforseo.v1",
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
