from __future__ import annotations

import unicodedata
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import Article
from app.modules.keywords.schemas import (
    KeywordCoverageBatchRequest,
    KeywordCoverageBatchResponse,
    KeywordCoverageResult,
    KeywordCoverageStatus,
)


def normalize_coverage_keyword(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def coverage_response(
    *,
    request_id: str,
    keyword: str,
    status: KeywordCoverageStatus,
    relation_id: str | None = None,
    covered_url: str | None = None,
) -> KeywordCoverageResult:
    return KeywordCoverageResult(
        request_id=request_id,
        normalized_keyword=normalize_coverage_keyword(keyword),
        status=status,
        relation_id=relation_id,
        covered_url=covered_url,
    )


def validate_coverage_response(
    request: KeywordCoverageBatchRequest,
    response: KeywordCoverageBatchResponse,
) -> KeywordCoverageBatchResponse:
    expected = [item.request_id for item in request.keywords]
    actual = [item.request_id for item in response.results]
    if len(set(actual)) != len(actual) or set(actual) != set(expected):
        raise ValueError("coverage_response_mismatch")
    return response


class FakeKeywordCoverageQuery:
    def __init__(self, coverage_by_keyword: dict[str, dict[str, Any]]) -> None:
        self.coverage_by_keyword = {
            normalize_coverage_keyword(keyword): dict(value)
            for keyword, value in coverage_by_keyword.items()
        }

    async def query(
        self, request: KeywordCoverageBatchRequest
    ) -> KeywordCoverageBatchResponse:
        results = []
        for item in request.keywords:
            normalized = normalize_coverage_keyword(item.keyword)
            evidence = self.coverage_by_keyword.get(normalized, {"status": "unknown"})
            results.append(
                coverage_response(
                    request_id=item.request_id,
                    keyword=normalized,
                    status=evidence.get("status", "unknown"),
                    relation_id=evidence.get("relation_id"),
                    covered_url=evidence.get("covered_url"),
                )
            )
        return validate_coverage_response(
            request,
            KeywordCoverageBatchResponse(results=results),
        )


class SQLAlchemyKeywordCoverageQuery:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def query(
        self, request: KeywordCoverageBatchRequest
    ) -> KeywordCoverageBatchResponse:
        normalized_inputs = {
            normalize_coverage_keyword(item.keyword) for item in request.keywords
        }
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(Article.id, Article.primary_keyword)
                    .where(
                        Article.project_id == request.project_id,
                        Article.status != "cancelled",
                    )
                    .order_by(Article.created_at, Article.id)
                )
            ).all()
        articles_by_keyword = self._articles_by_keyword(rows, normalized_inputs)
        results = []
        for item in request.keywords:
            normalized = normalize_coverage_keyword(item.keyword)
            article_id = articles_by_keyword.get(normalized)
            results.append(
                coverage_response(
                    request_id=item.request_id,
                    keyword=normalized,
                    status="covered" if article_id is not None else "unknown",
                    relation_id=article_id,
                )
            )
        return validate_coverage_response(
            request,
            KeywordCoverageBatchResponse(results=results),
        )

    @staticmethod
    def _articles_by_keyword(
        rows: Sequence[tuple[str, str]],
        normalized_inputs: set[str],
    ) -> dict[str, str]:
        result: dict[str, str] = {}
        for article_id, primary_keyword in rows:
            normalized = normalize_coverage_keyword(primary_keyword)
            if normalized in normalized_inputs:
                result.setdefault(normalized, article_id)
        return result
