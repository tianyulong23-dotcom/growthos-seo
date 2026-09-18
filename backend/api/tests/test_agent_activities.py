import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError
from temporalio.exceptions import ApplicationError

from app.modules.agent import activities
from app.core.config import Settings
from app.modules.agent.context_tokens import estimate_json_tokens
from app.modules.agent.model_gateway import AgentModelOutputError, AgentModelRequestError
from app.modules.agent.repository import (
    ToolExecutionLeaseLostError,
    _safe_compactable_message_count,
)
from app.modules.agent.tools import StartAuditArgs
from app.modules.settings.service import AISettingsEncryptionUnavailableError


BASE_LIMITS = {
    "model_rounds": 8,
    "tool_calls": 8,
    "total_tokens": 100_000,
    "model_cost": 5.0,
    "paid_tool_call_cost": 1.0,
    "paid_tool_cost": 3.0,
    "run_timeout_seconds": 1_800,
    "context_window_tokens": 32_000,
    "context_trigger_tokens": 100,
    "context_input_tokens": 24_000,
    "recent_tokens": 5_000,
    "compaction_batch_tokens": 100,
    "summary_tokens": 2_000,
    "tool_round_tokens": 8_000,
    "tool_context_tokens": 6_000,
    "tool_summary_tokens": 2_000,
    "execution_lease_seconds": 60,
    "tool_result_bytes": 102_400,
}


def test_consent_failure_is_not_reported_as_invalid_tool_arguments() -> None:
    from app.modules.agent.backlinks_consent import ConsentError

    code, message, retryable = activities.error_details(
        ConsentError("BACKLINKS_CHAT_SEND_EXPLICIT_USER_COMMAND_REQUIRED"),
    )
    assert code == "BACKLINKS_CHAT_SEND_EXPLICIT_USER_COMMAND_REQUIRED"
    assert "授权" in message
    assert retryable is False


def test_missing_ai_encryption_key_is_a_permanent_configuration_error() -> None:
    code, message, retryable = activities.error_details(
        AISettingsEncryptionUnavailableError()
    )

    assert code == "model_provider_configuration_error"
    assert message == "AI 模型配置当前不可用，请检查服务器加密配置"
    assert retryable is False


class CheckRunRepository:
    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "created_at": datetime.now(UTC) - timedelta(seconds=1_801),
            "limits": BASE_LIMITS,
        }


class CostLimitRepository(CheckRunRepository):
    def __init__(self, usage: dict[str, int | float]) -> None:
        self.usage = usage

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "created_at": datetime.now(UTC),
            "limits": BASE_LIMITS,
        }

    async def run_usage(self, run_id: str) -> dict[str, int | float]:
        return self.usage


def test_run_duration_limit_stops_before_another_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(activities, "repository", lambda: CheckRunRepository())

    result = asyncio.run(activities.check_run({"run_id": "run-1"}))

    assert result == {
        "allowed": False,
        "status": "limit_reached",
        "reason_code": "run_timeout",
        "reason": "本次任务已达到平台运行时长上限",
    }


class ToolBudgetRepository:
    def __init__(self, tool_cost: float) -> None:
        self.tool_cost = tool_cost
        self.steps: list[dict[str, Any]] = []

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "project_id": "project-1",
            "limits": BASE_LIMITS,
        }

    async def run_usage(self, run_id: str) -> dict[str, int | float]:
        return {
            "model_calls": 0,
            "tool_calls": 0,
            "total_tokens": 0,
            "model_cost": 0.0,
            "tool_cost": self.tool_cost,
        }

    async def add_step(self, run_id: str, *args: Any, **kwargs: Any) -> None:
        self.steps.append({"run_id": run_id, "args": args, "kwargs": kwargs})

    async def claim_registered_tool(
        self, run_id: str, tool_call_id: str, worker_id: str, lease_seconds: int
    ) -> tuple[str, Any]:
        return "claimed", SimpleNamespace(
            tool_name="start_technical_audit",
            arguments_json={},
            parameters_hash="a" * 64,
            model_tool_call_id="provider-call-1",
        )

    async def fail_tool_execution(self, *args: Any) -> None:
        self.steps.append({"failed_execution": args})


class RegistryThatMustNotRun:
    async def execute_read(self, project_id: str, name: str, arguments: dict) -> dict:
        raise AssertionError("budget rejection must happen before registry execution")

    async def prepare_write(
        self, project_id: str, name: str, arguments: dict, operation_id: str
    ) -> None:
        raise AssertionError("write intent rejection must happen before registry execution")


class RejectedPaidToolBudgetRepository(ToolBudgetRepository):
    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "project_id": "project-1",
            "limits": BASE_LIMITS,
            "messages": [{
                "role": "user",
                "content": "start approved onboarding work",
                "metadata": {
                    "trusted_system_trigger": True,
                    "trusted_write_tools": ["start_technical_audit"],
                },
            }],
        }

    async def reserve_paid_tool_budget(
        self,
        run_id: str,
        tool_call_id: str,
        tool_name: str,
        reserve_usd: float,
        limit_usd: float,
    ) -> dict[str, Any]:
        return {"allowed": False, "projected_cost": 3.5, "limit": limit_usd}


@pytest.mark.parametrize(
    ("tool_name", "message"),
    [
        ("update_business_profile", "请把目标客户改成中小型跨境电商卖家"),
        ("refresh_business_profile", "请重新识别网站业务资料"),
        ("start_technical_audit", "帮我启动一次网站审计"),
    ],
)
def test_write_requires_a_matching_explicit_user_request(
    tool_name: str, message: str
) -> None:
    assert activities.user_explicitly_requested_write(
        tool_name, [{"role": "user", "content": message}]
    )


@pytest.mark.parametrize(
    ("tool_name", "message"),
    [
        ("start_technical_audit", "请读取最新审计，没有历史数据就如实说明"),
        ("start_technical_audit", "检查项目是否已经开始审计"),
        ("start_technical_audit", "不要启动网站审计，只读取已有数据"),
        ("refresh_business_profile", "分析当前网站业务资料"),
        ("update_business_profile", "告诉我目标客户是什么"),
    ],
)
def test_read_or_negated_request_never_authorizes_a_write(
    tool_name: str, message: str
) -> None:
    assert not activities.user_explicitly_requested_write(
        tool_name, [{"role": "user", "content": message}]
    )


def test_trusted_internal_event_authorizes_only_its_listed_write_tools() -> None:
    messages = [
        {
            "role": "user",
            "content": "start approved onboarding work",
            "metadata": {
                "trusted_system_trigger": True,
                "trusted_write_tools": [
                    "start_technical_audit",
                    "start_keyword_library",
                ],
            },
        }
    ]

    assert activities.trusted_system_authorized_write(
        "start_technical_audit", messages
    )
    assert activities.trusted_system_authorized_write(
        "start_keyword_library", messages
    )
    assert not activities.trusted_system_authorized_write(
        "start_content_plan", messages
    )
    assert not activities.trusted_system_authorized_write(
        "start_articles", messages
    )


@pytest.mark.parametrize(
    "message",
    [
        "用关键词 AI SEO 工具生成一篇文章",
        "随机选一个关键词写一篇文章",
        "围绕 technical SEO audit 写一篇内容",
        "从当前关键词库随机选择一个适合 ElephTV 的关键词，生成 1 篇文章。不要创建内容计划。",
        "write an article for the keyword AI search visibility",
    ],
)
def test_keyword_article_request_authorizes_direct_article_creation(
    message: str,
) -> None:
    messages = [{"role": "user", "content": message}]

    assert activities.user_explicitly_requested_write("create_article", messages)
    assert not activities.user_explicitly_requested_write("start_articles", messages)


@pytest.mark.parametrize(
    "message",
    [
        "从内容计划生成两篇文章",
        "写内容计划中的首篇文章",
        "generate an article from the content plan",
    ],
)
def test_content_plan_article_request_authorizes_only_planned_article_generation(
    message: str,
) -> None:
    messages = [{"role": "user", "content": message}]

    assert activities.user_explicitly_requested_write("start_articles", messages)
    assert not activities.user_explicitly_requested_write("create_article", messages)


@pytest.mark.parametrize(
    "message",
    [
        "可以生成关键词文章吗？",
        "怎么从内容计划生成文章？",
        "能不能用这个关键词写文章？",
    ],
)
def test_article_capability_question_does_not_authorize_a_paid_write(
    message: str,
) -> None:
    messages = [{"role": "user", "content": message}]

    assert not activities.user_explicitly_requested_write("create_article", messages)
    assert not activities.user_explicitly_requested_write("start_articles", messages)


def test_unrequested_write_is_rejected_before_business_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = ToolBudgetRepository(0.0)

    async def get_run_context(run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "project_id": "project-1",
            "limits": BASE_LIMITS,
            "messages": [
                {"role": "user", "content": "请读取最新审计并总结问题"}
            ],
        }

    repo.get_run_context = get_run_context  # type: ignore[method-assign]
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "registry", lambda: RegistryThatMustNotRun())

    result = asyncio.run(
        activities.execute_tool(
            {
                "run_id": "run-1",
                "tool_call_id": "tool-call-1",
            }
        )
    )

    assert result["ok"] is False
    assert result["error_code"] == "write_not_explicitly_requested"
    assert len(repo.steps) == 2
    assert repo.steps[0]["failed_execution"][2] == "write_not_explicitly_requested"


