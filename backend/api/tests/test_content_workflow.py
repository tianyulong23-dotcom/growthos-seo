import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from temporalio.exceptions import ActivityError

from app.modules.content import activities as content_activities
from app.modules.content.activities import (
    budget_policy,
    costed_usage,
    degraded_stage_result,
)
from app.modules.content.workflows import ArticleGenerationWorkflow, retry_delay


EXPECTED_STAGES = [
    ("preparing", 5),
    ("collecting", 15),
    ("competitor_research", 30),
    ("planning", 45),
    ("writing", 65),
    ("editing", 80),
]
EXPECTED_QUALITY_STAGES = [
    ("checking_1", 88),
    ("revising_1", 92),
    ("checking_2", 93),
    ("revising_2", 94),
    ("checking_3", 95),
    ("revising_3", 96),
    ("checking_4", 97),
]


def test_costed_usage_estimates_only_tokens_without_provider_cost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        content_activities,
        "get_settings",
        lambda: type(
            "CostSettings",
            (),
            {
                "article_model_input_cost_per_million": 2.0,
                "article_model_output_cost_per_million": 8.0,
            },
        )(),
    )

    usage = costed_usage(
        {
            "input_tokens": 4_000,
            "output_tokens": 1_000,
            "unreported_input_tokens": 3_000,
            "unreported_output_tokens": 500,
            "reported_cost": 0.01,
            "cost_currency": "USD",
        }
    )

    assert usage["reported_cost"] == 0.01
    assert usage["estimated_cost"] == 0.01
    assert usage["estimation_basis"] == {
        "method": "token_rate_v1",
        "input_tokens": 3_000,
        "output_tokens": 500,
        "input_cost_per_million": 2.0,
        "output_cost_per_million": 8.0,
    }


def test_costed_usage_never_estimates_provider_priced_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        content_activities,
        "get_settings",
        lambda: type(
            "CostSettings",
            (),
            {
                "article_model_input_cost_per_million": 2.0,
                "article_model_output_cost_per_million": 8.0,
            },
        )(),
    )

    usage = costed_usage(
        {
            "input_tokens": 4_000,
            "output_tokens": 1_000,
            "reported_cost": 0.02,
            "cost_currency": "USD",
        }
    )

    assert usage["reported_cost"] == 0.02
    assert usage["estimated_cost"] is None
    assert usage["estimation_basis"] == {}


def test_fake_activities_move_queued_run_to_completed() -> None:
    workflow = ArticleGenerationWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        calls.append((name, payload))
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            return {
                "status": "completed",
                "warning": None,
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload["stage_kind"] == "checking"
                    else {}
                ),
            }
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert calls[0] == ("content_begin_run", {"run_id": "run-1"})
    stage_calls = [
        (payload["step_key"], payload["progress"])
        for name, payload in calls
        if name == "content_execute_stage"
    ]
    assert stage_calls == [*EXPECTED_STAGES, EXPECTED_QUALITY_STAGES[0]]
    assert calls[-1] == (
        "content_finish_run",
        {"run_id": "run-1", "status": "completed", "warnings": []},
    )


