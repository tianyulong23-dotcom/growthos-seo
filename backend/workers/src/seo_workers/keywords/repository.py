from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Iterable
from uuid import NAMESPACE_URL, uuid4, uuid5

import asyncpg

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import (
    PRIORITY_RULE_VERSION,
    MergedCandidate,
    RawKeyword,
    SeedDecision,
    display_keyword,
    normalize_keyword,
    priority_score,
    volume_percentiles,
)
from seo_workers.keywords.providers import (
    AIProviderConfig,
    CompetitorGap,
    DataForSEOProviderConfig,
)


@dataclass(frozen=True)
class KeywordRunContext:
    organization_id: str
    project_id: str
    run_id: str
    kind: str
    round_number: int
    domain: str
    country: str
    language: str
    competitor_domain: str | None
    profile: dict[str, Any]
    profile_source: str
    profile_version: str


@dataclass(frozen=True)
class ProfilePollResult:
    profile: dict[str, Any] | None
    terminal: bool
    status: str | None
    message: str
    source: str
    version: str
    page_hints: list[dict[str, Any]]


class ExternalRequestClaimLostError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExternalRequestRecord:
    request_key: str
    status: str
    build_run_id: str
    result_count: int
    response_metadata: dict[str, Any]
    expires_at: datetime | None
    claim_token: str | None = None
    lease_expires_at: datetime | None = None
    submitted_at: datetime | None = None
    claimed: bool = True
    attempt_count: int = 1
    error_code: str | None = None
    error_detail: str | None = None

    @property
    def reusable(self) -> bool:
        return self.status == "completed"

    @property
    def should_execute(self) -> bool:
        return self.status == "prepared" and self.claimed


def external_request_record(
    row: Any,
    *,
    claimed: bool,
) -> ExternalRequestRecord:
    return ExternalRequestRecord(
        request_key=str(row["request_key"]),
        status=str(row["status"]),
        build_run_id=str(row["build_run_id"]),
        result_count=int(row["result_count"] or 0),
        response_metadata=dict(row["response_metadata"] or {}),
        expires_at=row["expires_at"],
        claim_token=row["claim_token"],
        lease_expires_at=row["lease_expires_at"],
        submitted_at=row["submitted_at"],
        claimed=claimed,
        attempt_count=int(row["attempt_count"] or 1),
        error_code=row["error_code"],
        error_detail=row["error_detail"],
    )


@dataclass(frozen=True)
class StagedKeyword:
    candidate: MergedCandidate
    metric: dict[str, Any] | None
    metrics_status: str


@dataclass(frozen=True)
class KeywordCommitResult:
    result_version: int
    keyword_count: int
    pending_metrics_count: int


KEYWORD_COMMIT_BATCH_SIZE = 100
METRIC_REFRESH_MAX_ATTEMPTS = 3


KEYWORD_IDEA_UPSERT_SQL = """
    INSERT INTO keyword_ideas (
        organization_id,
        project_id,
        build_run_id,
        source,
        source_seed_id,
        source_seed_key,
        keyword,
        normalized_keyword,
        provider_rank,
        search_volume,
        cpc,
        competition,
        keyword_difficulty,
        intent,
        monthly_searches,
        raw_payload,
        metrics_payload,
        business_relevance
    )
    VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18
    )
    ON CONFLICT (
        build_run_id,
        source,
        normalized_keyword,
        source_seed_key
    ) DO UPDATE SET
        keyword = EXCLUDED.keyword,
        provider_rank = EXCLUDED.provider_rank,
        search_volume = EXCLUDED.search_volume,
        cpc = EXCLUDED.cpc,
        competition = EXCLUDED.competition,
        keyword_difficulty = EXCLUDED.keyword_difficulty,
        intent = EXCLUDED.intent,
        monthly_searches = EXCLUDED.monthly_searches,
        raw_payload = EXCLUDED.raw_payload,
        metrics_payload = EXCLUDED.metrics_payload,
        business_relevance = COALESCE(
            EXCLUDED.business_relevance,
            keyword_ideas.business_relevance
        )
"""

KEYWORD_GAP_UPSERT_SQL = """
    INSERT INTO keyword_competitor_gaps (
        id,
        organization_id,
        project_id,
        build_run_id,
        competitor_domain,
        keyword,
        normalized_keyword,
        competitor_rank,
        search_volume,
        cpc,
        competition,
        keyword_difficulty,
        intent,
        monthly_searches,
        raw_payload,
        status
    )
    VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, 'pending'
    )
    ON CONFLICT (build_run_id, normalized_keyword) DO UPDATE SET
        competitor_rank = EXCLUDED.competitor_rank,
        search_volume = EXCLUDED.search_volume,
        cpc = EXCLUDED.cpc,
        competition = EXCLUDED.competition,
        keyword_difficulty = EXCLUDED.keyword_difficulty,
        intent = EXCLUDED.intent,
        monthly_searches = EXCLUDED.monthly_searches,
        raw_payload = EXCLUDED.raw_payload
"""


async def _configure_connection(connection: asyncpg.Connection) -> None:
    await connection.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await connection.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def create_pool(settings: KeywordWorkerSettings) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn=settings.asyncpg_database_url,
        min_size=1,
        max_size=8,
        command_timeout=60,
        init=_configure_connection,
    )