def test_paid_tool_budget_is_reserved_before_business_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = RejectedPaidToolBudgetRepository(2.5)
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "registry", lambda: RegistryThatMustNotRun())

    result = asyncio.run(
        activities.execute_tool({
            "run_id": "run-1",
            "tool_call_id": "tool-call-1",
        })
    )

    assert result["ok"] is False
    assert result["error_code"] == "paid_tool_budget_exceeded"


class ProjectMemoryRepository:
    def __init__(self) -> None:
        self.events: list[tuple[str, Any]] = []

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "project_id": "project-1",
            "limits": {
                **BASE_LIMITS,
                "execution_lease_seconds": 60,
                "tool_result_bytes": 102_400,
            },
            "messages": [{
                "role": "user",
                "content": "目标客户是大型企业",
            }],
        }

    async def start_step(
        self, run_id: str, step_type: str, name: str, input_json: dict
    ) -> str:
        self.events.append(("step_started", {"name": name, "input": input_json}))
        return "step-1"

    async def claim_registered_tool(
        self, run_id: str, tool_call_id: str, worker_id: str, lease_seconds: int
    ) -> tuple[str, Any]:
        operations = [{
            "operation": "add",
            "category": "target_customers",
            "value": "大型企业",
            "source": "user_confirmed",
        }]
        self.events.append(("claimed", {
            "tool_call_id": tool_call_id,
            "lease_seconds": lease_seconds,
        }))
        return "claimed", SimpleNamespace(
            tool_name="update_project_memory",
            arguments_json={"operations": operations},
            parameters_hash="a" * 64,
            model_tool_call_id="memory-provider-call-1",
        )

    async def finish_step(
        self, step_id: str, output_json: dict, duration_ms: int, **kwargs: Any
    ) -> None:
        self.events.append(("step_finished", output_json))

    async def prepare_registered_tool(self, *args: Any) -> None:
        self.events.append(("prepared", args))

    async def complete_tool_execution(self, *args: Any) -> None:
        self.events.append(("completed", args))

    async def update_project_memory(
        self,
        run_id: str,
        operations: list[dict[str, Any]],
        *,
        tool_call_id: str,
        worker_id: str,
    ) -> dict[str, Any]:
        self.events.append(("updated_and_completed", {
            "run_id": run_id,
            "operations": operations,
            "tool_call_id": tool_call_id,
            "worker_id": worker_id,
        }))
        return {
            "verified": True,
            "applied": [{"operation": "add", "fact_id": "fact-1"}],
            "facts": [{
                "fact_id": "fact-1",
                "category": "target_customers",
                "value": "大型企业",
                "source": "user_confirmed",
                "source_message_id": "message-1",
            }],
        }

    async def fail_tool_execution(
        self, tool_call_id: str, worker_id: str, error_code: str
    ) -> None:
        raise AssertionError("successful memory update must not be marked failed")


def test_project_memory_tool_is_claimed_saved_verified_and_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = ProjectMemoryRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    operations = [{
        "operation": "add",
        "category": "target_customers",
        "value": "大型企业",
        "source": "user_confirmed",
    }]

    result = asyncio.run(activities.execute_tool({
        "run_id": "run-1",
        "tool_call_id": "memory-call-1",
    }))

    assert result["ok"] is True
    assert result["ok"] is True
    assert result["data"]["verified"] is True
    assert [event for event, _ in repo.events] == [
        "claimed", "step_started", "prepared", "updated_and_completed",
        "completed", "step_finished",
    ]
    assert repo.events[3][1]["operations"] == operations
    assert repo.events[3][1]["tool_call_id"] == "memory-call-1"
    assert repo.events[0][1]["lease_seconds"] == 60


@pytest.mark.parametrize(("name", "arguments"), [
    ("list_backlink_opportunities", {"limit": 1}),
    ("get_backlink_gmail_status", {}),
    ("get_backlink_gmail_sync_status", {"connectionId": "55555555-5555-4555-8555-555555555555"}),
    ("list_backlink_send_intents", {"limit": 1}),
    ("get_backlink_send_intent", {"sendIntentId": "55555555-5555-4555-8555-555555555555"}),
    ("get_backlink_mail_message", {"messageId": "55555555-5555-4555-8555-555555555555"}),
    ("get_backlink_mail_thread", {"threadId": "55555555-5555-4555-8555-555555555555"}),
])
def test_backlink_read_uses_persisted_run_scope_without_write_preparation(
    monkeypatch: pytest.MonkeyPatch,
    name: str, arguments: dict,
) -> None:
    class ReadRepository(ProjectMemoryRepository):
        async def get_run_context(self, run_id: str) -> dict[str, Any]:
            context = await super().get_run_context(run_id)
            return {
                **context, "organization_id": "server-org",
                "limits": {**context["limits"], "backlinks_delegation": {"signed": "test-grant"}},
            }

        async def claim_registered_tool(self, *args: Any) -> tuple[str, Any]:
            return "claimed", SimpleNamespace(
                tool_name=name,
                arguments_json=arguments,
                parameters_hash="a" * 64,
                model_tool_call_id="read-provider-call",
            )

    calls = []

    class ReadRegistry:
        async def execute_read(
            self, project_id: str, name: str, arguments: dict, *, organization_id: str,
            delegation: dict,
        ) -> dict:
            calls.append((project_id, name, arguments, organization_id))
            assert delegation == {"signed": "test-grant"}
            return {"items": [], "nextCursor": None}

    repo = ReadRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "registry", ReadRegistry)
    result = asyncio.run(activities.execute_tool({
        "run_id": "run-1", "tool_call_id": "read-call",
        "project_id": "untrusted-project", "organization_id": "untrusted-org",
    }))
    assert result["ok"] is True
    assert calls == [
        ("project-1", name, arguments, "server-org"),
    ]
    assert [event for event, _ in repo.events] == [
        "step_started", "completed", "step_finished",
    ]


class BusyToolRepository:
    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "project_id": "project-1",
            "limits": BASE_LIMITS,
        }

    async def claim_registered_tool(
        self, run_id: str, tool_call_id: str, worker_id: str, lease_seconds: int
    ) -> tuple[str, Any]:
        return "busy", SimpleNamespace()


def test_busy_tool_stays_in_temporal_retry_instead_of_returning_to_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(activities, "repository", BusyToolRepository)

    with pytest.raises(ApplicationError) as raised:
        asyncio.run(activities.execute_tool({
            "run_id": "run-1",
            "tool_call_id": "tool-call-1",
        }))

    assert raised.value.type == "ToolExecutionBusy"
    assert raised.value.next_retry_delay == timedelta(seconds=2)


class LeaseRenewalRepository:
    def __init__(self) -> None:
        self.renewed = asyncio.Event()
        self.calls: list[tuple[str, str, int]] = []

    async def renew_tool_lease(
        self, tool_call_id: str, worker_id: str, lease_seconds: int
    ) -> bool:
        self.calls.append((tool_call_id, worker_id, lease_seconds))
        self.renewed.set()
        return True


def test_temporal_tool_execution_heartbeats_and_renews_database_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = LeaseRenewalRepository()
    heartbeats: list[dict[str, str]] = []
    sleep_intervals: list[float] = []
    real_sleep = asyncio.sleep

    async def operation() -> str:
        await repo.renewed.wait()
        return "done"

    async def immediate_sleep(seconds: float) -> None:
        sleep_intervals.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(activities, "temporal_activity_running", lambda: True)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda details: heartbeats.append(details))
    monkeypatch.setattr(activities.asyncio, "sleep", immediate_sleep)

    result = asyncio.run(activities.run_with_tool_lease(
        operation(), repo, "tool-call-1", "worker-1", 300
    ))

    assert result == "done"
    assert heartbeats[0] == {"tool_call_id": "tool-call-1"}
    assert repo.calls[0] == ("tool-call-1", "worker-1", 300)
    assert activities.TOOL_HEARTBEAT_INTERVAL_SECONDS in sleep_intervals
    assert 100 in sleep_intervals
    assert activities.TOOL_HEARTBEAT_INTERVAL_SECONDS < 10


def test_database_failure_during_lease_renewal_retries_same_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operation_cancelled = asyncio.Event()
    real_sleep = asyncio.sleep

    class FailingLeaseRepository:
        async def renew_tool_lease(
            self, _tool_call_id: str, _worker_id: str, _lease_seconds: int
        ) -> bool:
            error = ConnectionError("database connection reset")
            error.errno = 10054
            raise error

    async def operation() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            operation_cancelled.set()

    async def immediate_sleep(_: float) -> None:
        await real_sleep(0)

    monkeypatch.setattr(activities, "temporal_activity_running", lambda: True)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda _details: None)
    monkeypatch.setattr(activities.asyncio, "sleep", immediate_sleep)

    with pytest.raises(ApplicationError) as raised:
        asyncio.run(activities.run_with_tool_lease(
            operation(), FailingLeaseRepository(), "tool-call-1", "worker-1", 3
        ))

    assert raised.value.type == "ToolLeaseDatabaseUnavailable"
    assert raised.value.next_retry_delay == timedelta(seconds=2)
    assert operation_cancelled.is_set()


