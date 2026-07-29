from copy import deepcopy
from dataclasses import dataclass
import re
from typing import Any


HTTP_METHODS = frozenset({"delete", "get", "head", "options", "patch", "post", "put", "trace"})
VERSION_SUFFIX = re.compile(r"\.v[1-9][0-9]*$")
TASK_QUEUE_PATTERN = re.compile(r"^growthos\.([a-z][a-z0-9-]*)\.v[1-9][0-9]*$")
FORBIDDEN_CRAWLER_PROPERTIES = frozenset(
    {
        "audithealth",
        "auditissues",
        "contactpurpose",
        "inferredpurpose",
        "lifecyclestatus",
        "opportunitystatus",
        "placementstatus",
        "projecthealth",
        "recommendationstatus",
        "siteprofile",
    }
)
FORBIDDEN_CRAWLER_ENUM_VALUES = frozenset(
    {
        "accepted",
        "active",
        "confirmed",
        "joined",
        "lost",
        "rejected",
    }
)
MODULE_UNAVAILABLE_RESPONSE = {
    "description": "The owning module is unavailable.",
    "content": {
        "application/problem+json": {
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "type",
                    "title",
                    "status",
                    "detail",
                    "code",
                    "message",
                    "requestId",
                    "retryable",
                ],
                "properties": {
                    "type": {"type": "string"},
                    "title": {"type": "string"},
                    "status": {"type": "integer", "const": 503},
                    "detail": {"type": "string"},
                    "code": {"type": "string"},
                    "message": {"type": "string"},
                    "requestId": {"type": "string"},
                    "retryable": {"type": "boolean"},
                },
            }
        }
    },
}


class ContractConflictError(ValueError):
    pass


@dataclass(frozen=True)
class ModuleOpenApi:
    module_id: str
    document: dict[str, Any]
    private_paths: frozenset[str] = frozenset()
    tag_module_map: tuple[tuple[str, str], ...] = ()


def _operation_module(module: ModuleOpenApi, operation: dict[str, Any]) -> str:
    if not module.tag_module_map:
        return module.module_id
    tag_module_map = dict(module.tag_module_map)
    matches = {
        tag_module_map[tag]
        for tag in operation.get("tags", [])
        if tag in tag_module_map
    }
    if len(matches) != 1:
        operation_id = operation.get("operationId", "<unknown>")
        raise ContractConflictError(
            f"{module.module_id} operation {operation_id} has no unique module tag"
        )
    return matches.pop()


def _module_unavailable_response(operation: dict[str, Any]) -> dict[str, Any]:
    response = deepcopy(MODULE_UNAVAILABLE_RESPONSE)
    upstream = operation.get("responses", {}).get("503")
    if upstream is not None and upstream != response:
        response["x-growthos-upstream-response"] = deepcopy(upstream)
    return response


def _operations(document: dict[str, Any], module_id: str) -> list[tuple[str, str, dict[str, Any]]]:
    operations: list[tuple[str, str, dict[str, Any]]] = []
    for path, path_item in document.get("paths", {}).items():
        for method, operation in path_item.items():
            if method.lower() not in HTTP_METHODS:
                continue
            operation_id = operation.get("operationId")
            if not isinstance(operation_id, str) or not operation_id.strip():
                raise ContractConflictError(
                    f"{module_id} {method.upper()} {path} has no operationId"
                )
            operations.append((method.lower(), path, operation))
    return operations