class KeywordRepository:
    def __init__(self, pool: asyncpg.Pool, settings: KeywordWorkerSettings) -> None:
        self.pool = pool
        self.settings = settings

    async def touch_worker_heartbeat(
        self,
        worker_id: str,
        *,
        task_queue: str,
        details: dict[str, Any] | None = None,
    ) -> datetime:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                DELETE FROM keyword_worker_heartbeats
                WHERE worker_id <> $1
                    AND last_seen_at < now() - interval '1 day'
                """,
                worker_id,
            )
            value = await connection.fetchval(
                """
                INSERT INTO keyword_worker_heartbeats (
                    worker_id,
                    task_queue,
                    details
                )
                VALUES ($1, $2, $3)
                ON CONFLICT (worker_id) DO UPDATE
                SET task_queue = EXCLUDED.task_queue,
                    last_seen_at = now(),
                    details = EXCLUDED.details
                RETURNING last_seen_at
                """,
                worker_id,
                task_queue,
                details or {},
            )
        if not isinstance(value, datetime):
            raise RuntimeError("无法记录关键词 worker 心跳")
        return value

    async def remove_worker_heartbeat(self, worker_id: str) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                "DELETE FROM keyword_worker_heartbeats WHERE worker_id = $1",
                worker_id,
            )

    async def load_context(self, task: dict[str, Any]) -> KeywordRunContext:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    run.organization_id,
                    run.project_id,
                    run.id AS run_id,
                    run.kind,
                    run.round_number,
                    run.profile_snapshot,
                    run.profile_source,
                    run.profile_version,
                    COALESCE(run.competitor_domain, project.competitor_domain)
                        AS competitor_domain,
                    project.domain,
                    project.country,
                    project.language
                FROM keyword_build_runs AS run
                JOIN projects AS project ON project.id = run.project_id
                WHERE run.id = $1
                    AND run.project_id = $2
                    AND run.organization_id = $3
                """,
                str(task["run_id"]),
                str(task["project_id"]),
                str(task["organization_id"]),
            )
        if row is None:
            raise RuntimeError("关键词任务或项目不存在")
        return KeywordRunContext(
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            run_id=row["run_id"],
            kind=row["kind"],
            round_number=row["round_number"],
            domain=row["domain"],
            country=row["country"],
            language=row["language"],
            competitor_domain=row["competitor_domain"],
            profile=dict(row["profile_snapshot"] or {}),
            profile_source=str(row["profile_source"] or ""),
            profile_version=str(row["profile_version"] or ""),
        )

    async def mark_started(self, run_id: str) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET status = 'running',
                    stage = CASE WHEN stage = 'queued' THEN 'queued' ELSE stage END,
                    message = CASE
                        WHEN stage = 'queued' THEN '正在准备关键词库'
                        ELSE message
                    END,
                    started_at = COALESCE(started_at, now()),
                    next_retry_at = NULL,
                    competitor_domain = COALESCE(
                        competitor_domain,
                        (
                            SELECT competitor_domain
                            FROM projects
                            WHERE projects.id = keyword_build_runs.project_id
                        )
                    ),
                    gap_status = CASE
                        WHEN COALESCE(
                            competitor_domain,
                            (
                                SELECT competitor_domain
                                FROM projects
                                WHERE projects.id = keyword_build_runs.project_id
                            )
                        ) IS NULL THEN 'not_requested'
                        WHEN gap_status = 'not_requested' THEN 'pending'
                        ELSE gap_status
                    END,
                    updated_at = now()
                WHERE id = $1
                    AND status IN ('queued', 'running', 'waiting')
                """,
                run_id,
            )

    async def set_stage(
        self,
        run_id: str,
        stage: str,
        message: str,
        progress: int,
        *,
        discovered_count: int | None = None,
        selected_count: int | None = None,
    ) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET status = 'running',
                    stage = CASE WHEN progress <= $4 THEN $2 ELSE stage END,
                    message = CASE WHEN progress <= $4 THEN $3 ELSE message END,
                    progress = GREATEST(progress, $4),
                    discovered_count = COALESCE($5, discovered_count),
                    selected_count = COALESCE($6, selected_count),
                    updated_at = now()
                WHERE id = $1
                    AND status IN ('queued', 'running', 'waiting')
                """,
                run_id,
                stage,
                message,
                min(max(progress, 0), 100),
                discovered_count,
                selected_count,
            )

    async def defer_run(
        self,
        context: KeywordRunContext,
        *,
        code: str,
        detail: str,
        retry_at: datetime,
    ) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET status = 'waiting',
                    stage = 'waiting_for_recovery',
                    message = '部分服务暂时不可用，系统将在后台自动继续',
                    recovery_count = recovery_count + 1,
                    next_retry_at = $2,
                    error_code = $3,
                    error_detail = $4,
                    finished_at = NULL,
                    updated_at = now()
                WHERE id = $1
                    AND status IN ('queued', 'running', 'waiting')
                """,
                context.run_id,
                retry_at,
                code[:120],
                detail[:2000],
            )

    async def block_run(
        self,
        context: KeywordRunContext,
        *,
        code: str,
        detail: str,
        stage: str,
        message: str,
        retry_at: datetime | None,
    ) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET status = 'blocked',
                    stage = $2,
                    message = $3,
                    next_retry_at = $4,
                    error_code = $5,
                    error_detail = $6,
                    finished_at = now(),
                    updated_at = now()
                WHERE id = $1
                    AND status IN ('queued', 'running', 'waiting', 'blocked')
                """,
                context.run_id,
                stage[:120],
                message[:500],
                retry_at,
                code[:120],
                detail[:2000],
            )

    async def complete_empty_run(
        self,
        context: KeywordRunContext,
        *,
        message: str,
    ) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    UPDATE keyword_seeds
                    SET expansion_status = 'not_applicable',
                        expansion_run_id = NULL,
                        expansion_round_number = NULL,
                        expanded_at = NULL,
                        updated_at = now()
                    WHERE initial_run_id = $1
                        AND decision = 'selected'
                    """,
                    context.run_id,
                )
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET status = 'completed',
                        stage = 'completed',
                        message = $2,
                        progress = 100,
                        keyword_count = 0,
                        pending_seed_count = $3,
                        gap_status = CASE
                            WHEN gap_status IN ('pending', 'running')
                                THEN 'skipped_no_data'
                            ELSE gap_status
                        END,
                        gap_message = CASE
                            WHEN gap_status IN ('pending', 'running')
                                THEN '主关键词流程没有可用数据'
                            ELSE gap_message
                        END,
                        error_code = NULL,
                        error_detail = NULL,
                        next_retry_at = NULL,
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = $1
                        AND status IN ('queued', 'running', 'waiting')
                    """,
                    context.run_id,
                    message[:500],
                    0,
                )

    async def poll_profile(self, context: KeywordRunContext) -> ProfilePollResult:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    profile.profile_json,
                    profile.user_overrides,
                    profile.source_run_id,
                    project.understanding_run_id,
                    crawl.status,
                    crawl.message
                FROM projects AS project
                LEFT JOIN site_profiles AS profile
                    ON profile.project_id = project.id
                LEFT JOIN crawl_runs AS crawl
                    ON crawl.run_id = project.understanding_run_id
                WHERE project.id = $1
                    AND project.organization_id = $2
                """,
                context.project_id,
                context.organization_id,
            )
            page_rows = (
                await connection.fetch(
                    """
                    SELECT
                        snapshot.final_url AS url,
                        snapshot.title,
                        snapshot.description,
                        snapshot.h1
                    FROM page_snapshots AS snapshot
                    JOIN pages AS page ON page.id = snapshot.page_id
                    WHERE snapshot.run_id = $1
                        AND page.organization_id = $2
                        AND page.project_id = $3
                    ORDER BY snapshot.depth, snapshot.fetched_at, snapshot.page_id
                    LIMIT 10
                    """,
                    row["understanding_run_id"],
                    context.organization_id,
                    context.project_id,
                )
                if row is not None and row["understanding_run_id"]
                else []
            )
        if row is None:
            raise RuntimeError("项目不存在")
        page_hints = [
            {
                "url": page["url"],
                "title": page["title"] or "",
                "description": page["description"] or "",
                "h1": list(page["h1"] or []),
            }
            for page in page_rows
        ]
        profile = dict(row["profile_json"] or {})
        profile.update(dict(row["user_overrides"] or {}))
        if profile_is_usable(profile):
            return ProfilePollResult(
                profile=profile,
                terminal=True,
                status=row["status"],
                message="网站业务资料已准备完成",
                source="site_profile",
                version=str(row["source_run_id"] or row["understanding_run_id"] or ""),
                page_hints=page_hints,
            )
        status = str(row["status"] or "")
        terminal = status in {"completed", "partial", "failed", "cancelled", "stopped"}
        message = str(row["message"] or "")
        return ProfilePollResult(
            profile=None,
            terminal=terminal,
            status=status or None,
            message=message,
            source="",
            version=str(row["understanding_run_id"] or ""),
            page_hints=page_hints,
        )

    async def save_profile_snapshot(
        self,
        context: KeywordRunContext,
        profile: dict[str, Any],
        *,
        source: str,
        version: str,
    ) -> dict[str, Any]:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                existing = await connection.fetchval(
                    """
                    SELECT profile_snapshot
                    FROM keyword_build_runs
                    WHERE id = $1
                    FOR UPDATE
                    """,
                    context.run_id,
                )
                if isinstance(existing, dict) and existing:
                    return dict(existing)
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET profile_snapshot = $2,
                        profile_source = $3,
                        profile_version = $4,
                        updated_at = now()
                    WHERE id = $1
                    """,
                    context.run_id,
                    profile,
                    source,
                    version,
                )
        return profile

    async def begin_external_request(
        self,
        *,
        context: KeywordRunContext,
        request_key: str,
        provider: str,
        endpoint: str,
        request_hash: str,
    ) -> ExternalRequestRecord:
        now = datetime.now(UTC)
        claim_token = str(uuid4())
        lease_expires_at = now + timedelta(
            seconds=max(self.settings.keyword_external_prepare_lease_seconds, 30)
        )
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                cache_lock_key = "|".join(
                    (
                        context.organization_id,
                        provider,
                        endpoint,
                        request_hash,
                    )
                )
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                    cache_lock_key,
                )
                row = await connection.fetchrow(
                    """
                    SELECT
                        request_key,
                        status,
                        build_run_id,
                        request_hash,
                        result_count,
                        response_metadata,
                        expires_at,
                        claim_token,
                        lease_expires_at,
                        submitted_at,
                        attempt_count,
                        error_code,
                        error_detail
                    FROM keyword_external_requests
                    WHERE request_key = $1
                    FOR UPDATE
                    """,
                    request_key,
                )
                if row is not None and str(row["request_hash"]) != request_hash:
                    raise RuntimeError("外部请求键对应的请求内容发生变化")

                if row is None:
                    cached = await connection.fetchrow(
                        """
                        SELECT
                            request_key,
                            status,
                            build_run_id,
                            request_hash,
                            result_count,
                            response_metadata,
                            expires_at,
                            claim_token,
                            lease_expires_at,
                            submitted_at,
                            attempt_count,
                            error_code,
                            error_detail
                        FROM keyword_external_requests
                        WHERE organization_id = $1
                            AND provider = $2
                            AND endpoint = $3
                            AND request_hash = $4
                            AND status = 'completed'
                            AND (
                                expires_at IS NULL
                                OR expires_at > $5
                            )
                        ORDER BY finished_at DESC NULLS LAST, id DESC
                        LIMIT 1
                        """,
                        context.organization_id,
                        provider,
                        endpoint,
                        request_hash,
                        now,
                    )
                    if cached is not None:
                        return external_request_record(cached, claimed=False)

                    unresolved = await connection.fetchrow(
                        """
                        SELECT
                            request_key,
                            status,
                            build_run_id,
                            request_hash,
                            result_count,
                            response_metadata,
                            expires_at,
                            claim_token,
                            lease_expires_at,
                            submitted_at,
                            attempt_count,
                            error_code,
                            error_detail
                        FROM keyword_external_requests
                        WHERE organization_id = $1
                            AND provider = $2
                            AND endpoint = $3
                            AND request_hash = $4
                            AND status = 'uncertain'
                        ORDER BY finished_at DESC NULLS LAST, id DESC
                        LIMIT 1
                        """,
                        context.organization_id,
                        provider,
                        endpoint,
                        request_hash,
                    )
                    if unresolved is not None:
                        return external_request_record(unresolved, claimed=False)

                    in_flight = await connection.fetchrow(
                        """
                        SELECT
                            request_key,
                            status,
                            build_run_id,
                            request_hash,
                            result_count,
                            response_metadata,
                            expires_at,
                            claim_token,
                            lease_expires_at,
                            submitted_at,
                            attempt_count,
                            error_code,
                            error_detail
                        FROM keyword_external_requests
                        WHERE organization_id = $1
                            AND provider = $2
                            AND endpoint = $3
                            AND request_hash = $4
                            AND status IN ('prepared', 'submitted')
                        ORDER BY started_at, id
                        LIMIT 1
                        """,
                        context.organization_id,
                        provider,
                        endpoint,
                        request_hash,
                    )
                    if in_flight is not None:
                        if (
                            in_flight["status"] == "submitted"
                            and in_flight["lease_expires_at"] is not None
                            and in_flight["lease_expires_at"] <= now
                        ):
                            in_flight = await connection.fetchrow(
                                """
                                UPDATE keyword_external_requests
                                SET status = 'uncertain',
                                    error_code = 'external_request_outcome_unknown',
                                    error_detail =
                                        '外部请求提交后未能确认最终结果',
                                    finished_at = now(),
                                    lease_expires_at = NULL
                                WHERE request_key = $1
                                RETURNING
                                    request_key,
                                    status,
                                    build_run_id,
                                    request_hash,
                                    result_count,
                                    response_metadata,
                                    expires_at,
                                    claim_token,
                                    lease_expires_at,
                                    submitted_at,
                                    attempt_count,
                                    error_code,
                                    error_detail
                                """,
                                in_flight["request_key"],
                            )
                            if in_flight is None:
                                raise RuntimeError("无法更新外部请求记录")
                            return external_request_record(in_flight, claimed=False)
                        if in_flight["status"] == "prepared" and (
                            in_flight["lease_expires_at"] is None
                            or in_flight["lease_expires_at"] <= now
                        ):
                            in_flight = await connection.fetchrow(
                                """
                                UPDATE keyword_external_requests
                                SET build_run_id = $2,
                                    request_hash = $3,
                                    status = 'prepared',
                                    attempt_count = attempt_count + 1,
                                    result_count = 0,
                                    response_metadata = '{}'::jsonb,
                                    error_code = NULL,
                                    error_detail = NULL,
                                    expires_at = NULL,
                                    claim_token = $4,
                                    lease_expires_at = $5,
                                    submitted_at = NULL,
                                    started_at = now(),
                                    finished_at = NULL
                                WHERE request_key = $1
                                RETURNING
                                    request_key,
                                    status,
                                    build_run_id,
                                    request_hash,
                                    result_count,
                                    response_metadata,
                                    expires_at,
                                    claim_token,
                                    lease_expires_at,
                                    submitted_at,
                                    attempt_count,
                                    error_code,
                                    error_detail
                                """,
                                in_flight["request_key"],
                                context.run_id,
                                request_hash,
                                claim_token,
                                lease_expires_at,
                            )
                            if in_flight is None:
                                raise RuntimeError("无法接管外部请求记录")
                            return external_request_record(in_flight, claimed=True)
                        return external_request_record(in_flight, claimed=False)

                    row = await connection.fetchrow(
                        """
                        INSERT INTO keyword_external_requests (
                            organization_id,
                            project_id,
                            build_run_id,
                            request_key,
                            provider,
                            endpoint,
                            request_hash,
                            status,
                            claim_token,
                            lease_expires_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, 'prepared', $8, $9)
                        RETURNING
                            request_key,
                            status,
                            build_run_id,
                            request_hash,
                            result_count,
                            response_metadata,
                            expires_at,
                            claim_token,
                            lease_expires_at,
                            submitted_at,
                            attempt_count,
                            error_code,
                            error_detail
                        """,
                        context.organization_id,
                        context.project_id,
                        context.run_id,
                        request_key,
                        provider,
                        endpoint,
                        request_hash,
                        claim_token,
                        lease_expires_at,
                    )
                    if row is None:
                        raise RuntimeError("无法创建外部请求记录")
                    return external_request_record(row, claimed=True)

                claimed = False
                if row is None:
                    raise RuntimeError("无法创建外部请求记录")
                if (
                    row["status"] == "submitted"
                    and row["lease_expires_at"] is not None
                    and row["lease_expires_at"] <= now
                ):
                    row = await connection.fetchrow(
                        """
                        UPDATE keyword_external_requests
                        SET status = 'uncertain',
                            error_code = 'external_request_outcome_unknown',
                            error_detail = '外部请求提交后未能确认最终结果',
                            finished_at = now(),
                            lease_expires_at = NULL
                        WHERE request_key = $1
                        RETURNING
                            request_key,
                            status,
                            build_run_id,
                            request_hash,
                            result_count,
                            response_metadata,
                            expires_at,
                            claim_token,
                            lease_expires_at,
                            submitted_at,
                            attempt_count,
                            error_code,
                            error_detail
                        """,
                        request_key,
                    )
                reclaim_prepared = (
                    row is not None
                    and row["status"] == "prepared"
                    and (row["lease_expires_at"] is None or row["lease_expires_at"] <= now)
                )
                if row is not None and (row["status"] == "retryable_failed" or reclaim_prepared):
                    row = await connection.fetchrow(
                        """
                        UPDATE keyword_external_requests
                        SET build_run_id = $2,
                            request_hash = $3,
                            status = 'prepared',
                            attempt_count = attempt_count + 1,
                            result_count = 0,
                            response_metadata = '{}'::jsonb,
                            error_code = NULL,
                            error_detail = NULL,
                            expires_at = NULL,
                            claim_token = $4,
                            lease_expires_at = $5,
                            submitted_at = NULL,
                            started_at = now(),
                            finished_at = NULL
                        WHERE request_key = $1
                        RETURNING
                            request_key,
                            status,
                            build_run_id,
                            request_hash,
                            result_count,
                            response_metadata,
                            expires_at,
                            claim_token,
                            lease_expires_at,
                            submitted_at,
                            attempt_count,
                            error_code,
                            error_detail
                        """,
                        request_key,
                        context.run_id,
                        request_hash,
                        claim_token,
                        lease_expires_at,
                    )
                    claimed = True
                if row is None:
                    raise RuntimeError("无法更新外部请求记录")
                return external_request_record(row, claimed=claimed)

    async def mark_external_request_submitted(
        self,
        request_key: str,
        *,
        claim_token: str,
    ) -> bool:
        lease_expires_at = datetime.now(UTC) + timedelta(
            seconds=max(self.settings.keyword_external_submitted_lease_seconds, 60)
        )
        async with self.pool.acquire() as connection:
            submitted = await connection.fetchval(
                """
                UPDATE keyword_external_requests
                SET status = 'submitted',
                    submitted_at = now(),
                    lease_expires_at = $3
                WHERE request_key = $1
                    AND status = 'prepared'
                    AND claim_token = $2
                RETURNING true
                """,
                request_key,
                claim_token,
                lease_expires_at,
            )
        return bool(submitted)

    async def complete_external_request(
        self,
        request_key: str,
        *,
        claim_token: str,
        result_count: int,
        metadata: dict[str, Any] | None = None,
        cost_usd: float = 0.0,
        expires_at: datetime | None = None,
    ) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                completed = await self._complete_external_request(
                    connection,
                    request_key=request_key,
                    claim_token=claim_token,
                    result_count=result_count,
                    metadata=metadata,
                    cost_usd=cost_usd,
                    expires_at=expires_at,
                )
                if not completed:
                    raise ExternalRequestClaimLostError("外部请求执行权已失效，拒绝保存过期结果")

    async def _complete_external_request(
        self,
        connection: asyncpg.Connection,
        *,
        request_key: str,
        claim_token: str,
        result_count: int,
        metadata: dict[str, Any] | None,
        cost_usd: float,
        expires_at: datetime | None,
    ) -> bool:
        row = await connection.fetchrow(
            """
            SELECT build_run_id, status, cost_usd, claim_token
            FROM keyword_external_requests
            WHERE request_key = $1
            FOR UPDATE
            """,
            request_key,
        )
        if row is None:
            return False
        if row["status"] == "completed":
            return True
        if row["status"] != "submitted" or row["claim_token"] != claim_token:
            return False
        previous_cost = Decimal(str(row["cost_usd"] or 0))
        next_cost = max(previous_cost, Decimal(str(max(cost_usd, 0.0))))
        await connection.execute(
            """
            UPDATE keyword_external_requests
            SET status = 'completed',
                result_count = $2,
                response_metadata = $3,
                cost_usd = $4,
                error_code = NULL,
                error_detail = NULL,
                expires_at = $5,
                lease_expires_at = NULL,
                finished_at = now()
            WHERE request_key = $1
            """,
            request_key,
            result_count,
            metadata or {},
            next_cost,
            expires_at,
        )
        cost_delta = next_cost - previous_cost
        if cost_delta > 0:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET total_cost_usd = total_cost_usd + $2,
                    updated_at = now()
                WHERE id = $1
                """,
                row["build_run_id"],
                cost_delta,
            )
        return True

    async def fail_external_request(
        self,
        request_key: str,
        *,
        claim_token: str,
        code: str,
        detail: str,
        failure_status: str = "retryable_failed",
        metadata: dict[str, Any] | None = None,
        cost_usd: float = 0.0,
    ) -> bool:
        if failure_status not in {
            "retryable_failed",
            "charged_failed",
            "uncertain",
        }:
            raise ValueError("外部请求失败状态无效")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    SELECT
                        build_run_id,
                        status,
                        cost_usd,
                        response_metadata,
                        claim_token
                    FROM keyword_external_requests
                    WHERE request_key = $1
                    FOR UPDATE
                    """,
                    request_key,
                )
                if (
                    row is None
                    or row["status"] not in {"prepared", "submitted"}
                    or row["claim_token"] != claim_token
                ):
                    return False
                previous_cost = Decimal(str(row["cost_usd"] or 0))
                next_cost = max(previous_cost, Decimal(str(max(cost_usd, 0.0))))
                response_metadata = dict(row["response_metadata"] or {})
                response_metadata.update(metadata or {})
                await connection.execute(
                    """
                    UPDATE keyword_external_requests
                    SET status = $2,
                        response_metadata = $3,
                        cost_usd = $4,
                        error_code = $5,
                        error_detail = $6,
                        lease_expires_at = NULL,
                        finished_at = now()
                    WHERE request_key = $1
                    """,
                    request_key,
                    failure_status,
                    response_metadata,
                    next_cost,
                    code[:120],
                    detail[:2000],
                )
                cost_delta = next_cost - previous_cost
                if cost_delta > 0:
                    await connection.execute(
                        """
                        UPDATE keyword_build_runs
                        SET total_cost_usd = total_cost_usd + $2,
                            updated_at = now()
                        WHERE id = $1
                        """,
                        row["build_run_id"],
                        cost_delta,
                    )
                return True

    async def save_ideas(
        self,
        context: KeywordRunContext,
        rows: Iterable[RawKeyword],
    ) -> int:
        values = keyword_idea_values(context, rows)
        if not values:
            return 0
        async with self.pool.acquire() as connection:
            await connection.executemany(KEYWORD_IDEA_UPSERT_SQL, values)
        return len(values)

    async def save_ideas_and_complete_external_request(
        self,
        context: KeywordRunContext,
        rows: Iterable[RawKeyword],
        *,
        request_key: str,
        claim_token: str,
        metadata: dict[str, Any],
        cost_usd: float,
        expires_at: datetime | None,
    ) -> int:
        values = keyword_idea_values(context, rows)
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                completed = await self._complete_external_request(
                    connection,
                    request_key=request_key,
                    claim_token=claim_token,
                    result_count=len(values),
                    metadata=metadata,
                    cost_usd=cost_usd,
                    expires_at=expires_at,
                )
                if not completed:
                    raise ExternalRequestClaimLostError("外部请求执行权已失效，拒绝保存过期结果")
                if values:
                    await connection.executemany(KEYWORD_IDEA_UPSERT_SQL, values)
        return len(values)

    async def load_ideas(
        self,
        run_id: str,
        sources: Iterable[str],
        *,
        included_only: bool = False,
    ) -> list[RawKeyword]:
        source_values = list(sources)
        if not source_values:
            return []
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    idea.keyword,
                    idea.source,
                    idea.provider_rank,
                    idea.source_seed_id,
                    seed.ai_rank AS source_seed_rank,
                    idea.search_volume,
                    idea.cpc,
                    idea.competition,
                    idea.keyword_difficulty,
                    idea.intent,
                    idea.monthly_searches,
                    idea.raw_payload,
                    idea.business_relevance
                FROM keyword_ideas AS idea
                LEFT JOIN keyword_seeds AS seed ON seed.id = idea.source_seed_id
                WHERE idea.build_run_id = $1
                    AND idea.source = ANY($2::text[])
                    AND ($3 = false OR idea.included = true)
                ORDER BY
                    CASE idea.source
                        WHEN 'profile_seed' THEN 0
                        WHEN 'seed' THEN 1
                        WHEN 'google_ads' THEN 2
                        WHEN 'google_suggest' THEN 3
                        WHEN 'ai' THEN 4
                        ELSE 5
                    END,
                    idea.provider_rank,
                    idea.id
                """,
                run_id,
                source_values,
                included_only,
            )
        return [raw_keyword_from_row(row) for row in rows]

    async def request_ideas(
        self,
        build_run_id: str,
        source: str,
        source_seed_id: str | None = None,
    ) -> list[RawKeyword]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    idea.keyword,
                    idea.source,
                    idea.provider_rank,
                    idea.source_seed_id,
                    seed.ai_rank AS source_seed_rank,
                    idea.search_volume,
                    idea.cpc,
                    idea.competition,
                    idea.keyword_difficulty,
                    idea.intent,
                    idea.monthly_searches,
                    idea.raw_payload,
                    idea.business_relevance
                FROM keyword_ideas AS idea
                LEFT JOIN keyword_seeds AS seed ON seed.id = idea.source_seed_id
                WHERE idea.build_run_id = $1
                    AND idea.source = $2
                    AND ($3::text IS NULL OR idea.source_seed_id = $3)
                ORDER BY idea.provider_rank, idea.id
                """,
                build_run_id,
                source,
                source_seed_id,
            )
        return [raw_keyword_from_row(row) for row in rows]

    async def save_seed_decisions(
        self,
        context: KeywordRunContext,
        decisions: list[SeedDecision],
        excluded: dict[str, str],
    ) -> list[dict[str, Any]]:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                for normalized, reason in excluded.items():
                    await connection.execute(
                        """
                        UPDATE keyword_ideas
                        SET exclusion_reason = $3
                        WHERE build_run_id = $1
                            AND source IN (
                                'profile_seed',
                                'labs_site',
                                'google_ads_site',
                                'keyword_ideas_broad'
                            )
                            AND normalized_keyword = $2
                        """,
                        context.run_id,
                        normalized,
                        reason,
                    )
                for decision in decisions:
                    candidate = decision.candidate
                    seed_id = deterministic_id(
                        "keyword-seed",
                        context.run_id,
                        candidate.normalized_keyword,
                    )
                    expansion_status = "not_applicable"
                    expansion_run_id = None
                    expansion_round = None
                    await connection.execute(
                        """
                        INSERT INTO keyword_seeds (
                            id,
                            organization_id,
                            project_id,
                            initial_run_id,
                            keyword,
                            normalized_keyword,
                            candidate_rank,
                            candidate_score,
                            candidate_details,
                            decision,
                            ai_rank,
                            business_topic,
                            reason_code,
                            reason,
                            expansion_status,
                            expansion_run_id,
                            expansion_round_number
                        )
                        VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9,
                            $10, $11, $12, $13, $14, $15, $16, $17
                        )
                        ON CONFLICT (initial_run_id, normalized_keyword) DO UPDATE SET
                            decision = EXCLUDED.decision,
                            candidate_score = EXCLUDED.candidate_score,
                            candidate_details = EXCLUDED.candidate_details,
                            ai_rank = EXCLUDED.ai_rank,
                            business_topic = EXCLUDED.business_topic,
                            reason_code = EXCLUDED.reason_code,
                            reason = EXCLUDED.reason,
                            expansion_status = 'not_applicable',
                            expansion_run_id = NULL,
                            expansion_round_number = NULL,
                            expanded_at = NULL,
                            updated_at = now()
                        """,
                        seed_id,
                        context.organization_id,
                        context.project_id,
                        context.run_id,
                        candidate.keyword,
                        candidate.normalized_keyword,
                        candidate.rank,
                        decision.business_relevance,
                        {
                            **candidate.selection_details,
                            "relevance_tier": decision.relevance_tier,
                            "relevance_method": "positive_business_admission",
                        },
                        "selected" if decision.selected else "rejected",
                        decision.ai_rank,
                        decision.business_topic,
                        decision.reason_code,
                        decision.reason,
                        expansion_status,
                        expansion_run_id,
                        expansion_round,
                    )
                    if not decision.selected:
                        await connection.execute(
                            """
                            UPDATE keyword_ideas
                            SET exclusion_reason = $3
                            WHERE build_run_id = $1
                                AND source IN (
                                    'profile_seed',
                                    'labs_site',
                                    'google_ads_site',
                                    'keyword_ideas_broad'
                                )
                                AND normalized_keyword = $2
                            """,
                            context.run_id,
                            candidate.normalized_keyword,
                            f"seed_ai_rejected:{decision.reason_code or 'rejected'}",
                        )
                selected_count = await connection.fetchval(
                    """
                    SELECT count(*)
                    FROM keyword_seeds
                    WHERE initial_run_id = $1
                        AND decision = 'selected'
                    """,
                    context.run_id,
                )
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET selected_count = $2,
                        pending_seed_count = $3,
                        updated_at = now()
                    WHERE id = $1
                    """,
                    context.run_id,
                    int(selected_count or 0),
                    0,
                )
        return await self.load_selected_topics(context.run_id)

    async def seeds_exist(self, initial_run_id: str) -> bool:
        async with self.pool.acquire() as connection:
            value = await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM keyword_seeds WHERE initial_run_id = $1)",
                initial_run_id,
            )
        return bool(value)

    async def load_active_seeds(self, run_id: str) -> list[dict[str, Any]]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    id,
                    keyword,
                    normalized_keyword,
                    ai_rank,
                    business_topic,
                    candidate_score
                FROM keyword_seeds
                WHERE expansion_run_id = $1
                    AND expansion_status = 'processing'
                ORDER BY ai_rank, id
                """,
                run_id,
            )
        return [dict(row) for row in rows]

    async def load_selected_topics(self, run_id: str) -> list[dict[str, Any]]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    id,
                    keyword,
                    normalized_keyword,
                    ai_rank,
                    business_topic,
                    candidate_score
                FROM keyword_seeds
                WHERE initial_run_id = $1
                    AND decision = 'selected'
                ORDER BY ai_rank, id
                """,
                run_id,
            )
        return [dict(row) for row in rows]

    async def save_seed_ideas(
        self,
        context: KeywordRunContext,
        seeds: list[dict[str, Any]],
    ) -> None:
        rows = [
            RawKeyword(
                keyword=str(seed["keyword"]),
                source="seed",
                provider_rank=index,
                source_seed_id=str(seed["id"]),
                source_seed_rank=int(seed.get("ai_rank") or 10**9),
                ai_relevance=1.0,
                raw_payload={"ai_rank": seed.get("ai_rank")},
            )
            for index, seed in enumerate(seeds, start=1)
        ]
        await self.save_ideas(context, rows)

    async def mark_candidate_selection(
        self,
        run_id: str,
        selected: list[MergedCandidate],
        rejected: list[MergedCandidate],
    ) -> None:
        values: list[tuple[str, str, bool, str | None, float]] = []
        for candidate in selected:
            values.append(
                (
                    run_id,
                    candidate.normalized_keyword,
                    True,
                    None,
                    candidate.relevance,
                )
            )
        for candidate in rejected:
            values.append(
                (
                    run_id,
                    candidate.normalized_keyword,
                    False,
                    candidate.exclusion_reason or "filtered",
                    candidate.relevance,
                )
            )
        if not values:
            return
        async with self.pool.acquire() as connection:
            await connection.executemany(
                """
                UPDATE keyword_ideas
                SET included = $3,
                    exclusion_reason = $4,
                    business_relevance = $5
                WHERE build_run_id = $1
                    AND normalized_keyword = $2
                """,
                values,
            )

    async def load_ai_config(self, organization_id: str) -> AIProviderConfig:
        row = None
        encryption_key = self.settings.ai_settings_encryption_key.strip()
        if encryption_key:
            async with self.pool.acquire() as connection:
                row = await connection.fetchrow(
                    """
                    SELECT
                        base_url,
                        pgp_sym_decrypt(api_key_encrypted, $2)::text AS api_key,
                        model,
                        request_timeout_seconds,
                        max_retries
                    FROM ai_provider_settings
                    WHERE organization_id = $1
                    """,
                    organization_id,
                    encryption_key,
                )
        if row is not None:
            return AIProviderConfig(
                base_url=str(row["base_url"]).rstrip("/"),
                api_key=str(row["api_key"]),
                model=str(row["model"]),
                timeout_seconds=int(row["request_timeout_seconds"]),
                max_retries=int(row["max_retries"]),
                initial_filter_model=self.settings.keyword_initial_filter_ai_model,
                topic_dedup_model=self.settings.keyword_topic_dedup_ai_model,
            )
        return AIProviderConfig(
            base_url=self.settings.business_profile_ai_base_url.rstrip("/"),
            api_key=self.settings.business_profile_ai_api_key,
            model=self.settings.business_profile_ai_model,
            timeout_seconds=parse_duration_seconds(
                self.settings.business_profile_ai_timeout,
                default=90,
            ),
            max_retries=max(self.settings.business_profile_ai_max_retries, 0),
            initial_filter_model=self.settings.keyword_initial_filter_ai_model,
            topic_dedup_model=self.settings.keyword_topic_dedup_ai_model,
        )

    async def load_dataforseo_config(
        self,
        organization_id: str,
    ) -> DataForSEOProviderConfig:
        row = None
        encryption_key = self.settings.ai_settings_encryption_key.strip()
        if encryption_key:
            async with self.pool.acquire() as connection:
                row = await connection.fetchrow(
                    """
                    SELECT
                        login,
                        pgp_sym_decrypt(
                            password_encrypted,
                            $2
                        )::text AS password
                    FROM dataforseo_provider_settings
                    WHERE organization_id = $1
                    """,
                    organization_id,
                    encryption_key,
                )
        if row is not None:
            return DataForSEOProviderConfig(
                login=str(row["login"]),
                password=str(row["password"]),
            )
        return DataForSEOProviderConfig(
            login=self.settings.dataforseo_login,
            password=self.settings.dataforseo_password,
        )

    async def set_gap_status(
        self,
        context: KeywordRunContext,
        *,
        status: str,
        message: str,
        count: int | None = None,
    ) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET gap_status = $2,
                    gap_message = $3,
                    gap_count = COALESCE($4, gap_count),
                    updated_at = now()
                WHERE id = $1
                """,
                context.run_id,
                status,
                message[:500],
                count,
            )

    async def save_gap_candidates(
        self,
        context: KeywordRunContext,
        rows: list[CompetitorGap],
    ) -> int:
        values = keyword_gap_values(context, rows)
        if not values:
            return 0
        async with self.pool.acquire() as connection:
            await connection.executemany(KEYWORD_GAP_UPSERT_SQL, values)
        return len(values)

    async def save_gap_candidates_and_complete_external_request(
        self,
        context: KeywordRunContext,
        rows: list[CompetitorGap],
        *,
        request_key: str,
        claim_token: str,
        metadata: dict[str, Any],
        cost_usd: float,
        expires_at: datetime | None,
    ) -> int:
        values = keyword_gap_values(context, rows)
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                completed = await self._complete_external_request(
                    connection,
                    request_key=request_key,
                    claim_token=claim_token,
                    result_count=len(values),
                    metadata=metadata,
                    cost_usd=cost_usd,
                    expires_at=expires_at,
                )
                if not completed:
                    raise ExternalRequestClaimLostError("外部请求执行权已失效，拒绝保存过期结果")
                if values:
                    await connection.executemany(KEYWORD_GAP_UPSERT_SQL, values)
        return len(values)

    async def load_gap_candidates(self, run_id: str) -> list[CompetitorGap]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    keyword,
                    competitor_rank,
                    search_volume,
                    cpc,
                    competition,
                    keyword_difficulty,
                    intent,
                    monthly_searches,
                    raw_payload
                FROM keyword_competitor_gaps
                WHERE build_run_id = $1
                ORDER BY
                    competitor_rank NULLS LAST,
                    search_volume DESC NULLS LAST,
                    normalized_keyword
                """,
                run_id,
            )
        return [
            CompetitorGap(
                keyword=row["keyword"],
                provider_rank=index,
                competitor_rank=row["competitor_rank"],
                search_volume=row["search_volume"],
                cpc=row["cpc"],
                competition=row["competition"],
                keyword_difficulty=row["keyword_difficulty"],
                intent=row["intent"],
                monthly_searches=list(row["monthly_searches"] or []),
                raw_payload=dict(row["raw_payload"] or {}),
            )
            for index, row in enumerate(rows, start=1)
        ]

    async def load_confirmed_gap_keywords(self, run_id: str) -> list[RawKeyword]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    keyword,
                    competitor_rank,
                    search_volume,
                    cpc,
                    competition,
                    keyword_difficulty,
                    intent,
                    monthly_searches,
                    raw_payload,
                    relevance
                FROM keyword_competitor_gaps
                WHERE build_run_id = $1
                    AND status IN ('active', 'needs_review')
                ORDER BY
                    search_volume DESC NULLS LAST,
                    competitor_rank ASC NULLS LAST,
                    normalized_keyword
                """,
                run_id,
            )
        return [
            RawKeyword(
                keyword=str(row["keyword"]),
                source="competitor_gap",
                provider_rank=int(row["competitor_rank"] or index),
                search_volume=row["search_volume"],
                cpc=float(row["cpc"]) if row["cpc"] is not None else None,
                competition=(float(row["competition"]) if row["competition"] is not None else None),
                keyword_difficulty=row["keyword_difficulty"],
                intent=row["intent"],
                monthly_searches=list(row["monthly_searches"] or []),
                raw_payload=dict(row["raw_payload"] or {}),
                ai_relevance=(float(row["relevance"]) if row["relevance"] is not None else None),
            )
            for index, row in enumerate(rows, start=1)
        ]

    async def finalize_gap_candidates(
        self,
        context: KeywordRunContext,
        *,
        accepted: dict[str, tuple[float, str]],
        status: str,
        message: str,
    ) -> int:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                if accepted:
                    await connection.execute(
                        """
                        DELETE FROM keyword_competitor_gaps
                        WHERE build_run_id = $1
                            AND normalized_keyword <> ALL($2::text[])
                        """,
                        context.run_id,
                        list(accepted),
                    )
                    await connection.executemany(
                        """
                        UPDATE keyword_competitor_gaps
                        SET relevance = $3,
                            status = $4
                        WHERE build_run_id = $1
                            AND normalized_keyword = $2
                        """,
                        [
                            (
                                context.run_id,
                                normalized,
                                relevance,
                                review_status,
                            )
                            for normalized, (relevance, review_status) in accepted.items()
                        ],
                    )
                else:
                    await connection.execute(
                        "DELETE FROM keyword_competitor_gaps WHERE build_run_id = $1",
                        context.run_id,
                    )
                count = int(
                    await connection.fetchval(
                        """
                        SELECT count(*)
                        FROM keyword_competitor_gaps
                        WHERE build_run_id = $1
                            AND status IN ('active', 'needs_review')
                        """,
                        context.run_id,
                    )
                    or 0
                )
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET gap_status = $2,
                        gap_message = $3,
                        gap_count = $4,
                        status = CASE
                            WHEN status = 'partial'
                                AND jsonb_array_length(partial_failures) = 0
                                AND $2 NOT IN ('failed', 'pending', 'running')
                            THEN 'completed'
                            ELSE status
                        END,
                        stage = CASE
                            WHEN status = 'partial'
                                AND jsonb_array_length(partial_failures) = 0
                                AND $2 NOT IN ('failed', 'pending', 'running')
                            THEN 'completed'
                            ELSE stage
                        END,
                        message = CASE
                            WHEN status = 'partial'
                                AND jsonb_array_length(partial_failures) = 0
                                AND $2 NOT IN ('failed', 'pending', 'running')
                            THEN '关键词库已建立'
                            ELSE message
                        END,
                        finished_at = CASE
                            WHEN status = 'partial'
                                AND jsonb_array_length(partial_failures) = 0
                                AND $2 NOT IN ('failed', 'pending', 'running')
                            THEN now()
                            ELSE finished_at
                        END,
                        updated_at = now()
                    WHERE id = $1
                    """,
                    context.run_id,
                    status,
                    message[:500],
                    count,
                )
        return count

    async def load_cached_metrics(
        self,
        context: KeywordRunContext,
        normalized_keywords: list[str],
    ) -> dict[str, dict[str, Any]]:
        if not normalized_keywords:
            return {}
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    keyword.normalized_keyword,
                    metric.search_volume,
                    metric.cpc,
                    metric.competition,
                    metric.competition_level,
                    metric.keyword_difficulty,
                    metric.intent,
                    metric.monthly_searches,
                    metric.raw_payload,
                    metric.fetched_at
                FROM keywords AS keyword
                JOIN keyword_metrics AS metric
                    ON metric.keyword_id = keyword.id
                    AND metric.provider = 'dataforseo'
                WHERE keyword.project_id = $1
                    AND keyword.country = $2
                    AND keyword.language = $3
                    AND keyword.normalized_keyword = ANY($4::text[])
                    AND metric.fetched_at >=
                        now() - ($5::int * interval '1 day')
                """,
                context.project_id,
                context.country,
                context.language,
                normalized_keywords,
                self.settings.keyword_metrics_cache_days,
            )
        return {
            row["normalized_keyword"]: {
                "search_volume": row["search_volume"],
                "cpc": row["cpc"],
                "competition": row["competition"],
                "competition_level": row["competition_level"],
                "keyword_difficulty": row["keyword_difficulty"],
                "intent": row["intent"],
                "monthly_searches": list(row["monthly_searches"] or []),
                "raw_payload": dict(row["raw_payload"] or {}),
                "_status": "cached",
                "_fetched_at": row["fetched_at"].isoformat(),
            }
            for row in rows
        }

    async def load_pending_metric_keywords(self, run_id: str) -> list[str]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT keyword
                FROM keywords
                WHERE last_build_run_id = $1
                    AND metrics_status = 'pending'
                ORDER BY priority_score DESC NULLS LAST, keyword
                LIMIT 1000
                """,
                run_id,
            )
        return [str(row["keyword"]) for row in rows]

    async def _refresh_priority_scores(
        self,
        connection: asyncpg.Connection,
        context: KeywordRunContext,
    ) -> int:
        rows = await connection.fetch(
            """
            SELECT
                keyword.id,
                keyword.keyword,
                keyword.normalized_keyword,
                keyword.classification_confidence,
                metric.search_volume,
                metric.keyword_difficulty,
                metric.intent
            FROM keywords AS keyword
            LEFT JOIN keyword_metrics AS metric
                ON metric.keyword_id = keyword.id
                AND metric.provider = 'dataforseo'
            WHERE keyword.organization_id = $1
                AND keyword.project_id = $2
                AND keyword.country = $3
                AND keyword.language = $4
                AND keyword.status = 'active'
            ORDER BY keyword.id
            """,
            context.organization_id,
            context.project_id,
            context.country,
            context.language,
        )
        metrics_by_keyword = {
            str(row["normalized_keyword"]): {
                "search_volume": row["search_volume"],
                "keyword_difficulty": row["keyword_difficulty"],
                "intent": row["intent"],
            }
            for row in rows
        }
        percentiles = volume_percentiles(metrics_by_keyword)
        updates = []
        for row in rows:
            normalized = str(row["normalized_keyword"])
            metric = metrics_by_keyword[normalized]
            candidate = MergedCandidate(
                keyword=str(row["keyword"]),
                normalized_keyword=normalized,
                rows=[
                    RawKeyword(
                        keyword=str(row["keyword"]),
                        source="keyword_overview",
                        search_volume=row["search_volume"],
                        keyword_difficulty=row["keyword_difficulty"],
                        intent=row["intent"],
                    )
                ],
                relevance=float(row["classification_confidence"] or 0),
                included=True,
            )
            score, confidence, details = priority_score(
                candidate,
                metric,
                context.profile,
                context.language,
                percentiles.get(normalized),
            )
            updates.append(
                (
                    str(row["id"]),
                    score,
                    confidence,
                    details,
                    PRIORITY_RULE_VERSION,
                )
            )
        if updates:
            await connection.executemany(
                """
                UPDATE keywords
                SET priority_score = $2,
                    priority_confidence = $3,
                    priority_details = $4,
                    score_version = $5,
                    updated_at = now()
                WHERE id = $1
                """,
                updates,
            )
        return len(updates)

    async def finish_pending_metrics(
        self,
        context: KeywordRunContext,
        keywords: list[str],
        rows: list[RawKeyword],
        *,
        failed: bool,
    ) -> dict[str, int]:
        normalized_keywords = {
            normalized for keyword in keywords if (normalized := normalize_keyword(keyword))
        }
        rows_by_keyword = {
            normalize_keyword(row.keyword): row
            for row in rows
            if normalize_keyword(row.keyword) in normalized_keywords
        }
        if not normalized_keywords:
            return {"updated": 0, "failed": 0, "no_data": 0}

        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.fetchval(
                    "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
                    context.project_id,
                )
                keyword_rows = await connection.fetch(
                    """
                    SELECT id, normalized_keyword
                    FROM keywords
                    WHERE organization_id = $1
                        AND project_id = $2
                        AND country = $3
                        AND language = $4
                        AND normalized_keyword = ANY($5::text[])
                        AND metrics_status = 'pending'
                    FOR UPDATE
                    """,
                    context.organization_id,
                    context.project_id,
                    context.country,
                    context.language,
                    list(normalized_keywords),
                )
                updated = 0
                failed_count = 0
                no_data = 0
                if failed:
                    keyword_ids = [str(row["id"]) for row in keyword_rows]
                    failed_count = len(keyword_ids)
                    if keyword_ids:
                        await connection.execute(
                            """
                            UPDATE keywords
                            SET metrics_status = 'failed',
                                updated_at = now()
                            WHERE id = ANY($1::text[])
                            """,
                            keyword_ids,
                        )
                else:
                    for keyword_row in keyword_rows:
                        keyword_id = str(keyword_row["id"])
                        row = rows_by_keyword.get(str(keyword_row["normalized_keyword"]))
                        metrics_status = "failed"
                        if row is None:
                            no_data += 1
                            failed_count += 1
                        else:
                            info = row.raw_payload.get("keyword_info")
                            info = info if isinstance(info, dict) else {}
                            await connection.execute(
                                """
                                INSERT INTO keyword_metrics (
                                    keyword_id,
                                    provider,
                                    search_volume,
                                    cpc,
                                    competition,
                                    competition_level,
                                    keyword_difficulty,
                                    intent,
                                    monthly_searches,
                                    raw_payload,
                                    fetched_at
                                )
                                VALUES (
                                    $1, 'dataforseo', $2, $3, $4, $5,
                                    $6, $7, $8, $9, now()
                                )
                                ON CONFLICT (keyword_id, provider) DO UPDATE SET
                                    search_volume = COALESCE(
                                        EXCLUDED.search_volume,
                                        keyword_metrics.search_volume
                                    ),
                                    cpc = COALESCE(EXCLUDED.cpc, keyword_metrics.cpc),
                                    competition = COALESCE(
                                        EXCLUDED.competition,
                                        keyword_metrics.competition
                                    ),
                                    competition_level = COALESCE(
                                        EXCLUDED.competition_level,
                                        keyword_metrics.competition_level
                                    ),
                                    keyword_difficulty = COALESCE(
                                        EXCLUDED.keyword_difficulty,
                                        keyword_metrics.keyword_difficulty
                                    ),
                                    intent = COALESCE(
                                        EXCLUDED.intent,
                                        keyword_metrics.intent
                                    ),
                                    monthly_searches = CASE
                                        WHEN jsonb_array_length(EXCLUDED.monthly_searches) > 0
                                            THEN EXCLUDED.monthly_searches
                                        ELSE keyword_metrics.monthly_searches
                                    END,
                                    raw_payload = (
                                        keyword_metrics.raw_payload || EXCLUDED.raw_payload
                                    ),
                                    fetched_at = EXCLUDED.fetched_at
                                """,
                                keyword_id,
                                row.search_volume,
                                row.cpc,
                                row.competition,
                                info.get("competition_level"),
                                row.keyword_difficulty,
                                row.intent,
                                row.monthly_searches or [],
                                row.raw_payload or {},
                            )
                            if row.keyword_difficulty is not None and row.intent is not None:
                                updated += 1
                                metrics_status = "fresh"
                            else:
                                failed_count += 1
                        await connection.execute(
                            """
                            UPDATE keywords
                            SET metrics_status = $2,
                                updated_at = now()
                            WHERE id = $1
                            """,
                            keyword_id,
                            metrics_status,
                        )

                    if failed_count == 0:
                        await connection.execute(
                            """
                            UPDATE keyword_build_runs
                            SET partial_failures = COALESCE(
                                    (
                                        SELECT jsonb_agg(item)
                                        FROM jsonb_array_elements(partial_failures) AS item
                                        WHERE COALESCE(item->>'source', '') NOT IN (
                                            'keyword_overview',
                                            'keyword_overview_recovery'
                                        )
                                    ),
                                    '[]'::jsonb
                                ),
                                updated_at = now()
                            WHERE id = $1
                            """,
                            context.run_id,
                        )

                    if updated:
                        await self._refresh_priority_scores(connection, context)

                pending_count = int(
                    await connection.fetchval(
                        """
                        SELECT count(*)
                        FROM keywords
                        WHERE organization_id = $1
                            AND project_id = $2
                            AND last_build_run_id = $3
                            AND metrics_status = 'pending'
                        """,
                        context.organization_id,
                        context.project_id,
                        context.run_id,
                    )
                    or 0
                )
                result_version = int(
                    await connection.fetchval(
                        """
                        SELECT COALESCE(max(result_version), 0) + 1
                        FROM keyword_build_runs
                        WHERE organization_id = $1
                            AND project_id = $2
                        """,
                        context.organization_id,
                        context.project_id,
                    )
                    or 1
                )
                run_state = await connection.fetchrow(
                    """
                    SELECT partial_failures, gap_status
                    FROM keyword_build_runs
                    WHERE id = $1
                    """,
                    context.run_id,
                )
                partial_failures = list(run_state["partial_failures"] or [])
                gap_status = str(run_state["gap_status"] or "not_requested")
                final_status = (
                    "partial"
                    if partial_failures or gap_status in {"failed", "pending", "running"}
                    else "completed"
                )
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET status = $2,
                        stage = $2,
                        message = CASE
                            WHEN $2 = 'partial'
                                AND jsonb_array_length(partial_failures) > 0
                                THEN '关键词库已建立，部分步骤使用了备用方案'
                            WHEN $2 = 'partial'
                                THEN '关键词库已建立，竞争对手分析未完成'
                            ELSE '关键词库已建立'
                        END,
                        result_version = $3,
                        updated_at = now(),
                        finished_at = COALESCE(finished_at, now())
                    WHERE id = $1
                    """,
                    context.run_id,
                    final_status,
                    result_version,
                )
        return {
            "updated": updated,
            "failed": failed_count,
            "no_data": no_data,
            "pending_metrics_count": pending_count,
            "result_version": result_version,
        }

    async def save_staged_metrics(
        self,
        run_id: str,
        metrics: dict[str, dict[str, Any]],
    ) -> None:
        values = [
            (run_id, normalized, dict(metric))
            for normalized, metric in metrics.items()
            if normalized
        ]
        if not values:
            return
        async with self.pool.acquire() as connection:
            await connection.executemany(
                """
                UPDATE keyword_ideas
                SET metrics_payload = $3
                WHERE build_run_id = $1
                    AND normalized_keyword = $2
                    AND included = true
                """,
                values,
            )

    async def load_staged_keywords(self, run_id: str) -> list[StagedKeyword]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    idea.keyword,
                    idea.normalized_keyword,
                    idea.source,
                    idea.provider_rank,
                    idea.source_seed_id,
                    seed.ai_rank AS source_seed_rank,
                    idea.search_volume,
                    idea.cpc,
                    idea.competition,
                    idea.keyword_difficulty,
                    idea.intent,
                    idea.monthly_searches,
                    idea.raw_payload,
                    idea.business_relevance,
                    idea.metrics_payload
                FROM keyword_ideas AS idea
                LEFT JOIN keyword_seeds AS seed ON seed.id = idea.source_seed_id
                WHERE idea.build_run_id = $1
                    AND idea.included = true
                ORDER BY idea.id
                """,
                run_id,
            )
        grouped: dict[str, list[RawKeyword]] = {}
        displays: dict[str, str] = {}
        relevance: dict[str, float] = {}
        metric_payloads: dict[str, dict[str, Any]] = {}
        for row in rows:
            normalized = row["normalized_keyword"]
            grouped.setdefault(normalized, []).append(raw_keyword_from_row(row))
            displays.setdefault(normalized, row["keyword"])
            relevance[normalized] = max(
                relevance.get(normalized, 0.0),
                float(row["business_relevance"] or 0.0),
            )
            payload = dict(row["metrics_payload"] or {})
            if payload:
                metric_payloads[normalized] = payload
        result: list[StagedKeyword] = []
        for normalized, raw_rows in grouped.items():
            payload = metric_payloads.get(normalized, {"_status": "pending"})
            state = str(payload.get("_status") or "pending")
            metric = {key: value for key, value in payload.items() if not key.startswith("_")}
            metrics_status = "fresh" if state in {"fresh", "cached"} else state
            result.append(
                StagedKeyword(
                    candidate=MergedCandidate(
                        keyword=displays[normalized],
                        normalized_keyword=normalized,
                        rows=raw_rows,
                        relevance=relevance[normalized],
                        included=True,
                    ),
                    metric=metric or None,
                    metrics_status=metrics_status,
                )
            )
        result.sort(key=lambda item: item.candidate.normalized_keyword)
        return result

    async def load_existing_normalized_keywords(
        self,
        context: KeywordRunContext,
    ) -> set[str]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT normalized_keyword
                FROM keywords
                WHERE organization_id = $1
                    AND project_id = $2
                """,
                context.organization_id,
                context.project_id,
            )
        return {str(row["normalized_keyword"]) for row in rows}

    async def record_partial_failure(
        self,
        run_id: str,
        *,
        source: str,
        code: str,
        message: str,
        details: Any = None,
    ) -> None:
        failure = {
            "source": source,
            "code": code,
            "message": message[:500],
        }
        if details:
            failure["details"] = details
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_build_runs
                SET partial_failures = CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements(partial_failures) AS item
                            WHERE item->>'source' = $3
                                AND item->>'code' = $4
                        ) THEN partial_failures
                        ELSE partial_failures || $2::jsonb
                    END,
                    updated_at = now()
                WHERE id = $1
                """,
                run_id,
                [failure],
                source,
                code,
            )

    async def start_metric_refresh_job(self, task: dict[str, Any]) -> dict[str, Any]:
        run_id = str(task["run_id"])
        workflow_id = str(task.get("_metric_workflow_id") or "")
        if not workflow_id:
            raise RuntimeError("指标恢复任务缺少工作流ID")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    SELECT status, attempt_count, workflow_id
                    FROM keyword_metric_refresh_jobs
                    WHERE run_id = $1
                    FOR UPDATE
                    """,
                    run_id,
                )
                if row is None:
                    raise RuntimeError("指标恢复任务不存在")
                if str(row["workflow_id"]) != workflow_id:
                    raise RuntimeError("指标恢复任务已由新的工作流接管")
                status = str(row["status"])
                attempt_count = int(row["attempt_count"] or 0)
                if status == "running":
                    return {
                        "attempt": attempt_count,
                        "status": status,
                        "started": True,
                    }
                if status in {"completed", "exhausted"}:
                    return {
                        "attempt": attempt_count,
                        "status": status,
                        "started": False,
                    }
                if attempt_count >= METRIC_REFRESH_MAX_ATTEMPTS:
                    raise RuntimeError("指标恢复任务已达到最大执行次数")
                attempt_count += 1
                await connection.execute(
                    """
                    UPDATE keyword_metric_refresh_jobs
                    SET status = 'running',
                        attempt_count = $3,
                        started_at = COALESCE(started_at, now()),
                        last_error_code = NULL,
                        last_error_detail = NULL,
                        updated_at = now()
                    WHERE run_id = $1
                        AND workflow_id = $2
                    """,
                    run_id,
                    workflow_id,
                    attempt_count,
                )
        return {
            "attempt": attempt_count,
            "status": "running",
            "started": True,
        }

    async def schedule_metric_refresh_retry(
        self,
        context: KeywordRunContext,
        *,
        expected_workflow_id: str,
        attempt_count: int,
        code: str,
        detail: str,
    ) -> dict[str, Any]:
        if attempt_count >= METRIC_REFRESH_MAX_ATTEMPTS:
            raise RuntimeError("指标恢复任务不能继续重试")
        delay = timedelta(minutes=30) if attempt_count == 1 else timedelta(hours=2)
        next_attempt = attempt_count + 1
        workflow_id = f"keyword-metrics:{context.run_id}:{next_attempt}:{uuid4()}"
        task = {
            "organization_id": context.organization_id,
            "project_id": context.project_id,
            "run_id": context.run_id,
            "kind": context.kind,
            "round_number": context.round_number,
            "_metric_workflow_id": workflow_id,
        }
        async with self.pool.acquire() as connection:
            updated = await connection.fetchval(
                """
                UPDATE keyword_metric_refresh_jobs
                SET workflow_id = $2,
                    task_payload = $3,
                    status = 'waiting',
                    orphan_replay_count = 0,
                    next_attempt_at = now() + $4::interval,
                    last_error_code = $5,
                    last_error_detail = $6,
                    dispatched_at = NULL,
                    last_checked_at = NULL,
                    updated_at = now()
                WHERE run_id = $1
                    AND workflow_id = $8
                    AND status = 'running'
                    AND attempt_count = $7
                RETURNING true
                """,
                context.run_id,
                workflow_id,
                task,
                delay,
                code[:120],
                detail[:2000],
                attempt_count,
                expected_workflow_id,
            )
        if not updated:
            raise RuntimeError("指标恢复任务状态已经变化")
        return {
            "workflow_id": workflow_id,
            "next_attempt_seconds": int(delay.total_seconds()),
        }

    async def finish_metric_refresh_job(
        self,
        context: KeywordRunContext,
        *,
        expected_workflow_id: str,
        exhausted: bool,
        code: str = "",
        detail: str = "",
    ) -> None:
        async with self.pool.acquire() as connection:
            updated = await connection.fetchval(
                """
                UPDATE keyword_metric_refresh_jobs
                SET status = $2,
                    last_error_code = NULLIF($3, ''),
                    last_error_detail = NULLIF($4, ''),
                    finished_at = now(),
                    updated_at = now()
                WHERE run_id = $1
                    AND workflow_id = $5
                    AND status = 'running'
                RETURNING true
                """,
                context.run_id,
                "exhausted" if exhausted else "completed",
                code[:120],
                detail[:2000],
                expected_workflow_id,
            )
        if not updated:
            raise RuntimeError("指标恢复任务状态已经变化")

    async def commit_keywords(
        self,
        context: KeywordRunContext,
        records: list[dict[str, Any]],
    ) -> KeywordCommitResult:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.fetchval(
                    "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
                    context.project_id,
                )
                for start in range(0, len(records), KEYWORD_COMMIT_BATCH_SIZE):
                    batch = records[start : start + KEYWORD_COMMIT_BATCH_SIZE]
                    keyword_values: list[tuple[Any, ...]] = []
                    metric_values: list[tuple[Any, ...]] = []
                    source_values_by_key: dict[tuple[str, str, str], tuple[Any, ...]] = {}
                    relation_values: list[tuple[Any, ...]] = []
                    keyword_ids: list[str] = []

                    for record in batch:
                        candidate: MergedCandidate = record["candidate"]
                        metric = record.get("metric")
                        metrics_status = str(record["metrics_status"])
                        if metrics_status == "fresh" and (
                            not metric
                            or metric.get("keyword_difficulty") is None
                            or metric.get("intent") is None
                        ):
                            metrics_status = "failed"
                        keyword_id = deterministic_id(
                            "keyword",
                            context.project_id,
                            context.country,
                            context.language,
                            candidate.normalized_keyword,
                        )
                        keyword_ids.append(keyword_id)
                        keyword_values.append(
                            (
                                keyword_id,
                                context.organization_id,
                                context.project_id,
                                context.country,
                                context.language,
                                candidate.keyword,
                                candidate.normalized_keyword,
                                record["business_topic"],
                                record["classification_confidence"],
                                record["review_status"],
                                record["primary_seed_id"],
                                record["priority_score"],
                                record["priority_confidence"],
                                record["priority_details"],
                                record["score_version"],
                                metrics_status,
                                context.run_id,
                            )
                        )
                        if metric:
                            metric_values.append(
                                (
                                    keyword_id,
                                    metric.get("search_volume"),
                                    metric.get("cpc"),
                                    metric.get("competition"),
                                    metric.get("competition_level"),
                                    metric.get("keyword_difficulty"),
                                    metric.get("intent"),
                                    metric.get("monthly_searches") or [],
                                    metric.get("raw_payload") or {},
                                )
                            )
                        for raw in candidate.rows:
                            source_seed_key = raw.source_seed_id or ""
                            source_values_by_key[(keyword_id, raw.source, source_seed_key)] = (
                                keyword_id,
                                raw.source,
                                raw.source_seed_id,
                                source_seed_key,
                                context.run_id,
                                {
                                    "provider_rank": raw.provider_rank,
                                    "raw_payload": raw.raw_payload,
                                    "seed_batch": record.get("source_seed_ids") or [],
                                    "last_build_run_id": context.run_id,
                                },
                            )
                        relation_values.extend(
                            (
                                keyword_id,
                                seed_id,
                                ("primary" if seed_id == record["primary_seed_id"] else "related"),
                                confidence,
                                basis,
                            )
                            for seed_id, confidence, basis in record["relations"]
                        )

                    await connection.executemany(
                        """
                        INSERT INTO keywords (
                            id,
                            organization_id,
                            project_id,
                            country,
                            language,
                            keyword,
                            normalized_keyword,
                            business_topic,
                            classification_confidence,
                            review_status,
                            primary_seed_id,
                            priority_score,
                            priority_confidence,
                            priority_details,
                            score_version,
                            metrics_status,
                            first_build_run_id,
                            last_build_run_id
                        )
                        VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9,
                            $10, $11, $12, $13, $14, $15, $16, $17, $17
                        )
                        ON CONFLICT (
                            project_id,
                            country,
                            language,
                            normalized_keyword
                        ) DO UPDATE SET
                            keyword = EXCLUDED.keyword,
                            business_topic = EXCLUDED.business_topic,
                            classification_confidence =
                                EXCLUDED.classification_confidence,
                            review_status = EXCLUDED.review_status,
                            primary_seed_id = EXCLUDED.primary_seed_id,
                            priority_score = EXCLUDED.priority_score,
                            priority_confidence = EXCLUDED.priority_confidence,
                            priority_details = EXCLUDED.priority_details,
                            score_version = EXCLUDED.score_version,
                            metrics_status = CASE
                                WHEN keywords.metrics_status = 'fresh'
                                    AND EXCLUDED.metrics_status IN ('pending', 'failed')
                                    THEN keywords.metrics_status
                                ELSE EXCLUDED.metrics_status
                            END,
                            last_build_run_id = EXCLUDED.last_build_run_id,
                            updated_at = now()
                        """,
                        keyword_values,
                    )
                    if metric_values:
                        await connection.executemany(
                            """
                            INSERT INTO keyword_metrics (
                                keyword_id,
                                provider,
                                search_volume,
                                cpc,
                                competition,
                                competition_level,
                                keyword_difficulty,
                                intent,
                                monthly_searches,
                                raw_payload,
                                fetched_at
                            )
                            VALUES (
                                $1, 'dataforseo', $2, $3, $4, $5,
                                $6, $7, $8, $9, now()
                            )
                            ON CONFLICT (keyword_id, provider) DO UPDATE SET
                                search_volume = COALESCE(
                                    EXCLUDED.search_volume,
                                    keyword_metrics.search_volume
                                ),
                                cpc = COALESCE(EXCLUDED.cpc, keyword_metrics.cpc),
                                competition = COALESCE(
                                    EXCLUDED.competition,
                                    keyword_metrics.competition
                                ),
                                competition_level = COALESCE(
                                    EXCLUDED.competition_level,
                                    keyword_metrics.competition_level
                                ),
                                keyword_difficulty = COALESCE(
                                    EXCLUDED.keyword_difficulty,
                                    keyword_metrics.keyword_difficulty
                                ),
                                intent = COALESCE(EXCLUDED.intent, keyword_metrics.intent),
                                monthly_searches = CASE
                                    WHEN jsonb_array_length(EXCLUDED.monthly_searches) > 0
                                        THEN EXCLUDED.monthly_searches
                                    ELSE keyword_metrics.monthly_searches
                                END,
                                raw_payload =
                                    keyword_metrics.raw_payload || EXCLUDED.raw_payload,
                                fetched_at = EXCLUDED.fetched_at
                            """,
                            metric_values,
                        )
                    if source_values_by_key:
                        await connection.executemany(
                            """
                            INSERT INTO keyword_sources (
                                keyword_id,
                                source,
                                source_seed_id,
                                source_seed_key,
                                first_build_run_id,
                                metadata_json
                            )
                            VALUES ($1, $2, $3, $4, $5, $6)
                            ON CONFLICT (
                                keyword_id,
                                source,
                                source_seed_key
                            ) DO UPDATE SET
                                metadata_json =
                                    keyword_sources.metadata_json || EXCLUDED.metadata_json
                            """,
                            list(source_values_by_key.values()),
                        )
                    await connection.execute(
                        "DELETE FROM keyword_seed_relations WHERE keyword_id = ANY($1::text[])",
                        keyword_ids,
                    )
                    if relation_values:
                        await connection.executemany(
                            """
                            INSERT INTO keyword_seed_relations (
                                keyword_id,
                                seed_id,
                                relation,
                                confidence,
                                basis
                            )
                            VALUES ($1, $2, $3, $4, $5)
                            ON CONFLICT (keyword_id, seed_id) DO UPDATE SET
                                relation = EXCLUDED.relation,
                                confidence = EXCLUDED.confidence,
                                basis = EXCLUDED.basis
                            """,
                            relation_values,
                        )

                result_version = int(
                    await connection.fetchval(
                        """
                        SELECT COALESCE(max(result_version), 0) + 1
                        FROM keyword_build_runs
                        WHERE project_id = $1
                        """,
                        context.project_id,
                    )
                    or 1
                )
                keyword_count = int(
                    await connection.fetchval(
                        """
                        SELECT count(*)
                        FROM keywords
                        WHERE organization_id = $1
                            AND project_id = $2
                            AND country = $3
                            AND language = $4
                            AND last_build_run_id = $5
                            AND status = 'active'
                        """,
                        context.organization_id,
                        context.project_id,
                        context.country,
                        context.language,
                        context.run_id,
                    )
                    or 0
                )
                pending_count = int(
                    await connection.fetchval(
                        """
                        SELECT count(*)
                        FROM keywords
                        WHERE organization_id = $1
                            AND project_id = $2
                            AND country = $3
                            AND language = $4
                            AND last_build_run_id = $5
                            AND metrics_status = 'pending'
                        """,
                        context.organization_id,
                        context.project_id,
                        context.country,
                        context.language,
                        context.run_id,
                    )
                    or 0
                )
                run_state = await connection.fetchrow(
                    """
                    SELECT partial_failures, gap_status
                    FROM keyword_build_runs
                    WHERE id = $1
                    """,
                    context.run_id,
                )
                partial_failures = list(run_state["partial_failures"] or [])
                gap_status = str(run_state["gap_status"] or "not_requested")
                final_status = (
                    "partial"
                    if partial_failures or gap_status in {"failed", "pending", "running"}
                    else "completed"
                )
                await connection.execute(
                    """
                    UPDATE keyword_seeds
                    SET expansion_status = 'not_applicable',
                        expansion_run_id = NULL,
                        expansion_round_number = NULL,
                        expanded_at = NULL,
                        updated_at = now()
                    WHERE initial_run_id = $1
                        AND decision = 'selected'
                    """,
                    context.run_id,
                )
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET status = $2,
                        stage = $2,
                        message = CASE
                            WHEN $2 = 'partial'
                                AND jsonb_array_length(partial_failures) > 0
                                THEN '关键词库已建立，部分步骤使用了备用方案'
                            WHEN $2 = 'partial'
                                THEN '关键词库已建立，竞争对手分析未完成'
                            ELSE '关键词库已建立'
                        END,
                        progress = 100,
                        keyword_count = $3,
                        pending_seed_count = $4,
                        result_version = $5,
                        error_code = NULL,
                        error_detail = NULL,
                        next_retry_at = NULL,
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = $1
                    """,
                    context.run_id,
                    final_status,
                    keyword_count,
                    pending_count,
                    result_version,
                )
                metric_workflow_id = f"keyword-metrics:{context.run_id}:1"
                metric_task = {
                    "organization_id": context.organization_id,
                    "project_id": context.project_id,
                    "run_id": context.run_id,
                    "kind": context.kind,
                    "round_number": context.round_number,
                    "_metric_workflow_id": metric_workflow_id,
                }
                if pending_count > 0:
                    await connection.execute(
                        """
                        INSERT INTO keyword_metric_refresh_jobs (
                            run_id,
                            organization_id,
                            project_id,
                            workflow_id,
                            task_payload,
                            status,
                            attempt_count,
                            next_attempt_at
                        )
                        VALUES ($1, $2, $3, $4, $5, 'waiting', 0,
                                now() + interval '5 minutes')
                        ON CONFLICT (run_id) DO NOTHING
                        """,
                        context.run_id,
                        context.organization_id,
                        context.project_id,
                        metric_workflow_id,
                        metric_task,
                    )
                else:
                    await connection.execute(
                        """
                        UPDATE keyword_metric_refresh_jobs
                        SET status = 'completed',
                            finished_at = COALESCE(finished_at, now()),
                            updated_at = now()
                        WHERE run_id = $1
                            AND status NOT IN ('completed', 'exhausted')
                        """,
                        context.run_id,
                    )
        return KeywordCommitResult(
            result_version=result_version,
            keyword_count=keyword_count,
            pending_metrics_count=pending_count,
        )

    async def fail_run(
        self,
        context: KeywordRunContext,
        *,
        code: str,
        message: str,
        detail: str,
    ) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                if context.kind == "expansion":
                    await connection.execute(
                        """
                        UPDATE keyword_seeds
                        SET expansion_status = 'pending_expansion',
                            expansion_run_id = NULL,
                            expansion_round_number = NULL,
                            updated_at = now()
                        WHERE expansion_run_id = $1
                            AND expansion_status = 'processing'
                        """,
                        context.run_id,
                    )
                else:
                    await connection.execute(
                        """
                        UPDATE keyword_seeds
                        SET expansion_status = 'failed',
                            updated_at = now()
                        WHERE expansion_run_id = $1
                            AND expansion_status = 'processing'
                        """,
                        context.run_id,
                    )
                await connection.execute(
                    """
                    UPDATE keyword_build_runs
                    SET status = 'failed',
                        stage = 'failed',
                        message = $2,
                        error_code = $3,
                        error_detail = $4,
                        finished_at = now(),
                        updated_at = now()
                    WHERE id = $1
                        AND status IN ('queued', 'running')
                    """,
                    context.run_id,
                    message[:500],
                    code[:120],
                    detail[:2000],
                )


def raw_keyword_from_row(row: asyncpg.Record) -> RawKeyword:
    return RawKeyword(
        keyword=row["keyword"],
        source=row["source"],
        provider_rank=row["provider_rank"],
        source_seed_id=row["source_seed_id"],
        source_seed_rank=row["source_seed_rank"],
        search_volume=row["search_volume"],
        cpc=row["cpc"],
        competition=row["competition"],
        keyword_difficulty=row["keyword_difficulty"],
        intent=row["intent"],
        monthly_searches=list(row["monthly_searches"] or []),
        raw_payload=dict(row["raw_payload"] or {}),
        ai_relevance=(
            float(row["business_relevance"]) if row["business_relevance"] is not None else None
        ),
    )


def keyword_idea_values(
    context: KeywordRunContext,
    rows: Iterable[RawKeyword],
) -> list[tuple[Any, ...]]:
    return [
        (
            context.organization_id,
            context.project_id,
            context.run_id,
            row.source,
            row.source_seed_id,
            row.source_seed_id or "",
            display_keyword(row.keyword),
            normalize_keyword(row.keyword),
            row.provider_rank,
            row.search_volume,
            row.cpc,
            row.competition,
            row.keyword_difficulty,
            row.intent,
            row.monthly_searches,
            row.raw_payload,
            {
                "_status": "fresh",
                "search_volume": row.search_volume,
                "cpc": row.cpc,
                "competition": row.competition,
                "competition_level": (
                    row.raw_payload.get("keyword_info", {}).get("competition_level")
                    if isinstance(row.raw_payload.get("keyword_info"), dict)
                    else None
                ),
                "keyword_difficulty": row.keyword_difficulty,
                "intent": row.intent,
                "monthly_searches": row.monthly_searches,
                "raw_payload": row.raw_payload,
            }
            if row.source.startswith("keyword_ideas")
            else {},
            row.ai_relevance,
        )
        for row in rows
        if normalize_keyword(row.keyword)
    ]


def keyword_gap_values(
    context: KeywordRunContext,
    rows: Iterable[CompetitorGap],
) -> list[tuple[Any, ...]]:
    if not context.competitor_domain:
        return []
    return [
        (
            deterministic_id(
                "keyword-gap",
                context.run_id,
                normalize_keyword(row.keyword),
            ),
            context.organization_id,
            context.project_id,
            context.run_id,
            context.competitor_domain,
            display_keyword(row.keyword),
            normalize_keyword(row.keyword),
            row.competitor_rank,
            row.search_volume,
            row.cpc,
            row.competition,
            row.keyword_difficulty,
            row.intent,
            row.monthly_searches,
            row.raw_payload,
        )
        for row in rows
        if normalize_keyword(row.keyword)
    ]


def deterministic_id(namespace: str, *values: str) -> str:
    return str(uuid5(NAMESPACE_URL, ":".join((namespace, *values))))


def profile_is_usable(profile: dict[str, Any]) -> bool:
    summary = profile.get("business_summary")
    products = profile.get("products_services")
    topics = profile.get("content_topics")
    return bool(
        (isinstance(summary, str) and summary.strip())
        or (isinstance(products, list) and products)
        or (isinstance(topics, list) and topics)
    )


def parse_duration_seconds(value: str, *, default: int) -> int:
    normalized = value.strip().casefold()
    try:
        if normalized.endswith("ms"):
            return max(1, int(float(normalized[:-2]) / 1000))
        if normalized.endswith("s"):
            return max(1, int(float(normalized[:-1])))
        if normalized.endswith("m"):
            return max(1, int(float(normalized[:-1]) * 60))
        return max(1, int(float(normalized)))
    except ValueError:
        return default