def test_lost_database_lease_cancels_operation_and_retries_same_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operation_cancelled = asyncio.Event()
    real_sleep = asyncio.sleep

    class LostLeaseRepository:
        async def renew_tool_lease(
            self, _tool_call_id: str, _worker_id: str, _lease_seconds: int
        ) -> bool:
            return False

    async def operation() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            operation_cancelled.set()

    async def immediate_sleep(_: float) -> None:
        await real_sleep(0)

    monkeypatch.setattr(activities, "temporal_activity_running", lambda: True)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda _details: None)
    monkeypatch.setattr(activities.asyncio, "sleep", immediate_sleep)

    with pytest.raises(ApplicationError) as raised:
        asyncio.run(activities.run_with_tool_lease(
            operation(), LostLeaseRepository(), "tool-call-1", "worker-1", 3
        ))

    assert raised.value.type == "ToolExecutionLeaseLost"
    assert raised.value.next_retry_delay == timedelta(seconds=2)
    assert operation_cancelled.is_set()


class LeaseLostDuringWriteRepository:
    def __init__(self) -> None:
        self.failed = False

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "running",
            "project_id": "project-1",
            "limits": BASE_LIMITS,
            "messages": [{"role": "user", "content": "请重新识别网站业务资料"}],
        }

    async def claim_registered_tool(
        self, run_id: str, tool_call_id: str, worker_id: str, lease_seconds: int
    ) -> tuple[str, Any]:
        return "claimed", SimpleNamespace(
            tool_name="refresh_business_profile",
            arguments_json={},
            before_json={},
            parameters_hash="a" * 64,
            model_tool_call_id="provider-call-1",
        )

    async def start_step(self, *args: Any, **kwargs: Any) -> str:
        return "step-1"

    async def reserve_paid_tool_budget(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"allowed": True, "projected_cost": 1.0, "limit": 3.0}

    async def prepare_registered_tool(self, *args: Any) -> None:
        return None

    async def set_tool_verifying(self, *args: Any) -> None:
        raise ToolExecutionLeaseLostError("工具执行权已经失效")

    async def fail_tool_execution(self, *args: Any) -> None:
        self.failed = True


class SuccessfulRefreshRegistry:
    async def prepare_write(
        self, project_id: str, name: str, arguments: dict, operation_id: str
    ) -> Any:
        return SimpleNamespace(
            arguments={"operation_id": operation_id},
            before={"understanding_run_id": None, "understanding_status": None},
            parameters_hash="b" * 64,
        )

    async def execute_write(self, *args: Any) -> dict[str, Any]:
        return {"verified": True, "status": "queued"}


def test_execute_tool_keeps_lease_loss_in_temporal_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = LeaseLostDuringWriteRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "registry", lambda: SuccessfulRefreshRegistry())

    with pytest.raises(ApplicationError) as raised:
        asyncio.run(activities.execute_tool({
            "run_id": "run-1",
            "tool_call_id": "tool-call-1",
        }))

    assert raised.value.type == "ToolExecutionLeaseLost"
    assert raised.value.next_retry_delay == timedelta(seconds=2)
    assert repo.failed is False


def test_oversized_memory_result_is_bounded_after_compaction() -> None:
    result = {
        "verified": True,
        "facts": [{
            "fact_id": f"fact-{index}",
            "category": "target_customers",
            "value": "中" * 2_000,
            "source": "user_confirmed",
        } for index in range(20)],
        "applied": [{
            "operation": "add",
            "fact_id": f"fact-{index}",
            "category": "target_customers",
            "value": "中" * 2_000,
            "source": "user_confirmed",
        } for index in range(20)],
    }

    bounded = activities.bound_tool_result_data(
        "memory-call-1", "update_project_memory", result, 102_400
    )

    assert bounded["verified"] is True
    assert bounded["truncated"] is True
    assert len(json.dumps(bounded, ensure_ascii=False).encode()) <= 102_400


def test_complete_tool_output_bounds_large_valid_arguments() -> None:
    def paths(prefix: str, count: int) -> list[str]:
        return [f"/{prefix}-{index}-" + "x" * 2_000 for index in range(count)]

    arguments = StartAuditArgs.model_validate({
        "allowed_paths": paths("allow", 100),
        "excluded_paths": paths("exclude", 100),
        "issue_exclusion_patterns": paths("issue", 250),
    }).model_dump(mode="json")
    output = {
        "tool_call_id": "audit-call-1",
        "tool": "start_technical_audit",
        "arguments": arguments,
        "ok": True,
        "summary": "技术审核任务状态：queued",
        "data": {"verified": True, "run_id": "run-1", "status": "queued"},
        "error_code": None,
        "retryable": False,
        "cost": 0.0,
    }

    bounded = activities.bound_tool_output(output, 102_400)

    assert activities.encoded_size(output) > 102_400
    assert activities.encoded_size(bounded) <= 102_400
    assert bounded["arguments"]["_truncated"] is True
    assert bounded["arguments"]["original_bytes"] > 102_400
    assert bounded["data"] == output["data"]


def test_model_result_views_keep_audit_result_separate_from_model_views() -> None:
    output = {
        "tool_call_id": "provider-call-1",
        "tool": "get_audit_pages",
        "arguments": {"run_id": "audit-1", "page": 1},
        "ok": True,
        "summary": "读取完成",
        "data": {
            "run_id": "audit-1",
            "page": 1,
            "page_size": 20,
            "total": 20,
            "items": [{
                "url": f"https://example.com/{index}",
                "body": "x" * 20_000,
            } for index in range(20)],
        },
        "error_code": None,
        "retryable": False,
        "cost": 0.0,
    }

    views = activities.build_model_result_views(
        output, {"tool_result_bytes": 20_000}
    )

    assert activities.encoded_size(views["once"]) <= 20_000
    assert views["long_term"]["data"]["items"][0] == {
        "url": "https://example.com/0"
    }
    assert output["data"]["items"][0]["body"] == "x" * 20_000
    assert views["once"] is not output


def test_project_profile_authoritative_fields_survive_long_term_compaction() -> None:
    output = {
        "tool_call_id": "provider-call-1",
        "tool": "get_project_profile",
        "arguments": {},
        "ok": True,
        "summary": "数据读取完成",
        "data": {
            "id": "project-1",
            "name": "Asana",
            "domain": "asana.com",
            "country": "US",
            "language": "en",
            "site_profile": {
                "business_name": "Asana",
                "business_type": "Work management platform",
                "business_summary": "Work management software for teams.",
                "target_audiences": ["Global teams"],
                "products_services": ["Project management"],
                "value_propositions": ["Coordinate work across teams"],
            },
        },
        "error_code": None,
        "retryable": False,
        "cost": 0.0,
    }

    views = activities.build_model_result_views(
        output, {"tool_result_bytes": 102_400}
    )

    assert views["long_term"]["data"]["domain"] == "asana.com"
    assert views["long_term"]["data"]["language"] == "en"
    assert views["long_term"]["data"]["site_profile"]["business_name"] == "Asana"


def test_tool_result_batch_is_bounded_without_dropping_failure() -> None:
    results = [
        {
            "tool_call_id": "provider-success",
            "tool": "get_audit_pages",
            "arguments": {"run_id": "audit-1"},
            "ok": True,
            "summary": "读取完成",
            "data": {"items": [{"body": "x" * 40_000}]},
            "error_code": None,
            "retryable": False,
            "result_ref": {"tool_call_id": "internal-success"},
            "tool_batch_id": "run-1:1",
        },
        {
            "tool_call_id": "provider-failure",
            "tool": "get_latest_audit",
            "arguments": {},
            "ok": False,
            "summary": "依赖服务暂时不可用" + "y" * 20_000,
            "data": {},
            "error_code": "agent_dependency_failed",
            "retryable": True,
            "result_ref": {"tool_call_id": "internal-failure"},
            "tool_batch_id": "run-1:1",
        },
    ]

    bounded = activities.bound_tool_result_batch(results, 8_000)

    assert estimate_json_tokens(bounded) <= 8_000
    failure = next(item for item in bounded if item["tool_call_id"] == "provider-failure")
    assert failure["ok"] is False
    assert failure["error_code"] == "agent_dependency_failed"
    assert failure["retryable"] is True
    assert failure["result_ref"] == {"tool_call_id": "internal-failure"}


class RecoveredDecisionRepository:
    def __init__(self) -> None:
        self.finished: tuple[str, int, list[dict[str, Any]]] | None = None

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {"status": "running"}

    async def registered_tool_call_refs(
        self, run_id: str, round_number: int
    ) -> list[dict[str, Any]]:
        return [{
            "tool_call_id": "run-1:2:1",
            "model_tool_call_id": "provider-call-1",
            "tool": "get_project_profile",
            "arguments_hash": "a" * 64,
        }]

    async def finish_recovered_model_step(
        self, run_id: str, round_number: int, tool_calls: list[dict[str, Any]]
    ) -> int:
        self.finished = (run_id, round_number, tool_calls)
        return 1


