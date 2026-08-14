import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

from app.db import retry
from app.core.config import Settings
from app.modules.audit.service import AuditRunNotFoundError
from app.modules.agent.tools import (
    READ_MODELS,
    TOOL_DEFINITIONS,
    WRITE_MODELS,
    ToolRegistry,
    tool_catalog_payload,
)
from app.modules.onboarding.service import OnboardingNotFoundError


PROFILE = {
    "business_name": "Example",
    "business_type": "Software",
    "business_summary": "SEO software",
    "target_audiences": ["Marketing teams"],
    "products_services": ["SEO audit"],
    "value_propositions": ["Clear evidence"],
    "ai_content_rules": "",
}


class Dumpable:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, mode: str = "python") -> dict[str, Any]:
        return dict(self.value)

    def __getattr__(self, name: str) -> Any:
        try:
            return self.value[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


class Project:
    def __init__(self) -> None:
        self.site_profile = Dumpable(PROFILE)
        self.understanding_run_id = None
        self.understanding_status = "completed"
        self.audit_run_id = None
        self.audit_status = "never_started"

    def model_dump(self, mode: str = "python") -> dict[str, Any]:
        return dict(PROFILE)


class FakeProjects:
    def __init__(self) -> None:
        self.project = Project()
        self.update_calls = 0
        self.refresh_calls = 0
        self.operations: dict[str, tuple[str, Project]] = {}
        self.understanding_runs: dict[str, Dumpable] = {}
        self.transient_read_failures = 0

    async def get(self, project_id: str) -> Project:
        assert project_id == "project-1"
        if self.transient_read_failures:
            self.transient_read_failures -= 1
            error = ConnectionError("database connection closed")
            error.code = "08006"  # type: ignore[attr-defined]
            raise error
        return self.project

    async def update_business_profile(self, project_id: str, request: Any) -> Project:
        self.update_calls += 1
        self.project.site_profile = Dumpable(request.model_dump(mode="json"))
        return self.project

    async def update_business_profile_once(
        self,
        project_id: str,
        request: Any,
        operation_id: str,
        parameters_hash: str,
        expected_before: dict[str, Any],
    ) -> tuple[Project, bool]:
        existing = self.operations.get(operation_id)
        if existing is not None:
            if existing[0] != parameters_hash:
                raise RuntimeError("操作编号与原始参数不一致")
            return existing[1], True
        current = self.project.site_profile.model_dump(mode="json")
        if any(current.get(key) != value for key, value in expected_before.items()):
            raise RuntimeError("项目状态已经变化，请重新发起操作")
        self.update_calls += 1
        self.project.site_profile = Dumpable(request.model_dump(mode="json"))
        self.operations[operation_id] = (parameters_hash, self.project)
        return self.project, False

    async def refresh_business_profile(
        self, project_id: str, operation_id: str
    ) -> Project:
        assert project_id == "project-1"
        self.refresh_calls += 1
        self.project.understanding_run_id = operation_id
        self.project.understanding_status = "queued"
        self.understanding_runs[operation_id] = Dumpable(
            {"run_id": operation_id, "status": "queued"}
        )
        return self.project

    async def get_business_profile_run(
        self, project_id: str, run_id: str
    ) -> Dumpable | None:
        assert project_id == "project-1"
        return self.understanding_runs.get(run_id)


class FakeAudits:
    def __init__(self) -> None:
        self.issue_calls: list[tuple[Any, ...]] = []
        self.create_calls = 0
        self.runs: dict[str, Dumpable] = {}

    async def list_runs(self, project_id: str, page: int, page_size: int) -> Dumpable:
        assert (project_id, page, page_size) == ("project-1", 1, 1)
        return DumpableCollection(
            [Dumpable({"run_id": "audit-1", "status": "completed"})]
        )

    async def issues(
        self,
        project_id: str,
        run_id: str,
        page: int,
        page_size: int,
        severity: str | None,
        search: str,
    ) -> Dumpable:
        self.issue_calls.append(
            (project_id, run_id, page, page_size, severity, search)
        )
        return Dumpable(
            {
                "items": [
                    {
                        "title": "Minor warning",
                        "code": "minor_warning",
                        "severity": "warning",
                        "affected_count": 100,
                        "recommendation": "Review it",
                        "urls": ["https://example.com/warning"],
                    },
                    {
                        "title": "Broken links",
                        "code": "broken_links",
                        "severity": "error",
                        "affected_count": 12,
                        "recommendation": "Fix the links",
                        "urls": [f"https://example.com/{index}" for index in range(12)],
                    },
                    {
                        "title": "Missing titles",
                        "code": "missing_titles",
                        "severity": "error",
                        "affected_count": 3,
                        "recommendation": "Add titles",
                        "urls": ["https://example.com/title"],
                    }
                ],
                "total": 3,
                "page": 1,
                "page_size": 100,
            }
        )

    async def get_run(self, project_id: str, run_id: str) -> Dumpable:
        assert project_id == "project-1"
        try:
            return self.runs[run_id]
        except KeyError as exc:
            raise AuditRunNotFoundError from exc

    async def create_run(
        self, project_id: str, request: Any, operation_id: str
    ) -> Dumpable:
        assert project_id == "project-1"
        request.model_dump(mode="json")
        self.create_calls += 1
        run = Dumpable({"run_id": operation_id, "status": "queued"})
        self.runs[operation_id] = run
        return run


class DumpableCollection:
    def __init__(self, items: list[Dumpable]) -> None:
        self.items = items


def build_registry() -> tuple[ToolRegistry, FakeProjects]:
    projects = FakeProjects()
    return ToolRegistry(Settings(), projects, FakeAudits()), projects


class FakeKeywords:
    def __init__(self, status: str | None) -> None:
        self.run_status = status

    async def status(self, project_id: str) -> SimpleNamespace:
        assert project_id == "project-1"
        run = (
            SimpleNamespace(status=self.run_status)
            if self.run_status is not None
            else None
        )
        return SimpleNamespace(run=run)


class FakeContentPlans:
    def __init__(self, batch: SimpleNamespace | None = None) -> None:
        self.batch = batch
        self.create_calls: list[tuple[str, str, str]] = []

    async def create_automatic(
        self, organization_id: str, project_id: str, *, idempotency_key: str
    ) -> SimpleNamespace:
        self.create_calls.append((organization_id, project_id, idempotency_key))
        return SimpleNamespace(batch_id="batch-created")

    async def get_batch(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> SimpleNamespace:
        assert organization_id == Settings().default_organization_id
        assert project_id == "project-1"
        assert self.batch is not None
        assert batch_id == self.batch.batch_id
        return self.batch


class FakeContent:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str, str]] = []
        self.read_calls: list[tuple[str, str, str]] = []
        self.create_calls: list[tuple[str, dict[str, Any], str, str]] = []

    async def create_article(
        self,
        project_id: str,
        request: Any,
        idempotency_key: str,
        *,
        organization_id: str,
    ) -> SimpleNamespace:
        self.create_calls.append((
            project_id,
            request.model_dump(mode="json"),
            idempotency_key,
            organization_id,
        ))
        return SimpleNamespace(
            id="article-direct-1",
            primary_keyword=request.primary_keyword,
            title=request.title,
            run=SimpleNamespace(
                id="article-run-direct-1",
                status="queued",
                stage="queued",
                progress=0,
            ),
        )

    async def generate_next_planned_articles(
        self,
        project_id: str,
        count: int,
        *,
        organization_id: str,
        batch_id: str,
    ) -> list[SimpleNamespace]:
        self.calls.append((project_id, count, organization_id, batch_id))
        return [
            SimpleNamespace(
                id=f"article-{index}",
                title=f"Article {index}",
                run=SimpleNamespace(id=f"article-run-{index}", status="queued"),
            )
            for index in range(1, count + 1)
        ]

    async def get_article(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
    ) -> Dumpable:
        self.read_calls.append((project_id, article_id, organization_id))
        index = article_id.rsplit("-", 1)[-1]
        return Dumpable({
            "id": article_id,
            "title": f"Article {index}",
            "run": {
                "id": f"article-run-{index}",
                "article_id": article_id,
                "status": "completed_with_warnings",
                "stage": "completed",
                "progress": 100,
                "warnings": ["review_recommended"],
                "error_code": None,
                "error_detail": None,
            },
        })

    async def get_article_generation_snapshot(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
    ) -> dict[str, Any]:
        article = (
            await self.get_article(
                project_id, article_id, organization_id=organization_id
            )
        ).model_dump(mode="json")
        run = article["run"]
        return {
            "article_id": article["id"],
            "primary_keyword": article.get("primary_keyword", f"keyword {article_id}"),
            "title": article.get("title"),
            "run_id": run.get("id"),
            "status": run.get("status"),
            "stage": run.get("stage"),
            "progress": run.get("progress"),
            "warnings": run.get("warnings", []),
            "error_code": run.get("error_code"),
            "error_detail": run.get("error_detail"),
            "billing": {
                "reported_cost": None,
                "estimated_cost": None,
                "complete": False,
            },
        }

    async def list_articles(
        self,
        project_id: str,
        page: int,
        page_size: int,
        article_status: str | None,
        search: str | None,
        *,
        organization_id: str,
    ) -> SimpleNamespace:
        assert project_id == "project-1"
        assert (page, page_size, article_status) == (1, 2, None)
        assert organization_id == Settings().default_organization_id
        article_id = "article-hd" if search else "article-recent"
        return SimpleNamespace(items=[SimpleNamespace(id=article_id)])