def aggregate_openapi_documents(
    platform_document: dict[str, Any],
    modules: list[ModuleOpenApi],
) -> dict[str, Any]:
    aggregate = deepcopy(platform_document)
    aggregate.setdefault("paths", {})
    aggregate.setdefault("components", {})
    seen_routes: set[tuple[str, str]] = set()
    seen_operation_ids: set[str] = set()

    for method, path, operation in _operations(aggregate, "platform"):
        route = (method, path)
        operation_id = operation["operationId"]
        if route in seen_routes:
            raise ContractConflictError(f"duplicate route {method.upper()} {path}")
        if operation_id in seen_operation_ids:
            raise ContractConflictError(f"duplicate operationId {operation_id}")
        seen_routes.add(route)
        seen_operation_ids.add(operation_id)

    for module in modules:
        public_document = deepcopy(module.document)
        public_document["paths"] = {
            path: path_item
            for path, path_item in public_document.get("paths", {}).items()
            if path not in module.private_paths
        }
        for method, path, operation in _operations(public_document, module.module_id):
            route = (method, path)
            operation_id = operation["operationId"]
            if route in seen_routes:
                raise ContractConflictError(f"duplicate route {method.upper()} {path}")
            if operation_id in seen_operation_ids:
                raise ContractConflictError(f"duplicate operationId {operation_id}")
            operation["x-growthos-module"] = _operation_module(module, operation)
            operation.setdefault("responses", {})["503"] = _module_unavailable_response(
                operation
            )
            aggregate["paths"].setdefault(path, {})[method] = operation
            seen_routes.add(route)
            seen_operation_ids.add(operation_id)

        for component_type, values in public_document.get("components", {}).items():
            target = aggregate["components"].setdefault(component_type, {})
            for name, value in values.items():
                if name in target:
                    if target[name] == value:
                        continue
                    label = "schema" if component_type == "schemas" else component_type
                    raise ContractConflictError(f"duplicate {label} {name}")
                target[name] = value

    return aggregate


