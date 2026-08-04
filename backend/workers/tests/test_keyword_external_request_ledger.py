from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import RawKeyword
from seo_workers.keywords.repository import (
    ExternalRequestClaimLostError,
    KeywordRepository,
    KeywordRunContext,
)


pytestmark = pytest.mark.anyio


class FakeTransaction(AbstractAsyncContextManager[None]):
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *args: object) -> None:
        return None


class LedgerConnection:
    def __init__(self, row: dict[str, Any] | None = None) -> None:
        self.row = dict(row) if row is not None else None
        self.run_cost = Decimal("0")
        self.saved_batches: list[list[tuple[Any, ...]]] = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction()

    async def fetchrow(self, query: str, *arguments: Any) -> dict[str, Any] | None:
        normalized = " ".join(query.split())
        if (
            normalized.startswith("SELECT")
            and "WHERE request_key = $1" in normalized
            and "keyword_external_requests" in normalized
        ):
            if self.row is None or self.row["request_key"] != arguments[0]:
                return None
            return dict(self.row)
        if (
            normalized.startswith("SELECT")
            and "status = 'completed'" in normalized
            and "keyword_external_requests" in normalized
        ):
            if self.row is None or self.row["status"] != "completed":
                return None
            expires_at = self.row.get("expires_at")
            if expires_at is not None and expires_at <= arguments[4]:
                return None
            return dict(self.row)
        if (
            normalized.startswith("SELECT")
            and "status = 'uncertain'" in normalized
            and "keyword_external_requests" in normalized
        ):
            if self.row is None or self.row["status"] != "uncertain":
                return None
            return dict(self.row)
        if (
            normalized.startswith("SELECT")
            and "status IN ('prepared', 'submitted')" in normalized
            and "keyword_external_requests" in normalized
        ):
            if self.row is None or self.row["status"] not in {"prepared", "submitted"}:
                return None
            return dict(self.row)
        if normalized.startswith("INSERT INTO keyword_external_requests"):
            if self.row is not None:
                return None
            self.row = {
                "request_key": arguments[3],
                "status": "prepared",
                "build_run_id": arguments[2],
                "request_hash": arguments[6],
                "result_count": 0,
                "response_metadata": {},
                "expires_at": None,
                "claim_token": arguments[7],
                "lease_expires_at": arguments[8],
                "submitted_at": None,
                "attempt_count": 1,
                "error_code": None,
                "error_detail": None,
                "cost_usd": Decimal("0"),
            }
            return dict(self.row)
        if (
            normalized.startswith("UPDATE keyword_external_requests")
            and "attempt_count = attempt_count + 1" in normalized
        ):
            assert self.row is not None
            self.row.update(
                {
                    "build_run_id": arguments[1],
                    "request_hash": arguments[2],
                    "status": "prepared",
                    "attempt_count": int(self.row["attempt_count"]) + 1,
                    "result_count": 0,
                    "response_metadata": {},
                    "expires_at": None,
                    "claim_token": arguments[3],
                    "lease_expires_at": arguments[4],
                    "submitted_at": None,
                    "error_code": None,
                    "error_detail": None,
                }
            )
            return dict(self.row)
        if (
            normalized.startswith("UPDATE keyword_external_requests")
            and "status = 'uncertain'" in normalized
            and "RETURNING" in normalized
        ):
            assert self.row is not None
            self.row.update(
                {
                    "status": "uncertain",
                    "lease_expires_at": None,
                    "error_code": "external_request_outcome_unknown",
                    "error_detail": "外部请求提交后未能确认最终结果",
                }
            )
            return dict(self.row)
        raise AssertionError(f"Unexpected fetchrow query: {normalized}")

    async def fetchval(self, query: str, *arguments: Any) -> bool | None:
        normalized = " ".join(query.split())
        if (
            normalized.startswith("UPDATE keyword_external_requests")
            and "status = 'submitted'" in normalized
        ):
            assert self.row is not None
            if (
                self.row["status"] != "prepared"
                or self.row["claim_token"] != arguments[1]
            ):
                return None
            self.row.update(
                {
                    "status": "submitted",
                    "submitted_at": datetime.now(UTC),
                    "lease_expires_at": arguments[2],
                }
            )
            return True
        raise AssertionError(f"Unexpected fetchval query: {normalized}")

    async def execute(self, query: str, *arguments: Any) -> str:
        normalized = " ".join(query.split())
        if normalized.startswith("SELECT pg_advisory_xact_lock"):
            return "SELECT 1"
        if (
            normalized.startswith("UPDATE keyword_external_requests")
            and "status = 'completed'" in normalized
        ):
            assert self.row is not None
            self.row.update(
                {
                    "status": "completed",
                    "result_count": arguments[1],
                    "response_metadata": arguments[2],
                    "cost_usd": arguments[3],
                    "expires_at": arguments[4],
                    "error_code": None,
                    "error_detail": None,
                    "lease_expires_at": None,
                }
            )
            return "UPDATE 1"
        if (
            normalized.startswith("UPDATE keyword_external_requests")
            and "status = $2" in normalized
        ):
            assert self.row is not None
            self.row.update(
                {
                    "status": arguments[1],
                    "response_metadata": arguments[2],
                    "cost_usd": arguments[3],
                    "error_code": arguments[4],
                    "error_detail": arguments[5],
                    "lease_expires_at": None,
                }
            )
            return "UPDATE 1"
        if normalized.startswith("UPDATE keyword_build_runs"):
            self.run_cost += Decimal(str(arguments[1]))
            return "UPDATE 1"
        raise AssertionError(f"Unexpected execute query: {normalized}")

    async def executemany(
        self,
        query: str,
        arguments: list[tuple[Any, ...]],
    ) -> None:
        self.saved_batches.append(arguments)