class FakeOnboarding:
    def __init__(self, article_ids: list[str]) -> None:
        self.article_ids = article_ids
        self.calls: list[tuple[str, str]] = []

    async def article_ids_for_initial_generation(
        self, organization_id: str, project_id: str
    ) -> list[str]:
        self.calls.append((organization_id, project_id))
        return list(self.article_ids)


class MissingOnboarding(FakeOnboarding):
    async def observe_started_step(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
        external_run_id: str,
    ) -> None:
        raise OnboardingNotFoundError


class FakeKeywordsWithBilling(FakeKeywords):
    async def status(self, project_id: str) -> Dumpable:
        assert project_id == "project-1"
        return Dumpable({
            "run": {
                "run_id": "public-status-run",
                "status": "completed",
            }
        })

    async def keyword_library_billing(
        self, project_id: str
    ) -> dict[str, str | float | bool]:
        assert project_id == "project-1"
        return {
            "run_id": "keyword-run-1",
            "reported_cost_usd": 0.15,
            "complete": True,
        }


class FakeContentPlansWithBilling(FakeContentPlans):
    async def get_batch(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> Dumpable:
        return Dumpable({
            "batch_id": batch_id,
            "project_id": project_id,
            "source": "automatic",
            "target_count": 30,
            "status": "completed",
            "stage": "completed",
            "candidate_snapshot_count": 30,
            "selected_count": 30,
            "valid_pack_count": 30,
            "preparation_count": 30,
            "preview_ready_count": 30,
            "plan_item_count": 30,
            "external_request_count": 3,
            "total_cost_usd": 0.42,
            "retryable": False,
            "error_code": None,
            "error_detail": None,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
            "finished_at": datetime.now(UTC),
        })


class FakeContentWithBilling(FakeContent):
    async def get_article_generation_snapshot(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
    ) -> dict[str, Any]:
        payload = await super().get_article_generation_snapshot(
            project_id, article_id, organization_id=organization_id
        )
        payload["billing"] = {
            "reported_cost": 0.21,
            "estimated_cost": None,
            "complete": True,
        }
        return payload


async def execute_prepared_write(
    registry: ToolRegistry, name: str, arguments: dict[str, Any], operation_id: str
) -> dict[str, Any]:
    prepared = await registry.prepare_write(
        "project-1", name, arguments, operation_id
    )
    return await registry.execute_write(
        "project-1",
        name,
        prepared.arguments,
        prepared.before,
        prepared.parameters_hash,
    )


def test_tool_models_reject_project_identity_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        READ_MODELS["get_latest_audit"].model_validate({"project_id": "other-project"})
    with pytest.raises(ValidationError):
        WRITE_MODELS["update_business_profile"].model_validate(
            {"changes": {"project_id": "other-project"}}
        )
    with pytest.raises(ValidationError):
        READ_MODELS["get_article_generation_status"].model_validate(
            {"project_id": "other-project"}
        )
    for name in (
        "start_keyword_library",
        "start_content_plan",
        "start_articles",
        "create_article",
    ):
        with pytest.raises(ValidationError):
            WRITE_MODELS[name].model_validate({"project_id": "other-project"})


def test_article_start_only_accepts_one_or_two_articles() -> None:
    assert WRITE_MODELS["start_articles"].model_validate(
        {"batch_id": "batch-1", "count": 1}
    ).count == 1
    assert WRITE_MODELS["start_articles"].model_validate(
        {"batch_id": "batch-1", "count": 2}
    ).count == 2
    with pytest.raises(ValidationError):
        WRITE_MODELS["start_articles"].model_validate(
            {"batch_id": "batch-1", "count": 0}
        )
    with pytest.raises(ValidationError):
        WRITE_MODELS["start_articles"].model_validate(
            {"batch_id": "batch-1", "count": 3}
        )
    with pytest.raises(ValidationError):
        WRITE_MODELS["start_articles"].model_validate({"count": 2})


@pytest.mark.parametrize("status", [None, "queued", "running", "failed"])
def test_content_plan_requires_a_usable_keyword_library(
    status: str | None,
) -> None:
    registry = ToolRegistry(
        Settings(),
        FakeProjects(),
        FakeAudits(),
        keywords=FakeKeywords(status),
        content_plans=FakeContentPlans(),
    )

    with pytest.raises(RuntimeError, match="keyword_library_not_ready"):
        asyncio.run(
            execute_prepared_write(
                registry, "start_content_plan", {}, "content-plan-operation"
            )
        )


@pytest.mark.parametrize("status", ["partial", "completed"])
def test_content_plan_accepts_usable_keyword_library(status: str) -> None:
    content_plans = FakeContentPlans()
    registry = ToolRegistry(
        Settings(),
        FakeProjects(),
        FakeAudits(),
        keywords=FakeKeywords(status),
        content_plans=content_plans,
    )

    result = asyncio.run(
        execute_prepared_write(
            registry, "start_content_plan", {}, "content-plan-operation"
        )
    )

    assert result["batch_id"] == "batch-created"
    assert len(content_plans.create_calls) == 1


@pytest.mark.parametrize(
    ("source", "status", "target_count", "plan_item_count"),
    [
        ("manual", "completed", 30, 30),
        ("automatic", "running", 30, 30),
        ("automatic", "completed", 29, 30),
        ("automatic", "completed", 30, 29),
    ],
)
def test_articles_require_the_completed_automatic_thirty_item_batch(
    source: str, status: str, target_count: int, plan_item_count: int
) -> None:
    batch = SimpleNamespace(
        batch_id="batch-1",
        source=source,
        status=status,
        target_count=target_count,
        plan_item_count=plan_item_count,
    )
    registry = ToolRegistry(
        Settings(),
        FakeProjects(),
        FakeAudits(),
        content_plans=FakeContentPlans(batch),
        content=FakeContent(),
    )

    with pytest.raises(RuntimeError, match="content_plan_not_ready"):
        asyncio.run(
            execute_prepared_write(
                registry,
                "start_articles",
                {"batch_id": "batch-1", "count": 2},
                "article-operation",
            )
        )


def test_articles_are_generated_from_the_authorized_batch() -> None:
    settings = Settings()
    batch = SimpleNamespace(
        batch_id="batch-1",
        source="automatic",
        status="completed",
        target_count=30,
        plan_item_count=30,
    )
    content = FakeContent()
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        content_plans=FakeContentPlans(batch),
        content=content,
    )

    result = asyncio.run(
        execute_prepared_write(
            registry,
            "start_articles",
            {"batch_id": "batch-1", "count": 2},
            "article-operation",
        )
    )

    assert result["verified"] is True
    assert result["article_ids"] == ["article-1", "article-2"]
    assert content.calls == [
        ("project-1", 2, settings.default_organization_id, "batch-1")
    ]