def test_warning_completes_run_with_warnings() -> None:
    workflow = ArticleGenerationWorkflow()
    finishes: list[dict[str, Any]] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            warning = (
                {"code": "checking_degraded", "message": "检查服务暂不可用，已保存完整稿"}
                if payload["step_key"] == "checking_1"
                else None
            )
            return {
                "status": "completed",
                "warning": warning,
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload["step_key"] == "checking_1"
                    else {}
                ),
            }
        finishes.append(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert finishes == [
        {
            "run_id": "run-1",
            "status": "completed_with_warnings",
            "warnings": [
                {
                    "code": "checking_degraded",
                    "message": "检查服务暂不可用，已保存完整稿",
                }
            ],
        }
    ]


def test_all_research_sources_failing_still_completes_the_full_workflow() -> None:
    workflow = ArticleGenerationWorkflow()
    stages: list[str] = []
    finishes: list[dict[str, Any]] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            stages.append(payload["step_key"])
            warnings = []
            if payload["step_key"] == "collecting":
                warnings = [
                    {"code": "dataforseo_unavailable", "message": "SERP unavailable"},
                    {"code": "research_unavailable", "message": "Research unavailable"},
                    {
                        "code": "internal_sources_unavailable",
                        "message": "Internal sources unavailable",
                    },
                ]
            if payload["step_key"] == "competitor_research":
                warnings.append(
                    {
                        "code": "competitor_sources_unavailable",
                        "message": "Competitor sources unavailable",
                    }
                )
            return {
                "status": "completed",
                "warnings": warnings,
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload["stage_kind"] == "checking"
                    else {}
                ),
            }
        if name == "content_finish_run":
            finishes.append(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert stages == [
        "preparing",
        "collecting",
        "competitor_research",
        "planning",
        "writing",
        "editing",
        "checking_1",
    ]
    assert finishes[0]["status"] == "completed_with_warnings"
    assert {warning["code"] for warning in finishes[0]["warnings"]} == {
        "dataforseo_unavailable",
        "research_unavailable",
        "internal_sources_unavailable",
        "competitor_sources_unavailable",
    }


def test_cancelled_stage_stops_without_writing_a_terminal_result() -> None:
    workflow = ArticleGenerationWorkflow()
    calls: list[str] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        calls.append(name)
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            return {"status": "cancelled"}
        raise AssertionError("cancelled workflow must not call content_finish_run")

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert calls == ["content_begin_run", "content_execute_stage"]


def test_revision_is_skipped_only_when_checking_reports_no_issues() -> None:
    workflow = ArticleGenerationWorkflow()
    stages: list[str] = []
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            stages.append(payload["step_key"])
            return {
                "status": "completed",
                "warning": None,
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload["step_key"] == "checking_1"
                    else {}
                ),
            }
        finish = payload
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert not any(item.startswith("revising_") for item in stages)
    assert finish["status"] == "completed"


def test_semantic_checker_unavailable_does_not_trigger_article_revision() -> None:
    workflow = ArticleGenerationWorkflow()
    stages: list[str] = []
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            stages.append(str(payload["step_key"]))
            if payload["stage_kind"] == "checking":
                return {
                    "status": "completed",
                    "warnings": [
                        {
                            "code": "checking_degraded",
                            "message": "检查服务暂不可用，已保留确定性检查结果",
                        }
                    ],
                    "result": {
                        "passed": False,
                        "issue_count": 0,
                        "check_status": "unavailable",
                        "repairable": False,
                        "repair_scope": [],
                    },
                }
            return {"status": "completed", "result": {}}
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-checker-unavailable"}))

    assert not any(stage.startswith("revising_") for stage in stages)
    assert finish["status"] == "completed_with_warnings"
    assert [item["code"] for item in finish["warnings"]] == ["checking_degraded"]


def test_explicit_repairable_section_issue_still_runs_targeted_revision() -> None:
    workflow = ArticleGenerationWorkflow()
    quality_stages: list[str] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] in {"checking", "revising"}:
                quality_stages.append(str(payload["step_key"]))
            if payload["step_key"] == "checking_1":
                return {
                    "status": "completed",
                    "result": {
                        "passed": False,
                        "issue_count": 1,
                        "check_status": "completed",
                        "repairable": True,
                        "repair_scope": ["section-2"],
                    },
                }
            if payload["step_key"] == "checking_2":
                return {
                    "status": "completed",
                    "result": {
                        "passed": True,
                        "issue_count": 0,
                        "check_status": "completed",
                        "repairable": False,
                        "repair_scope": [],
                    },
                }
            return {"status": "completed", "result": {}}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-repairable"}))

    assert quality_stages == ["checking_1", "revising_1", "checking_2"]


