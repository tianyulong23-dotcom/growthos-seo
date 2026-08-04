from types import SimpleNamespace

import pytest

from app.modules.agent.repository import (
    _completion_fact_is_incomplete,
    _materialize_legacy_message_chain,
    _message_path,
    _safe_compactable_message_count,
    _token_bounded_compactable_message_count,
)


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