def test_direct_article_creation_uses_the_existing_content_service() -> None:
    settings = Settings()
    content = FakeContent()
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        content=content,
    )

    result = asyncio.run(
        execute_prepared_write(
            registry,
            "create_article",
            {
                "primary_keyword": "AI search visibility",
                "secondary_keywords": ["AI SEO"],
                "language": "en",
            },
            "direct-article-operation",
        )
    )

    assert result == {
        "operation_id": "direct-article-operation",
        "verified": True,
        "article_id": "article-direct-1",
        "run_id": "article-run-direct-1",
        "primary_keyword": "AI search visibility",
        "title": None,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
    }
    assert content.create_calls == [(
        "project-1",
        {
            "primary_keyword": "AI search visibility",
            "secondary_keywords": ["AI SEO"],
            "article_type": None,
            "title": None,
            "writing_direction": None,
            "language": "en",
        },
        "agent:direct-article-operation:article",
        settings.default_organization_id,
    )]


def test_article_status_discovers_initial_articles_from_onboarding() -> None:
    settings = Settings()
    content = FakeContent()
    onboarding = FakeOnboarding(["article-1", "article-2"])
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        content=content,
        onboarding=onboarding,
    )

    result = asyncio.run(
        registry.execute_read("project-1", "get_article_generation_status", {})
    )

    assert onboarding.calls == [
        (settings.default_organization_id, "project-1")
    ]
    assert [item["article_id"] for item in result["articles"]] == [
        "article-1",
        "article-2",
    ]
    assert result["articles"][0] == {
        "article_id": "article-1",
        "primary_keyword": "keyword article-1",
        "title": "Article 1",
        "run_id": "article-run-1",
        "status": "completed_with_warnings",
        "stage": "completed",
        "progress": 100,
        "warnings": ["review_recommended"],
        "error_code": None,
        "error_detail": None,
    }