class DecisionGatewayThatMustNotRun:
    async def decide(self, *args: Any, **kwargs: Any) -> None:
        raise AssertionError("persisted tool calls must be reused without another model call")


def test_activity_model_gateway_applies_temporal_request_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Gateway:
        pass

    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    gateway = activities.activity_model_gateway({
        "request_timeout_seconds": 105,
        "max_retries": 0,
    })

    assert gateway.request_timeout_seconds == 105
    assert gateway.max_retries == 0


def test_research_update_uses_only_successful_evidence_reads_from_current_run() -> None:
    research = activities.research_update_for_run(
        [
            {"role": "assistant", "content": "之前的问题"},
            {"role": "user", "content": "你认为业务资料准确吗？"},
        ],
        [
            {
                "tool": "get_project_profile",
                "ok": True,
                "arguments": {},
                "summary": "读取完成",
            },
            {
                "tool": "get_latest_audit",
                "ok": False,
                "arguments": {},
                "summary": "读取失败",
            },
            {
                "tool": "search_project_memory",
                "ok": True,
                "arguments": {"query": "业务"},
                "summary": "记忆读取完成",
            },
            {
                "tool": "update_business_profile",
                "ok": True,
                "arguments": {"changes": {"business_name": "Example"}},
                "summary": "更新完成",
            },
        ],
        "核心定位准确，但目标市场仍缺少证据。",
    )

    assert research == {
        "topic": "你认为业务资料准确吗？",
        "input_scope": {
            "evidence_reads": [{"tool": "get_project_profile", "arguments": {}}],
        },
        "conclusion": "核心定位准确，但目标市场仍缺少证据。",
    }


def test_model_cost_limit_stops_before_another_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        activities,
        "repository",
        lambda: CostLimitRepository({
            "model_calls": 2,
            "tool_calls": 0,
            "total_tokens": 500,
            "model_cost": 5.0,
            "tool_cost": 0.0,
        }),
    )

    result = asyncio.run(activities.check_run({"run_id": "run-1"}))

    assert result["allowed"] is False
    assert result["reason_code"] == "model_cost_limit"


def test_total_paid_cost_limit_stops_before_another_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        activities,
        "repository",
        lambda: CostLimitRepository({
            "model_calls": 1,
            "tool_calls": 2,
            "total_tokens": 250,
            "model_cost": 1.5,
            "tool_cost": 1.5,
        }),
    )

    result = asyncio.run(activities.check_run({"run_id": "run-1"}))

    assert result["allowed"] is False
    assert result["reason_code"] == "paid_cost_limit"


def test_research_update_skips_chat_memory_and_failed_reads() -> None:
    assert activities.research_update_for_run(
        [{"role": "user", "content": "你好"}],
        [{"tool": "search_project_memory", "ok": True, "arguments": {}}],
        "你好，我是 Aris。",
    ) is None
    assert activities.research_update_for_run(
        [{"role": "user", "content": "审计怎么样"}],
        [{"tool": "get_latest_audit", "ok": False, "arguments": {}}],
        "暂时无法读取审计。",
    ) is None


def test_model_decision_reuses_registered_calls_without_calling_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = RecoveredDecisionRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", DecisionGatewayThatMustNotRun)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 2}))

    assert result["type"] == "tool_calls"
    assert result["tool_calls"][0]["tool_call_id"] == "run-1:2:1"
    assert repo.finished == ("run-1", 2, result["tool_calls"])


class FailedModelDecisionRepository:
    def __init__(self) -> None:
        self.failed_step: dict[str, Any] | None = None

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "organization_id": "test-org",
            "status": "running",
            "messages": [{"role": "user", "content": "检查项目"}],
            "project": {},
            "project_memory": [],
            "research_records": [],
            "conversation_summary": "",
            "limits": BASE_LIMITS,
        }

    async def registered_tool_call_refs(
        self, run_id: str, round_number: int
    ) -> list[dict[str, Any]]:
        return []

    async def register_tool_calls(
        self,
        run_id: str,
        round_number: int,
        tool_calls: list[dict[str, Any]],
        max_arguments_bytes: int,
    ) -> list[dict[str, Any]]:
        return tool_calls

    async def tool_model_context(
        self, run_id: str, round_number: int
    ) -> dict[str, Any]:
        return {"summary": "", "results": []}

    async def start_step(
        self, run_id: str, step_type: str, name: str, input_json: dict[str, Any]
    ) -> str:
        return "step-1"

    async def finish_step(
        self,
        step_id: str,
        output_json: dict[str, Any],
        duration_ms: int,
        **kwargs: Any,
    ) -> None:
        self.failed_step = {"output": output_json, "kwargs": kwargs}


class PermanentlyFailedDecisionGateway:
    async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
        return 1

    async def decide(self, *args: Any, **kwargs: Any) -> None:
        raise AgentModelRequestError(
            "模型 API 密钥无效或没有权限",
            error_code="model_provider_auth_failed",
            retryable=False,
            status_code=401,
        )


class InvalidOutputDecisionGateway:
    async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
        return 1

    async def decide(self, *args: Any, **kwargs: Any) -> None:
        raise AgentModelOutputError("模型返回了无效内容")