def test_first_repair_is_followed_by_a_full_recheck_and_stops_on_pass() -> None:
    workflow = ArticleGenerationWorkflow()
    quality_calls: list[dict[str, Any]] = []
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] in {"checking", "revising"}:
                quality_calls.append(dict(payload))
            passed = payload["step_key"] == "checking_2"
            return {
                "status": "completed",
                "result": (
                    {"passed": passed, "issue_count": 0 if passed else 2}
                    if payload["stage_kind"] == "checking"
                    else {"revised_sections": 2}
                ),
            }
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-first-repair"}))

    assert quality_calls == [
        {
            "run_id": "run-first-repair",
            "step_key": "checking_1",
            "stage_kind": "checking",
            "progress": 88,
            "repair_iteration": 0,
            "input_step_key": "editing",
        },
        {
            "run_id": "run-first-repair",
            "step_key": "revising_1",
            "stage_kind": "revising",
            "progress": 92,
            "repair_iteration": 1,
            "input_step_key": "checking_1",
        },
        {
            "run_id": "run-first-repair",
            "step_key": "checking_2",
            "stage_kind": "checking",
            "progress": 93,
            "repair_iteration": 1,
            "input_step_key": "revising_1",
        },
    ]
    assert finish["status"] == "completed"


def test_resolved_check_and_revision_warnings_do_not_leak_to_final_result() -> None:
    workflow = ArticleGenerationWorkflow()
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            step_key = str(payload["step_key"])
            warnings = []
            if step_key == "writing":
                warnings.append(
                    {"code": "writing_degraded", "message": "fallback section used"}
                )
            if step_key == "checking_1":
                warnings.append(
                    {"code": "checking_degraded", "message": "first check failed"}
                )
            if step_key == "revising_1":
                warnings.append(
                    {"code": "revising_degraded", "message": "first repair failed"}
                )
            passed = step_key == "checking_2"
            return {
                "status": "completed",
                "warnings": warnings,
                "result": (
                    {"passed": passed, "issue_count": 0 if passed else 1}
                    if payload["stage_kind"] == "checking"
                    else {}
                ),
            }
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-resolved-warning"}))

    assert finish == {
        "run_id": "run-resolved-warning",
        "status": "completed",
        "warnings": [],
    }


@pytest.mark.parametrize(
    ("content_score_passed", "expected_status", "expected_warning_codes"),
    [
        (True, "completed", []),
        (
            False,
            "completed_with_warnings",
            ["content_quality_below_threshold"],
        ),
    ],
)
def test_latest_content_score_controls_low_score_warning_lifecycle(
    content_score_passed: bool,
    expected_status: str,
    expected_warning_codes: list[str],
) -> None:
    workflow = ArticleGenerationWorkflow()
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            warnings = []
            if payload["step_key"] == "editing":
                warnings.append(
                    {
                        "code": "content_quality_below_threshold",
                        "message": "Initial content score was below 70",
                    }
                )
            return {
                "status": "completed",
                "warnings": warnings,
                "result": (
                    {
                        "passed": True,
                        "issue_count": 0,
                        "content_score_passed": content_score_passed,
                    }
                    if payload["stage_kind"] == "checking"
                    else {}
                ),
            }
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-content-score-warning"}))

    assert finish["status"] == expected_status
    assert [item["code"] for item in finish["warnings"]] == expected_warning_codes


def test_activity_error_invokes_stage_recovery_and_workflow_continues() -> None:
    workflow = ArticleGenerationWorkflow()
    calls: list[tuple[str, str]] = []
    failed_once = False

    def activity_error(name: str) -> ActivityError:
        return ActivityError(
            "activity failed",
            scheduled_event_id=1,
            started_event_id=2,
            identity="worker",
            activity_type=name,
            activity_id="1",
            retry_state=None,
        )

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal failed_once
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            calls.append((name, str(payload["step_key"])))
            if payload["step_key"] == "writing" and not failed_once:
                failed_once = True
                raise activity_error(name)
            return {
                "status": "completed",
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload["stage_kind"] == "checking"
                    else {}
                ),
            }
        if name == "content_recover_stage":
            calls.append((name, str(payload["step_key"])))
            return {"status": "completed", "result": {"complete": True}}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-timeout-recovery"}))

    assert ("content_recover_stage", "writing") in calls
    assert ("content_execute_stage", "editing") in calls