def test_article_status_keeps_explicit_article_id_compatibility() -> None:
    settings = Settings()
    content = FakeContent()
    onboarding = FakeOnboarding(["article-1", "article-2"])
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        content=content,
        onboarding=onboarding,
    )

    result = asyncio.run(
        registry.execute_read(
            "project-1",
            "get_article_generation_status",
            {"article_ids": ["article-manual"]},
        )
    )

    assert onboarding.calls == []
    assert result["articles"][0]["article_id"] == "article-manual"
    assert content.read_calls == [
        ("project-1", "article-manual", settings.default_organization_id)
    ]


def test_article_status_finds_manual_article_by_keyword() -> None:
    settings = Settings()
    content = FakeContent()
    onboarding = FakeOnboarding([])
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        content=content,
        onboarding=onboarding,
    )

    result = asyncio.run(
        registry.execute_read(
            "project-1",
            "get_article_generation_status",
            {"search": "hd streaming"},
        )
    )

    assert onboarding.calls == []
    assert result["articles"][0]["article_id"] == "article-hd"


def test_article_status_falls_back_to_recent_articles() -> None:
    settings = Settings()
    content = FakeContent()
    onboarding = FakeOnboarding([])
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        content=content,
        onboarding=onboarding,
    )

    result = asyncio.run(
        registry.execute_read("project-1", "get_article_generation_status", {})
    )

    assert onboarding.calls == [
        (settings.default_organization_id, "project-1")
    ]
    assert result["articles"][0]["article_id"] == "article-recent"