def test_model_activity_returns_permanent_provider_error_without_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FailedModelDecisionRepository()

    async def no_compaction(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", PermanentlyFailedDecisionGateway)
    monkeypatch.setattr(activities, "compact_history", no_compaction)
    monkeypatch.setattr(activities, "compact_tool_history", no_compaction)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result == {
        "type": "model_error",
        "error_code": "model_provider_auth_failed",
        "message": "模型 API 密钥无效或没有权限",
        "retryable": False,
    }
    assert repo.failed_step is not None
    assert repo.failed_step["kwargs"]["error_code"] == "model_provider_auth_failed"


def test_model_activity_does_not_offer_to_repeat_an_invalid_paid_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FailedModelDecisionRepository()

    async def no_compaction(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", InvalidOutputDecisionGateway)
    monkeypatch.setattr(activities, "compact_history", no_compaction)
    monkeypatch.setattr(activities, "compact_tool_history", no_compaction)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "model_error"
    assert result["error_code"] == "invalid_model_output"
    assert result["retryable"] is False


def test_tool_result_limit_cannot_be_smaller_than_minimal_message() -> None:
    with pytest.raises(ValidationError):
        Settings(agent_tool_result_bytes=10)


class CompactionRepository:
    def __init__(self) -> None:
        self.summary: tuple[str, int, str, str | None] | None = None
        self.step: dict[str, Any] | None = None

    async def save_conversation_summary(
        self,
        conversation_id: str,
        through_message_count: int,
        content: str,
        expected_active_message_id: str | None,
    ) -> bool:
        self.summary = (
            conversation_id,
            through_message_count,
            content,
            expected_active_message_id,
        )
        return True

    async def add_step(self, run_id: str, *args: Any, **kwargs: Any) -> None:
        self.step = {"run_id": run_id, "args": args, "kwargs": kwargs}


class SummaryDecision:
    answer = "压缩后的历史摘要"


class SummaryResult:
    decision = SummaryDecision()
    usage = {
        "input_tokens": 50,
        "output_tokens": 10,
        "total_tokens": 60,
        "cost": 0.02,
        "cost_currency": "USD",
    }


class SummaryGateway:
    async def summarize(self, old_summary: str, messages: list[dict]) -> SummaryResult:
        return SummaryResult()


class LifecycleCompactionRepository(CompactionRepository):
    def __init__(self) -> None:
        super().__init__()
        self.events: list[tuple[str, Any]] = []

    async def start_step(
        self, run_id: str, step_type: str, name: str, input_json: dict
    ) -> str:
        self.events.append(("started", {"name": name, "input": input_json}))
        return "step-1"

    async def finish_step(
        self, step_id: str, output_json: dict, duration_ms: int, **kwargs: Any
    ) -> None:
        self.events.append(("finished", {
            "step_id": step_id,
            "output": output_json,
            "status": kwargs.get("status", "completed"),
        }))


class LifecycleSummaryGateway:
    repo: LifecycleCompactionRepository

    async def summarize(self, old_summary: str, messages: list[dict]) -> SummaryResult:
        assert self.repo.events[0][0] == "started"
        return SummaryResult()


def test_history_compaction_marks_the_same_step_running_then_completed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = LifecycleCompactionRepository()
    LifecycleSummaryGateway.repo = repo
    context = {
        "conversation_id": "conversation-1",
        "active_message_id": "message-5",
        "conversation_summary": "旧摘要",
        "compactable_messages": [{"role": "user", "content": "x" * 100}],
        "compactable_through_count": 5,
        "limits": BASE_LIMITS,
    }
    monkeypatch.setattr(activities, "ModelGateway", LifecycleSummaryGateway)

    asyncio.run(activities.compact_history(repo, context, "run-1", request_tokens=100))

    assert [event[0] for event in repo.events] == ["started", "finished"]
    assert repo.events[1][1]["step_id"] == "step-1"
    assert repo.events[1][1]["status"] == "completed"


class FailedSummaryGateway:
    async def summarize(self, old_summary: str, messages: list[dict]) -> SummaryResult:
        raise RuntimeError("summary provider unavailable")


def test_history_compaction_records_its_model_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = CompactionRepository()
    context = {
        "conversation_id": "conversation-1",
        "active_message_id": "message-5",
        "conversation_summary": "旧摘要",
        "compactable_messages": [{"role": "user", "content": "x" * 100}],
        "compactable_through_count": 5,
        "limits": BASE_LIMITS,
    }
    monkeypatch.setattr(activities, "ModelGateway", SummaryGateway)

    asyncio.run(activities.compact_history(repo, context, "run-1", request_tokens=100))

    assert repo.summary == (
        "conversation-1", 5, "压缩后的历史摘要", "message-5"
    )
    assert repo.step is not None
    assert repo.step["args"][0:2] == ("model", "history_compaction")
    assert repo.step["kwargs"]["usage"] == SummaryResult.usage


def test_history_compaction_failure_is_recorded_and_does_not_escape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = CompactionRepository()
    context = {
        "conversation_id": "conversation-1",
        "active_message_id": "message-5",
        "conversation_summary": "旧摘要",
        "compactable_messages": [{"role": "user", "content": "x" * 100}],
        "compactable_through_count": 5,
        "limits": BASE_LIMITS,
    }
    monkeypatch.setattr(activities, "ModelGateway", FailedSummaryGateway)

    asyncio.run(activities.compact_history(repo, context, "run-1", request_tokens=100))

    assert repo.summary is None
    assert repo.step is not None
    assert repo.step["args"][0:2] == ("model", "history_compaction")
    assert repo.step["kwargs"]["status"] == "failed"
    assert "保留原对话继续执行" in repo.step["args"][3]["error"]


def test_history_summary_batches_preserve_every_character() -> None:
    messages = [
        {"role": "user", "content": "a" * 7},
        {"role": "assistant", "content": "b" * 8},
        {"role": "user", "content": ""},
    ]

    batches = activities.history_summary_batches(messages, 24)

    rebuilt: dict[str, str] = {"user": "", "assistant": ""}
    for batch in batches:
        assert estimate_json_tokens(batch) <= 24
        for item in batch:
            rebuilt[str(item["role"])] += str(item["content"])
    assert rebuilt == {"user": "a" * 7, "assistant": "b" * 8}


class ContextDecision:
    def model_dump(self, mode: str) -> dict[str, Any]:
        return {"type": "final", "answer": "done", "evidence": [], "research": None}


class ContextResult:
    decision = ContextDecision()
    model = "test-model"
    base_url = "https://models.example/v1"
    usage = {"total_tokens": 12}


class ContextDecisionRepository(CompactionRepository):
    def __init__(self, contexts: list[dict[str, Any]]) -> None:
        super().__init__()
        self.contexts = contexts
        self.context_index = 0
        self.finished_steps: list[dict[str, Any]] = []

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return self.contexts[self.context_index]

    async def save_conversation_summary(
        self,
        conversation_id: str,
        through_message_count: int,
        content: str,
        expected_active_message_id: str | None,
    ) -> bool:
        saved = await super().save_conversation_summary(
            conversation_id,
            through_message_count,
            content,
            expected_active_message_id,
        )
        if self.context_index < len(self.contexts) - 1:
            self.context_index += 1
        return saved

    async def registered_tool_call_refs(
        self, run_id: str, round_number: int
    ) -> list[dict[str, Any]]:
        return []

    async def register_tool_calls(
        self,
        run_id: str,
        round_number: int,
        calls: list[dict[str, Any]],
        max_argument_bytes: int,
    ) -> list[dict[str, Any]]:
        return [
            {
                "tool_call_id": f"{run_id}:{round_number}:{index}",
                "model_tool_call_id": call["tool_call_id"],
                "tool": call["tool"],
                "arguments_hash": "hash",
            }
            for index, call in enumerate(calls, start=1)
        ]

    async def tool_model_context(
        self, run_id: str, round_number: int
    ) -> dict[str, Any]:
        return {"summary": "", "results": []}

    async def repair_interrupted_tool_calls(self, run_id: str, current_round: int) -> int:
        return 0

    async def start_step(
        self, run_id: str, step_type: str, name: str, input_json: dict[str, Any]
    ) -> str:
        return f"step-{len(self.finished_steps) + 1}"

    async def finish_step(
        self, step_id: str, output_json: dict[str, Any], duration_ms: int, **kwargs: Any
    ) -> None:
        self.finished_steps.append({
            "step_id": step_id,
            "output": output_json,
            "status": kwargs.get("status", "completed"),
        })

    async def set_model_snapshot(self, run_id: str, snapshot: dict[str, Any]) -> None:
        return None


def context_for_messages(
    messages: list[dict[str, Any]],
    compactable_count: int,
    *,
    trigger_tokens: int = 100,
) -> dict[str, Any]:
    force_compactable_count = _safe_compactable_message_count(
        [SimpleNamespace(role=str(item.get("role", ""))) for item in messages],
        2,
    )
    return {
        "status": "running",
        "conversation_id": "conversation-1",
        "active_message_id": "message-current",
        "organization_id": "test-org",
        "messages": messages,
        "compactable_messages": messages[:compactable_count],
        "compactable_through_count": compactable_count,
        "force_compactable_messages": messages[:force_compactable_count],
        "force_compactable_through_count": force_compactable_count,
        "conversation_summary": "",
        "project": {},
        "project_memory": [],
        "research_records": [],
        "limits": {
            **BASE_LIMITS,
            "context_trigger_tokens": trigger_tokens,
        },
    }


def test_model_activity_compacts_when_full_request_crosses_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = [
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "new question"},
    ]
    compacted = [{"role": "user", "content": "new question"}]
    repo = ContextDecisionRepository([
        context_for_messages(original, 2),
        {**context_for_messages(compacted, 0), "conversation_summary": "old summary"},
    ])

    class Gateway:
        decided_messages: list[dict[str, Any]] = []

        async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
            return 101 if len(args[0]) > 1 else 20

        async def summarize(self, previous: str, messages: list[dict[str, Any]]) -> SummaryResult:
            assert messages == original[:2]
            return SummaryResult()

        async def decide(self, messages: list[dict[str, Any]], *args: Any, **kwargs: Any) -> ContextResult:
            Gateway.decided_messages = messages
            return ContextResult()

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "final"
    assert repo.summary == (
        "conversation-1", 2, "压缩后的历史摘要", "message-current"
    )
    assert Gateway.decided_messages == compacted


def test_model_activity_uses_repository_organization_not_payload(monkeypatch) -> None:
    context = context_for_messages(
        [{"role": "user", "content": "Read project state"}], 0,
        trigger_tokens=20_000,
    )
    repo = ContextDecisionRepository([context])

    class Gateway:
        async def decision_request_tokens(self, *args, **kwargs):
            assert self.organization_id == "test-org"
            return 10

        async def decide(self, *args, **kwargs):
            assert self.organization_id == "test-org"
            return ContextResult()

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({
        "run_id": "run-1", "round": 1, "organization_id": "forged-org",
    }))

    assert result["type"] == "final"


def test_model_activity_keeps_original_messages_when_summary_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = [
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "new question"},
    ]
    repo = ContextDecisionRepository([context_for_messages(original, 2)])

    class Gateway:
        decided_messages: list[dict[str, Any]] = []

        async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
            return 101

        async def summarize(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("summary unavailable")

        async def decide(self, messages: list[dict[str, Any]], *args: Any, **kwargs: Any) -> ContextResult:
            Gateway.decided_messages = messages
            return ContextResult()

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "final"
    assert repo.summary is None
    assert Gateway.decided_messages == original


def test_model_activity_rejects_an_oversized_current_message_before_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = context_for_messages(
        [{"role": "user", "content": "current question"}],
        0,
        trigger_tokens=20_000,
    )
    context["limits"] = {
        **context["limits"],
        "context_input_tokens": 4_096,
    }
    repo = ContextDecisionRepository([context])

    class Gateway:
        decide_calls = 0

        async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
            return 4_200

        async def decide(self, *args: Any, **kwargs: Any) -> ContextResult:
            Gateway.decide_calls += 1
            return ContextResult()

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "model_error"
    assert result["error_code"] == "model_context_overflow"
    assert Gateway.decide_calls == 0


def test_tool_results_are_reduced_until_the_full_request_fits() -> None:
    raw_tool_results = [{
        "tool_call_id": "provider-call-1",
        "tool": "get_project_profile",
        "ok": True,
        "summary": "result " * 1_500,
        "data": {"description": "detail " * 1_500},
        "arguments": {"project_id": "project-1"},
    }]

    class Gateway:
        seen_totals: list[int] = []

        async def decision_request_tokens(
            self,
            messages: list[dict[str, Any]],
            tool_results: list[dict[str, Any]],
            **kwargs: Any,
        ) -> int:
            total = 3_000 + estimate_json_tokens(tool_results)
            self.seen_totals.append(total)
            return total

    gateway = Gateway()
    tool_results, total = asyncio.run(activities.fit_tool_results_to_request(
        gateway,
        [{"role": "user", "content": "current question"}],
        raw_tool_results,
        {},
        tool_token_limit=8_000,
        request_token_limit=4_096,
    ))

    assert gateway.seen_totals[0] > 4_096
    assert total <= 4_096
    assert estimate_json_tokens(tool_results) < estimate_json_tokens(raw_tool_results)


def test_model_activity_context_overflow_compacts_and_retries_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second"},
        {"role": "assistant", "content": "second answer"},
        {"role": "user", "content": "current"},
    ]
    compacted = original[2:]
    repo = ContextDecisionRepository([
        context_for_messages(original, 0, trigger_tokens=10_000),
        {
            **context_for_messages(compacted, 0, trigger_tokens=10_000),
            "conversation_summary": "forced summary",
        },
    ])

    class Gateway:
        decide_calls = 0
        summary_calls = 0

        async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
            return 50

        async def summarize(self, previous: str, messages: list[dict[str, Any]]) -> SummaryResult:
            Gateway.summary_calls += 1
            assert messages == original[:2]
            return SummaryResult()

        async def decide(self, *args: Any, **kwargs: Any) -> ContextResult:
            Gateway.decide_calls += 1
            if Gateway.decide_calls == 1:
                raise AgentModelRequestError(
                    "too large",
                    error_code="model_context_overflow",
                    retryable=False,
                    status_code=400,
                )
            return ContextResult()

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "final"
    assert Gateway.decide_calls == 2
    assert Gateway.summary_calls == 1
    assert repo.summary == (
        "conversation-1", 2, "压缩后的历史摘要", "message-current"
    )