def test_three_repairs_run_four_full_checks_before_warning_delivery() -> None:
    workflow = ArticleGenerationWorkflow()
    quality_calls: list[tuple[str, str | None, int]] = []
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] in {"checking", "revising"}:
                quality_calls.append(
                    (
                        str(payload["step_key"]),
                        payload.get("input_step_key"),
                        int(payload["repair_iteration"]),
                    )
                )
            return {
                "status": "completed",
                "result": (
                    {"passed": False, "issue_count": 1}
                    if payload["stage_kind"] == "checking"
                    else {"revised_sections": 1}
                ),
            }
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-three-repairs"}))

    assert quality_calls == [
        ("checking_1", "editing", 0),
        ("revising_1", "checking_1", 1),
        ("checking_2", "revising_1", 1),
        ("revising_2", "checking_2", 2),
        ("checking_3", "revising_2", 2),
        ("revising_3", "checking_3", 3),
        ("checking_4", "revising_3", 3),
    ]
    assert finish["status"] == "completed_with_warnings"
    assert finish["warnings"][-1]["code"] == "quality_issues_remaining"


def test_unchanged_repairable_issue_fingerprint_stops_after_one_revision() -> None:
    workflow = ArticleGenerationWorkflow()
    quality_stages: list[str] = []
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] in {"checking", "revising"}:
                quality_stages.append(str(payload["step_key"]))
            if payload["stage_kind"] == "checking":
                return {
                    "status": "completed",
                    "result": {
                        "passed": False,
                        "issue_count": 1,
                        "repairable": True,
                        "repairable_issue_count": 1,
                        "repairable_issue_fingerprint": [
                            "prose:section-2:required_question_unanswered"
                        ],
                    },
                }
            if payload["stage_kind"] == "revising":
                return {"status": "completed", "result": {"revised_sections": 1}}
            return {"status": "completed", "result": {}}
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-converged"}))

    assert quality_stages == ["checking_1", "revising_1", "checking_2"]
    assert finish["status"] == "completed_with_warnings"
    assert finish["warnings"][-1]["code"] == "quality_revision_converged"


def test_converged_revision_preserves_separate_evidence_gap_warning() -> None:
    workflow = ArticleGenerationWorkflow()
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] == "checking":
                return {
                    "status": "completed",
                    "result": {
                        "passed": False,
                        "issue_count": 2,
                        "repairable": True,
                        "repairable_issue_count": 1,
                        "repairable_issue_fingerprint": [
                            "prose:section-2:required_question_unanswered"
                        ],
                        "evidence_issue_count": 1,
                    },
                }
            if payload["stage_kind"] == "revising":
                return {"status": "completed", "result": {"revised_sections": 1}}
            return {"status": "completed", "result": {}}
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-converged-with-evidence-gap"}))

    assert [item["code"] for item in finish["warnings"][-2:]] == [
        "quality_revision_converged",
        "quality_evidence_gaps",
    ]


def test_workflow_rejects_payload_beyond_run_id() -> None:
    workflow = ArticleGenerationWorkflow()

    with pytest.raises(ValueError, match="only accepts run_id"):
        asyncio.run(workflow.run({"run_id": "run-1", "keyword": "not-allowed"}))


def test_budget_policy_only_limits_optional_work() -> None:
    assert budget_policy(481, 1081) == {"hard_budget_reached": False}
    assert budget_policy(299, 899) == {"hard_budget_reached": False}
    assert "skip_revision" not in budget_policy(119, 719)
    assert budget_policy(-600, 0)["hard_budget_reached"] is True


def test_budget_warning_does_not_stop_remaining_quality_stages() -> None:
    workflow = ArticleGenerationWorkflow()
    stages: list[str] = []
    finish: dict[str, Any] = {}

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            stages.append(payload["step_key"])
            return {
                "status": "completed",
                "warning": (
                    {
                        "code": "hard_budget_reached",
                        "message": "已停止可选增强，继续完成质量检查",
                    }
                    if payload["step_key"] == "preparing"
                    else None
                ),
                "hard_budget_reached": True,
                "result": (
                    {"passed": False, "issue_count": 1}
                    if payload["stage_kind"] == "checking"
                    else {"revised_sections": 1}
                ),
            }
        finish = payload
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert stages == [
        *[step_key for step_key, _progress in EXPECTED_STAGES],
        *[step_key for step_key, _progress in EXPECTED_QUALITY_STAGES],
    ]
    assert finish == {
        "run_id": "run-1",
        "status": "completed_with_warnings",
        "warnings": [
            {
                "code": "hard_budget_reached",
                "message": "已停止可选增强，继续完成质量检查",
            },
            {
                "code": "quality_issues_remaining",
                "message": "文章已完整生成并完成三轮自动修订，仍有部分质量问题未解决",
            },
        ],
    }


