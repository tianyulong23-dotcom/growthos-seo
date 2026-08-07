from pydantic import ValidationError
import pytest

from app.modules.keywords.coverage import (
    FakeKeywordCoverageQuery,
    coverage_response,
    validate_coverage_response,
)
from app.modules.keywords.schemas import (
    KeywordCoverageBatchRequest,
    KeywordCoverageBatchResponse,
    KeywordCoverageInput,
    KeywordCoverageResult,
)


def _request() -> KeywordCoverageBatchRequest:
    return KeywordCoverageBatchRequest(
        project_id="project-1",
        keywords=[
            KeywordCoverageInput(
                request_id="rk-001",
                keyword_id=None,
                keyword="  Car   Detailing Cost ",
            ),
            KeywordCoverageInput(
                request_id="rk-002",
                keyword_id="kw-2",
                keyword="car wash cost",
            ),
            KeywordCoverageInput(
                request_id="rk-003",
                keyword_id=None,
                keyword="unavailable evidence",
            ),
        ],
    )


@pytest.mark.anyio
async def test_fake_coverage_query_preserves_covered_uncovered_and_unknown() -> None:
    query = FakeKeywordCoverageQuery(
        {
            "car detailing cost": {
                "status": "uncovered",
            },
            "car wash cost": {
                "status": "covered",
                "relation_id": "coverage-2",
                "covered_url": "https://example.com/car-wash-cost",
            },
            "unavailable evidence": {
                "status": "unknown",
            },
        }
    )

    response = await query.query(_request())

    assert [item.request_id for item in response.results] == [
        "rk-001",
        "rk-002",
        "rk-003",
    ]
    assert [item.normalized_keyword for item in response.results] == [
        "car detailing cost",
        "car wash cost",
        "unavailable evidence",
    ]
    assert [item.status for item in response.results] == [
        "uncovered",
        "covered",
        "unknown",
    ]
    assert response.results[1].relation_id == "coverage-2"


def test_coverage_contract_requires_exactly_one_result_per_request() -> None:
    request = _request()
    missing = KeywordCoverageBatchResponse(
        results=[
            KeywordCoverageResult(
                request_id="rk-001",
                normalized_keyword="car detailing cost",
                status="uncovered",
            )
        ]
    )

    try:
        validate_coverage_response(request, missing)
    except ValueError as exc:
        assert str(exc) == "coverage_response_mismatch"
    else:
        raise AssertionError("missing coverage result was accepted")


def test_covered_result_requires_relation_or_url() -> None:
    try:
        KeywordCoverageResult(
            request_id="rk-001",
            normalized_keyword="car detailing cost",
            status="covered",
        )
    except ValidationError as exc:
        assert "covered result requires relation_id or covered_url" in str(exc)
    else:
        raise AssertionError("covered result without evidence was accepted")


def test_covered_result_rejects_blank_evidence() -> None:
    with pytest.raises(ValidationError):
        KeywordCoverageResult(
            request_id="rk-001",
            normalized_keyword="car detailing cost",
            status="covered",
            relation_id="   ",
        )


def test_coverage_request_is_bounded_and_rejects_duplicate_request_ids() -> None:
    try:
        KeywordCoverageBatchRequest(
            project_id="project-1",
            keywords=[
                KeywordCoverageInput(request_id="same", keyword="one"),
                KeywordCoverageInput(request_id="same", keyword="two"),
            ],
        )
    except ValidationError as exc:
        assert "request_id values must be unique" in str(exc)
    else:
        raise AssertionError("duplicate coverage request IDs were accepted")


def test_coverage_response_helper_never_guesses_unknown_as_uncovered() -> None:
    result = coverage_response(
        request_id="rk-001",
        keyword="Missing  Evidence",
        status="unknown",
    )

    assert result.normalized_keyword == "missing evidence"
    assert result.status == "unknown"