def test_model_activity_context_overflow_shrinks_tool_results_without_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = context_for_messages(
        [{"role": "user", "content": "current"}],
        0,
        trigger_tokens=10_000,
    )
    raw_tool_results = [{
        "tool_call_id": "provider-call-1",
        "tool": "get_project_profile",
        "ok": True,
        "summary": "result " * 300,
        "data": {"description": "detail " * 300},
        "arguments": {"project_id": "project-1"},
    }]

    class Repo(ContextDecisionRepository):
        async def tool_model_context(
            self, run_id: str, round_number: int
        ) -> dict[str, Any]:
            return {"summary": "", "results": raw_tool_results}

    repo = Repo([context])

    class Gateway:
        decide_tool_tokens: list[int] = []

        async def decision_request_tokens(
            self,
            messages: list[dict[str, Any]],
            tool_results: list[dict[str, Any]],
            **kwargs: Any,
        ) -> int:
            return 3_000 + estimate_json_tokens(tool_results)

        async def decide(
            self,
            messages: list[dict[str, Any]],
            tool_results: list[dict[str, Any]],
            **kwargs: Any,
        ) -> ContextResult:
            self.decide_tool_tokens.append(estimate_json_tokens(tool_results))
            if len(self.decide_tool_tokens) == 1:
                raise AgentModelRequestError(
                    "too large",
                    error_code="model_context_overflow",
                    retryable=False,
                    status_code=400,
                )
            return ContextResult()

    gateway = Gateway()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", lambda: gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "final"
    assert len(gateway.decide_tool_tokens) == 2
    assert gateway.decide_tool_tokens[1] < gateway.decide_tool_tokens[0]
    assert repo.summary is None


def test_model_activity_context_overflow_without_reducible_context_does_not_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = context_for_messages(
        [{"role": "user", "content": "current"}],
        0,
        trigger_tokens=10_000,
    )
    repo = ContextDecisionRepository([context])

    class Gateway:
        decide_calls = 0

        async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
            return 50

        async def decide(self, *args: Any, **kwargs: Any) -> None:
            Gateway.decide_calls += 1
            raise AgentModelRequestError(
                "too large",
                error_code="model_context_overflow",
                retryable=False,
                status_code=400,
            )

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "model_error"
    assert result["error_code"] == "model_context_overflow"
    assert Gateway.decide_calls == 1


def test_model_activity_second_context_overflow_is_not_retried_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second"},
        {"role": "assistant", "content": "second answer"},
        {"role": "user", "content": "current"},
    ]
    repo = ContextDecisionRepository([
        context_for_messages(original, 0, trigger_tokens=10_000),
        {
            **context_for_messages(original[2:], 0, trigger_tokens=10_000),
            "conversation_summary": "forced summary",
        },
    ])

    class Gateway:
        decide_calls = 0
        summary_calls = 0

        async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
            return 50

        async def summarize(self, *args: Any, **kwargs: Any) -> SummaryResult:
            Gateway.summary_calls += 1
            return SummaryResult()

        async def decide(self, *args: Any, **kwargs: Any) -> None:
            Gateway.decide_calls += 1
            raise AgentModelRequestError(
                "too large",
                error_code="model_context_overflow",
                retryable=False,
                status_code=400,
            )

    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", Gateway)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "model_error"
    assert result["error_code"] == "model_context_overflow"
    assert Gateway.decide_calls == 2
    assert Gateway.summary_calls == 1


class ToolHistoryCompactionRepository:
    def __init__(self) -> None:
        self.repaired: tuple[str, int] | None = None
        self.summary: tuple[str, int, str] | None = None
        self.step: dict[str, Any] | None = None

    async def repair_interrupted_tool_calls(
        self, run_id: str, current_round: int
    ) -> int:
        self.repaired = (run_id, current_round)
        return 0

    async def save_tool_context_summary(
        self, run_id: str, through_round: int, summary: str
    ) -> None:
        self.summary = (run_id, through_round, summary)

    async def add_step(self, run_id: str, *args: Any, **kwargs: Any) -> None:
        self.step = {"run_id": run_id, "args": args, "kwargs": kwargs}


class ToolHistorySummaryGateway:
    received: tuple[str, list[dict[str, Any]]] | None = None

    async def summarize_tool_history(
        self, old_summary: str, results: list[dict[str, Any]]
    ) -> SummaryResult:
        ToolHistorySummaryGateway.received = (old_summary, results)
        return SummaryResult()


class FailedToolHistorySummaryGateway:
    async def summarize_tool_history(
        self, old_summary: str, results: list[dict[str, Any]]
    ) -> SummaryResult:
        raise RuntimeError("summary provider unavailable")


def tool_history_context() -> dict[str, Any]:
    return {
        "summary": "旧工具摘要",
        "through_round": 0,
        "results": [
            {
                "tool_call_id": f"provider-{round_number}",
                "tool": "get_project_profile",
                "ok": round_number != 2,
                "summary": ("读取完成" if round_number != 2 else "读取失败") + "x" * 80,
                "data": {"round": round_number},
                "error_code": None if round_number != 2 else "agent_dependency_failed",
                "retryable": round_number == 2,
                "tool_batch_id": f"run-1:{round_number}",
            }
            for round_number in (1, 2, 3)
        ],
    }


def test_tool_history_compaction_summarizes_only_old_rounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = ToolHistoryCompactionRepository()
    ToolHistorySummaryGateway.received = None
    monkeypatch.setattr(activities, "ModelGateway", ToolHistorySummaryGateway)

    asyncio.run(activities.compact_tool_history(
        repo,
        "run-1",
        4,
        tool_history_context(),
        {"tool_context_tokens": 100, "tool_summary_tokens": 2_000},
    ))

    assert repo.repaired == ("run-1", 4)
    assert repo.summary == ("run-1", 2, "压缩后的历史摘要")
    assert ToolHistorySummaryGateway.received is not None
    old_summary, summarized = ToolHistorySummaryGateway.received
    assert old_summary == "旧工具摘要"
    assert [item["tool_call_id"] for item in summarized] == ["provider-1", "provider-2"]
    assert summarized[0]["data"] == {}
    assert summarized[1]["ok"] is False
    assert summarized[1]["error_code"] == "agent_dependency_failed"
    assert repo.step is not None
    assert repo.step["args"][0:2] == ("model", "tool_history_compaction")
    assert repo.step["args"][3]["through_round"] == 2


def test_tool_history_compaction_failure_keeps_original_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = ToolHistoryCompactionRepository()
    context = tool_history_context()
    original_results = json.loads(json.dumps(context["results"], ensure_ascii=False))
    monkeypatch.setattr(activities, "ModelGateway", FailedToolHistorySummaryGateway)

    asyncio.run(activities.compact_tool_history(
        repo,
        "run-1",
        4,
        context,
        {"tool_context_tokens": 100, "tool_summary_tokens": 2_000},
    ))

    assert repo.summary is None
    assert context["results"] == original_results
    assert repo.step is not None
    assert repo.step["kwargs"]["status"] == "failed"
    assert "保留原结果继续执行" in repo.step["args"][3]["error"]


class StreamFinalRepository:
    def __init__(self, status: str = "verifying") -> None:
        self.status = status
        self.steps: list[dict[str, Any]] = []
        self.snapshot: dict[str, Any] | None = None

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": self.status,
            "project_id": "project-1",
            "conversation_id": "conversation-1",
            "messages": [{"role": "user", "content": "总结最新审计"}],
        }

    async def add_step(self, run_id: str, *args: Any, **kwargs: Any) -> None:
        self.steps.append({"run_id": run_id, "args": args, "kwargs": kwargs})

    async def set_model_snapshot(
        self, run_id: str, snapshot: dict[str, Any]
    ) -> None:
        self.snapshot = snapshot