def test_busy_step_waits_and_reuses_result_after_worker_restart() -> None:
    workflow = ArticleGenerationWorkflow()
    stage_attempts: dict[str, int] = {}
    sleeps: list[float] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            step_key = payload["step_key"]
            stage_attempts[step_key] = stage_attempts.get(step_key, 0) + 1
            if step_key == "writing" and stage_attempts[step_key] == 1:
                return {"status": "busy"}
            return {"status": "completed", "warning": None, "result": {}}
        return None

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    workflow._call = call  # type: ignore[method-assign]
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert stage_attempts["writing"] == 2
    assert sleeps == [5]


def test_retry_delay_increases_and_caps_without_limiting_attempts() -> None:
    assert [retry_delay(attempt) for attempt in range(7)] == [
        5.0,
        10.0,
        20.0,
        40.0,
        60.0,
        60.0,
        60.0,
    ]


def test_recovery_activity_does_not_take_over_an_active_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recovery_calls = 0

    class FakeRepository:
        async def get_run_context(self, _run_id: str) -> dict[str, Any]:
            return {"status": "running"}

        async def force_claim_step(self, *_args: Any, **_kwargs: Any) -> tuple[str, None]:
            return "busy", None

    async def recover(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal recovery_calls
        recovery_calls += 1
        return {}

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())
    monkeypatch.setattr(content_activities, "recover_stage_work", recover)

    result = asyncio.run(
        content_activities.recover_stage(
            {"run_id": "run-1", "step_key": "writing", "stage_kind": "writing"}
        )
    )

    assert result == {"status": "busy"}
    assert recovery_calls == 0


def test_stage_failure_has_a_complete_output_degradation() -> None:
    assert degraded_stage_result("editing") == {
        "warning": {
            "code": "editing_degraded",
            "message": "全文编辑暂不可用，已保留合并后的完整稿",
        }
    }
    assert degraded_stage_result("checking")["warning"]["code"] == "checking_degraded"
    assert degraded_stage_result("revising")["warning"]["code"] == "revising_degraded"


def test_activity_records_fixed_degradation_instead_of_failing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completed: list[dict[str, Any]] = []

    class FakeRepository:
        async def get_run_context(self, run_id: str) -> dict[str, Any]:
            return {
                "status": "running",
                "soft_deadline_at": datetime.now(UTC) + timedelta(minutes=5),
                "hard_deadline_at": datetime.now(UTC) + timedelta(minutes=10),
            }

        async def claim_step(
            self, run_id: str, step_key: str, worker_id: str, lease_seconds: int
        ) -> tuple[str, None]:
            return "claimed", None

        async def set_stage(self, run_id: str, step_key: str, progress: int) -> None:
            return None

        async def complete_step(self, *args: Any, **kwargs: Any) -> None:
            completed.append(kwargs)

    async def fail_stage(
        step_key: str, context: dict[str, Any], policy: dict[str, bool]
    ) -> dict[str, Any]:
        raise RuntimeError("provider unavailable")

    async def recover_stage(
        step_key: str, context: dict[str, Any], policy: dict[str, bool]
    ) -> dict[str, Any]:
        return {
            "output_ref": "s3://bucket/run-1/checking/article.json.gz",
            **degraded_stage_result(step_key),
            "summary": {"passed": False, "issue_count": 1},
        }

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())
    monkeypatch.setattr(content_activities, "execute_stage_work", fail_stage)
    monkeypatch.setattr(content_activities, "recover_stage_work", recover_stage)

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "run-1", "step_key": "checking", "progress": 90}
        )
    )

    assert result["status"] == "completed"
    assert result["warning"] == {
        "code": "checking_degraded",
        "message": "检查服务暂不可用，已保存检查前完整稿",
    }
    assert completed[0]["warning_code"] == "checking_degraded"