def validate_event_registry(document: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    command_names: set[str] = set()
    cross_module_commands = set(document.get("crossModuleCommands", []))
    for command in document.get("commands", []):
        name = command.get("name")
        owner = command.get("ownerModule")
        producers = command.get("producerModules", [])
        if not isinstance(name, str) or name in command_names:
            errors.append(f"command name is missing or duplicated: {name}")
            continue
        command_names.add(name)
        if not isinstance(owner, str) or not name.startswith(f"{owner}."):
            errors.append(f"{name} is not namespaced by its handler")
        if VERSION_SUFFIX.search(name) is None:
            errors.append(f"{name} is not versioned")
        if command.get("handlerModule") != owner:
            errors.append(f"{name} handler differs from command owner")
        if command.get("payloadSchemaVersion") != 1:
            errors.append(f"{name} payload schema version is not 1")
        if not command.get("payloadSchema"):
            errors.append(f"{name} has no payload schema")
        if not command.get("dedupeKey"):
            errors.append(f"{name} has no dedupe key")
        is_cross_module = any(producer != owner for producer in producers)
        if is_cross_module != (name in cross_module_commands):
            errors.append(f"{name} cross-module command membership is inconsistent")
        if command.get("handlerWritePolicy") != "evidence-only":
            errors.append(f"{name} handler write policy is not evidence-only")
    if not cross_module_commands.issubset(command_names):
        errors.append("crossModuleCommands contains an unknown command")

    names: set[str] = set()
    cross_module_names = set(document.get("crossModuleEvents", []))
    for event in document.get("events", []):
        name = event.get("name")
        owner = event.get("ownerModule")
        consumers = event.get("consumerModules", [])
        if not isinstance(name, str) or name in names:
            errors.append(f"event name is missing or duplicated: {name}")
            continue
        names.add(name)
        if not isinstance(owner, str) or not name.startswith(f"{owner}."):
            errors.append(f"{name} is not namespaced by its owner")
        if VERSION_SUFFIX.search(name) is None:
            errors.append(f"{name} is not versioned")
        publication_mode = event.get("publicationMode")
        if publication_mode == "outbox" and event.get("outboxOwner") != owner:
            errors.append(f"{name} outbox owner differs from fact owner")
        if publication_mode == "temporal-result" and event.get("outboxOwner") is not None:
            errors.append(f"{name} temporal result must not claim an outbox")
        if publication_mode not in {"outbox", "temporal-result"}:
            errors.append(f"{name} publication mode is invalid")
        if event.get("payloadSchemaVersion") != 1:
            errors.append(f"{name} payload schema version is not 1")
        if not event.get("dedupeKey"):
            errors.append(f"{name} has no dedupe key")
        is_cross_module = any(consumer != owner for consumer in consumers)
        if is_cross_module != (name in cross_module_names):
            errors.append(f"{name} cross-module registry membership is inconsistent")
        if is_cross_module and event.get("consumerWritePolicy") != "projection-only":
            errors.append(f"{name} cross-module consumers are not projection-only")
        if is_cross_module and not event.get("payloadSchema"):
            errors.append(f"{name} has no payload schema")
    if not cross_module_names.issubset(names):
        errors.append("crossModuleEvents contains an unknown event")
    return errors


def validate_temporal_registry(document: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    queues: set[str] = set()
    workflow_types: set[str] = set()
    activity_types: set[str] = set()
    signal_types: set[str] = set()
    query_types: set[str] = set()
    for module in document.get("modules", []):
        module_id = module.get("moduleId")
        implementation_status = module.get("implementationStatus")
        if implementation_status not in {"target-contract", "executable"}:
            errors.append(f"{module_id} implementation status is invalid")
        task_queue = module.get("taskQueue")
        queue_match = TASK_QUEUE_PATTERN.fullmatch(task_queue or "")
        if queue_match is None or queue_match.group(1) != module_id:
            errors.append(f"{module_id} task queue is not module-namespaced")
        if task_queue in queues:
            errors.append(f"task queue is shared: {task_queue}")
        queues.add(task_queue)
        if module.get("databaseAccess") == "none":
            if module.get("databaseRole") is not None or module.get("allowedSchemas") != []:
                errors.append(f"{module_id} no-database Worker has database permissions")
        else:
            if module.get("databaseAccess") != "writer":
                errors.append(f"{module_id} Worker database access mode is invalid")
            if module.get("databaseRole") != f"growthos_{module_id}_writer":
                errors.append(f"{module_id} Worker database role is invalid")
            if module.get("allowedSchemas") != [module_id]:
                errors.append(
                    f"{module_id} Worker schema permissions cross a module boundary"
                )

        workflow_id_prefix = f"{module_id}:<workspaceId>:<websiteProjectId>:"
        for workflow in module.get("workflows", []):
            workflow_type = workflow.get("workflowType")
            workflow_id_pattern = workflow.get("workflowIdPattern", "")
            if (
                not isinstance(workflow_type, str)
                or not workflow_type.startswith(module_id)
                or not workflow_type.endswith("V1Workflow")
            ):
                errors.append(f"{module_id} Workflow type is not namespaced and versioned")
            if workflow_type in workflow_types:
                errors.append(f"Workflow type is shared: {workflow_type}")
            workflow_types.add(workflow_type)
            if not workflow_id_pattern.startswith(workflow_id_prefix):
                errors.append(f"{module_id} Workflow ID is not module-namespaced")
            if workflow.get("replayPolicy") != "deterministic":
                errors.append(f"{module_id} Workflow replay policy is not deterministic")
            if workflow.get("restartPolicy") != "reuse-workflow-id":
                errors.append(f"{module_id} Workflow restart policy is not deduplicated")
            if workflow.get("cancellationPolicy") != "propagate":
                errors.append(f"{module_id} Workflow cancellation does not propagate")
            for signal_type in workflow.get("signalTypes", []):
                if (
                    not isinstance(signal_type, str)
                    or not signal_type.startswith(module_id)
                    or not signal_type.endswith("V1")
                ):
                    errors.append(f"{module_id} Signal type is not namespaced and versioned")
                if signal_type in signal_types:
                    errors.append(f"Signal type is shared: {signal_type}")
                signal_types.add(signal_type)
            for query_type in workflow.get("queryTypes", []):
                if (
                    not isinstance(query_type, str)
                    or not query_type.startswith(module_id)
                    or not query_type.endswith("V1")
                ):
                    errors.append(f"{module_id} Query type is not namespaced and versioned")
                if query_type in query_types:
                    errors.append(f"Query type is shared: {query_type}")
                query_types.add(query_type)

        for activity_type in module.get("activityTypes", []):
            if (
                not isinstance(activity_type, str)
                or not activity_type.startswith(module_id)
                or not activity_type.endswith("V1")
            ):
                errors.append(f"{module_id} Activity type is not namespaced and versioned")
            if activity_type in activity_types:
                errors.append(f"Activity type is shared: {activity_type}")
            activity_types.add(activity_type)

        for provider in module.get("providers", []):
            kill_switch = provider.get("killSwitch", "")
            if not kill_switch.startswith(f"{module_id}.") or VERSION_SUFFIX.search(
                kill_switch
            ) is None:
                errors.append(f"{module_id} Provider Kill Switch crosses a module boundary")
    return errors


def _normalized_contract_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _walk_schema(value: Any, path: str = "$") -> list[tuple[str, Any]]:
    values = [(path, value)]
    if isinstance(value, dict):
        for key, child in value.items():
            values.extend(_walk_schema(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            values.extend(_walk_schema(child, f"{path}[{index}]"))
    return values


def validate_crawler_evidence_contract(
    request: dict[str, Any],
    evidence: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    expected_task_types = [
        "site_understanding",
        "technical_audit",
        "backlink_validation",
    ]
    if request.get("properties", {}).get("version", {}).get("const") != (
        "crawler.evidence.request.v1"
    ):
        errors.append("crawler evidence request version is invalid")
    if request.get("properties", {}).get("taskType", {}).get("enum") != expected_task_types:
        errors.append("crawler evidence request task types differ from the executable source")
    if evidence.get("properties", {}).get("version", {}).get("const") != (
        "crawler.evidence.v1"
    ):
        errors.append("crawler evidence version is invalid")
    if evidence.get("properties", {}).get("policyVersion", {}).get("const") != (
        "safefetch.gold.v1"
    ):
        errors.append("crawler evidence SafeFetch policy version is invalid")
    if evidence.get("properties", {}).get("taskType", {}).get("enum") != expected_task_types:
        errors.append("crawler evidence task types differ from the executable source")

    required_evidence_fields = {
        "policyVersion",
        "artifactRefs",
        "pages",
        "contactObservations",
        "backlinkObservations",
        "technicalObservations",
    }
    if not required_evidence_fields.issubset(set(evidence.get("required", []))):
        errors.append("crawler evidence required fields do not match the executable worker")

    required_observation_fields = {
        "renderMode",
        "robotsDecision",
        "securityDecision",
        "resolvedIps",
        "redirectChain",
        "noindex",
        "error",
    }
    for observation_name in ("pages", "backlinkObservations"):
        observation = (
            evidence.get("properties", {})
            .get(observation_name, {})
            .get("items", {})
        )
        if not required_observation_fields.issubset(
            set(observation.get("required", []))
        ):
            errors.append(
                f"crawler {observation_name} omit executable safety evidence fields"
            )

    artifact_key = (
        evidence.get("properties", {})
        .get("artifactRefs", {})
        .get("items", {})
        .get("properties", {})
        .get("key", {})
    )
    if artifact_key.get("pattern") != r"^crawler/[^/]+/[^/]+/[^/]+/.+$":
        errors.append("crawler artifact key does not preserve the source prefix")

    for document_name, document in (("request", request), ("evidence", evidence)):
        for path, value in _walk_schema(document):
            if path.endswith(".properties") and isinstance(value, dict):
                for property_name in value:
                    if _normalized_contract_name(property_name) in (
                        FORBIDDEN_CRAWLER_PROPERTIES
                    ):
                        errors.append(
                            f"{document_name} contains final business property "
                            f"{property_name}"
                        )
            if path.endswith(".enum") and isinstance(value, list):
                for enum_value in value:
                    if (
                        isinstance(enum_value, str)
                        and _normalized_contract_name(enum_value)
                        in FORBIDDEN_CRAWLER_ENUM_VALUES
                    ):
                        errors.append(
                            f"{document_name} contains final business enum {enum_value}"
                        )
    return errors