class CapturingEventStore:
    def __init__(
        self,
        fail_publish: bool = False,
        active_message: dict[str, Any] | None = None,
    ) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []
        self.close_calls: list[dict[str, Any]] = []
        self.fail_publish = fail_publish
        self.current_active_message = active_message

    async def active_message(
        self,
        conversation_id: str,
        run_id: str,
        *,
        round_number: int | None = None,
    ) -> dict[str, Any] | None:
        active = self.current_active_message
        if active is None:
            return None
        if round_number is not None and active.get("round") != round_number:
            return None
        return dict(active)

    async def publish(
        self, conversation_id: str, event_type: str, payload: dict[str, Any]
    ) -> str | None:
        if self.fail_publish:
            return None
        self.events.append((conversation_id, event_type, payload))
        if event_type == "message_end":
            self.current_active_message = None
        return f"{len(self.events)}-0"

    async def close_message(
        self, conversation_id: str, payload: dict[str, Any]
    ) -> str | None:
        self.close_calls.append(payload)
        return await self.publish(conversation_id, "message_end", payload)


class StreamingFinalDecision:
    def model_dump(self, mode: str) -> dict[str, Any]:
        return {
            "type": "final",
            "answer": "结论明确。\n\n- 第一项\n- 第二项",
            "evidence": [],
            "research": None,
        }


class StreamingFinalResult:
    decision = StreamingFinalDecision()
    model = "test-model"
    base_url = "https://models.example/v1"
    usage = {"total_tokens": 12}


class StreamingFinalGateway:
    async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
        return 1

    async def decide_stream(
        self, messages: list[dict[str, Any]], tool_results: list[dict[str, Any]],
        on_update: Any, **kwargs: Any,
    ) -> StreamingFinalResult:
        await on_update({"kind": "stream_start", "attempt": 0})
        await on_update({"kind": "text_start", "attempt": 0})
        await on_update({
            "kind": "text_delta", "attempt": 0, "delta": "结论明确。\n\n",
        })
        await on_update({
            "kind": "text_delta", "attempt": 0, "delta": "- 第一项\n- 第二项",
        })
        await on_update({"kind": "text_end", "attempt": 0})
        await on_update({
            "kind": "stream_end", "attempt": 0, "status": "completed",
        })
        return StreamingFinalResult()


class StreamingToolDecision:
    def model_dump(self, mode: str) -> dict[str, Any]:
        return {
            "type": "tool_calls",
            "tool_calls": [
                {
                    "tool_call_id": "provider-call-1",
                    "tool": "get_project_profile",
                    "arguments": {},
                }
            ],
        }


class StreamingToolResult:
    decision = StreamingToolDecision()
    model = "test-model"
    base_url = "https://models.example/v1"
    usage = {"total_tokens": 12}


class StreamingTextThenToolGateway:
    async def decision_request_tokens(self, *args: Any, **kwargs: Any) -> int:
        return 1

    async def decide_stream(
        self, messages: list[dict[str, Any]], tool_results: list[dict[str, Any]],
        on_update: Any, **kwargs: Any,
    ) -> StreamingToolResult:
        await on_update({"kind": "stream_start", "attempt": 0})
        await on_update({"kind": "text_start", "attempt": 0})
        await on_update({
            "kind": "text_delta", "attempt": 0, "delta": "我先读取项目资料。",
        })
        await on_update({"kind": "text_end", "attempt": 0})
        await on_update({
            "kind": "toolcall_start", "attempt": 0, "index": 0,
            "tool_call_id": "", "tool_name": "",
        })
        await on_update({
            "kind": "toolcall_delta", "attempt": 0, "index": 0,
            "id_delta": "provider-call-1", "name_delta": "get_project_profile",
            "arguments_delta": "{}",
        })
        await on_update({
            "kind": "toolcall_end", "attempt": 0, "index": 0,
            "tool_call_id": "provider-call-1", "tool_name": "get_project_profile",
        })
        await on_update({
            "kind": "stream_end", "attempt": 0, "status": "completed",
        })
        return StreamingToolResult()


def test_model_decide_streams_markdown_as_the_persisted_final_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = {
        **context_for_messages([{"role": "user", "content": "给出结论"}], 0),
        "project_id": "project-1",
    }
    repo = ContextDecisionRepository([context])
    store = CapturingEventStore()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", StreamingFinalGateway)
    monkeypatch.setattr(activities, "build_agent_event_store", lambda: store)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    final_message_id = "a11120c6-e044-5648-98dd-5315924bc018"
    assert result == {
        "type": "final",
        "answer": "结论明确。\n\n- 第一项\n- 第二项",
        "evidence": [],
        "research": None,
        "message_id": final_message_id,
    }
    message_events = [event for event in store.events if event[1].startswith("message_")]
    assert [event[1] for event in message_events] == [
        "message_start", "message_update", "message_update", "message_update",
        "message_update", "message_end",
    ]
    assert all(event[2]["phase"] == "final" for event in message_events)
    assert all(event[2]["message_id"] == final_message_id for event in message_events)
    deltas = [
        event[2]["assistant_message_event"]["delta"]
        for event in message_events
        if event[1] == "message_update"
        and event[2]["assistant_message_event"]["kind"] == "text_delta"
    ]
    assert deltas == ["结论明确。\n\n", "- 第一项\n- 第二项"]


def test_model_decide_does_not_stream_tool_preamble_as_a_final_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = {
        **context_for_messages([{"role": "user", "content": "检查项目资料"}], 0),
        "project_id": "project-1",
    }
    repo = ContextDecisionRepository([context])
    store = CapturingEventStore()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "ModelGateway", StreamingTextThenToolGateway)
    monkeypatch.setattr(activities, "build_agent_event_store", lambda: store)

    result = asyncio.run(activities.model_decide({"run_id": "run-1", "round": 1}))

    assert result["type"] == "tool_calls"
    message_events = [event for event in store.events if event[1].startswith("message_")]
    assert message_events
    assert any(
        event[1] == "message_end"
        and event[2]["phase"] == "final"
        and event[2]["outcome"] == "discarded"
        for event in message_events
    )
    assert any(
        event[1] == "message_update" and event[2]["phase"] == "decision"
        for event in message_events
    )
    assert result["progress_text"] == "我先读取项目资料。"
    assert [item["phase"] for item in store.close_calls] == ["decision"]


def test_finish_turn_closes_interrupted_message_before_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = StreamFinalRepository()
    store = CapturingEventStore(active_message={
        "round": 3,
        "message_id": "message-decision",
        "part_id": "message-decision:assistant",
        "phase": "decision",
        "attempt": 1,
    })
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "build_agent_event_store", lambda: store)

    asyncio.run(activities.finish_turn({
        "run_id": "run-1",
        "round": 3,
        "outcome": "error",
        "error_code": "activity_timeout",
        "error_message": "模型执行超时",
    }))

    assert [event[1] for event in store.events] == ["message_end", "turn_end"]
    assert store.events[0][2]["status"] == "error"
    assert store.events[0][2]["code"] == "activity_timeout"
    assert store.events[1][2]["round"] == 3


def test_finish_closes_any_interrupted_message_before_persisting_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FinishRepository()
    store = CapturingEventStore(active_message={
        "round": 2,
        "message_id": "message-decision",
        "part_id": "message-decision:assistant",
        "phase": "decision",
        "attempt": 0,
    })
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "build_agent_event_store", lambda: store)

    asyncio.run(activities.finish({
        "run_id": "run-1",
        "answer": "任务失败",
        "status": "failed",
        "error_code": "agent_run_failed",
        "error_message": "任务执行失败",
    }))

    assert repo.finalized is not None
    assert [event[1] for event in store.events] == ["message_end", "agent_end"]
    assert store.events[0][2]["status"] == "error"
    assert store.events[0][2]["message_id"] == "message-decision"


def test_business_progress_keeps_separate_calls_and_latest_retry_state() -> None:
    progress = activities.business_progress_from_evidence({
        "tool_evidence": [
            {
                "tool_call_id": "profile-1", "tool": "get_project_profile",
                "execution_status": "failed",
            },
            {"tool": "unknown_internal_tool", "execution_status": "completed"},
            {
                "tool_call_id": "audit-1", "tool": "get_latest_audit",
                "execution_status": "failed",
            },
            {
                "tool_call_id": "profile-1", "tool": "get_project_profile",
                "execution_status": "completed",
            },
            {
                "tool_call_id": "profile-2", "tool": "get_project_profile",
                "execution_status": "completed",
            },
        ]
    })

    assert progress == [
        {
            "tool_call_id": "profile-1",
            "tool": "get_project_profile",
            "label": "项目资料已读取",
            "status": "completed",
        },
        {
            "tool_call_id": "audit-1",
            "tool": "get_latest_audit",
            "label": "技术审核读取未完成",
            "status": "failed",
        },
        {
            "tool_call_id": "profile-2",
            "tool": "get_project_profile",
            "label": "项目资料已读取",
            "status": "completed",
        },
    ]


def test_business_progress_keeps_every_visible_call() -> None:
    progress = activities.business_progress_from_evidence({
        "tool_evidence": [
            {
                "tool_call_id": f"profile-{index}",
                "tool": "get_project_profile",
                "execution_status": "completed",
            }
            for index in range(10)
        ]
    })

    assert len(progress) == 10
    assert [item["tool_call_id"] for item in progress] == [
        f"profile-{index}" for index in range(10)
    ]


