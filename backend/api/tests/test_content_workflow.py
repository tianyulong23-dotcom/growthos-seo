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
from app.modules.content.models import Article
from app.modules.content.repository import ContentRepository
from app.modules.content.workflows import (
    MAX_FINISH_ATTEMPTS,
    MAX_STAGE_RECOVERY_ATTEMPTS,
    ArticleGenerationWorkflow,
    retry_delay,
)


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
]
EXPECTED_VISUAL_STAGES = [
    ("visual_resolving", 55),
    ("visual_assembling", 96),
    ("visual_checking", 98),
]


def assert_generation_stage_dependencies(stages: list[str]) -> None:
    expected = {
        *[step_key for step_key, _progress in EXPECTED_STAGES],
        *[step_key for step_key, _progress in EXPECTED_QUALITY_STAGES],
        *[step_key for step_key, _progress in EXPECTED_VISUAL_STAGES],
    }
    assert len(stages) == len(expected)
    assert set(stages) == expected
    assert stages[:4] == [
        "preparing",
        "collecting",
        "competitor_research",
        "planning",
    ]
    assert stages.index("planning") < stages.index("writing")
    assert stages.index("planning") < stages.index("visual_resolving")
    assert stages.index("writing") < stages.index("editing") < stages.index("checking_1")
    assert stages.index("checking_1") < stages.index("visual_assembling")
    assert stages.index("visual_resolving") < stages.index("visual_assembling")
    assert stages.index("visual_assembling") < stages.index("visual_checking")


def test_apply_article_snapshot_fills_missing_historical_metadata() -> None:
    article = Article(
        id="article-1",
        organization_id="org-1",
        project_id="project-1",
        primary_keyword="solar battery payback",
        publication_status="publish_ready",
        secondary_keywords_json=[],
        indexing="index/follow",
        seo_field_states_json={},
    )
    metadata = {
        "title": "Solar battery payback",
        "slug": "solar-battery-payback",
        "meta_title": "Solar battery payback",
        "meta_description": "A practical guide.",
        "secondary_keywords": [],
        "canonical_url": None,
        "indexing": "index/follow",
        "field_states": {},
        "publication_status": "publish_ready",
    }

    ContentRepository._apply_article_snapshot(
        article,
        {"type": "doc", "schema_version": 2, "content": []},
        metadata,
        "# Solar battery payback\n",
        "<h1>Solar battery payback</h1>",
        "content-hash",
        1,
        1,
    )

    assert article.focus_keyword == "solar battery payback"


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
    assert_generation_stage_dependencies([step_key for step_key, _progress in stage_calls])
    assert dict(stage_calls) == dict(
        [*EXPECTED_STAGES, *EXPECTED_QUALITY_STAGES, *EXPECTED_VISUAL_STAGES]
    )
    assert calls[-1] == (
        "content_finish_run",
        {
            "run_id": "run-1",
            "status": "completed",
            "warnings": [],
            "final_step_key": "visual_checking",
        },
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
            "final_step_key": "visual_checking",
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

    assert_generation_stage_dependencies(stages)
    assert finishes[0]["status"] == "completed_with_warnings"
    assert finishes[0]["final_step_key"] == "visual_checking"
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


def test_fallback_sections_fail_retryably_instead_of_being_finalized() -> None:
    workflow = ArticleGenerationWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        calls.append((name, dict(payload)))
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] == "checking":
                return {
                    "status": "completed",
                    "result": {
                        "passed": False,
                        "issue_count": 4,
                        "check_status": "completed",
                        "repairable": True,
                        "repair_scope": ["section-1"],
                        "blocking_issue_codes": ["fallback_section"],
                    },
                }
            if payload["stage_kind"] == "revising":
                return {"status": "completed", "result": {"revised_sections": 1}}
            return {"status": "completed", "result": {}}
        if name == "content_fail_run":
            return {"status": "failed"}
        if name == "content_finish_run":
            raise AssertionError("fallback sections must not be finalized")
        raise AssertionError(name)

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-fallback-sections"}))

    quality_stages = [
        payload["step_key"]
        for name, payload in calls
        if name == "content_execute_stage"
        and payload["stage_kind"] in {"checking", "revising"}
    ]
    assert quality_stages == ["checking_1"]
    assert calls[-1] == (
        "content_fail_run",
        {
            "run_id": "run-fallback-sections",
            "error_code": "article_quality_blocked",
            "error_detail": "generated article contains fallback sections",
            "failed_stage": "checking",
            "retryable": True,
        },
    )
    assert not any(name == "content_finish_run" for name, _payload in calls)


def test_nonblocking_repairable_issue_is_saved_as_a_warning_without_revision() -> None:
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

    assert quality_stages == ["checking_1"]


def test_quality_check_runs_once_after_full_article_editing() -> None:
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
    ]
    assert finish["status"] == "completed_with_warnings"
    assert finish["warnings"][-1]["code"] == "quality_issues_remaining"


def test_single_check_preserves_generation_and_check_warnings() -> None:
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

    assert finish["run_id"] == "run-resolved-warning"
    assert finish["status"] == "completed_with_warnings"
    assert [item["code"] for item in finish["warnings"]] == [
        "writing_degraded",
        "checking_degraded",
        "quality_issues_remaining",
    ]


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


def test_failed_nonblocking_check_does_not_start_a_revision_loop() -> None:
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

    assert quality_calls == [("checking_1", "editing", 0)]
    assert finish["status"] == "completed_with_warnings"
    assert finish["warnings"][-1]["code"] == "quality_issues_remaining"


