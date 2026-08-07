from datetime import UTC, datetime

from pydantic import ValidationError

from app.modules.content.schemas import ContentPlanArticleCreateRequest


def _payload() -> dict:
    return {
        "plan_item_id": "plan-1",
        "plan_item_version": 4,
        "project_id": "project-1",
        "primary_keyword": " car detailing cost ",
        "secondary_keywords": [
            {"keyword": "mobile car detailing cost", "type": "service"},
            {"keyword": "detailing price factors", "type": "informational"},
        ],
        "title": {
            "value": " How Much Does Car Detailing Cost? ",
            "policy": "locked",
        },
        "writing_direction": {
            "value": "Explain the main price ranges and the factors that change the final price.",
            "policy": "locked",
        },
        "serp_snapshot_id": "serp-1",
        "serp_snapshot_generated_at": "2026-08-05T01:30:00Z",
        "country": "US",
        "language": "en",
        "planned_publish_at": "2026-08-12T02:00:00Z",
    }


def test_content_plan_article_contract_preserves_locked_inputs_and_keyword_order() -> None:
    request = ContentPlanArticleCreateRequest.model_validate(_payload())

    assert request.primary_keyword == "car detailing cost"
    assert request.title.value == "How Much Does Car Detailing Cost?"
    assert request.title.policy == "locked"
    assert request.writing_direction.policy == "locked"
    assert [item.keyword for item in request.secondary_keywords] == [
        "mobile car detailing cost",
        "detailing price factors",
    ]
    assert request.article_idempotency_key == "content-plan:plan-1:article"
    assert request.run_idempotency_key == "content-plan:plan-1:v4:run"
    assert request.serp_snapshot_generated_at == datetime(2026, 8, 5, 1, 30, tzinfo=UTC)
    assert request.planned_publish_at == datetime(2026, 8, 12, 2, tzinfo=UTC)


def test_content_plan_article_contract_allows_suggested_preview_values() -> None:
    payload = _payload()
    payload["title"]["policy"] = "suggested"
    payload["writing_direction"]["policy"] = "suggested"

    request = ContentPlanArticleCreateRequest.model_validate(payload)

    assert request.title.policy == "suggested"
    assert request.writing_direction.policy == "suggested"


def test_content_plan_article_contract_rejects_more_than_eight_secondary_keywords() -> None:
    payload = _payload()
    payload["secondary_keywords"] = [
        {"keyword": f"secondary {index}", "type": "informational"}
        for index in range(1, 10)
    ]

    try:
        ContentPlanArticleCreateRequest.model_validate(payload)
    except ValidationError as exc:
        assert "at most 8 items" in str(exc)
    else:
        raise AssertionError("nine secondary keywords were accepted")


def test_content_plan_article_contract_rejects_naive_publish_time_and_extra_fields() -> None:
    payload = _payload()
    payload["planned_publish_at"] = "2026-08-12T10:00:00"
    payload["serp_snapshot_generated_at"] = "2026-08-05T09:30:00"
    payload["organization_id"] = "client-controlled-org"

    try:
        ContentPlanArticleCreateRequest.model_validate(payload)
    except ValidationError as exc:
        message = str(exc)
        assert message.count("datetime must include a timezone") == 2
        assert "Extra inputs are not permitted" in message
    else:
        raise AssertionError("invalid internal article input was accepted")
