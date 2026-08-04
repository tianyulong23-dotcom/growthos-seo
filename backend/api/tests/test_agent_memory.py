from datetime import UTC, datetime, timedelta

import pytest

from app.modules.agent.models import AgentResearchRecord
from app.modules.agent.repository import (
    _apply_memory_operations,
    _bounded_memory_context,
    _ensure_memory_fact_ids,
    _estimate_context_tokens,
    _memory_context_catalog,
)
from app.modules.agent.repository import AgentRepository
from app.modules.agent.schemas import UpdateProjectMemoryArgs


def fact(value: str, source: str = "inferred") -> dict[str, str]:
    return {
        "category": "target_customers",
        "value": value,
        "source": source,
    }


def apply(
    existing: list[dict[str, str]],
    operations: list[dict[str, str]],
    message: str,
) -> tuple[list[dict], list[dict]]:
    return _apply_memory_operations(
        existing,
        operations,
        user_message_id="message-1",
        user_message=message,
    )


def test_add_creates_a_stable_fact_id_and_binds_confirmed_source() -> None:
    result, applied = apply([], [{
        "operation": "add",
        "category": "target_customers",
        "value": "大型企业",
        "source": "user_confirmed",
    }], "我们的目标客户是大型企业")

    assert result[0]["fact_id"].startswith("fact-")
    assert result[0]["source"] == "user_confirmed"
    assert result[0]["source_message_id"] == "message-1"
    assert applied[0]["fact_id"] == result[0]["fact_id"]
    assert _ensure_memory_fact_ids(result) == result


def test_update_uses_fact_id_and_does_not_leave_the_old_fact() -> None:
    old_value = "旧客户描述" * 300
    existing = _ensure_memory_fact_ids([fact(old_value)])

    result, applied = apply(existing, [{
        "operation": "update",
        "fact_id": existing[0]["fact_id"],
        "value": "大型企业",
        "source": "user_confirmed",
    }], "目标客户改为大型企业")

    assert len(result) == 1
    assert result[0]["fact_id"] == existing[0]["fact_id"]
    assert result[0]["value"] == "大型企业"
    assert old_value not in [item["value"] for item in result]
    assert applied[0]["operation"] == "update"


def test_updated_fact_id_cannot_collide_when_the_old_value_is_added_again() -> None:
    existing = _ensure_memory_fact_ids([fact("原客户")])
    original_fact_id = existing[0]["fact_id"]
    updated, _ = apply(existing, [{
        "operation": "update",
        "fact_id": original_fact_id,
        "value": "新客户",
        "source": "inferred",
    }], "分析客户")

    result, _ = apply(updated, [{
        "operation": "add",
        "category": "target_customers",
        "value": "原客户",
        "source": "inferred",
    }], "分析客户")

    assert [item["value"] for item in result] == ["新客户", "原客户"]
    assert len({item["fact_id"] for item in result}) == 2
    assert result[0]["fact_id"] == original_fact_id


def test_existing_duplicate_fact_ids_are_repaired_deterministically() -> None:
    existing = [
        {**fact("新客户"), "fact_id": "fact-duplicate"},
        {**fact("原客户"), "fact_id": "fact-duplicate"},
    ]

    first = _ensure_memory_fact_ids(existing)
    second = _ensure_memory_fact_ids(existing)

    assert len({item["fact_id"] for item in first}) == 2
    assert first == second
    assert first[0]["fact_id"] == "fact-duplicate"


@pytest.mark.parametrize("value", [" ", "\t\r\n"])
def test_memory_schema_rejects_whitespace_only_values(value: str) -> None:
    with pytest.raises(ValueError):
        UpdateProjectMemoryArgs.model_validate({
            "operations": [{
                "operation": "add",
                "category": "target_customers",
                "value": value,
                "source": "inferred",
            }],
        })


def test_memory_repository_rejects_whitespace_only_values_defensively() -> None:
    with pytest.raises(ValueError, match="不能为空"):
        apply([], [{
            "operation": "add",
            "category": "target_customers",
            "value": "   ",
            "source": "inferred",
        }], "分析客户")


def test_inference_cannot_replace_or_delete_confirmed_fact() -> None:
    existing = _ensure_memory_fact_ids([fact("大型企业", "user_confirmed")])

    with pytest.raises(ValueError, match="不能覆盖"):
        apply(existing, [{
            "operation": "update",
            "fact_id": existing[0]["fact_id"],
            "value": "中小企业",
            "source": "inferred",
        }], "分析一下客户类型")
    with pytest.raises(ValueError, match="不能覆盖"):
        apply(existing, [{
            "operation": "delete",
            "fact_id": existing[0]["fact_id"],
            "source": "inferred",
        }], "分析一下客户类型")


def test_confirmed_fact_can_be_deleted_when_user_says_it_is_obsolete() -> None:
    existing = _ensure_memory_fact_ids([fact("大型企业", "user_confirmed")])
    result, applied = apply(existing, [{
            "operation": "delete",
            "fact_id": existing[0]["fact_id"],
            "source": "user_confirmed",
        }], "删除大型企业这条记忆")

    assert result == []
    assert applied == [{"operation": "delete", "fact_id": existing[0]["fact_id"]}]