def test_display_parts_keep_document_order_and_update_retry_in_place() -> None:
    parts = activities.display_parts_from_evidence(
        {
            "display_events": [
                {"type": "text", "text": "我先读取项目资料。"},
                {
                    "type": "tool",
                    "tool_call_id": "profile-1",
                    "tool": "get_project_profile",
                    "execution_status": "failed",
                },
                {"type": "text", "text": "读取中断，我只重试这一项。"},
                {
                    "type": "tool",
                    "tool_call_id": "profile-1",
                    "tool": "get_project_profile",
                    "execution_status": "completed",
                },
                {
                    "type": "tool",
                    "tool_call_id": "profile-2",
                    "tool": "get_project_profile",
                    "execution_status": "completed",
                },
            ]
        },
        "资料已经核对。",
    )

    assert parts == [
        {"type": "text", "text": "我先读取项目资料。"},
        {
            "type": "tool",
            "tool_call_id": "profile-1",
            "tool": "get_project_profile",
            "label": "项目资料已读取",
            "status": "completed",
        },
        {"type": "text", "text": "读取中断，我只重试这一项。"},
        {
            "type": "tool",
            "tool_call_id": "profile-2",
            "tool": "get_project_profile",
            "label": "项目资料已读取",
            "status": "completed",
        },
        {"type": "text", "text": "资料已经核对。"},
    ]


def test_display_parts_do_not_truncate_visible_progress_text() -> None:
    progress_text = "进" * 2_500

    parts = activities.display_parts_from_evidence(
        {"display_events": [{"type": "text", "text": progress_text}]},
        "最终回答",
    )

    assert parts == [
        {"type": "text", "text": progress_text},
        {"type": "text", "text": "最终回答"},
    ]


def test_failure_answer_reports_completed_work_failure_point_and_next_step() -> None:
    answer = activities.failure_answer([
        {"tool": "get_project_profile", "label": "项目资料已读取", "status": "completed"},
        {"tool": "get_latest_audit", "label": "技术审核读取未完成", "status": "failed"},
    ])

    assert answer.startswith("本次任务没有完成，但已完成的步骤和业务操作已经保留。")
    assert "- 项目资料已读取" in answer
    assert "- 技术审核读取未完成" in answer
    assert "先读取当前项目状态" in answer


def test_failure_answer_hides_service_error_without_tool_failure() -> None:
    answer = activities.failure_answer(
        [],
        "模型服务鉴权失败\napi_key=sk-abcdefghijklmnop",
    )

    assert "- 回答整理中断" in answer
    assert "模型服务鉴权失败" not in answer
    assert "api_key" not in answer
    assert "sk-abcdefghijklmnop" not in answer


def test_failure_answer_prefers_business_failure_over_service_error() -> None:
    answer = activities.failure_answer(
        [{"tool": "get_latest_audit", "label": "技术审核读取未完成", "status": "failed"}],
        "模型服务暂时不可用",
    )

    assert "- 技术审核读取未完成" in answer
    assert "模型服务暂时不可用" not in answer


class FinishRepository:
    def __init__(self) -> None:
        self.finalized: tuple[Any, ...] | None = None

    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        return {
            "status": "verifying",
            "project_id": "project-1",
            "conversation_id": "conversation-1",
        }

    async def save_context_updates(self, run_id: str, research: Any) -> None:
        return None

    async def completion_evidence(self, run_id: str) -> dict[str, Any]:
        return {
            "display_events": [
                {"type": "text", "text": "我先读取项目资料。"},
                {
                    "type": "tool",
                    "tool_call_id": "profile-1",
                    "tool": "get_project_profile",
                    "execution_status": "completed",
                },
                {"type": "text", "text": "接着检查技术审核。"},
                {
                    "type": "tool",
                    "tool_call_id": "audit-1",
                    "tool": "get_latest_audit",
                    "execution_status": "failed",
                },
            ],
            "tool_evidence": [
                {
                    "tool_call_id": "profile-1",
                    "tool": "get_project_profile",
                    "execution_status": "completed",
                },
                {
                    "tool_call_id": "audit-1",
                    "tool": "get_latest_audit",
                    "execution_status": "failed",
                },
            ]
        }

    async def finalize_run(self, *args: Any) -> None:
        self.finalized = args


class EmptyProgressFinishRepository(FinishRepository):
    async def completion_evidence(self, run_id: str) -> dict[str, Any]:
        return {"tool_evidence": []}


class CreatedArticleFinishRepository(FinishRepository):
    async def completion_evidence(self, run_id: str) -> dict[str, Any]:
        return {
            "tool_evidence": [
                {
                    "tool_call_id": "keywords-1",
                    "tool": "list_keywords",
                    "execution_status": "completed",
                    "ok": True,
                    "summary": "关键词库中找到 42 个关键词",
                    "data": {"total": 42},
                },
                {
                    "tool_call_id": "article-1",
                    "tool": "create_article",
                    "execution_status": "completed",
                    "ok": True,
                    "summary": "已启动 1 篇文章生成",
                    "data": {
                        "operation_id": "article-operation-1",
                        "verified": True,
                        "article_id": "article-created-1",
                        "run_id": "article-run-created-1",
                        "primary_keyword": "hd streaming",
                        "title": "HD Streaming Guide",
                        "status": "queued",
                        "stage": "queued",
                        "progress": 0,
                    },
                },
            ]
        }


def test_finish_reports_created_article_when_final_model_response_is_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = CreatedArticleFinishRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "build_agent_event_store", CapturingEventStore)

    asyncio.run(activities.finish({
        "run_id": "run-1",
        "answer": "任务失败",
        "status": "failed",
        "error_code": "model_provider_unavailable",
        "error_message": "模型服务请求过多，请稍后重试",
    }))

    assert repo.finalized is not None
    answer = repo.finalized[1]
    assert "文章已经创建" in answer
    assert "hd streaming" in answer
    assert "article-created-1" in answer
    assert "没有创建内容计划" in answer
    assert "回答整理" in answer
    assert "尚未产生可确认的业务结果" not in answer
    assert "重新发起" not in answer


def test_finish_persists_service_failure_reason_without_business_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = EmptyProgressFinishRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(
        activities,
        "build_agent_event_store",
        CapturingEventStore,
    )

    asyncio.run(activities.finish({
        "run_id": "run-1",
        "answer": "任务失败",
        "status": "failed",
        "error_code": "provider_authentication_failed",
        "error_message": "模型服务鉴权失败",
    }))

    assert repo.finalized is not None
    assert "- 回答整理中断" in repo.finalized[1]
    assert "模型服务鉴权失败" not in repo.finalized[1]
    assert repo.finalized[2] == {
        "evidence": [],
        "display_parts": [{"type": "text", "text": repo.finalized[1]}],
    }


def test_finish_structures_limit_reached_answer_with_preserved_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FinishRepository()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "build_agent_event_store", CapturingEventStore)

    asyncio.run(activities.finish({
        "run_id": "run-1",
        "answer": "运行上限已到",
        "status": "limit_reached",
        "error_code": "model_rounds",
        "error_message": "本次任务已达到平台运行上限",
    }))

    assert repo.finalized is not None
    assert repo.finalized[3] == "limit_reached"
    assert "**已完成**" in repo.finalized[1]
    assert "**停在**" in repo.finalized[1]
    assert "本次任务已达到平台运行上限" in repo.finalized[1]
    assert "**下一步**" in repo.finalized[1]


def test_finish_uses_same_message_id_for_database_and_finish_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FinishRepository()
    store = CapturingEventStore()
    monkeypatch.setattr(activities, "repository", lambda: repo)
    monkeypatch.setattr(activities, "build_agent_event_store", lambda: store)

    asyncio.run(activities.finish({
        "run_id": "run-1",
        "answer": "最终回答",
        "message_id": "message-final",
        "status": "completed",
    }))

    assert repo.finalized is not None
    assert repo.finalized[2] == {
        "evidence": [],
        "business_progress": [
            {
                "tool_call_id": "profile-1",
                "tool": "get_project_profile",
                "label": "项目资料已读取",
                "status": "completed",
            },
            {
                "tool_call_id": "audit-1",
                "tool": "get_latest_audit",
                "label": "技术审核读取未完成",
                "status": "failed",
            },
        ],
        "display_parts": [
            {"type": "text", "text": "我先读取项目资料。"},
            {
                "type": "tool",
                "tool_call_id": "profile-1",
                "tool": "get_project_profile",
                "label": "项目资料已读取",
                "status": "completed",
            },
            {"type": "text", "text": "接着检查技术审核。"},
            {
                "type": "tool",
                "tool_call_id": "audit-1",
                "tool": "get_latest_audit",
                "label": "技术审核读取未完成",
                "status": "failed",
            },
            {"type": "text", "text": "最终回答"},
        ],
    }
    assert repo.finalized[-1] == "message-final"
    assert [event[1] for event in store.events] == ["message_end", "agent_end"]
    assert store.events[0][2]["message_id"] == "message-final"
    assert store.events[0][2]["event_key"] == "run-1:final:end:persisted"
    assert store.events[0][2]["outcome"] == "persisted"
    assert store.events[1][2]["status"] == "completed"