def test_async_status_tools_return_real_downstream_billing() -> None:
    settings = Settings()
    registry = ToolRegistry(
        settings,
        FakeProjects(),
        FakeAudits(),
        keywords=FakeKeywordsWithBilling("completed"),
        content_plans=FakeContentPlansWithBilling(),
        content=FakeContentWithBilling(),
        onboarding=FakeOnboarding(["article-1", "article-2"]),
    )

    keyword_result = asyncio.run(
        registry.execute_read("project-1", "get_keyword_library_status", {})
    )
    plan_result = asyncio.run(
        registry.execute_read(
            "project-1", "get_content_plan_status", {"batch_id": "batch-1"}
        )
    )
    article_result = asyncio.run(
        registry.execute_read("project-1", "get_article_generation_status", {})
    )

    assert keyword_result["billing"] == {
        "source": "keyword_external_requests",
        "reference_id": "keyword-run-1",
        "reported_cost_usd": 0.15,
        "complete": True,
    }
    assert "total_cost_usd" not in keyword_result["run"]
    assert plan_result["billing"] == {
        "source": "content_plan_external_requests",
        "reference_id": "batch-1",
        "reported_cost_usd": 0.42,
        "complete": True,
    }
    assert article_result["billing"] == {
        "source": "article_run_steps",
        "reference_id": "article-run-1,article-run-2",
        "reported_cost_usd": 0.42,
        "estimated_cost_usd": 0.0,
        "complete": True,
    }