class FakeAcquire(AbstractAsyncContextManager[LedgerConnection]):
    def __init__(self, connection: LedgerConnection) -> None:
        self.connection = connection

    async def __aenter__(self) -> LedgerConnection:
        return self.connection

    async def __aexit__(self, *args: object) -> None:
        return None


class LedgerPool:
    def __init__(self, connection: LedgerConnection) -> None:
        self.connection = connection

    def acquire(self) -> FakeAcquire:
        return FakeAcquire(self.connection)


def context() -> KeywordRunContext:
    return KeywordRunContext(
        organization_id="organization-1",
        project_id="project-1",
        run_id="run-1",
        kind="initial",
        round_number=1,
        domain="example.com",
        country="US",
        language="en",
        competitor_domain=None,
        profile={},
        profile_source="",
        profile_version="",
    )


def existing_row(status: str, *, request_hash: str = "hash-1") -> dict[str, Any]:
    now = datetime.now(UTC)
    return {
        "request_key": "request-1",
        "status": status,
        "build_run_id": "run-1",
        "request_hash": request_hash,
        "result_count": 12,
        "response_metadata": {"cached": True},
        "expires_at": now - timedelta(days=1),
        "claim_token": "claim-old",
        "lease_expires_at": (
            now + timedelta(minutes=5)
            if status in {"prepared", "submitted"}
            else None
        ),
        "submitted_at": now if status == "submitted" else None,
        "attempt_count": 1,
        "error_code": "provider_error" if status != "completed" else None,
        "error_detail": "provider failed" if status != "completed" else None,
        "cost_usd": Decimal("0.02"),
    }


def repository(connection: LedgerConnection) -> KeywordRepository:
    return KeywordRepository(  # type: ignore[arg-type]
        LedgerPool(connection),
        KeywordWorkerSettings(),
    )


async def begin(repo: KeywordRepository, *, request_hash: str = "hash-1"):
    return await repo.begin_external_request(
        context=context(),
        request_key="request-1",
        provider="dataforseo",
        endpoint="dataforseo_labs/google/keyword_ideas/live",
        request_hash=request_hash,
    )


async def test_completed_request_is_reused_even_after_its_cache_expiry() -> None:
    connection = LedgerConnection(existing_row("completed"))

    request = await begin(repository(connection))

    assert request.reusable is True
    assert request.should_execute is False


async def test_unexpired_completed_request_is_reused_across_build_runs() -> None:
    row = existing_row("completed")
    row["request_key"] = "request-from-run-1"
    row["expires_at"] = datetime.now(UTC) + timedelta(days=1)
    connection = LedgerConnection(row)
    repo = repository(connection)
    next_context = KeywordRunContext(
        **{
            **context().__dict__,
            "project_id": "project-2",
            "run_id": "run-2",
        }
    )

    request = await repo.begin_external_request(
        context=next_context,
        request_key="request-from-run-2",
        provider="dataforseo",
        endpoint="dataforseo_labs/google/keyword_ideas/live",
        request_hash="hash-1",
    )

    assert request.request_key == "request-from-run-1"
    assert request.build_run_id == "run-1"
    assert request.reusable is True
    assert request.should_execute is False