def test_confirmed_delete_is_rejected_without_the_old_value_in_user_message() -> None:
    existing = _ensure_memory_fact_ids([fact("大型企业", "user_confirmed")])

    with pytest.raises(ValueError, match="没有明确指出"):
        apply(existing, [{
            "operation": "delete",
            "fact_id": existing[0]["fact_id"],
            "source": "user_confirmed",
        }], "删除那条客户记忆")


def test_duplicate_fact_upgrades_source_without_duplication() -> None:
    existing = [fact("跨境卖家")]
    result, _ = apply(existing, [{
        "operation": "add",
        "category": "target_customers",
        "value": "跨境卖家",
        "source": "user_confirmed",
    }], "目标客户就是跨境卖家")

    assert len(result) == 1
    assert result[0]["source"] == "user_confirmed"
    assert result[0]["source_message_id"] == "message-1"
    assert existing == [fact("跨境卖家")]


def test_fake_user_confirmation_is_downgraded_and_cannot_override_confirmation() -> None:
    existing = _ensure_memory_fact_ids([fact("大型企业", "user_confirmed")])

    with pytest.raises(ValueError, match="不能覆盖"):
        apply(existing, [{
            "operation": "update",
            "fact_id": existing[0]["fact_id"],
            "value": "中小企业",
            "source": "user_confirmed",
        }], "帮我分析项目")


def test_fake_user_confirmation_on_add_is_saved_as_inferred() -> None:
    result, _ = apply([], [{
        "operation": "add",
        "category": "target_customers",
        "value": "大型企业",
        "source": "user_confirmed",
    }], "帮我分析项目")

    assert result[0]["source"] == "inferred"
    assert "source_message_id" not in result[0]


def test_memory_context_is_bounded_and_prioritizes_confirmed_facts() -> None:
    existing = [
        fact("较早的推测信息"),
        fact("用户明确确认的重要信息", "user_confirmed"),
        fact("较新的平台信息", "platform_data"),
    ]
    confirmed_only_budget = _estimate_context_tokens(
        _ensure_memory_fact_ids([existing[1]])
    )

    result = _bounded_memory_context(existing, max_tokens=confirmed_only_budget)

    assert result[0]["value"] == existing[1]["value"]
    assert result[0]["source"] == "user_confirmed"
    assert result[0]["fact_id"].startswith("fact-")
    assert _estimate_context_tokens(result) <= confirmed_only_budget
    assert existing[0]["value"] == "较早的推测信息"


def test_memory_catalog_reports_hidden_facts_by_category() -> None:
    existing = _ensure_memory_fact_ids([
        fact("较早的推测信息"),
        fact("用户明确确认的重要信息", "user_confirmed"),
        {
            "category": "seo_goals",
            "value": "提高自然流量",
            "source": "platform_data",
        },
    ])
    visible = [existing[1], existing[2]]

    catalog = _memory_context_catalog(existing, visible)

    assert catalog == {
        "total_facts": 3,
        "visible_facts": 2,
        "hidden_facts": 1,
        "categories": {
            "target_customers": {"total": 2, "visible": 1},
            "seo_goals": {"total": 1, "visible": 1},
        },
    }


def test_memory_updates_do_not_delete_old_facts_after_two_hundred() -> None:
    existing = [fact(f"客户群体 {index}") for index in range(200)]

    result, _ = apply(existing, [{
        "operation": "add",
        "category": "target_customers",
        "value": "第 201 个客户群体",
        "source": "user_confirmed",
    }], "新增第 201 个客户群体")

    assert len(result) == 201
    assert result[0]["value"] == existing[0]["value"]
    assert result[-1]["value"] == "第 201 个客户群体"
    assert result[-1]["source"] == "user_confirmed"


def test_oversized_confirmed_fact_is_explicitly_truncated_for_context_only() -> None:
    original = fact("重" * 2_000, "user_confirmed")

    result = _bounded_memory_context([original])

    assert len(result) == 1
    assert result[0]["source"] == "user_confirmed"
    assert result[0]["fact_id"].startswith("fact-")
    assert result[0]["context_truncated"] is True
    assert result[0]["value"].startswith("重")
    assert result[0]["value"].endswith(" [context truncated]")
    assert _estimate_context_tokens(result) <= 2_000
    assert original["value"] == "重" * 2_000


def test_research_context_marks_fresh_and_stale_records() -> None:
    common = {
        "id": "research-1",
        "project_id": "project-1",
        "run_id": "run-1",
        "topic": "竞争对手研究",
        "input_scope_json": {"market": "CN"},
        "conclusion": "优先分析三个直接竞争对手",
        "tools_json": ["get_project_profile"],
    }
    fresh = AgentResearchRecord(
        **common,
        created_at=datetime.now(UTC) - timedelta(days=10),
    )
    stale = AgentResearchRecord(
        **{**common, "id": "research-2", "run_id": "run-2"},
        created_at=datetime.now(UTC) - timedelta(days=45),
    )

    fresh_context = AgentRepository._research_context(fresh)
    stale_context = AgentRepository._research_context(stale)

    assert fresh_context["reuse_policy"] == "reuse_before_refresh"
    assert stale_context["reuse_policy"] == "stale_offer_refresh"
    assert fresh_context["input_scope"] == {"market": "CN"}