def test_activity_persists_expired_budget_without_skipping_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completed: list[dict[str, Any]] = []
    work_calls = 0

    class FakeRepository:
        async def get_run_context(self, _run_id: str) -> dict[str, Any]:
            expired = datetime.now(UTC) - timedelta(seconds=1)
            return {
                "status": "running",
                "soft_deadline_at": expired,
                "hard_deadline_at": expired,
            }

        async def claim_step(self, *_args: Any, **_kwargs: Any) -> tuple[str, None]:
            return "claimed", None

        async def set_stage(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        async def complete_step(self, *_args: Any, **kwargs: Any) -> None:
            completed.append(kwargs)

    async def work(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal work_calls
        work_calls += 1
        return {"output_ref": "s3://bucket/run-1/writing.json.gz", "summary": {}}

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())
    monkeypatch.setattr(content_activities, "execute_stage_work", work)

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "run-1", "step_key": "writing", "progress": 65}
        )
    )

    assert work_calls == 1
    assert result["status"] == "completed"
    assert result["hard_budget_reached"] is True
    assert completed[0]["summary"]["hard_budget_reached"] is True


def test_recovery_persists_expired_budget_without_skipping_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completed: list[dict[str, Any]] = []
    recovery_calls = 0

    class FakeRepository:
        async def get_run_context(self, _run_id: str) -> dict[str, Any]:
            expired = datetime.now(UTC) - timedelta(seconds=1)
            return {
                "status": "running",
                "soft_deadline_at": expired,
                "hard_deadline_at": expired,
            }

        async def force_claim_step(self, *_args: Any, **_kwargs: Any) -> tuple[str, None]:
            return "claimed", None

        async def complete_step(self, *_args: Any, **kwargs: Any) -> None:
            completed.append(kwargs)

    async def recover(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal recovery_calls
        recovery_calls += 1
        return {"output_ref": "s3://bucket/run-1/writing.json.gz", "summary": {}}

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())
    monkeypatch.setattr(content_activities, "recover_stage_work", recover)

    result = asyncio.run(
        content_activities.recover_stage(
            {"run_id": "run-1", "step_key": "writing", "stage_kind": "writing"}
        )
    )

    assert recovery_calls == 1
    assert result["status"] == "completed"
    assert result["hard_budget_reached"] is True
    assert completed[0]["summary"]["hard_budget_reached"] is True


def test_recovery_activity_renews_lease_after_transient_renewal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    renew_attempts: list[tuple[str, str, str, int]] = []
    completed: list[dict[str, Any]] = []
    renewed = asyncio.Event()
    original_sleep = asyncio.sleep

    class FakeRepository:
        async def get_run_context(self, run_id: str) -> dict[str, Any]:
            return {"status": "running"}

        async def force_claim_step(
            self, run_id: str, step_key: str, worker_id: str, lease_seconds: int
        ) -> tuple[str, None]:
            return "claimed", None

        async def renew_step_lease(
            self, run_id: str, step_key: str, worker_id: str, lease_seconds: int
        ) -> bool:
            renew_attempts.append((run_id, step_key, worker_id, lease_seconds))
            if len(renew_attempts) == 1:
                raise RuntimeError("transient database error")
            renewed.set()
            return True

        async def complete_step(self, *args: Any, **kwargs: Any) -> None:
            completed.append(kwargs)

    async def recover_after_renewal(
        step_key: str, context: dict[str, Any], policy: dict[str, bool]
    ) -> dict[str, Any]:
        await asyncio.wait_for(renewed.wait(), timeout=1)
        return {
            "output_ref": "s3://bucket/run-1/checking_1/article.json.gz",
            "summary": {"passed": True, "issue_count": 0},
        }

    async def yield_immediately(_seconds: float) -> None:
        await original_sleep(0)

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())
    monkeypatch.setattr(content_activities, "worker_identity", lambda: "worker-recovery")
    monkeypatch.setattr(content_activities, "recover_stage_work", recover_after_renewal)
    monkeypatch.setattr(content_activities.asyncio, "sleep", yield_immediately)

    result = asyncio.run(
        content_activities.recover_stage(
            {
                "run_id": "run-1",
                "step_key": "checking_1",
                "stage_kind": "checking",
            }
        )
    )

    assert result["status"] == "completed"
    assert len(renew_attempts) >= 2
    assert all(attempt[:3] == ("run-1", "checking_1", "worker-recovery") for attempt in renew_attempts)
    assert completed[0]["output_ref"] == "s3://bucket/run-1/checking_1/article.json.gz"