def test_memory_search_requires_a_keyword_or_category() -> None:
    with pytest.raises(ValidationError, match="必须提供"):
        READ_MODELS["search_project_memory"].model_validate({})

    parsed = READ_MODELS["search_project_memory"].model_validate({
        "query": " 跨境卖家 ",
    })

    assert parsed.query == "跨境卖家"


def test_update_profile_catalog_exposes_allowed_change_fields() -> None:
    definition = next(
        item for item in tool_catalog_payload()
        if item["function"]["name"] == "update_business_profile"
    )
    schema = definition["function"]["parameters"]
    changes_ref = schema["properties"]["changes"]["$ref"].rsplit("/", 1)[-1]
    change_fields = set(schema["$defs"][changes_ref]["properties"])

    assert change_fields == {
        "business_name",
        "business_type",
        "business_summary",
        "target_audiences",
        "products_services",
        "value_propositions",
        "ai_content_rules",
    }


def test_audit_catalog_explains_the_latest_audit_dependency() -> None:
    definitions = {
        item["function"]["name"]: item["function"] for item in tool_catalog_payload()
    }

    assert "run_id" in definitions["get_latest_audit"]["description"]
    assert "受影响页面 URL" in definitions["get_audit_issues"]["description"]
    assert "fact_id" in definitions["search_project_memory"]["description"]


def test_state_changing_tools_invalidate_remaining_calls() -> None:
    invalidating = {
        name
        for name, definition in TOOL_DEFINITIONS.items()
        if definition.invalidates_remaining_calls
    }

    assert invalidating == {
        "update_business_profile",
        "refresh_business_profile",
        "start_technical_audit",
        "start_keyword_library",
        "start_content_plan",
        "start_articles",
        "create_article",
        "update_project_memory",
    }
    assert all(
        not TOOL_DEFINITIONS[name].invalidates_remaining_calls
        for name in READ_MODELS
    )


def test_latest_audit_includes_ranked_issue_details() -> None:
    registry, _ = build_registry()

    result = asyncio.run(registry.execute_read("project-1", "get_latest_audit", {}))

    assert result["audit"]["run_id"] == "audit-1"
    assert result["top_issues"]["items"][0]["title"] == "Broken links"
    assert result["top_issues"]["items"][1]["title"] == "Missing titles"
    assert result["top_issues"]["items"][2]["title"] == "Minor warning"
    assert len(result["top_issues"]["items"][0]["urls"]) == 10
    assert registry.audits.issue_calls == [
        ("project-1", "audit-1", 1, 100, None, "")
    ]


def test_read_tool_retries_a_transient_database_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry, projects = build_registry()
    projects.transient_read_failures = 1

    async def sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(retry.asyncio, "sleep", sleep)

    result = asyncio.run(
        registry.execute_read("project-1", "get_project_profile", {})
    )

    assert result["business_name"] == "Example"
    assert projects.transient_read_failures == 0


