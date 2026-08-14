from types import SimpleNamespace

import pytest

from app.modules.agent.models import AgentTimelineEvent
from app.modules.agent.repository import (
    _downstream_billing_cost,
    _downstream_billing_entries,
    _completion_display_events,
    _completion_fact_is_incomplete,
    _completion_tool_evidence,
    _materialize_legacy_message_chain,
    _message_path,
    _safe_compactable_message_count,
    _token_bounded_compactable_message_count,
    _unsettled_reservation_cost,
)


def test_downstream_billing_cost_deduplicates_repeated_status_reads() -> None:
    steps = [
        SimpleNamespace(output_json={
            "data": {
                "billing": {
                    "source": "keyword_external_requests",
                    "reference_id": "keyword-run-1",
                    "reported_cost_usd": cost,
                }
            }
        })
        for cost in (0.12, 0.12, 0.15)
    ]
    steps.append(SimpleNamespace(output_json={
        "data": {
            "billing": {
                "source": "content_plan_external_requests",
                "reference_id": "batch-1",
                "reported_cost_usd": 0.2,
            }
        }
    }))

    assert _downstream_billing_cost(steps) == 0.35


def test_completed_billing_settles_only_the_matching_tool_reservation() -> None:
    reservations = [
        SimpleNamespace(
            sequence=1,
            input_json={
                "tool_name": "start_keyword_library",
                "reserve_usd": 1.0,
            },
        ),
        SimpleNamespace(
            sequence=2,
            input_json={
                "tool_name": "start_content_plan",
                "reserve_usd": 1.0,
            },
        ),
    ]
    steps = [SimpleNamespace(output_json={
        "data": {
            "billing": {
                "source": "keyword_external_requests",
                "reference_id": "keyword-run-1",
                "reported_cost_usd": 0.35,
                "complete": True,
            }
        }
    })]

    assert _unsettled_reservation_cost(
        reservations, _downstream_billing_entries(steps)
    ) == 1.0


def test_incomplete_billing_keeps_the_original_reservation() -> None:
    reservations = [SimpleNamespace(
        sequence=1,
        input_json={
            "tool_name": "start_keyword_library",
            "reserve_usd": 1.0,
        },
    )]
    steps = [SimpleNamespace(output_json={
        "data": {
            "billing": {
                "source": "keyword_external_requests",
                "reference_id": "keyword-run-1",
                "reported_cost_usd": 0.2,
                "complete": False,
            }
        }
    })]

    assert _unsettled_reservation_cost(
        reservations, _downstream_billing_entries(steps)
    ) == 1.0


def test_timeline_table_rejects_invalid_foundation_events_at_the_database_boundary() -> None:
    constraint_names = {
        constraint.name for constraint in AgentTimelineEvent.__table__.constraints
    }

    assert {
        "ck_agent_timeline_events_kind",
        "ck_agent_timeline_events_status",
        "ck_agent_timeline_events_sequence",
        "ck_agent_timeline_events_event_key",
        "ck_agent_timeline_events_title",
        "ck_agent_timeline_events_content",
    } <= constraint_names


def messages(*roles: str) -> list[SimpleNamespace]:
    return [SimpleNamespace(role=role, content=role) for role in roles]


def test_editing_legacy_linear_history_keeps_messages_before_the_target() -> None:
    history = [
        SimpleNamespace(id="u1", parent_message_id=None, created_at=index)
        for index in range(4)
    ]
    history[1].id = "a1"
    history[2].id = "u2"
    history[3].id = "a2"
    _materialize_legacy_message_chain(history)
    replacement = SimpleNamespace(
        id="u2-edited",
        parent_message_id=history[2].parent_message_id,
        created_at=4,
    )

    active = _message_path(
        [*history, replacement],
        replacement.id,
        allow_legacy_linear=False,
    )

    assert [message.id for message in active] == ["u1", "a1", "u2-edited"]


def test_compaction_keeps_a_recent_fragment_starting_with_user() -> None:
    history = messages("user", "assistant", "user", "assistant", "user")

    compactable_count = _safe_compactable_message_count(history, keep_at_least=2)

    assert compactable_count == 2
    assert history[compactable_count].role == "user"


def test_compaction_never_includes_the_current_user_message() -> None:
    history = messages("user", "assistant", "user")

    compactable_count = _safe_compactable_message_count(history, keep_at_least=0)

    assert compactable_count == 2
    assert compactable_count < len(history)
    assert history[compactable_count].role == "user"