def test_completed_collecting_step_does_not_repeat_paid_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paid_calls = 0

    class CompletedStep:
        summary_json = {
            "warnings": [
                {"code": "research_unavailable", "message": "Research unavailable"}
            ],
            "result": {"available": 1},
        }

    class FakeRepository:
        async def get_run_context(self, _run_id: str) -> dict[str, Any]:
            return {
                "status": "running",
                "soft_deadline_at": datetime.now(UTC) + timedelta(minutes=5),
                "hard_deadline_at": datetime.now(UTC) + timedelta(minutes=10),
            }

        async def claim_step(
            self,
            _run_id: str,
            _step_key: str,
            _worker_id: str,
            lease_seconds: int,
        ) -> tuple[str, CompletedStep]:
            assert lease_seconds > 0
            return "completed", CompletedStep()

    async def paid_work(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal paid_calls
        paid_calls += 1
        return {}

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())
    monkeypatch.setattr(content_activities, "execute_stage_work", paid_work)

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "run-1", "step_key": "collecting", "progress": 15}
        )
    )

    assert result["status"] == "completed"
    assert result["warnings"][0]["code"] == "research_unavailable"
    assert result["result"] == {"available": 1}
    assert paid_calls == 0


def test_legacy_skip_revision_cannot_hide_failed_quality_check() -> None:
    workflow = ArticleGenerationWorkflow()
    stages: list[str] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            step_key = str(payload["step_key"])
            stages.append(step_key)
            if step_key == "checking_1":
                return {
                    "status": "completed",
                    "skip_revision": True,
                    "result": {"passed": False, "issue_count": 1},
                }
            return {"status": "completed", "result": {}}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "legacy-run"}))

    assert "revising_1" in stages


def test_completed_legacy_check_does_not_replay_skip_revision_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CompletedStep:
        summary_json = {
            "skip_revision": True,
            "result": {"passed": False, "issue_count": 1},
        }

    class FakeRepository:
        async def get_run_context(self, _run_id: str) -> dict[str, Any]:
            return {
                "status": "running",
                "soft_deadline_at": datetime.now(UTC) + timedelta(minutes=5),
                "hard_deadline_at": datetime.now(UTC) + timedelta(minutes=10),
            }

        async def claim_step(
            self,
            _run_id: str,
            _step_key: str,
            _worker_id: str,
            lease_seconds: int,
        ) -> tuple[str, CompletedStep]:
            assert lease_seconds > 0
            return "completed", CompletedStep()

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "legacy-run", "step_key": "checking", "progress": 90}
        )
    )

    assert result["result"] == {"passed": False, "issue_count": 1}
    assert "skip_revision" not in result


def test_cancelled_run_cannot_claim_or_complete_another_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claims = 0

    class FakeRepository:
        async def get_run_context(self, _run_id: str) -> dict[str, Any]:
            return {"status": "cancelled"}

        async def claim_step(self, *_: Any, **__: Any) -> tuple[str, None]:
            nonlocal claims
            claims += 1
            return "claimed", None

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "run-1", "step_key": "writing", "progress": 60}
        )
    )

    assert result == {"status": "cancelled"}
    assert claims == 0


@pytest.mark.parametrize("step_key", ["collecting", "competitor_research"])
def test_hard_budget_observation_does_not_skip_external_collection(
    monkeypatch: pytest.MonkeyPatch, step_key: str
) -> None:
    external_calls = 0

    async def external(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal external_calls
        external_calls += 1
        return {}

    monkeypatch.setattr(content_activities, "collect_sources", external)
    monkeypatch.setattr(content_activities, "collect_competitors", external)

    result = asyncio.run(
        content_activities.execute_stage_work(
            step_key,
            {"run_id": "run-1", "primary_keyword": "keyword"},
            budget_policy(-1, -1),
        )
    )

    assert external_calls == 1
    assert result == {}