def test_repairable_issue_fingerprint_does_not_trigger_revision() -> None:
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

    assert quality_stages == ["checking_1"]
    assert finish["status"] == "completed_with_warnings"
    assert finish["warnings"][-1]["code"] == "quality_issues_remaining"
    assert finish["final_step_key"] == "visual_checking"


def test_failed_check_is_not_repeated_for_comparison() -> None:
    workflow = ArticleGenerationWorkflow()
    finish: dict[str, Any] = {}
    checking_calls = 0

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal finish, checking_calls
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            if payload["stage_kind"] == "checking":
                checking_calls += 1
                issue_count = 2 if checking_calls == 1 else 3
                return {
                    "status": "completed",
                    "result": {
                        "passed": False,
                        "issue_count": issue_count,
                        "repairable": True,
                        "repairable_issue_count": issue_count,
                        "repairable_issue_fingerprint": [
                            f"prose:section-1:issue-{index}"
                            for index in range(issue_count)
                        ],
                    },
                }
            if payload["stage_kind"] == "revising":
                return {"status": "completed", "result": {"revised_sections": 1}}
            return {"status": "completed", "result": {}}
        finish = dict(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-worse-revision"}))

    assert checking_calls == 1
    assert finish["final_step_key"] == "visual_checking"
    assert finish["warnings"][-1]["code"] == "quality_issues_remaining"


def test_single_check_preserves_separate_evidence_gap_warning() -> None:
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
        "quality_issues_remaining",
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

    assert_generation_stage_dependencies(stages)
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
                "message": "The complete article was saved with deterministic quality warnings.",
            },
        ],
        "final_step_key": "visual_checking",
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


def test_busy_step_waits_for_the_existing_database_lease() -> None:
    workflow = ArticleGenerationWorkflow()
    stage_attempts: dict[str, int] = {}
    sleeps: list[float] = []

    async def call(name: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            step_key = payload["step_key"]
            stage_attempts[step_key] = stage_attempts.get(step_key, 0) + 1
            if step_key == "planning" and stage_attempts[step_key] == 1:
                return {"status": "busy", "retry_after_seconds": 361}
            return {"status": "completed", "warning": None, "result": {}}
        return None

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    workflow._call = call  # type: ignore[method-assign]
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1"}))

    assert stage_attempts["planning"] == 2
    assert sleeps == [361]


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


def test_stage_recovery_exhaustion_marks_run_failed() -> None:
    workflow = ArticleGenerationWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

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
        calls.append((name, payload))
        if name == "content_begin_run":
            return {"status": "running"}
        if name in {"content_execute_stage", "content_recover_stage"}:
            raise activity_error(name)
        if name == "content_fail_run":
            return {"status": "failed"}
        raise AssertionError(name)

    async def sleep(_seconds: float) -> None:
        return None

    workflow._call = call  # type: ignore[method-assign]
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-recovery-exhausted"}))

    recovery_calls = [name for name, _payload in calls if name == "content_recover_stage"]
    assert len(recovery_calls) == MAX_STAGE_RECOVERY_ATTEMPTS
    assert calls[-1] == (
        "content_fail_run",
        {
            "run_id": "run-recovery-exhausted",
            "error_code": "article_stage_recovery_exhausted",
            "error_detail": "preparing could not be recovered after bounded retries",
            "failed_stage": "preparing",
            "retryable": True,
        },
    )


def test_finish_exhaustion_marks_run_failed_instead_of_looping_forever() -> None:
    workflow = ArticleGenerationWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

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
        calls.append((name, payload))
        if name == "content_begin_run":
            return {"status": "running"}
        if name == "content_execute_stage":
            return {
                "status": "completed",
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload["stage_kind"] == "checking"
                    else {}
                ),
            }
        if name == "content_finish_run":
            raise activity_error(name)
        if name == "content_fail_run":
            return {"status": "failed"}
        raise AssertionError(name)

    async def sleep(_seconds: float) -> None:
        return None

    workflow._call = call  # type: ignore[method-assign]
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-finish-exhausted"}))

    finish_calls = [name for name, _payload in calls if name == "content_finish_run"]
    assert len(finish_calls) == MAX_FINISH_ATTEMPTS
    assert calls[-1] == (
        "content_fail_run",
        {
            "run_id": "run-finish-exhausted",
            "error_code": "article_finish_exhausted",
            "error_detail": "generated article could not be finalized after bounded retries",
            "failed_stage": "finalizing",
            "retryable": True,
        },
    )


def test_fail_run_activity_persists_structured_terminal_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failures: list[dict[str, Any]] = []

    class FakeRepository:
        async def fail_run(self, run_id: str, **failure: Any) -> None:
            failures.append({"run_id": run_id, **failure})

    monkeypatch.setattr(content_activities, "repository", lambda: FakeRepository())

    result = asyncio.run(
        content_activities.fail_run(
            {
                "run_id": "run-failed",
                "error_code": "article_workflow_closed",
                "error_detail": "Temporal closed without a database terminal state",
                "failed_stage": "writing",
                "retryable": True,
            }
        )
    )

    assert result == {"status": "failed"}
    assert failures == [
        {
            "run_id": "run-failed",
            "error_code": "article_workflow_closed",
            "error_detail": "Temporal closed without a database terminal state",
            "failed_stage": "writing",
            "retryable": True,
        }
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

    assert result == {"status": "busy", "retry_after_seconds": 1}
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


def test_legacy_skip_revision_flag_does_not_restore_revision_loop() -> None:
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

    assert_generation_stage_dependencies(stages)


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