def test_compaction_does_not_summarize_an_unanswered_user_message() -> None:
    history = messages("user", "user", "assistant", "user")

    compactable_count = _safe_compactable_message_count(history, keep_at_least=2)

    assert compactable_count == 0


def test_compaction_with_zero_requested_keep_is_still_bounded() -> None:
    history = messages("user", "assistant")

    compactable_count = _safe_compactable_message_count(history, keep_at_least=0)

    assert compactable_count == 0


def test_recent_history_is_kept_by_token_budget_at_a_complete_answer_boundary() -> None:
    history = [
        SimpleNamespace(role="user", content="old question " * 80),
        SimpleNamespace(role="assistant", content="old answer " * 80),
        SimpleNamespace(role="user", content="recent question"),
        SimpleNamespace(role="assistant", content="recent answer"),
        SimpleNamespace(role="user", content="current question"),
    ]

    compactable_count = _token_bounded_compactable_message_count(
        history, max_recent_tokens=70
    )

    assert compactable_count == 2
    assert history[compactable_count].role == "user"


def test_recent_history_is_not_compacted_just_because_it_has_many_messages() -> None:
    history = [
        SimpleNamespace(role=role, content="ok")
        for role in ("user", "assistant") * 20
    ] + [SimpleNamespace(role="user", content="current")]

    compactable_count = _token_bounded_compactable_message_count(
        history, max_recent_tokens=2_000
    )

    assert compactable_count == 0


@pytest.mark.parametrize(
    "status",
    ["queued", "pending", "running", "in_progress", "partial", "failed"],
)
def test_nonterminal_business_status_is_prioritized_as_incomplete(status: str) -> None:
    assert _completion_fact_is_incomplete({
        "execution_status": "completed",
        "verified": True,
        "status": status,
    }) is True


def test_completed_business_status_is_not_incomplete_when_verified() -> None:
    assert _completion_fact_is_incomplete({
        "execution_status": "completed",
        "verified": True,
        "status": "completed",
    }) is False


def test_completion_display_events_follow_model_order_and_keep_unclosed_calls() -> None:
    executions = [
        SimpleNamespace(
            tool_call_id="profile-1",
            tool_name="get_project_profile",
            status="completed",
        ),
        SimpleNamespace(
            tool_call_id="audit-1",
            tool_name="get_latest_audit",
            status="failed",
        ),
        SimpleNamespace(
            tool_call_id="status-1",
            tool_name="get_audit_status",
            status="claimed",
        ),
    ]
    steps = [
        SimpleNamespace(
            step_type="model",
            name="chat.completions",
            output_json={
                "progress_text": "我先读取项目资料。",
                "tool_calls": [{"tool_call_id": "profile-1"}],
            },
        ),
        SimpleNamespace(
            step_type="model",
            name="history_compaction",
            output_json={"progress_text": "内部整理不展示"},
        ),
        SimpleNamespace(
            step_type="model",
            name="chat.completions",
            output_json={
                "progress_text": "接着检查技术审核。",
                "tool_calls": [
                    {"tool_call_id": "profile-1"},
                    {"tool_call_id": "audit-1"},
                ],
            },
        ),
    ]

    assert _completion_display_events(steps, executions) == [
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
        {
            "type": "tool",
            "tool_call_id": "status-1",
            "tool": "get_audit_status",
            "execution_status": "claimed",
        },
    ]


def test_completion_display_events_do_not_truncate_visible_progress_text() -> None:
    progress_text = "进" * 2_500
    steps = [
        SimpleNamespace(
            step_type="model",
            name="chat.completions",
            output_json={"progress_text": progress_text, "tool_calls": []},
        )
    ]

    assert _completion_display_events(steps, []) == [
        {"type": "text", "text": progress_text}
    ]


def test_completion_evidence_keeps_created_article_identity_and_status() -> None:
    execution = SimpleNamespace(
        tool_call_id="article-call-1",
        round_number=2,
        call_number=1,
        tool_name="create_article",
        status="completed",
        error_code=None,
        result_json={
            "ok": True,
            "summary": "已启动 1 篇文章生成",
            "data": {
                "article_id": "article-1",
                "run_id": "article-run-1",
                "primary_keyword": "hd streaming",
                "title": "HD Streaming Guide",
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                "verified": True,
            },
        },
        model_result_json={"long_term": {"data": {}}},
    )

    evidence = _completion_tool_evidence(execution)

    assert evidence["data"] == {
        "article_id": "article-1",
        "run_id": "article-run-1",
        "primary_keyword": "hd streaming",
        "title": "HD Streaming Guide",
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "verified": True,
    }