async def test_matching_in_flight_request_is_not_submitted_twice() -> None:
    row = existing_row("submitted")
    row["request_key"] = "request-from-run-1"
    connection = LedgerConnection(row)
    repo = repository(connection)

    request = await repo.begin_external_request(
        context=KeywordRunContext(
            **{
                **context().__dict__,
                "project_id": "project-2",
                "run_id": "run-2",
            }
        ),
        request_key="request-from-run-2",
        provider="dataforseo",
        endpoint="dataforseo_labs/google/keyword_ideas/live",
        request_hash="hash-1",
    )

    assert request.request_key == "request-from-run-1"
    assert request.status == "submitted"
    assert request.should_execute is False
    assert request.claimed is False
    assert request.result_count == 12


async def test_expired_cross_run_prepared_request_is_safely_claimed() -> None:
    row = existing_row("prepared")
    row["request_key"] = "request-from-run-1"
    row["lease_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    connection = LedgerConnection(row)
    repo = repository(connection)

    request = await repo.begin_external_request(
        context=KeywordRunContext(
            **{
                **context().__dict__,
                "project_id": "project-2",
                "run_id": "run-2",
            }
        ),
        request_key="request-from-run-2",
        provider="dataforseo",
        endpoint="dataforseo_labs/google/keyword_ideas/live",
        request_hash="hash-1",
    )

    assert request.request_key == "request-from-run-1"
    assert request.build_run_id == "run-2"
    assert request.status == "prepared"
    assert request.should_execute is True
    assert request.attempt_count == 2


async def test_expired_cross_run_submitted_request_becomes_uncertain() -> None:
    row = existing_row("submitted")
    row["request_key"] = "request-from-run-1"
    row["lease_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    connection = LedgerConnection(row)
    repo = repository(connection)

    request = await repo.begin_external_request(
        context=KeywordRunContext(
            **{
                **context().__dict__,
                "project_id": "project-2",
                "run_id": "run-2",
            }
        ),
        request_key="request-from-run-2",
        provider="dataforseo",
        endpoint="dataforseo_labs/google/keyword_ideas/live",
        request_hash="hash-1",
    )

    assert request.request_key == "request-from-run-1"
    assert request.status == "uncertain"
    assert request.should_execute is False
    assert request.error_code == "external_request_outcome_unknown"


async def test_matching_cross_run_uncertain_request_blocks_a_new_paid_request() -> None:
    row = existing_row("uncertain")
    row["request_key"] = "request-from-run-1"
    connection = LedgerConnection(row)
    repo = repository(connection)

    request = await repo.begin_external_request(
        context=KeywordRunContext(
            **{
                **context().__dict__,
                "project_id": "project-2",
                "run_id": "run-2",
            }
        ),
        request_key="request-from-run-2",
        provider="dataforseo",
        endpoint="dataforseo_labs/google/keyword_ideas/live",
        request_hash="hash-1",
    )

    assert request.request_key == "request-from-run-1"
    assert request.status == "uncertain"
    assert request.should_execute is False
    assert request.claimed is False


@pytest.mark.parametrize(
    "status",
    ["prepared", "submitted", "charged_failed", "uncertain"],
)
async def test_unsafe_failure_states_never_claim_another_paid_request(
    status: str,
) -> None:
    connection = LedgerConnection(existing_row(status))

    request = await begin(repository(connection))

    assert request.status == status
    assert request.should_execute is False
    assert request.claimed is False
    assert request.attempt_count == 1


async def test_retryable_failure_is_atomically_claimed_for_the_next_attempt() -> None:
    connection = LedgerConnection(existing_row("retryable_failed"))

    request = await begin(repository(connection))

    assert request.status == "prepared"
    assert request.should_execute is True
    assert request.claimed is True
    assert request.attempt_count == 2
    assert request.response_metadata == {}
    assert request.error_code is None


async def test_expired_prepared_request_is_safely_reclaimed() -> None:
    row = existing_row("prepared")
    row["lease_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    connection = LedgerConnection(row)

    request = await begin(repository(connection))

    assert request.status == "prepared"
    assert request.should_execute is True
    assert request.claimed is True
    assert request.claim_token != "claim-old"
    assert request.attempt_count == 2


async def test_expired_submitted_request_becomes_uncertain_without_reexecution() -> None:
    row = existing_row("submitted")
    row["lease_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    connection = LedgerConnection(row)

    request = await begin(repository(connection))

    assert request.status == "uncertain"
    assert request.should_execute is False
    assert request.claimed is False
    assert request.error_code == "external_request_outcome_unknown"


async def test_same_request_key_cannot_be_reused_for_different_content() -> None:
    connection = LedgerConnection(existing_row("completed", request_hash="old-hash"))

    with pytest.raises(RuntimeError, match="请求内容发生变化"):
        await begin(repository(connection), request_hash="new-hash")


async def test_completing_the_same_request_twice_only_counts_its_cost_once() -> None:
    connection = LedgerConnection()
    repo = repository(connection)
    request = await begin(repo)
    assert request.should_execute is True
    assert request.claim_token is not None
    assert await repo.mark_external_request_submitted(
        "request-1",
        claim_token=request.claim_token,
    )

    await repo.complete_external_request(
        "request-1",
        claim_token=request.claim_token,
        result_count=12,
        metadata={"path": ["v3", "dataforseo_labs"]},
        cost_usd=0.02,
    )
    await repo.complete_external_request(
        "request-1",
        claim_token=request.claim_token,
        result_count=12,
        metadata={"path": ["v3", "dataforseo_labs"]},
        cost_usd=0.02,
    )

    assert connection.row is not None
    assert connection.row["status"] == "completed"
    assert connection.row["cost_usd"] == Decimal("0.02")
    assert connection.run_cost == Decimal("0.02")


async def test_recording_the_same_charged_failure_twice_only_counts_its_cost_once() -> None:
    connection = LedgerConnection()
    repo = repository(connection)
    request = await begin(repo)
    assert request.should_execute is True
    assert request.claim_token is not None
    assert await repo.mark_external_request_submitted(
        "request-1",
        claim_token=request.claim_token,
    )

    for _ in range(2):
        await repo.fail_external_request(
            "request-1",
            claim_token=request.claim_token,
            code="dataforseo_task_failed",
            detail="DataForSEO charged task failed",
            failure_status="charged_failed",
            metadata={"path": ["v3", "dataforseo_labs"]},
            cost_usd=0.03,
        )

    assert connection.row is not None
    assert connection.row["status"] == "charged_failed"
    assert connection.row["cost_usd"] == Decimal("0.03")
    assert connection.run_cost == Decimal("0.03")


async def test_expired_claim_cannot_complete_or_change_an_uncertain_request() -> None:
    connection = LedgerConnection()
    repo = repository(connection)
    request = await begin(repo)
    assert request.claim_token is not None
    assert await repo.mark_external_request_submitted(
        "request-1",
        claim_token=request.claim_token,
    )
    assert connection.row is not None
    connection.row["status"] = "uncertain"
    connection.row["lease_expires_at"] = None

    with pytest.raises(ExternalRequestClaimLostError):
        await repo.complete_external_request(
            "request-1",
            claim_token=request.claim_token,
            result_count=12,
        )
    updated = await repo.fail_external_request(
        "request-1",
        claim_token=request.claim_token,
        code="network_error",
        detail="late failure",
    )

    assert updated is False
    assert connection.row["status"] == "uncertain"


async def test_expired_claim_cannot_persist_keyword_rows() -> None:
    row = existing_row("uncertain")
    connection = LedgerConnection(row)
    repo = repository(connection)

    with pytest.raises(ExternalRequestClaimLostError):
        await repo.save_ideas_and_complete_external_request(
            context(),
            [
                RawKeyword(
                    keyword="car care products",
                    source="keyword_ideas_broad",
                    provider_rank=1,
                )
            ],
            request_key="request-1",
            claim_token="claim-old",
            metadata={},
            cost_usd=0.02,
            expires_at=None,
        )

    assert connection.saved_batches == []
    assert connection.row is not None
    assert connection.row["status"] == "uncertain"