def test_unknown_tool_is_never_executed() -> None:
    registry, _ = build_registry()

    with pytest.raises(ValueError, match="不允许"):
        asyncio.run(registry.execute_read("project-1", "run_python", {}))


def test_write_tool_is_validated_and_idempotent() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "update_business_profile",
            {"changes": {"target_audiences": ["跨境电商卖家"]}},
            "operation-1",
        )
    )

    assert projects.update_calls == 0
    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    second = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first["verified"] is True
    assert first["operation_id"] == "operation-1"
    assert second["already_completed"] is True
    assert second["operation_id"] == "operation-1"
    assert projects.update_calls == 1


def test_refresh_business_profile_replay_reuses_the_same_run() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "refresh_business_profile",
            {},
            "understanding-operation-1",
        )
    )

    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first == {
        "operation_id": "understanding-operation-1",
        "verified": True,
        "run_id": "understanding-operation-1",
        "status": "queued",
    }
    assert repeated["already_completed"] is True
    assert repeated["run_id"] == "understanding-operation-1"
    assert projects.refresh_calls == 1


def test_refresh_retry_finds_original_run_after_a_newer_refresh() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "refresh_business_profile",
            {},
            "understanding-operation-1",
        )
    )
    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    asyncio.run(
        projects.refresh_business_profile(
            "project-1", "understanding-operation-2"
        )
    )

    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first["run_id"] == "understanding-operation-1"
    assert repeated == {
        "operation_id": "understanding-operation-1",
        "verified": True,
        "run_id": "understanding-operation-1",
        "status": "queued",
        "already_completed": True,
    }
    assert projects.refresh_calls == 2


def test_start_technical_audit_replay_reuses_the_same_run() -> None:
    registry, _ = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "start_technical_audit",
            {},
            "audit-operation-1",
        )
    )

    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first == {
        "operation_id": "audit-operation-1",
        "verified": True,
        "run_id": "audit-operation-1",
        "status": "queued",
    }
    assert repeated["already_completed"] is True
    assert repeated["run_id"] == "audit-operation-1"
    assert registry.audits.create_calls == 1


def test_start_technical_audit_succeeds_for_project_without_onboarding() -> None:
    registry = ToolRegistry(
        Settings(),
        FakeProjects(),
        FakeAudits(),
        onboarding=MissingOnboarding([]),
    )

    result = asyncio.run(
        execute_prepared_write(
            registry, "start_technical_audit", {}, "audit-operation-1"
        )
    )

    assert result["verified"] is True
    assert result["run_id"] == "audit-operation-1"


def test_start_technical_audit_replay_treats_a_later_audit_failure_as_created() -> None:
    registry, _ = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "start_technical_audit",
            {},
            "audit-operation-1",
        )
    )
    asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    registry.audits.runs["audit-operation-1"] = Dumpable(
        {"run_id": "audit-operation-1", "status": "failed"}
    )

    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert repeated == {
        "operation_id": "audit-operation-1",
        "verified": True,
        "run_id": "audit-operation-1",
        "status": "failed",
        "already_completed": True,
    }
    assert registry.audits.create_calls == 1


def test_profile_retry_uses_operation_record_after_intervening_change() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "update_business_profile",
            {"changes": {"target_audiences": ["跨境电商卖家"]}},
            "operation-1",
        )
    )
    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    projects.project.site_profile = Dumpable(
        {**PROFILE, "target_audiences": ["后来人工修改的客户"]}
    )

    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first["verified"] is True
    assert repeated["already_completed"] is True
    assert projects.update_calls == 1


def test_changed_precondition_rejects_stale_approval() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "update_business_profile",
            {"changes": {"target_audiences": ["跨境电商卖家"]}},
            "operation-1",
        )
    )
    changed = {**PROFILE, "target_audiences": ["Enterprise"]}
    projects.project.site_profile = Dumpable(changed)

    with pytest.raises(RuntimeError, match="状态已经变化"):
        asyncio.run(
            registry.execute_write(
                "project-1",
                "update_business_profile",
                prepared.arguments,
                prepared.before,
                prepared.parameters_hash,
            )
        )
