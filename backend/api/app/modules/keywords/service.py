from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import (
    and_,
    asc,
    case,
    delete,
    desc,
    exists,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.keywords.models import (
    Keyword,
    KeywordBuildRun,
    KeywordCompetitor,
    KeywordCompetitorAnalysisDispatch,
    KeywordCompetitorAnalysisRun,
    KeywordCompetitorGap,
    KeywordCompetitorOpportunity,
    KeywordCompetitorOpportunityDecision,
    KeywordCompetitorOpportunityRanking,
    KeywordExternalRequest,
    KeywordIdea,
    KeywordMetric,
    KeywordMetricRefreshJob,
    KeywordSeed,
    KeywordSource,
    KeywordTag,
    KeywordTagAssignment,
    KeywordWorkerHeartbeat,
    KeywordWorkflowDispatch,
)
from app.modules.keywords.schemas import (
    KeywordBatchStatusRequest,
    KeywordBatchStatusResponse,
    KeywordBuildRunResponse,
    KeywordCompetitorGapItemResponse,
    KeywordCompetitorGapListResponse,
    KeywordCompetitorAnalysisRunResponse,
    KeywordCompetitorAnalysisRunSummaryResponse,
    KeywordCompetitorListResponse,
    KeywordCompetitorAnalysisRunListResponse,
    KeywordCompetitorAnalysisRequest,
    KeywordCompetitorOpportunityBatchRequest,
    KeywordCompetitorOpportunityBatchResponse,
    KeywordCompetitorOpportunityListResponse,
    KeywordCompetitorOpportunityResponse,
    KeywordCompetitorRankingResponse,
    KeywordCompetitorResponse,
    KeywordCostSummaryResponse,
    KeywordExternalIssueListResponse,
    KeywordExternalIssueResponse,
    KeywordGSCSaveRequest,
    KeywordGSCSaveResponse,
    KeywordLibraryStatusResponse,
    KeywordListItemResponse,
    KeywordListResponse,
    KeywordOperationalHealthResponse,
    KeywordTagAssignmentRequest,
    KeywordTagAssignmentResponse,
    KeywordTagResponse,
)
from app.modules.projects.models import Project
from app.modules.settings.models import AIProviderSetting, DataForSEOProviderSetting, GSCConnection
from app.modules.settings.gsc import gsc_site_matches_domain
from app.workflows.client import connect_temporal

logger = logging.getLogger(__name__)
METRIC_ORPHAN_REPLAY_LIMIT = 3


class KeywordProjectNotFoundError(Exception):
    pass


class KeywordBuildAlreadyRunningError(Exception):
    pass


class KeywordRetryUnavailableError(Exception):
    pass


class KeywordExternalIssueUnavailableError(Exception):
    pass


class KeywordCompetitorAnalysisAlreadyRunningError(Exception):
    pass


class KeywordCompetitorOpportunityUnavailableError(Exception):
    pass


class KeywordGSCRequiredError(Exception):
    pass


@dataclass(frozen=True)
class KeywordBootstrapRecord:
    run_id: str
    organization_id: str
    project_id: str
    kind: str
    round_number: int
    workflow_id: str
    task_payload: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True)
class KeywordCompetitorAnalysisBootstrapRecord:
    run_id: str
    organization_id: str
    project_id: str
    workflow_id: str
    target_domain: str
    country: str
    language: str
    analysis_mode: str
    competitor_domains: list[str]
    local_market: dict[str, Any]
    competitor_limit: int
    keyword_limit: int
    task_payload: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True)
class KeywordDispatchRecord:
    run_id: str
    workflow_id: str
    task_payload: dict[str, Any]


@dataclass(frozen=True)
class KeywordActiveWorkflowRecord:
    run_id: str
    workflow_id: str
    task_payload: dict[str, Any]
    run_status: str
    dispatch_status: str
    updated_at: datetime


@dataclass(frozen=True)
class KeywordMetricDispatchRecord:
    run_id: str
    workflow_id: str
    task_payload: dict[str, Any]


@dataclass(frozen=True)
class KeywordMetricActiveWorkflowRecord:
    run_id: str
    workflow_id: str
    updated_at: datetime


@dataclass(frozen=True)
class KeywordCompetitorAnalysisDispatchRecord:
    run_id: str
    workflow_id: str
    task_payload: dict[str, Any]


@dataclass(frozen=True)
class KeywordCompetitorAnalysisActiveWorkflowRecord:
    run_id: str
    workflow_id: str
    updated_at: datetime


@dataclass(frozen=True)
class KeywordOperationalHealth:
    worker_healthy: bool
    worker_last_seen_at: datetime | None
    active_runs: int
    waiting_runs: int
    blocked_runs: int
    stale_prepared_requests: int
    uncertain_requests: int
    charged_failed_requests: int
    metric_refresh_waiting: int
    metric_refresh_running: int
    metric_refresh_exhausted: int
    failed_metrics: int


class KeywordWorkflowLauncher(Protocol):
    async def start(self, task: dict[str, Any], workflow_id: str) -> None: ...

    async def start_metrics(self, task: dict[str, Any], workflow_id: str) -> None: ...

    async def start_competitor_analysis(self, task: dict[str, Any], workflow_id: str) -> None: ...

    async def cancel(self, workflow_id: str) -> None: ...

    async def state(self, workflow_id: str) -> str: ...


class TemporalKeywordWorkflowLauncher:
    def __init__(self, task_queue: str) -> None:
        self.task_queue = task_queue
        self._client: Client | None = None
        self._client_lock = asyncio.Lock()

    async def _get_client(self) -> Client:
        if self._client is not None:
            return self._client
        async with self._client_lock:
            if self._client is None:
                self._client = await connect_temporal()
        return self._client

    async def start(self, task: dict[str, Any], workflow_id: str) -> None:
        client = await self._get_client()
        try:
            await client.start_workflow(
                "KeywordBuildWorkflow",
                task,
                id=workflow_id,
                task_queue=self.task_queue,
            )
        except WorkflowAlreadyStartedError:
            return

    async def start_metrics(self, task: dict[str, Any], workflow_id: str) -> None:
        client = await self._get_client()
        try:
            await client.start_workflow(
                "KeywordMetricsRecoveryWorkflow",
                task,
                id=workflow_id,
                task_queue=self.task_queue,
            )
        except WorkflowAlreadyStartedError:
            return

    async def start_competitor_analysis(self, task: dict[str, Any], workflow_id: str) -> None:
        client = await self._get_client()
        try:
            await client.start_workflow(
                "KeywordCompetitorAnalysisWorkflow",
                task,
                id=workflow_id,
                task_queue=self.task_queue,
            )
        except WorkflowAlreadyStartedError:
            return

    async def cancel(self, workflow_id: str) -> None:
        client = await self._get_client()
        await client.get_workflow_handle(workflow_id).cancel()

    async def state(self, workflow_id: str) -> str:
        client = await self._get_client()
        try:
            description = await client.get_workflow_handle(workflow_id).describe()
        except RPCError as exc:
            return "missing" if exc.status == RPCStatusCode.NOT_FOUND else "unknown"
        return "running" if description.status == WorkflowExecutionStatus.RUNNING else "closed"


def build_initial_keyword_bootstrap(
    *,
    organization_id: str,
    project_id: str,
    created_at: datetime,
) -> KeywordBootstrapRecord:
    run_id = str(uuid4())
    return KeywordBootstrapRecord(
        run_id=run_id,
        organization_id=organization_id,
        project_id=project_id,
        kind="initial",
        round_number=1,
        workflow_id=f"keywords:build:{run_id}",
        task_payload={
            "organization_id": organization_id,
            "project_id": project_id,
            "run_id": run_id,
            "kind": "initial",
            "round_number": 1,
        },
        created_at=created_at,
    )


def keyword_run_from_bootstrap(record: KeywordBootstrapRecord) -> KeywordBuildRun:
    return KeywordBuildRun(
        id=record.run_id,
        organization_id=record.organization_id,
        project_id=record.project_id,
        kind=record.kind,
        round_number=record.round_number,
        status="queued",
        stage="queued",
        message="正在准备关键词库",
        created_at=record.created_at,
        updated_at=record.created_at,
    )


def keyword_dispatch_from_bootstrap(
    record: KeywordBootstrapRecord,
) -> KeywordWorkflowDispatch:
    return KeywordWorkflowDispatch(
        run_id=record.run_id,
        workflow_id=record.workflow_id,
        task_payload=record.task_payload,
        status="pending",
        created_at=record.created_at,
        updated_at=record.created_at,
        next_attempt_at=record.created_at,
    )


def build_competitor_analysis_bootstrap(
    *,
    organization_id: str,
    project_id: str,
    target_domain: str,
    country: str,
    language: str,
    analysis_mode: str,
    competitor_domains: list[str],
    local_market: dict[str, Any],
    created_at: datetime,
) -> KeywordCompetitorAnalysisBootstrapRecord:
    run_id = str(uuid4())
    competitor_limit = len(competitor_domains) if analysis_mode == "manual" else 5
    task_payload = {
        "organization_id": organization_id,
        "project_id": project_id,
        "run_id": run_id,
        "analysis_mode": analysis_mode,
        "competitor_domains": competitor_domains,
        "local_market": local_market,
        "competitor_limit": competitor_limit,
        "keyword_limit": 100,
    }
    return KeywordCompetitorAnalysisBootstrapRecord(
        run_id=run_id,
        organization_id=organization_id,
        project_id=project_id,
        workflow_id=f"keywords:competitor-analysis:{run_id}",
        target_domain=target_domain,
        country=country,
        language=language,
        analysis_mode=analysis_mode,
        competitor_domains=competitor_domains,
        local_market=local_market,
        competitor_limit=competitor_limit,
        keyword_limit=100,
        task_payload=task_payload,
        created_at=created_at,
    )


def competitor_analysis_run_from_bootstrap(
    record: KeywordCompetitorAnalysisBootstrapRecord,
) -> KeywordCompetitorAnalysisRun:
    return KeywordCompetitorAnalysisRun(
        id=record.run_id,
        organization_id=record.organization_id,
        project_id=record.project_id,
        workflow_id=record.workflow_id,
        target_domain=record.target_domain,
        country=record.country,
        language=record.language,
        analysis_mode=record.analysis_mode,
        requested_competitor_domains=record.competitor_domains,
        local_market=record.local_market,
        discovery_method=("manual" if record.analysis_mode == "manual" else "serp_competitors"),
        status="queued",
        stage="queued",
        message="正在准备竞争分析",
        competitor_limit=record.competitor_limit,
        keyword_limit=record.keyword_limit,
        created_at=record.created_at,
        updated_at=record.created_at,
    )


def competitor_analysis_dispatch_from_bootstrap(
    record: KeywordCompetitorAnalysisBootstrapRecord,
) -> KeywordCompetitorAnalysisDispatch:
    return KeywordCompetitorAnalysisDispatch(
        run_id=record.run_id,
        workflow_id=record.workflow_id,
        task_payload=record.task_payload,
        status="pending",
        created_at=record.created_at,
        updated_at=record.created_at,
        next_attempt_at=record.created_at,
    )


class SQLAlchemyKeywordRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def status(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordLibraryStatusResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            run = await session.scalar(
                select(KeywordBuildRun)
                .where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                )
                .order_by(
                    KeywordBuildRun.round_number.desc(),
                    KeywordBuildRun.created_at.desc(),
                )
                .limit(1)
            )
            total_keywords, active_keywords, _ = await self._counts(
                session,
                organization_id,
                project_id,
            )
            pending_metrics_count = await session.scalar(
                select(func.count(Keyword.id)).where(
                    Keyword.organization_id == organization_id,
                    Keyword.project_id == project_id,
                    Keyword.metrics_status == "pending",
                )
            )
            result_version = await session.scalar(
                select(func.coalesce(func.max(KeywordBuildRun.result_version), 0)).where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                )
            )
            return KeywordLibraryStatusResponse(
                run=build_run_response(run) if run is not None else None,
                total_keywords=total_keywords,
                active_keywords=active_keywords,
                pending_metrics_count=int(pending_metrics_count or 0),
                result_version=int(result_version or 0),
            )

    async def cost_summary(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordCostSummaryResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            requests = list(
                (
                    await session.scalars(
                        select(KeywordExternalRequest).where(
                            KeywordExternalRequest.organization_id == organization_id,
                            KeywordExternalRequest.project_id == project_id,
                        )
                    )
                ).all()
            )

        dataforseo_cost = 0.0
        ai_cost = 0.0
        ai_input_tokens = 0
        ai_output_tokens = 0
        ai_requests = 0
        ai_requests_with_reported_cost = 0
        for request in requests:
            cost = max(float(request.cost_usd or 0), 0)
            if request.provider == "dataforseo":
                dataforseo_cost += cost
                continue
            if request.provider != "ai":
                continue
            ai_requests += 1
            ai_cost += cost
            if cost > 0:
                ai_requests_with_reported_cost += 1
            metadata = dict(request.response_metadata or {})
            usage = metadata.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            ai_input_tokens += token_count(usage, "prompt_tokens", "input_tokens")
            ai_output_tokens += token_count(usage, "completion_tokens", "output_tokens")

        return KeywordCostSummaryResponse(
            request_count=len(requests),
            dataforseo_cost_usd=round(dataforseo_cost, 6),
            ai_reported_cost_usd=round(ai_cost, 6),
            total_reported_cost_usd=round(dataforseo_cost + ai_cost, 6),
            ai_input_tokens=ai_input_tokens,
            ai_output_tokens=ai_output_tokens,
            ai_cost_complete=(ai_requests == 0 or ai_requests_with_reported_cost == ai_requests),
        )

    async def list_external_issues(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordExternalIssueListResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            rows = list(
                (
                    await session.scalars(
                        select(KeywordExternalRequest)
                        .where(
                            KeywordExternalRequest.organization_id == organization_id,
                            KeywordExternalRequest.project_id == project_id,
                            KeywordExternalRequest.status.in_(("uncertain", "charged_failed")),
                        )
                        .order_by(
                            KeywordExternalRequest.started_at,
                            KeywordExternalRequest.id,
                        )
                    )
                ).all()
            )
        return KeywordExternalIssueListResponse(
            items=[external_issue_response(row) for row in rows]
        )

    async def accept_external_issue_as_empty(
        self,
        organization_id: str,
        project_id: str,
        request_id: int,
    ) -> KeywordExternalIssueResponse:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id, lock=True)
            request = await session.scalar(
                select(KeywordExternalRequest)
                .where(
                    KeywordExternalRequest.id == request_id,
                    KeywordExternalRequest.organization_id == organization_id,
                    KeywordExternalRequest.project_id == project_id,
                )
                .with_for_update()
            )
            if (
                request is None
                or request.provider != "dataforseo"
                or request.status not in {"uncertain", "charged_failed"}
            ):
                raise KeywordExternalIssueUnavailableError

            metadata = dict(request.response_metadata or {})
            metadata.update(
                {
                    "rows": [],
                    "data": [],
                    "operator_resolution": "accepted_empty",
                    "resolved_at": now.isoformat(),
                }
            )
            request.status = "completed"
            request.result_count = 0
            request.response_metadata = metadata
            request.error_code = None
            request.error_detail = None
            request.claim_token = None
            request.lease_expires_at = None
            request.expires_at = now + timedelta(days=1)
            request.finished_at = now

            run = (
                await session.scalar(
                    select(KeywordBuildRun)
                    .where(KeywordBuildRun.id == request.build_run_id)
                    .with_for_update()
                )
                if request.build_run_id is not None
                else None
            )
            dispatch = (
                await session.scalar(
                    select(KeywordWorkflowDispatch)
                    .where(KeywordWorkflowDispatch.run_id == request.build_run_id)
                    .with_for_update()
                )
                if request.build_run_id is not None
                else None
            )
            if run is not None and dispatch is not None and run.status == "blocked":
                task_payload = dict(dispatch.task_payload)
                task_payload["_recovery_count"] = int(run.recovery_count or 0)
                dispatch.workflow_id = (
                    f"keywords:build:{run.id}:resolved:{run.recovery_count}:{uuid4()}"
                )
                dispatch.task_payload = task_payload
                dispatch.status = "pending"
                dispatch.attempts = 0
                dispatch.last_error = None
                dispatch.next_attempt_at = now
                dispatch.dispatched_at = None
                dispatch.last_checked_at = None
                dispatch.updated_at = now
                run.status = "queued"
                run.stage = "waiting_for_recovery"
                run.message = "外部请求已核对，正在继续创建关键词库"
                run.next_retry_at = None
                run.finished_at = None
                run.updated_at = now
            competitor_run = (
                await session.scalar(
                    select(KeywordCompetitorAnalysisRun)
                    .where(KeywordCompetitorAnalysisRun.id == request.competitor_analysis_run_id)
                    .with_for_update()
                )
                if request.competitor_analysis_run_id is not None
                else None
            )
            competitor_dispatch = (
                await session.scalar(
                    select(KeywordCompetitorAnalysisDispatch)
                    .where(
                        KeywordCompetitorAnalysisDispatch.run_id
                        == request.competitor_analysis_run_id
                    )
                    .with_for_update()
                )
                if request.competitor_analysis_run_id is not None
                else None
            )
            other_active_competitor_run = (
                await session.scalar(
                    select(KeywordCompetitorAnalysisRun.id)
                    .where(
                        KeywordCompetitorAnalysisRun.organization_id == organization_id,
                        KeywordCompetitorAnalysisRun.project_id == project_id,
                        KeywordCompetitorAnalysisRun.status.in_(("queued", "running")),
                        KeywordCompetitorAnalysisRun.id != request.competitor_analysis_run_id,
                    )
                    .limit(1)
                )
                if request.competitor_analysis_run_id is not None
                else None
            )
            can_resume_competitor_run = bool(
                competitor_run is not None
                and competitor_dispatch is not None
                and competitor_run.status in {"failed", "partial"}
                and competitor_dispatch.status != "dispatching"
                and other_active_competitor_run is None
            )
            if can_resume_competitor_run:
                assert competitor_run is not None
                assert competitor_dispatch is not None
                workflow_id = f"keywords:competitor-analysis:{competitor_run.id}:resolved:{uuid4()}"
                task_payload = dict(competitor_dispatch.task_payload)
                task_payload["_recovery_count"] = int(competitor_run.recovery_count or 0)
                competitor_dispatch.workflow_id = workflow_id
                competitor_dispatch.task_payload = task_payload
                competitor_dispatch.status = "pending"
                competitor_dispatch.attempts = 0
                competitor_dispatch.last_error = None
                competitor_dispatch.next_attempt_at = now
                competitor_dispatch.dispatched_at = None
                competitor_dispatch.last_checked_at = None
                competitor_dispatch.updated_at = now
                competitor_run.workflow_id = workflow_id
                competitor_run.status = "queued"
                competitor_run.stage = "waiting_for_recovery"
                competitor_run.message = "外部请求已核对，正在继续竞争分析"
                competitor_run.progress = 0
                competitor_run.error_code = None
                competitor_run.error_detail = None
                competitor_run.finished_at = None
                competitor_run.updated_at = now
            elif competitor_run is not None:
                metadata = dict(request.response_metadata or {})
                metadata["workflow_recovery"] = "deferred"
                metadata["workflow_recovery_reason"] = (
                    "dispatch_in_progress"
                    if competitor_dispatch is not None
                    and competitor_dispatch.status == "dispatching"
                    else (
                        "newer_analysis_active"
                        if other_active_competitor_run is not None
                        else f"owner_status_{competitor_run.status}"
                    )
                )
                request.response_metadata = metadata
            await session.commit()
            return external_issue_response(request)

    async def list_keywords(
        self,
        organization_id: str,
        project_id: str,
        *,
        page: int,
        page_size: int,
        search: str | None,
        intent: str | None,
        source: str | None,
        seed_id: str | None,
        status: str,
        metrics_status: str | None,
        min_volume: int | None,
        max_difficulty: int | None,
        sort: str,
        order: str,
    ) -> KeywordListResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            metric_join = and_(
                KeywordMetric.keyword_id == Keyword.id,
                KeywordMetric.provider == "dataforseo",
            )
            statement = (
                select(Keyword, KeywordMetric, KeywordSeed.keyword.label("primary_seed"))
                .outerjoin(KeywordMetric, metric_join)
                .outerjoin(KeywordSeed, KeywordSeed.id == Keyword.primary_seed_id)
                .where(
                    Keyword.organization_id == organization_id,
                    Keyword.project_id == project_id,
                    Keyword.status == status,
                )
            )
            filters = []
            if search and search.strip():
                escaped = escape_like(search.strip().casefold())
                filters.append(func.lower(Keyword.keyword).like(f"%{escaped}%", escape="\\"))
            if intent:
                filters.append(KeywordMetric.intent == intent)
            if metrics_status:
                filters.append(Keyword.metrics_status == metrics_status)
            if min_volume is not None:
                filters.append(KeywordMetric.search_volume >= min_volume)
            if max_difficulty is not None:
                filters.append(KeywordMetric.keyword_difficulty <= max_difficulty)
            if source:
                filters.append(
                    exists(
                        select(KeywordSource.id).where(
                            KeywordSource.keyword_id == Keyword.id,
                            KeywordSource.source == source,
                        )
                    )
                )
            if seed_id:
                filters.append(Keyword.primary_seed_id == seed_id)
            if filters:
                statement = statement.where(and_(*filters))

            count_statement = select(func.count()).select_from(statement.subquery())
            total = int(await session.scalar(count_statement) or 0)
            statement = statement.order_by(*keyword_order(sort, order))
            statement = statement.offset((page - 1) * page_size).limit(page_size)
            rows = (await session.execute(statement)).all()
            keyword_ids = [row.Keyword.id for row in rows]

            sources_by_keyword: dict[str, list[str]] = {}
            tags_by_keyword: dict[str, list[KeywordTagResponse]] = {}
            if keyword_ids:
                source_rows = (
                    await session.execute(
                        select(KeywordSource.keyword_id, KeywordSource.source)
                        .where(KeywordSource.keyword_id.in_(keyword_ids))
                        .order_by(KeywordSource.source)
                    )
                ).all()
                for source_row in source_rows:
                    values = sources_by_keyword.setdefault(source_row.keyword_id, [])
                    if source_row.source not in values:
                        values.append(source_row.source)

                tag_rows = (
                    await session.execute(
                        select(
                            KeywordTagAssignment.keyword_id,
                            KeywordTag.id,
                            KeywordTag.name,
                            KeywordTag.color,
                        )
                        .join(KeywordTag, KeywordTag.id == KeywordTagAssignment.tag_id)
                        .where(KeywordTagAssignment.keyword_id.in_(keyword_ids))
                        .order_by(KeywordTag.name)
                    )
                ).all()
                for tag_row in tag_rows:
                    tags_by_keyword.setdefault(tag_row.keyword_id, []).append(
                        KeywordTagResponse(
                            id=tag_row.id,
                            name=tag_row.name,
                            color=tag_row.color,
                        )
                    )

            result_version = await session.scalar(
                select(func.coalesce(func.max(KeywordBuildRun.result_version), 0)).where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                )
            )
            return KeywordListResponse(
                items=[
                    keyword_item_response(
                        row.Keyword,
                        row.KeywordMetric,
                        row.primary_seed,
                        sources_by_keyword.get(row.Keyword.id, []),
                        tags_by_keyword.get(row.Keyword.id, []),
                    )
                    for row in rows
                ],
                total=total,
                page=page,
                page_size=page_size,
                result_version=int(result_version or 0),
            )

    async def save_gsc_keywords(
        self,
        organization_id: str,
        project_id: str,
        request: KeywordGSCSaveRequest,
    ) -> KeywordGSCSaveResponse:
        normalized: dict[str, str] = {}
        for value in request.keywords:
            keyword, normalized_keyword = normalize_saved_keyword(value)
            if keyword:
                normalized.setdefault(normalized_keyword, keyword)
        if not normalized:
            return KeywordGSCSaveResponse(
                saved=0,
                added_to_library=0,
                already_in_library=0,
            )

        now = datetime.now(UTC)
        async with self.sessions() as session:
            project = await self._require_project(
                session,
                organization_id,
                project_id,
                lock=True,
            )
            build_run = await session.scalar(
                select(KeywordBuildRun)
                .where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                )
                .order_by(
                    KeywordBuildRun.round_number.desc(),
                    KeywordBuildRun.created_at.desc(),
                )
                .limit(1)
                .with_for_update()
            )
            if build_run is None:
                build_run = KeywordBuildRun(
                    id=str(uuid4()),
                    organization_id=organization_id,
                    project_id=project_id,
                    kind="initial",
                    round_number=1,
                    status="completed",
                    stage="completed",
                    message="关键词已从 Google 搜索表现保存",
                    progress=100,
                    discovered_count=len(normalized),
                    selected_count=len(normalized),
                    keyword_count=0,
                    pending_seed_count=0,
                    result_version=0,
                    profile_snapshot={},
                    profile_source="gsc_search_performance",
                    profile_version="",
                    gap_status="not_requested",
                    gap_message="",
                    gap_count=0,
                    partial_failures=[],
                    started_at=now,
                    finished_at=now,
                    created_at=now,
                    updated_at=now,
                )
                session.add(build_run)
                await session.flush()

            existing_rows = list(
                (
                    await session.scalars(
                        select(Keyword).where(
                            Keyword.organization_id == organization_id,
                            Keyword.project_id == project_id,
                            Keyword.country == project.country,
                            Keyword.language == project.language,
                            Keyword.normalized_keyword.in_(normalized),
                        )
                    )
                ).all()
            )
            existing_by_normalized = {
                row.normalized_keyword: row for row in existing_rows
            }
            added = 0
            existing = 0
            for normalized_keyword, keyword_value in normalized.items():
                keyword = existing_by_normalized.get(normalized_keyword)
                if keyword is None:
                    keyword = Keyword(
                        id=str(uuid4()),
                        organization_id=organization_id,
                        project_id=project_id,
                        country=project.country,
                        language=project.language,
                        keyword=keyword_value,
                        normalized_keyword=normalized_keyword,
                        classification_confidence=None,
                        review_status="approved",
                        priority_details={"source": "gsc_search_performance"},
                        status="active",
                        metrics_status="stale",
                        first_build_run_id=build_run.id,
                        last_build_run_id=build_run.id,
                        created_at=now,
                        updated_at=now,
                    )
                    session.add(keyword)
                    await session.flush()
                    added += 1
                else:
                    keyword.status = "active"
                    keyword.archived_at = None
                    keyword.last_build_run_id = build_run.id
                    keyword.updated_at = now
                    existing += 1

                source = await session.scalar(
                    select(KeywordSource).where(
                        KeywordSource.keyword_id == keyword.id,
                        KeywordSource.source == "gsc_search_performance",
                        KeywordSource.source_seed_key == "",
                    )
                )
                if source is None:
                    session.add(
                        KeywordSource(
                            keyword_id=keyword.id,
                            source="gsc_search_performance",
                            source_seed_key="",
                            first_build_run_id=build_run.id,
                            metadata_json={"origin": "search_performance"},
                        )
                    )

            build_run.result_version = int(build_run.result_version or 0) + 1
            build_run.updated_at = now
            build_run.keyword_count = int(
                await session.scalar(
                    select(func.count(Keyword.id)).where(
                        Keyword.organization_id == organization_id,
                        Keyword.project_id == project_id,
                    )
                )
                or 0
            )
            await session.commit()
            return KeywordGSCSaveResponse(
                saved=len(normalized),
                added_to_library=added,
                already_in_library=existing,
            )

    async def list_competitor_gaps(
        self,
        organization_id: str,
        project_id: str,
        *,
        page: int,
        page_size: int,
    ) -> KeywordCompetitorGapListResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            filters = (
                KeywordCompetitorGap.organization_id == organization_id,
                KeywordCompetitorGap.project_id == project_id,
                KeywordCompetitorGap.status.in_(("active", "needs_review")),
            )
            total = int(
                await session.scalar(select(func.count(KeywordCompetitorGap.id)).where(*filters))
                or 0
            )
            rows = list(
                (
                    await session.scalars(
                        select(KeywordCompetitorGap)
                        .where(*filters)
                        .order_by(
                            KeywordCompetitorGap.search_volume.desc().nulls_last(),
                            KeywordCompetitorGap.competitor_rank.asc().nulls_last(),
                            KeywordCompetitorGap.normalized_keyword,
                        )
                        .offset((page - 1) * page_size)
                        .limit(page_size)
                    )
                ).all()
            )
            return KeywordCompetitorGapListResponse(
                items=[
                    KeywordCompetitorGapItemResponse(
                        id=row.id,
                        competitor_domain=row.competitor_domain,
                        keyword=row.keyword,
                        competitor_rank=row.competitor_rank,
                        search_volume=row.search_volume,
                        cpc=row.cpc,
                        competition=row.competition,
                        keyword_difficulty=row.keyword_difficulty,
                        intent=row.intent,
                        monthly_searches=list(row.monthly_searches or []),
                        relevance=row.relevance,
                        status=row.status,
                        created_at=row.created_at,
                    )
                    for row in rows
                ],
                total=total,
                page=page,
                page_size=page_size,
            )

    async def create_competitor_analysis(
        self,
        organization_id: str,
        project_id: str,
        request: KeywordCompetitorAnalysisRequest,
    ) -> KeywordCompetitorAnalysisRunResponse:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            project = await self._require_project(session, organization_id, project_id)
            competitor_domains = normalize_competitor_domains(
                request.competitor_domains,
                target_domain=project.domain,
            )
            if request.mode == "manual" and not competitor_domains:
                raise ValueError("手动分析至少需要一个竞争对手域名")
            if request.mode == "auto" and competitor_domains:
                raise ValueError("自动发现不能同时指定竞争对手域名")
            if request.mode == "manual" and request.local_market is not None:
                raise ValueError("手动分析不执行本地竞争对手发现")
            if request.mode == "auto":
                gsc_site_url = await session.scalar(
                    select(GSCConnection.site_url).where(
                        GSCConnection.project_id == project_id,
                        GSCConnection.organization_id == organization_id,
                        GSCConnection.site_url.is_not(None),
                        GSCConnection.requires_reconnect.is_(False),
                    )
                )
                if not gsc_site_url or not gsc_site_matches_domain(
                    str(gsc_site_url), project.domain
                ):
                    raise KeywordGSCRequiredError(
                        "自动发现竞争对手前必须连接 Google Search Console，"
                        "并选择与当前项目域名匹配的 property"
                    )
            active = await session.scalar(
                select(KeywordCompetitorAnalysisRun.id).where(
                    KeywordCompetitorAnalysisRun.organization_id == organization_id,
                    KeywordCompetitorAnalysisRun.project_id == project_id,
                    KeywordCompetitorAnalysisRun.status.in_(("queued", "running")),
                )
            )
            if active is not None:
                raise KeywordCompetitorAnalysisAlreadyRunningError
            bootstrap = build_competitor_analysis_bootstrap(
                organization_id=organization_id,
                project_id=project_id,
                target_domain=project.domain,
                country=project.country,
                language=project.language,
                analysis_mode=request.mode,
                competitor_domains=competitor_domains,
                local_market=(
                    request.local_market.model_dump(exclude_none=True)
                    if request.local_market is not None
                    else {}
                ),
                created_at=now,
            )
            run = competitor_analysis_run_from_bootstrap(bootstrap)
            session.add(run)
            try:
                await session.flush()
                session.add(competitor_analysis_dispatch_from_bootstrap(bootstrap))
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise KeywordCompetitorAnalysisAlreadyRunningError from exc
            return competitor_analysis_run_response(run)

    async def competitor_analysis_status(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordCompetitorAnalysisRunResponse | None:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            run = await self._latest_competitor_analysis_run(session, organization_id, project_id)
            return competitor_analysis_run_response(run) if run is not None else None

    async def list_competitors(
        self,
        organization_id: str,
        project_id: str,
        *,
        include_evidence: bool = False,
    ) -> KeywordCompetitorListResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            run = await self._competitor_result_run(session, organization_id, project_id)
            if run is None:
                return KeywordCompetitorListResponse()
            rows = list(
                (
                    await session.scalars(
                        select(KeywordCompetitor)
                        .where(KeywordCompetitor.analysis_run_id == run.id)
                        .order_by(KeywordCompetitor.provider_rank)
                    )
                ).all()
            )
            return KeywordCompetitorListResponse(
                run_id=run.id,
                items=[
                    KeywordCompetitorResponse(
                        id=row.id,
                        domain=row.domain,
                        provider_rank=row.provider_rank,
                        avg_position=row.avg_position,
                        median_position=row.median_position,
                        rating=row.rating,
                        etv=row.etv,
                        keywords_count=row.keywords_count,
                        visibility=row.visibility,
                        relevant_serp_items=row.relevant_serp_items,
                        keywords_positions=(
                            dict(row.keywords_positions or {}) if include_evidence else {}
                        ),
                        domain_type=row.domain_type,
                        is_seo_competitor=row.is_seo_competitor,
                        is_business_competitor=row.is_business_competitor,
                        classification_confidence=row.classification_confidence,
                        why_they_matter=row.why_they_matter,
                        serp_evidence=(list(row.serp_evidence or []) if include_evidence else []),
                        domain_overview={
                            key: value
                            for key, value in dict(row.domain_overview or {}).items()
                            if key in {"organic_keywords", "organic_traffic", "has_data"}
                        },
                        ranked_keywords_evidence=(
                            list(row.ranked_keywords_evidence or []) if include_evidence else []
                        ),
                        ranked_keywords_evidence_count=len(
                            list(row.ranked_keywords_evidence or [])
                        ),
                        ranked_keywords_checked=competitor_landscape_has_key(
                            row.raw_payload, "ranked_keywords_evidence"
                        ),
                        backlinks_evidence=(
                            dict(row.backlinks_evidence or {}) if include_evidence else {}
                        ),
                        selected_for_gap=row.selected_for_gap,
                        site_check_status=row.site_check_status,
                        site_relation=row.site_relation,
                        site_verification={
                            key: value
                            for key, value in dict(row.site_verification or {}).items()
                            if include_evidence
                            or key
                            in {
                                "original_domain",
                                "final_domain",
                                "site_reason",
                                "error",
                            }
                        },
                        intersections=row.intersections,
                        organic_keywords=row.organic_keywords,
                        organic_traffic=row.organic_traffic,
                        status=row.status,
                        keyword_count=row.keyword_count,
                        cost_usd=float(row.cost_usd or 0),
                        error_code=row.error_code,
                        error_detail=row.error_detail,
                    )
                    for row in rows
                ],
            )

    async def list_competitor_opportunities(
        self,
        organization_id: str,
        project_id: str,
        *,
        page: int,
        page_size: int,
        search: str = "",
        competitor_domain: str = "",
        intent: str = "",
        opportunity_status: str = "new",
        min_volume: int | None = None,
        max_difficulty: int | None = None,
        in_library: bool | None = None,
        sort: str = "opportunity_score",
        order: str = "desc",
    ) -> KeywordCompetitorOpportunityListResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            run = await self._competitor_result_run(session, organization_id, project_id)
            if run is None:
                return KeywordCompetitorOpportunityListResponse(
                    total=0, page=page, page_size=page_size
                )
            library_match = exists().where(
                Keyword.organization_id == organization_id,
                Keyword.project_id == project_id,
                Keyword.country == run.country,
                Keyword.language == run.language,
                Keyword.normalized_keyword == KeywordCompetitorOpportunity.normalized_keyword,
            )
            decision_join = and_(
                KeywordCompetitorOpportunityDecision.organization_id == organization_id,
                KeywordCompetitorOpportunityDecision.project_id == project_id,
                KeywordCompetitorOpportunityDecision.country == run.country,
                KeywordCompetitorOpportunityDecision.language == run.language,
                KeywordCompetitorOpportunityDecision.normalized_keyword
                == KeywordCompetitorOpportunity.normalized_keyword,
            )
            effective_status = func.coalesce(
                KeywordCompetitorOpportunityDecision.status,
                KeywordCompetitorOpportunity.status,
            )
            filters: list[Any] = [KeywordCompetitorOpportunity.analysis_run_id == run.id]
            normalized_search = search.strip()
            if normalized_search:
                filters.append(
                    KeywordCompetitorOpportunity.keyword.ilike(
                        f"%{escape_like(normalized_search)}%", escape="\\"
                    )
                )
            if intent:
                filters.append(KeywordCompetitorOpportunity.intent == intent)
            if opportunity_status and opportunity_status != "all":
                filters.append(effective_status == opportunity_status)
            if min_volume is not None:
                filters.append(KeywordCompetitorOpportunity.search_volume >= min_volume)
            if max_difficulty is not None:
                filters.append(KeywordCompetitorOpportunity.keyword_difficulty <= max_difficulty)
            if in_library is not None:
                filters.append(library_match if in_library else ~library_match)
            if competitor_domain:
                filters.append(
                    exists()
                    .where(
                        KeywordCompetitorOpportunityRanking.opportunity_id
                        == KeywordCompetitorOpportunity.id,
                        KeywordCompetitorOpportunityRanking.competitor_id == KeywordCompetitor.id,
                        KeywordCompetitor.domain == competitor_domain,
                    )
                    .correlate(KeywordCompetitorOpportunity)
                )

            total = int(
                await session.scalar(
                    select(func.count(KeywordCompetitorOpportunity.id))
                    .select_from(KeywordCompetitorOpportunity)
                    .outerjoin(
                        KeywordCompetitorOpportunityDecision,
                        decision_join,
                    )
                    .where(*filters)
                )
                or 0
            )
            result_rows = list(
                (
                    await session.execute(
                        select(
                            KeywordCompetitorOpportunity,
                            KeywordCompetitorOpportunityDecision.status,
                            KeywordCompetitorOpportunityDecision.keyword_id,
                            KeywordCompetitorOpportunityDecision.updated_at,
                        )
                        .outerjoin(
                            KeywordCompetitorOpportunityDecision,
                            decision_join,
                        )
                        .where(*filters)
                        .order_by(*competitor_opportunity_order(sort, order))
                        .offset((page - 1) * page_size)
                        .limit(page_size)
                    )
                ).all()
            )
            rows = [result[0] for result in result_rows]
            decision_by_normalized = {
                result[0].normalized_keyword: (result[1], result[2], result[3])
                for result in result_rows
            }
            opportunity_ids = [row.id for row in rows]
            normalized_keywords = [row.normalized_keyword for row in rows]
            ranking_rows = (
                (
                    await session.execute(
                        select(
                            KeywordCompetitorOpportunityRanking,
                            KeywordCompetitor.domain,
                        )
                        .join(
                            KeywordCompetitor,
                            KeywordCompetitor.id
                            == KeywordCompetitorOpportunityRanking.competitor_id,
                        )
                        .where(
                            KeywordCompetitorOpportunityRanking.opportunity_id.in_(opportunity_ids)
                        )
                        .order_by(
                            KeywordCompetitorOpportunityRanking.opportunity_id,
                            KeywordCompetitorOpportunityRanking.competitor_rank.asc().nulls_last(),
                            KeywordCompetitor.provider_rank,
                        )
                    )
                ).all()
                if opportunity_ids
                else []
            )
            library_rows = (
                list(
                    (
                        await session.scalars(
                            select(Keyword).where(
                                Keyword.organization_id == organization_id,
                                Keyword.project_id == project_id,
                                Keyword.country == run.country,
                                Keyword.language == run.language,
                                Keyword.normalized_keyword.in_(normalized_keywords),
                            )
                        )
                    ).all()
                )
                if normalized_keywords
                else []
            )

            rankings_by_opportunity: dict[str, list[KeywordCompetitorRankingResponse]] = {}
            for ranking, domain in ranking_rows:
                rankings_by_opportunity.setdefault(ranking.opportunity_id, []).append(
                    KeywordCompetitorRankingResponse(
                        competitor_id=ranking.competitor_id,
                        domain=domain,
                        rank=ranking.competitor_rank,
                        url=ranking.competitor_url,
                    )
                )
            library_by_normalized = {row.normalized_keyword: row for row in library_rows}
            items = []
            for row in rows:
                library_keyword = library_by_normalized.get(row.normalized_keyword)
                decision_status, decision_keyword_id, decision_updated_at = decision_by_normalized[
                    row.normalized_keyword
                ]
                items.append(
                    KeywordCompetitorOpportunityResponse(
                        id=row.id,
                        keyword=row.keyword,
                        normalized_keyword=row.normalized_keyword,
                        best_competitor_rank=row.best_competitor_rank,
                        competitor_count=row.competitor_count,
                        opportunity_score=row.opportunity_score,
                        search_volume=row.search_volume,
                        cpc=row.cpc,
                        competition=row.competition,
                        competition_level=row.competition_level,
                        keyword_difficulty=row.keyword_difficulty,
                        intent=row.intent,
                        monthly_searches=list(row.monthly_searches or []),
                        metrics_fetched_at=row.metrics_fetched_at,
                        status=decision_status or row.status,
                        keyword_id=(
                            library_keyword.id
                            if library_keyword
                            else decision_keyword_id or row.keyword_id
                        ),
                        in_library=library_keyword is not None,
                        analyzed_at=run.finished_at or run.created_at,
                        updated_at=decision_updated_at or row.updated_at,
                        rankings=rankings_by_opportunity.get(row.id, []),
                    )
                )
            return KeywordCompetitorOpportunityListResponse(
                run_id=run.id,
                analyzed_at=run.finished_at or run.created_at,
                items=items,
                total=total,
                page=page,
                page_size=page_size,
            )

    async def competitor_analysis_runs(
        self,
        organization_id: str,
        project_id: str,
        *,
        limit: int,
    ) -> KeywordCompetitorAnalysisRunListResponse:
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            rows = list(
                (
                    await session.scalars(
                        select(KeywordCompetitorAnalysisRun)
                        .where(
                            KeywordCompetitorAnalysisRun.organization_id == organization_id,
                            KeywordCompetitorAnalysisRun.project_id == project_id,
                        )
                        .order_by(KeywordCompetitorAnalysisRun.created_at.desc())
                        .limit(limit)
                    )
                ).all()
            )
            return KeywordCompetitorAnalysisRunListResponse(
                items=[
                    KeywordCompetitorAnalysisRunSummaryResponse(
                        run_id=row.id,
                        mode=row.analysis_mode,
                        status=row.status,
                        discovered_count=row.discovered_count,
                        analyzed_competitor_count=row.analyzed_competitor_count,
                        completed_competitors=row.completed_competitors,
                        unique_keyword_count=row.unique_keyword_count,
                        total_cost_usd=max(float(row.total_cost_usd or 0), 0),
                        created_at=row.created_at,
                    )
                    for row in rows
                ]
            )

    async def batch_competitor_opportunities(
        self,
        organization_id: str,
        project_id: str,
        request: KeywordCompetitorOpportunityBatchRequest,
    ) -> KeywordCompetitorOpportunityBatchResponse:
        now = datetime.now(UTC)
        unique_ids = list(dict.fromkeys(request.opportunity_ids))
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id, lock=True)
            opportunities = list(
                (
                    await session.scalars(
                        select(KeywordCompetitorOpportunity)
                        .where(
                            KeywordCompetitorOpportunity.organization_id == organization_id,
                            KeywordCompetitorOpportunity.project_id == project_id,
                            KeywordCompetitorOpportunity.id.in_(unique_ids),
                        )
                        .with_for_update()
                    )
                ).all()
            )
            if len(opportunities) != len(unique_ids):
                raise KeywordCompetitorOpportunityUnavailableError
            run_ids = {row.analysis_run_id for row in opportunities}
            runs = list(
                (
                    await session.scalars(
                        select(KeywordCompetitorAnalysisRun).where(
                            KeywordCompetitorAnalysisRun.id.in_(run_ids)
                        )
                    )
                ).all()
            )
            run_by_id = {row.id: row for row in runs}
            if len(run_by_id) != len(run_ids):
                raise KeywordCompetitorOpportunityUnavailableError
            decisions = list(
                (
                    await session.scalars(
                        select(KeywordCompetitorOpportunityDecision).where(
                            KeywordCompetitorOpportunityDecision.organization_id == organization_id,
                            KeywordCompetitorOpportunityDecision.project_id == project_id,
                            KeywordCompetitorOpportunityDecision.normalized_keyword.in_(
                                [row.normalized_keyword for row in opportunities]
                            ),
                        )
                    )
                ).all()
            )
            decision_by_market_keyword = {
                (
                    row.country,
                    row.language,
                    row.normalized_keyword,
                ): row
                for row in decisions
            }
            allowed_statuses = {
                "accept": {"new", "dismissed", "accepted"},
                "dismiss": {"new"},
                "restore": {"dismissed"},
            }
            for opportunity in opportunities:
                run = run_by_id[opportunity.analysis_run_id]
                decision = decision_by_market_keyword.get(
                    (run.country, run.language, opportunity.normalized_keyword)
                )
                effective_status = decision.status if decision else opportunity.status
                if effective_status not in allowed_statuses[request.action]:
                    raise KeywordCompetitorOpportunityUnavailableError
            if request.action == "dismiss":
                for opportunity in opportunities:
                    await self._set_competitor_opportunity_decision(
                        session,
                        opportunity=opportunity,
                        run=run_by_id[opportunity.analysis_run_id],
                        status="dismissed",
                        keyword_id=None,
                        decided_at=now,
                    )
                await session.commit()
                return KeywordCompetitorOpportunityBatchResponse(
                    updated=len(opportunities), added_to_library=0, already_in_library=0
                )
            if request.action == "restore":
                for opportunity in opportunities:
                    await self._set_competitor_opportunity_decision(
                        session,
                        opportunity=opportunity,
                        run=run_by_id[opportunity.analysis_run_id],
                        status="new",
                        keyword_id=None,
                        decided_at=None,
                    )
                await session.commit()
                return KeywordCompetitorOpportunityBatchResponse(
                    updated=len(opportunities), added_to_library=0, already_in_library=0
                )

            build_run = await session.scalar(
                select(KeywordBuildRun)
                .where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                    KeywordBuildRun.kind == "initial",
                    KeywordBuildRun.status.in_(("completed", "partial")),
                )
                .order_by(KeywordBuildRun.created_at.desc())
                .limit(1)
                .with_for_update()
            )
            if build_run is None:
                raise KeywordCompetitorOpportunityUnavailableError
            rankings = (
                await session.execute(
                    select(
                        KeywordCompetitorOpportunityRanking,
                        KeywordCompetitor.domain,
                    )
                    .join(
                        KeywordCompetitor,
                        KeywordCompetitor.id == KeywordCompetitorOpportunityRanking.competitor_id,
                    )
                    .where(KeywordCompetitorOpportunityRanking.opportunity_id.in_(unique_ids))
                )
            ).all()
            rankings_by_opportunity: dict[str, list[dict[str, Any]]] = {}
            for ranking, domain in rankings:
                rankings_by_opportunity.setdefault(ranking.opportunity_id, []).append(
                    {
                        "competitor_id": ranking.competitor_id,
                        "domain": domain,
                        "rank": ranking.competitor_rank,
                        "url": ranking.competitor_url,
                    }
                )

            added = 0
            existing_count = 0
            for opportunity in opportunities:
                run = run_by_id.get(opportunity.analysis_run_id)
                if run is None:
                    raise KeywordCompetitorOpportunityUnavailableError
                opportunity_metric_at = opportunity.metrics_fetched_at
                opportunity_metric_metadata = {
                    "analysis_run_id": opportunity.analysis_run_id,
                    "rankings": rankings_by_opportunity.get(opportunity.id, []),
                    **competitor_opportunity_metric_provenance(opportunity),
                }
                keyword = await session.scalar(
                    select(Keyword).where(
                        Keyword.organization_id == organization_id,
                        Keyword.project_id == project_id,
                        Keyword.country == run.country,
                        Keyword.language == run.language,
                        Keyword.normalized_keyword == opportunity.normalized_keyword,
                    )
                )
                keyword_is_new = keyword is None
                previous_metrics_status = keyword.metrics_status if keyword is not None else "stale"
                if keyword is None:
                    keyword = Keyword(
                        id=str(uuid4()),
                        organization_id=organization_id,
                        project_id=project_id,
                        country=run.country,
                        language=run.language,
                        keyword=opportunity.keyword,
                        normalized_keyword=opportunity.normalized_keyword,
                        classification_confidence=None,
                        review_status="approved",
                        priority_score=opportunity.opportunity_score,
                        priority_confidence=1,
                        priority_details={
                            "source": "competitor_opportunity",
                            "competitor_count": opportunity.competitor_count,
                            "best_competitor_rank": opportunity.best_competitor_rank,
                        },
                        score_version="competitor-opportunity-v1",
                        status="active",
                        metrics_status="stale",
                        first_build_run_id=build_run.id,
                        last_build_run_id=build_run.id,
                        created_at=now,
                        updated_at=now,
                    )
                    session.add(keyword)
                    await session.flush()
                    added += 1
                else:
                    keyword.status = "active"
                    keyword.archived_at = None
                    keyword.updated_at = now
                    existing_count += 1

                # Domain Intersection is the completed metric fetch; its nulls are authoritative.
                metric = await session.scalar(
                    select(KeywordMetric).where(
                        KeywordMetric.keyword_id == keyword.id,
                        KeywordMetric.provider == "dataforseo",
                    )
                )
                metric_existed = metric is not None
                metric_refreshed = False
                if metric is None:
                    metric = KeywordMetric(keyword_id=keyword.id, provider="dataforseo")
                    session.add(metric)
                    metric.raw_payload = {
                        "source": "competitor_opportunity",
                        "competitor_opportunity": opportunity_metric_metadata,
                    }
                elif metric.fetched_at is None or metric.fetched_at <= opportunity_metric_at:
                    raw_payload = dict(metric.raw_payload or {})
                    raw_payload["competitor_opportunity"] = opportunity_metric_metadata
                    metric.raw_payload = raw_payload

                if metric.fetched_at is None or metric.fetched_at <= opportunity_metric_at:
                    for field in (
                        "search_volume",
                        "cpc",
                        "competition",
                        "competition_level",
                        "keyword_difficulty",
                        "intent",
                    ):
                        setattr(metric, field, getattr(opportunity, field))
                    metric.monthly_searches = list(opportunity.monthly_searches or [])
                    metric.fetched_at = opportunity_metric_at
                    metric_refreshed = True

                if metric_refreshed:
                    keyword.metrics_status = "fresh"
                elif keyword_is_new or not metric_existed:
                    keyword.metrics_status = "stale"
                else:
                    keyword.metrics_status = previous_metrics_status

                source = await session.scalar(
                    select(KeywordSource).where(
                        KeywordSource.keyword_id == keyword.id,
                        KeywordSource.source == "competitor_opportunity",
                        KeywordSource.source_seed_key == opportunity.analysis_run_id,
                    )
                )
                if source is None:
                    session.add(
                        KeywordSource(
                            keyword_id=keyword.id,
                            source="competitor_opportunity",
                            source_seed_key=opportunity.analysis_run_id,
                            first_build_run_id=build_run.id,
                            metadata_json={
                                "opportunity_id": opportunity.id,
                                "rankings": rankings_by_opportunity.get(opportunity.id, []),
                            },
                        )
                    )
                await self._set_competitor_opportunity_decision(
                    session,
                    opportunity=opportunity,
                    run=run,
                    status="accepted",
                    keyword_id=keyword.id,
                    decided_at=now,
                )
            build_run.result_version = int(build_run.result_version or 0) + 1
            build_run.updated_at = now
            await session.commit()
            return KeywordCompetitorOpportunityBatchResponse(
                updated=len(opportunities),
                added_to_library=added,
                already_in_library=existing_count,
            )

    async def _set_competitor_opportunity_decision(
        self,
        session: AsyncSession,
        *,
        opportunity: KeywordCompetitorOpportunity,
        run: KeywordCompetitorAnalysisRun,
        status: str,
        keyword_id: str | None,
        decided_at: datetime | None,
    ) -> None:
        now = datetime.now(UTC)
        decision = await session.scalar(
            select(KeywordCompetitorOpportunityDecision).where(
                KeywordCompetitorOpportunityDecision.organization_id == opportunity.organization_id,
                KeywordCompetitorOpportunityDecision.project_id == opportunity.project_id,
                KeywordCompetitorOpportunityDecision.country == run.country,
                KeywordCompetitorOpportunityDecision.language == run.language,
                KeywordCompetitorOpportunityDecision.normalized_keyword
                == opportunity.normalized_keyword,
            )
        )
        if decision is None:
            decision = KeywordCompetitorOpportunityDecision(
                id=str(uuid4()),
                organization_id=opportunity.organization_id,
                project_id=opportunity.project_id,
                country=run.country,
                language=run.language,
                normalized_keyword=opportunity.normalized_keyword,
                status=status,
                keyword_id=keyword_id,
                decided_at=decided_at,
                created_at=now,
                updated_at=now,
            )
            session.add(decision)
        else:
            decision.status = status
            decision.keyword_id = keyword_id
            decision.decided_at = decided_at
            decision.updated_at = now

        market_runs = select(KeywordCompetitorAnalysisRun.id).where(
            KeywordCompetitorAnalysisRun.organization_id == opportunity.organization_id,
            KeywordCompetitorAnalysisRun.project_id == opportunity.project_id,
            KeywordCompetitorAnalysisRun.country == run.country,
            KeywordCompetitorAnalysisRun.language == run.language,
        )
        await session.execute(
            update(KeywordCompetitorOpportunity)
            .where(
                KeywordCompetitorOpportunity.organization_id == opportunity.organization_id,
                KeywordCompetitorOpportunity.project_id == opportunity.project_id,
                KeywordCompetitorOpportunity.analysis_run_id.in_(market_runs),
                KeywordCompetitorOpportunity.normalized_keyword == opportunity.normalized_keyword,
            )
            .values(
                status=status,
                keyword_id=keyword_id,
                decided_at=decided_at,
                updated_at=now,
            )
        )

    async def _latest_competitor_analysis_run(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
    ) -> KeywordCompetitorAnalysisRun | None:
        return await session.scalar(
            select(KeywordCompetitorAnalysisRun)
            .where(
                KeywordCompetitorAnalysisRun.organization_id == organization_id,
                KeywordCompetitorAnalysisRun.project_id == project_id,
            )
            .order_by(KeywordCompetitorAnalysisRun.created_at.desc())
            .limit(1)
        )

    async def _competitor_result_run(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
    ) -> KeywordCompetitorAnalysisRun | None:
        base = (
            select(KeywordCompetitorAnalysisRun)
            .where(
                KeywordCompetitorAnalysisRun.organization_id == organization_id,
                KeywordCompetitorAnalysisRun.project_id == project_id,
                KeywordCompetitorAnalysisRun.status.in_(("completed", "partial")),
            )
            .order_by(KeywordCompetitorAnalysisRun.created_at.desc())
            .limit(1)
        )
        return await session.scalar(base)

    async def retry_failed_initial_build(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordBuildRunResponse:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            await self._require_project(
                session,
                organization_id,
                project_id,
                lock=True,
            )
            active = await session.scalar(
                select(KeywordBuildRun.id).where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                    KeywordBuildRun.status.in_(("queued", "running", "waiting")),
                )
            )
            if active is not None:
                raise KeywordBuildAlreadyRunningError
            run = await session.scalar(
                select(KeywordBuildRun)
                .where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                    KeywordBuildRun.kind == "initial",
                    KeywordBuildRun.status == "failed",
                )
                .order_by(KeywordBuildRun.created_at.desc())
                .limit(1)
                .with_for_update()
            )
            if run is None:
                raise KeywordRetryUnavailableError

            seeds = list(
                (
                    await session.scalars(
                        select(KeywordSeed).where(
                            KeywordSeed.initial_run_id == run.id,
                            KeywordSeed.decision == "selected",
                        )
                    )
                ).all()
            )
            for seed in seeds:
                seed.expansion_status = "not_applicable"
                seed.expansion_run_id = None
                seed.expansion_round_number = None
                seed.expanded_at = None
                seed.updated_at = now

            run.status = "queued"
            run.stage = "queued"
            run.message = "关键词库重试已进入队列"
            run.progress = 0
            run.selected_count = len(seeds)
            run.keyword_count = 0
            run.pending_seed_count = 0
            run.partial_failures = []
            run.gap_status = "pending" if run.competitor_domain else "not_requested"
            run.gap_message = ""
            run.gap_count = 0
            run.error_code = None
            run.error_detail = None
            run.started_at = None
            run.finished_at = None
            run.updated_at = now

            dispatch = await session.get(KeywordWorkflowDispatch, run.id)
            workflow_id = f"keywords:build:{run.id}:retry:{uuid4()}"
            task_payload = {
                "organization_id": organization_id,
                "project_id": project_id,
                "run_id": run.id,
                "kind": "initial",
                "round_number": run.round_number,
            }
            if dispatch is None:
                dispatch = KeywordWorkflowDispatch(
                    run_id=run.id,
                    workflow_id=workflow_id,
                    task_payload=task_payload,
                    status="pending",
                    created_at=now,
                    updated_at=now,
                    next_attempt_at=now,
                )
                session.add(dispatch)
            else:
                dispatch.workflow_id = workflow_id
                dispatch.task_payload = task_payload
                dispatch.status = "pending"
                dispatch.attempts = 0
                dispatch.last_error = None
                dispatch.next_attempt_at = now
                dispatch.dispatched_at = None
                dispatch.last_checked_at = None
                dispatch.updated_at = now
            await session.commit()
            return build_run_response(run)

    async def batch_status(
        self,
        organization_id: str,
        project_id: str,
        request: KeywordBatchStatusRequest,
    ) -> KeywordBatchStatusResponse:
        now = datetime.now(UTC)
        values: dict[str, Any] = {
            "status": request.status,
            "updated_at": now,
            "archived_at": now if request.status == "archived" else None,
        }
        async with self.sessions() as session:
            result = await session.execute(
                update(Keyword)
                .where(
                    Keyword.organization_id == organization_id,
                    Keyword.project_id == project_id,
                    Keyword.id.in_(request.keyword_ids),
                )
                .values(**values)
                .returning(Keyword.id)
            )
            updated = len(result.all())
            await session.commit()
            return KeywordBatchStatusResponse(updated=updated)

    async def assign_tags(
        self,
        organization_id: str,
        project_id: str,
        request: KeywordTagAssignmentRequest,
    ) -> KeywordTagAssignmentResponse:
        normalized_tags = normalize_tags(request.tag_names)
        async with self.sessions() as session:
            await self._require_project(session, organization_id, project_id)
            keyword_ids = list(
                (
                    await session.scalars(
                        select(Keyword.id).where(
                            Keyword.organization_id == organization_id,
                            Keyword.project_id == project_id,
                            Keyword.id.in_(request.keyword_ids),
                        )
                    )
                ).all()
            )
            tags: list[KeywordTag] = []
            for name, normalized_name in normalized_tags:
                tag = await session.scalar(
                    select(KeywordTag).where(
                        KeywordTag.project_id == project_id,
                        KeywordTag.normalized_name == normalized_name,
                    )
                )
                if tag is None:
                    tag = KeywordTag(
                        id=str(uuid4()),
                        project_id=project_id,
                        name=name,
                        normalized_name=normalized_name,
                    )
                    session.add(tag)
                    await session.flush()
                tags.append(tag)
            for keyword_id in keyword_ids:
                for tag in tags:
                    assignment_exists = await session.scalar(
                        select(KeywordTagAssignment.keyword_id).where(
                            KeywordTagAssignment.keyword_id == keyword_id,
                            KeywordTagAssignment.tag_id == tag.id,
                        )
                    )
                    if assignment_exists is None:
                        session.add(
                            KeywordTagAssignment(
                                keyword_id=keyword_id,
                                tag_id=tag.id,
                            )
                        )
            await session.commit()
            return KeywordTagAssignmentResponse(
                updated=len(keyword_ids),
                tags=[
                    KeywordTagResponse(id=tag.id, name=tag.name, color=tag.color) for tag in tags
                ],
            )

    async def resume_ready_blocked_runs(
        self,
        organization_id: str,
        *,
        service_started_at: datetime,
        dataforseo_environment_configured: bool,
        ai_environment_configured: bool,
        limit: int,
    ) -> int:
        now = datetime.now(UTC)
        dataforseo_setting_is_newer = exists(
            select(DataForSEOProviderSetting.organization_id).where(
                DataForSEOProviderSetting.organization_id == organization_id,
                DataForSEOProviderSetting.updated_at > KeywordBuildRun.updated_at,
            )
        )
        ai_setting_is_newer = exists(
            select(AIProviderSetting.organization_id).where(
                AIProviderSetting.organization_id == organization_id,
                AIProviderSetting.updated_at > KeywordBuildRun.updated_at,
            )
        )
        project_is_newer = exists(
            select(Project.id).where(
                Project.id == KeywordBuildRun.project_id,
                Project.updated_at > KeywordBuildRun.updated_at,
            )
        )
        dataforseo_ready = or_(
            dataforseo_setting_is_newer,
            and_(
                dataforseo_environment_configured,
                KeywordBuildRun.updated_at < service_started_at,
            ),
        )
        ai_ready = or_(
            ai_setting_is_newer,
            and_(
                ai_environment_configured,
                KeywordBuildRun.updated_at < service_started_at,
            ),
        )
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(KeywordBuildRun, KeywordWorkflowDispatch)
                    .join(
                        KeywordWorkflowDispatch,
                        KeywordWorkflowDispatch.run_id == KeywordBuildRun.id,
                    )
                    .where(
                        KeywordBuildRun.organization_id == organization_id,
                        KeywordBuildRun.status == "blocked",
                        or_(
                            and_(
                                KeywordBuildRun.next_retry_at.is_not(None),
                                KeywordBuildRun.next_retry_at <= now,
                            ),
                            and_(
                                KeywordBuildRun.error_code == "dataforseo_not_configured",
                                dataforseo_ready,
                            ),
                            and_(
                                KeywordBuildRun.error_code == "dataforseo_auth_failed",
                                dataforseo_setting_is_newer,
                            ),
                            and_(
                                KeywordBuildRun.error_code == "ai_not_configured",
                                ai_ready,
                            ),
                            and_(
                                KeywordBuildRun.error_code == "ai_auth_failed",
                                ai_setting_is_newer,
                            ),
                            and_(
                                KeywordBuildRun.error_code.in_(
                                    ("unsupported_country", "unsupported_language")
                                ),
                                project_is_newer,
                            ),
                        ),
                    )
                    .order_by(
                        KeywordBuildRun.next_retry_at.asc().nulls_last(),
                        KeywordBuildRun.updated_at,
                        KeywordBuildRun.id,
                    )
                    .limit(max(1, min(limit, 100)))
                    .with_for_update(
                        skip_locked=True,
                        of=KeywordBuildRun,
                    )
                )
            ).all()
            for run, dispatch in rows:
                task_payload = dict(dispatch.task_payload)
                task_payload["_recovery_count"] = int(run.recovery_count or 0)
                dispatch.workflow_id = (
                    f"keywords:build:{run.id}:resume:{run.recovery_count}:{uuid4()}"
                )
                dispatch.task_payload = task_payload
                dispatch.status = "pending"
                dispatch.attempts = 0
                dispatch.last_error = None
                dispatch.next_attempt_at = now
                dispatch.dispatched_at = None
                dispatch.last_checked_at = None
                dispatch.updated_at = now
                run.status = "queued"
                run.stage = "waiting_for_recovery"
                run.message = "后台条件已恢复，正在继续创建关键词库"
                run.next_retry_at = None
                run.finished_at = None
                run.updated_at = now
            await session.commit()
            return len(rows)

    async def settle_stale_external_requests(self) -> int:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            prepared = await session.execute(
                update(KeywordExternalRequest)
                .where(
                    KeywordExternalRequest.status == "prepared",
                    KeywordExternalRequest.lease_expires_at.is_not(None),
                    KeywordExternalRequest.lease_expires_at <= now,
                )
                .values(
                    status="retryable_failed",
                    error_code="external_request_prepare_expired",
                    error_detail="外部请求在提交前中断，可以安全重试",
                    lease_expires_at=None,
                    finished_at=now,
                )
            )
            submitted = await session.execute(
                update(KeywordExternalRequest)
                .where(
                    KeywordExternalRequest.status == "submitted",
                    KeywordExternalRequest.lease_expires_at.is_not(None),
                    KeywordExternalRequest.lease_expires_at <= now,
                )
                .values(
                    status="uncertain",
                    error_code="external_request_outcome_unknown",
                    error_detail="外部请求提交后未能确认最终结果",
                    lease_expires_at=None,
                    finished_at=now,
                )
            )
            await session.commit()
            return int(prepared.rowcount or 0) + int(submitted.rowcount or 0)

    async def cleanup_operational_data(self, *, retention_days: int) -> int:
        now = datetime.now(UTC)
        cutoff = now - timedelta(days=max(retention_days, 30))
        heartbeat_cutoff = now - timedelta(days=1)
        terminal_run = or_(
            exists(
                select(KeywordBuildRun.id).where(
                    KeywordBuildRun.id == KeywordExternalRequest.build_run_id,
                    KeywordBuildRun.status.in_(("partial", "completed", "failed", "cancelled")),
                )
            ),
            exists(
                select(KeywordCompetitorAnalysisRun.id).where(
                    KeywordCompetitorAnalysisRun.id
                    == KeywordExternalRequest.competitor_analysis_run_id,
                    KeywordCompetitorAnalysisRun.status.in_(("partial", "completed", "failed")),
                )
            ),
        )
        terminal_idea_run = exists(
            select(KeywordBuildRun.id).where(
                KeywordBuildRun.id == KeywordIdea.build_run_id,
                KeywordBuildRun.status.in_(("partial", "completed", "failed", "cancelled")),
            )
        )
        terminal_source_run = exists(
            select(KeywordBuildRun.id).where(
                KeywordBuildRun.id == KeywordSource.first_build_run_id,
                KeywordBuildRun.status.in_(("partial", "completed", "failed", "cancelled")),
            )
        )
        async with self.sessions() as session:
            compacted = await session.execute(
                update(KeywordExternalRequest)
                .where(
                    KeywordExternalRequest.finished_at.is_not(None),
                    KeywordExternalRequest.finished_at < cutoff,
                    terminal_run,
                    or_(
                        KeywordExternalRequest.response_metadata.op("?")("payload"),
                        KeywordExternalRequest.response_metadata.op("?")("rows"),
                    ),
                )
                .values(
                    response_metadata=(
                        KeywordExternalRequest.response_metadata.op("-")("payload")
                    ).op("-")("rows")
                )
            )
            deleted_heartbeats = await session.execute(
                delete(KeywordWorkerHeartbeat).where(
                    KeywordWorkerHeartbeat.last_seen_at < heartbeat_cutoff
                )
            )
            compacted_ideas = await session.execute(
                update(KeywordIdea)
                .where(
                    KeywordIdea.created_at < cutoff,
                    terminal_idea_run,
                    or_(
                        KeywordIdea.raw_payload != {},
                        KeywordIdea.metrics_payload != {},
                    ),
                )
                .values(raw_payload={}, metrics_payload={})
            )
            compacted_sources = await session.execute(
                update(KeywordSource)
                .where(
                    KeywordSource.created_at < cutoff,
                    terminal_source_run,
                    KeywordSource.metadata_json.op("?")("raw_payload"),
                )
                .values(metadata_json=KeywordSource.metadata_json.op("-")("raw_payload"))
            )
            compacted_metrics = await session.execute(
                update(KeywordMetric)
                .where(
                    KeywordMetric.fetched_at < cutoff,
                    KeywordMetric.raw_payload != {},
                )
                .values(raw_payload={})
            )
            await session.commit()
            return sum(
                int(result.rowcount or 0)
                for result in (
                    compacted,
                    deleted_heartbeats,
                    compacted_ideas,
                    compacted_sources,
                    compacted_metrics,
                )
            )

    async def mark_active_runs_waiting_for_worker(
        self,
        organization_id: str,
        *,
        stale_seconds: int,
    ) -> int:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            build_result = await session.execute(
                update(KeywordBuildRun)
                .where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.status.in_(("queued", "running", "waiting")),
                    KeywordBuildRun.updated_at < now - timedelta(seconds=max(stale_seconds, 10)),
                )
                .values(
                    status="waiting",
                    stage="waiting_for_worker",
                    message="关键词服务正在恢复，任务进度已保存",
                    next_retry_at=now + timedelta(seconds=max(stale_seconds, 10)),
                    updated_at=now,
                )
            )
            competitor_result = await session.execute(
                update(KeywordCompetitorAnalysisRun)
                .where(
                    KeywordCompetitorAnalysisRun.organization_id == organization_id,
                    KeywordCompetitorAnalysisRun.status.in_(("queued", "running")),
                    KeywordCompetitorAnalysisRun.updated_at
                    < now - timedelta(seconds=max(stale_seconds, 10)),
                )
                .values(
                    stage="waiting_for_worker",
                    message="关键词服务正在恢复，竞争分析进度已保存",
                    updated_at=now,
                )
            )
            await session.commit()
            return int(build_result.rowcount or 0) + int(competitor_result.rowcount or 0)

    async def operational_health(
        self,
        organization_id: str,
        *,
        task_queue: str,
        worker_stale_seconds: int,
    ) -> KeywordOperationalHealth:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            worker_last_seen_at = await session.scalar(
                select(func.max(KeywordWorkerHeartbeat.last_seen_at)).where(
                    KeywordWorkerHeartbeat.task_queue == task_queue
                )
            )
            run_counts = (
                await session.execute(
                    select(
                        func.count(KeywordBuildRun.id)
                        .filter(KeywordBuildRun.status.in_(("queued", "running", "waiting")))
                        .label("active"),
                        func.count(KeywordBuildRun.id)
                        .filter(KeywordBuildRun.status == "waiting")
                        .label("waiting"),
                        func.count(KeywordBuildRun.id)
                        .filter(KeywordBuildRun.status == "blocked")
                        .label("blocked"),
                    ).where(KeywordBuildRun.organization_id == organization_id)
                )
            ).one()
            competitor_run_counts = (
                await session.execute(
                    select(
                        func.count(KeywordCompetitorAnalysisRun.id)
                        .filter(KeywordCompetitorAnalysisRun.status.in_(("queued", "running")))
                        .label("active"),
                        func.count(KeywordCompetitorAnalysisRun.id)
                        .filter(
                            KeywordCompetitorAnalysisRun.status.in_(("queued", "running")),
                            KeywordCompetitorAnalysisRun.stage == "waiting_for_worker",
                        )
                        .label("waiting"),
                    ).where(KeywordCompetitorAnalysisRun.organization_id == organization_id)
                )
            ).one()
            request_counts = (
                await session.execute(
                    select(
                        func.count(KeywordExternalRequest.id)
                        .filter(
                            KeywordExternalRequest.status == "prepared",
                            KeywordExternalRequest.lease_expires_at.is_not(None),
                            KeywordExternalRequest.lease_expires_at <= now,
                        )
                        .label("stale_prepared"),
                        func.count(KeywordExternalRequest.id)
                        .filter(KeywordExternalRequest.status == "uncertain")
                        .label("uncertain"),
                        func.count(KeywordExternalRequest.id)
                        .filter(KeywordExternalRequest.status == "charged_failed")
                        .label("charged_failed"),
                    ).where(
                        KeywordExternalRequest.organization_id == organization_id,
                    )
                )
            ).one()
            metric_refresh_counts = (
                await session.execute(
                    select(
                        func.count(KeywordMetricRefreshJob.run_id)
                        .filter(KeywordMetricRefreshJob.status.in_(("pending", "waiting")))
                        .label("waiting"),
                        func.count(KeywordMetricRefreshJob.run_id)
                        .filter(KeywordMetricRefreshJob.status.in_(("dispatched", "running")))
                        .label("running"),
                        func.count(KeywordMetricRefreshJob.run_id)
                        .filter(
                            KeywordMetricRefreshJob.status == "exhausted",
                            exists(
                                select(Keyword.id).where(
                                    Keyword.last_build_run_id == KeywordMetricRefreshJob.run_id,
                                    Keyword.metrics_status == "failed",
                                    Keyword.status == "active",
                                )
                            ),
                        )
                        .label("exhausted"),
                    ).where(KeywordMetricRefreshJob.organization_id == organization_id)
                )
            ).one()
            failed_metrics = await session.scalar(
                select(func.count(Keyword.id)).where(
                    Keyword.organization_id == organization_id,
                    Keyword.metrics_status == "failed",
                    Keyword.status == "active",
                )
            )
        worker_healthy = bool(
            worker_last_seen_at is not None
            and (now - worker_last_seen_at).total_seconds() <= max(worker_stale_seconds, 10)
        )
        return KeywordOperationalHealth(
            worker_healthy=worker_healthy,
            worker_last_seen_at=worker_last_seen_at,
            active_runs=(int(run_counts.active or 0) + int(competitor_run_counts.active or 0)),
            waiting_runs=(int(run_counts.waiting or 0) + int(competitor_run_counts.waiting or 0)),
            blocked_runs=int(run_counts.blocked or 0),
            stale_prepared_requests=int(request_counts.stale_prepared or 0),
            uncertain_requests=int(request_counts.uncertain or 0),
            charged_failed_requests=int(request_counts.charged_failed or 0),
            metric_refresh_waiting=int(metric_refresh_counts.waiting or 0),
            metric_refresh_running=int(metric_refresh_counts.running or 0),
            metric_refresh_exhausted=int(metric_refresh_counts.exhausted or 0),
            failed_metrics=int(failed_metrics or 0),
        )

    async def list_pending_dispatches(self, limit: int) -> list[KeywordDispatchRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        KeywordWorkflowDispatch.run_id,
                        KeywordWorkflowDispatch.workflow_id,
                        KeywordWorkflowDispatch.task_payload,
                    )
                    .where(
                        KeywordWorkflowDispatch.status == "pending",
                        KeywordWorkflowDispatch.next_attempt_at <= datetime.now(UTC),
                    )
                    .order_by(
                        KeywordWorkflowDispatch.created_at,
                        KeywordWorkflowDispatch.run_id,
                    )
                    .limit(max(1, min(limit, 100)))
                )
            ).all()
            return [
                KeywordDispatchRecord(
                    run_id=row.run_id,
                    workflow_id=row.workflow_id,
                    task_payload=dict(row.task_payload),
                )
                for row in rows
            ]

    async def claim_pending_competitor_analysis_dispatches(
        self, limit: int
    ) -> list[KeywordCompetitorAnalysisDispatchRecord]:
        async with self.sessions() as session:
            now = datetime.now(UTC)
            rows = list(
                (
                    await session.scalars(
                        select(KeywordCompetitorAnalysisDispatch)
                        .where(
                            KeywordCompetitorAnalysisDispatch.status.in_(
                                ("pending", "dispatching")
                            ),
                            KeywordCompetitorAnalysisDispatch.next_attempt_at <= now,
                        )
                        .order_by(
                            KeywordCompetitorAnalysisDispatch.created_at,
                            KeywordCompetitorAnalysisDispatch.run_id,
                        )
                        .limit(max(1, min(limit, 100)))
                        .with_for_update(skip_locked=True)
                    )
                ).all()
            )
            records = [
                KeywordCompetitorAnalysisDispatchRecord(
                    run_id=row.run_id,
                    workflow_id=row.workflow_id,
                    task_payload=dict(row.task_payload),
                )
                for row in rows
            ]
            for row in rows:
                row.status = "dispatching"
                row.next_attempt_at = now + timedelta(minutes=1)
                row.updated_at = now
            await session.commit()
            return records

    async def mark_competitor_analysis_dispatch_succeeded(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        async with self.sessions() as session:
            now = datetime.now(UTC)
            await session.execute(
                update(KeywordCompetitorAnalysisDispatch)
                .where(
                    KeywordCompetitorAnalysisDispatch.run_id == run_id,
                    KeywordCompetitorAnalysisDispatch.workflow_id == expected_workflow_id,
                    KeywordCompetitorAnalysisDispatch.status == "dispatching",
                )
                .values(
                    status="dispatched",
                    last_error=None,
                    dispatched_at=now,
                    updated_at=now,
                )
            )
            await session.commit()

    async def record_competitor_analysis_dispatch_failure(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        message: str,
    ) -> None:
        async with self.sessions() as session:
            dispatch = await session.scalar(
                select(KeywordCompetitorAnalysisDispatch)
                .where(
                    KeywordCompetitorAnalysisDispatch.run_id == run_id,
                    KeywordCompetitorAnalysisDispatch.workflow_id == expected_workflow_id,
                )
                .with_for_update()
            )
            if dispatch is None or dispatch.status != "dispatching":
                return
            dispatch.attempts += 1
            dispatch.status = "pending"
            dispatch.last_error = message[:2000]
            dispatch.next_attempt_at = datetime.now(UTC) + timedelta(
                seconds=min(60, 2 ** min(dispatch.attempts, 6))
            )
            dispatch.updated_at = datetime.now(UTC)
            run = await session.get(KeywordCompetitorAnalysisRun, run_id)
            if run is not None and run.status == "queued":
                run.message = "任务已保存，等待关键词服务恢复后自动重试"
                run.updated_at = datetime.now(UTC)
            await session.commit()

    async def list_active_competitor_analysis_workflows(
        self,
        organization_id: str,
        limit: int,
    ) -> list[KeywordCompetitorAnalysisActiveWorkflowRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        KeywordCompetitorAnalysisRun.id,
                        KeywordCompetitorAnalysisDispatch.workflow_id,
                        KeywordCompetitorAnalysisRun.updated_at,
                    )
                    .join(
                        KeywordCompetitorAnalysisDispatch,
                        KeywordCompetitorAnalysisDispatch.run_id == KeywordCompetitorAnalysisRun.id,
                    )
                    .where(
                        KeywordCompetitorAnalysisRun.organization_id == organization_id,
                        KeywordCompetitorAnalysisRun.status.in_(("queued", "running")),
                        KeywordCompetitorAnalysisDispatch.status == "dispatched",
                    )
                    .order_by(
                        KeywordCompetitorAnalysisDispatch.last_checked_at.asc().nulls_first(),
                        KeywordCompetitorAnalysisRun.updated_at,
                        KeywordCompetitorAnalysisRun.id,
                    )
                    .limit(max(1, min(limit, 100)))
                )
            ).all()
            return [
                KeywordCompetitorAnalysisActiveWorkflowRecord(
                    run_id=row.id,
                    workflow_id=row.workflow_id,
                    updated_at=row.updated_at,
                )
                for row in rows
            ]

    async def mark_competitor_analysis_workflow_checked(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(KeywordCompetitorAnalysisDispatch)
                .where(
                    KeywordCompetitorAnalysisDispatch.run_id == run_id,
                    KeywordCompetitorAnalysisDispatch.workflow_id == expected_workflow_id,
                )
                .values(last_checked_at=datetime.now(UTC))
            )
            await session.commit()

    async def requeue_orphaned_competitor_analysis_workflow(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        max_recoveries: int,
    ) -> bool:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(KeywordCompetitorAnalysisRun)
                .where(KeywordCompetitorAnalysisRun.id == run_id)
                .with_for_update()
            )
            dispatch = await session.scalar(
                select(KeywordCompetitorAnalysisDispatch)
                .where(KeywordCompetitorAnalysisDispatch.run_id == run_id)
                .with_for_update()
            )
            if (
                run is None
                or dispatch is None
                or run.status not in {"queued", "running"}
                or dispatch.status != "dispatched"
                or dispatch.workflow_id != expected_workflow_id
            ):
                return False

            recovery_limit = max(max_recoveries, 1)
            if int(run.recovery_count or 0) >= recovery_limit:
                run.status = "failed"
                run.stage = "failed"
                run.message = "竞争分析连续失联，已停止自动恢复"
                run.progress = 100
                run.error_code = "competitor_analysis_recovery_exhausted"
                run.error_detail = "竞争分析工作流连续异常，已达到自动恢复上限"
                run.finished_at = now
                run.updated_at = now
                dispatch.last_error = run.error_detail
                dispatch.last_checked_at = now
                dispatch.updated_at = now
                await session.commit()
                return False

            next_recovery_count = int(run.recovery_count or 0) + 1
            workflow_id = (
                f"keywords:competitor-analysis:{run.id}:recovery:{next_recovery_count}:{uuid4()}"
            )
            task_payload = dict(dispatch.task_payload)
            task_payload["_recovery_count"] = next_recovery_count
            dispatch.workflow_id = workflow_id
            dispatch.task_payload = task_payload
            dispatch.status = "pending"
            dispatch.attempts = 0
            dispatch.last_error = None
            dispatch.next_attempt_at = now
            dispatch.dispatched_at = None
            dispatch.last_checked_at = None
            dispatch.updated_at = now
            run.workflow_id = workflow_id
            run.status = "queued"
            run.stage = "waiting_for_recovery"
            run.message = "后台任务已恢复，正在继续竞争分析"
            run.recovery_count = next_recovery_count
            run.error_code = None
            run.error_detail = None
            run.finished_at = None
            run.updated_at = now
            await session.commit()
            return True

    async def list_pending_metric_dispatches(
        self,
        limit: int,
    ) -> list[KeywordMetricDispatchRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        KeywordMetricRefreshJob.run_id,
                        KeywordMetricRefreshJob.workflow_id,
                        KeywordMetricRefreshJob.task_payload,
                    )
                    .where(
                        KeywordMetricRefreshJob.status.in_(("pending", "waiting")),
                        KeywordMetricRefreshJob.next_attempt_at <= datetime.now(UTC),
                    )
                    .order_by(
                        KeywordMetricRefreshJob.next_attempt_at,
                        KeywordMetricRefreshJob.updated_at,
                        KeywordMetricRefreshJob.run_id,
                    )
                    .limit(max(1, min(limit, 100)))
                )
            ).all()
            return [
                KeywordMetricDispatchRecord(
                    run_id=row.run_id,
                    workflow_id=row.workflow_id,
                    task_payload=dict(row.task_payload),
                )
                for row in rows
            ]

    async def mark_metric_dispatch_succeeded(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            await session.execute(
                update(KeywordMetricRefreshJob)
                .where(
                    KeywordMetricRefreshJob.run_id == run_id,
                    KeywordMetricRefreshJob.workflow_id == expected_workflow_id,
                    KeywordMetricRefreshJob.status.in_(("pending", "waiting")),
                )
                .values(
                    status="dispatched",
                    dispatched_at=now,
                    last_error_code=None,
                    last_error_detail=None,
                    updated_at=now,
                )
            )
            await session.commit()

    async def record_metric_dispatch_failure(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        message: str,
    ) -> None:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            await session.execute(
                update(KeywordMetricRefreshJob)
                .where(
                    KeywordMetricRefreshJob.run_id == run_id,
                    KeywordMetricRefreshJob.workflow_id == expected_workflow_id,
                    KeywordMetricRefreshJob.status.in_(("pending", "waiting")),
                )
                .values(
                    status="pending",
                    next_attempt_at=now + timedelta(seconds=10),
                    last_error_code="metric_workflow_dispatch_failed",
                    last_error_detail=message[:2000],
                    updated_at=now,
                )
            )
            await session.commit()

    async def list_active_metric_workflows(
        self,
        organization_id: str,
        limit: int,
    ) -> list[KeywordMetricActiveWorkflowRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        KeywordMetricRefreshJob.run_id,
                        KeywordMetricRefreshJob.workflow_id,
                        KeywordMetricRefreshJob.updated_at,
                    )
                    .where(
                        KeywordMetricRefreshJob.organization_id == organization_id,
                        KeywordMetricRefreshJob.status.in_(("dispatched", "running")),
                    )
                    .order_by(
                        KeywordMetricRefreshJob.last_checked_at.asc().nulls_first(),
                        KeywordMetricRefreshJob.updated_at,
                        KeywordMetricRefreshJob.run_id,
                    )
                    .limit(max(1, min(limit, 100)))
                )
            ).all()
            return [
                KeywordMetricActiveWorkflowRecord(
                    run_id=row.run_id,
                    workflow_id=row.workflow_id,
                    updated_at=row.updated_at,
                )
                for row in rows
            ]

    async def mark_metric_workflow_checked(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(KeywordMetricRefreshJob)
                .where(
                    KeywordMetricRefreshJob.run_id == run_id,
                    KeywordMetricRefreshJob.workflow_id == expected_workflow_id,
                )
                .values(last_checked_at=datetime.now(UTC))
            )
            await session.commit()

    async def requeue_orphaned_metric_workflow(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> bool:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            job = await session.scalar(
                select(KeywordMetricRefreshJob)
                .where(KeywordMetricRefreshJob.run_id == run_id)
                .with_for_update()
            )
            if (
                job is None
                or job.workflow_id != expected_workflow_id
                or job.status not in {"dispatched", "running"}
            ):
                return False
            next_replay_count = min(
                job.orphan_replay_count + 1,
                METRIC_ORPHAN_REPLAY_LIMIT,
            )
            if next_replay_count >= METRIC_ORPHAN_REPLAY_LIMIT:
                await session.execute(
                    select(Project.id).where(Project.id == job.project_id).with_for_update()
                )
                failed_metrics = await session.execute(
                    update(Keyword)
                    .where(
                        Keyword.organization_id == job.organization_id,
                        Keyword.project_id == job.project_id,
                        Keyword.last_build_run_id == job.run_id,
                        Keyword.metrics_status == "pending",
                    )
                    .values(metrics_status="failed", updated_at=now)
                )
                failed_count = int(failed_metrics.rowcount or 0)
                job.orphan_replay_count = next_replay_count
                job.finished_at = now
                job.updated_at = now
                if failed_count == 0:
                    job.status = "completed"
                    job.last_error_code = None
                    job.last_error_detail = None
                    await session.commit()
                    return True

                run = await session.scalar(
                    select(KeywordBuildRun)
                    .where(KeywordBuildRun.id == job.run_id)
                    .with_for_update()
                )
                if run is not None:
                    failure = {
                        "source": "keyword_overview_recovery",
                        "code": "metric_workflow_orphaned_exhausted",
                        "message": "部分关键词指标暂时不可用",
                    }
                    partial_failures = list(run.partial_failures or [])
                    if not any(
                        isinstance(item, dict)
                        and item.get("source") == failure["source"]
                        and item.get("code") == failure["code"]
                        for item in partial_failures
                    ):
                        partial_failures.append(failure)
                    latest_version = await session.scalar(
                        select(func.coalesce(func.max(KeywordBuildRun.result_version), 0)).where(
                            KeywordBuildRun.organization_id == job.organization_id,
                            KeywordBuildRun.project_id == job.project_id,
                        )
                    )
                    run.partial_failures = partial_failures
                    run.status = "partial"
                    run.stage = "partial"
                    run.message = "关键词库已建立，部分指标暂不可用"
                    run.result_version = int(latest_version or 0) + 1
                    run.updated_at = now
                job.status = "exhausted"
                job.last_error_code = "metric_workflow_orphaned_exhausted"
                job.last_error_detail = "指标恢复工作流连续异常，已停止自动恢复"
                await session.commit()
                return True
            replay_attempt = max(job.attempt_count, 1)
            next_workflow_id = f"keyword-metrics:{job.run_id}:{replay_attempt}:{uuid4()}"
            payload = dict(job.task_payload)
            payload["_metric_workflow_id"] = next_workflow_id
            if job.status == "running" and job.attempt_count > 0:
                job.attempt_count -= 1
            job.workflow_id = next_workflow_id
            job.task_payload = payload
            job.status = "pending"
            job.next_attempt_at = now
            job.dispatched_at = None
            job.last_checked_at = None
            job.last_error_code = "metric_workflow_orphaned"
            job.last_error_detail = "指标恢复工作流意外结束，已重新排队"
            job.orphan_replay_count = next_replay_count
            job.updated_at = now
            await session.commit()
            return True

    async def list_active_workflows(
        self,
        organization_id: str,
        limit: int,
    ) -> list[KeywordActiveWorkflowRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        KeywordBuildRun.id,
                        KeywordBuildRun.status,
                        KeywordBuildRun.updated_at,
                        KeywordWorkflowDispatch.workflow_id,
                        KeywordWorkflowDispatch.task_payload,
                        KeywordWorkflowDispatch.status.label("dispatch_status"),
                    )
                    .join(
                        KeywordWorkflowDispatch,
                        KeywordWorkflowDispatch.run_id == KeywordBuildRun.id,
                    )
                    .where(
                        KeywordBuildRun.organization_id == organization_id,
                        KeywordBuildRun.status.in_(("queued", "running", "waiting")),
                    )
                    .order_by(
                        KeywordWorkflowDispatch.last_checked_at.asc().nulls_first(),
                        KeywordBuildRun.updated_at,
                        KeywordBuildRun.id,
                    )
                    .limit(max(1, min(limit, 100)))
                )
            ).all()
            return [
                KeywordActiveWorkflowRecord(
                    run_id=row.id,
                    workflow_id=row.workflow_id,
                    task_payload=dict(row.task_payload),
                    run_status=row.status,
                    dispatch_status=row.dispatch_status,
                    updated_at=row.updated_at,
                )
                for row in rows
            ]

    async def mark_workflow_checked(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(KeywordWorkflowDispatch)
                .where(
                    KeywordWorkflowDispatch.run_id == run_id,
                    KeywordWorkflowDispatch.workflow_id == expected_workflow_id,
                )
                .values(last_checked_at=datetime.now(UTC))
            )
            await session.commit()

    async def requeue_orphaned_workflow(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        max_recoveries: int,
    ) -> bool:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(KeywordBuildRun).where(KeywordBuildRun.id == run_id).with_for_update()
            )
            dispatch = await session.scalar(
                select(KeywordWorkflowDispatch)
                .where(KeywordWorkflowDispatch.run_id == run_id)
                .with_for_update()
            )
            if (
                run is None
                or dispatch is None
                or run.status not in {"queued", "running", "waiting"}
                or dispatch.workflow_id != expected_workflow_id
            ):
                return False
            task_payload = dict(dispatch.task_payload)
            orphan_recovery_count = max(
                int(task_payload.get("_orphan_recovery_count") or 0),
                0,
            )
            if orphan_recovery_count >= max(max_recoveries, 1):
                run.status = "blocked"
                run.stage = "waiting_for_recovery"
                run.message = "后台任务暂时不可用，系统稍后自动继续"
                run.error_code = "workflow_recovery_exhausted"
                run.error_detail = "关键词工作流连续失联，已暂停快速恢复"
                run.next_retry_at = now + timedelta(hours=1)
                run.finished_at = None
                run.updated_at = now
                dispatch.last_error = run.error_detail
                dispatch.updated_at = now
                await session.commit()
                return False
            next_recovery_count = int(run.recovery_count or 0) + 1
            task_payload["_recovery_count"] = next_recovery_count
            task_payload["_orphan_recovery_count"] = orphan_recovery_count + 1
            dispatch.workflow_id = (
                f"keywords:build:{run.id}:recovery:{next_recovery_count}:{uuid4()}"
            )
            dispatch.task_payload = task_payload
            dispatch.status = "pending"
            dispatch.attempts = 0
            dispatch.last_error = None
            dispatch.next_attempt_at = now
            dispatch.dispatched_at = None
            dispatch.last_checked_at = None
            dispatch.updated_at = now
            run.status = "queued"
            run.stage = "waiting_for_recovery"
            run.message = "后台任务已恢复，正在继续创建关键词库"
            run.recovery_count = next_recovery_count
            run.next_retry_at = None
            run.finished_at = None
            run.updated_at = now
            await session.commit()
            return True

    async def mark_dispatch_succeeded(self, run_id: str) -> None:
        async with self.sessions() as session:
            dispatch = await session.get(KeywordWorkflowDispatch, run_id)
            if dispatch is None:
                return
            now = datetime.now(UTC)
            dispatch.status = "dispatched"
            dispatch.last_error = None
            dispatch.dispatched_at = now
            dispatch.updated_at = now
            await session.commit()

    async def record_dispatch_failure(self, run_id: str, message: str) -> None:
        async with self.sessions() as session:
            dispatch = await session.scalar(
                select(KeywordWorkflowDispatch)
                .where(KeywordWorkflowDispatch.run_id == run_id)
                .with_for_update()
            )
            if dispatch is None or dispatch.status != "pending":
                return
            dispatch.attempts += 1
            dispatch.last_error = message[:2000]
            dispatch.next_attempt_at = datetime.now(UTC) + timedelta(
                seconds=min(60, 2 ** min(dispatch.attempts, 6))
            )
            dispatch.updated_at = datetime.now(UTC)
            run = await session.get(KeywordBuildRun, run_id)
            if run is not None and run.status == "queued":
                run.message = "任务已保存，等待关键词服务恢复后自动重试"
                run.updated_at = datetime.now(UTC)
            await session.commit()

    async def _require_project(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        *,
        lock: bool = False,
    ) -> Project:
        statement = select(Project).where(
            Project.organization_id == organization_id,
            Project.id == project_id,
        )
        if lock:
            statement = statement.with_for_update()
        project = await session.scalar(statement)
        if project is None:
            raise KeywordProjectNotFoundError
        return project

    async def _counts(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
    ) -> tuple[int, int, int]:
        total_keywords, active_keywords = (
            await session.execute(
                select(
                    func.count(Keyword.id),
                    func.count(Keyword.id).filter(Keyword.status == "active"),
                ).where(
                    Keyword.organization_id == organization_id,
                    Keyword.project_id == project_id,
                )
            )
        ).one()
        pending = await self._pending_seed_count(
            session,
            organization_id,
            project_id,
        )
        return int(total_keywords or 0), int(active_keywords or 0), pending

    async def _pending_seed_count(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
    ) -> int:
        value = await session.scalar(
            select(func.count(KeywordSeed.id)).where(
                KeywordSeed.organization_id == organization_id,
                KeywordSeed.project_id == project_id,
                KeywordSeed.expansion_status == "pending_expansion",
            )
        )
        return int(value or 0)


class KeywordService:
    def __init__(
        self,
        settings: Settings,
        repository: SQLAlchemyKeywordRepository,
        launcher: KeywordWorkflowLauncher,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.launcher = launcher
        self.started_at = datetime.now(UTC)
        self._last_operational_cleanup_at: datetime | None = None

    async def status(self, project_id: str) -> KeywordLibraryStatusResponse:
        return await self.repository.status(
            self.settings.default_organization_id,
            project_id,
        )

    async def cost_summary(self, project_id: str) -> KeywordCostSummaryResponse:
        return await self.repository.cost_summary(
            self.settings.default_organization_id,
            project_id,
        )

    async def list_external_issues(
        self,
        project_id: str,
    ) -> KeywordExternalIssueListResponse:
        return await self.repository.list_external_issues(
            self.settings.default_organization_id,
            project_id,
        )

    async def accept_external_issue_as_empty(
        self,
        project_id: str,
        request_id: int,
    ) -> KeywordExternalIssueResponse:
        issue = await self.repository.accept_external_issue_as_empty(
            self.settings.default_organization_id,
            project_id,
            request_id,
        )
        await self.dispatch_pending_workflows(limit=10)
        return issue

    async def list_keywords(self, project_id: str, **kwargs: Any) -> KeywordListResponse:
        return await self.repository.list_keywords(
            self.settings.default_organization_id,
            project_id,
            **kwargs,
        )

    async def save_gsc_keywords(
        self,
        project_id: str,
        request: KeywordGSCSaveRequest,
    ) -> KeywordGSCSaveResponse:
        return await self.repository.save_gsc_keywords(
            self.settings.default_organization_id,
            project_id,
            request,
        )

    async def list_competitor_gaps(
        self,
        project_id: str,
        *,
        page: int,
        page_size: int,
    ) -> KeywordCompetitorGapListResponse:
        return await self.repository.list_competitor_gaps(
            self.settings.default_organization_id,
            project_id,
            page=page,
            page_size=page_size,
        )

    async def start_competitor_analysis(
        self,
        project_id: str,
        request: KeywordCompetitorAnalysisRequest,
    ) -> KeywordCompetitorAnalysisRunResponse:
        run = await self.repository.create_competitor_analysis(
            self.settings.default_organization_id,
            project_id,
            request,
        )
        await self.dispatch_pending_workflows(limit=10)
        return run

    async def competitor_analysis_status(
        self, project_id: str
    ) -> KeywordCompetitorAnalysisRunResponse | None:
        return await self.repository.competitor_analysis_status(
            self.settings.default_organization_id,
            project_id,
        )

    async def list_competitors(
        self, project_id: str, *, include_evidence: bool = False
    ) -> KeywordCompetitorListResponse:
        return await self.repository.list_competitors(
            self.settings.default_organization_id,
            project_id,
            include_evidence=include_evidence,
        )

    async def list_competitor_opportunities(
        self, project_id: str, **kwargs: Any
    ) -> KeywordCompetitorOpportunityListResponse:
        return await self.repository.list_competitor_opportunities(
            self.settings.default_organization_id,
            project_id,
            **kwargs,
        )

    async def competitor_analysis_runs(
        self, project_id: str, *, limit: int
    ) -> KeywordCompetitorAnalysisRunListResponse:
        return await self.repository.competitor_analysis_runs(
            self.settings.default_organization_id,
            project_id,
            limit=limit,
        )

    async def batch_competitor_opportunities(
        self,
        project_id: str,
        request: KeywordCompetitorOpportunityBatchRequest,
    ) -> KeywordCompetitorOpportunityBatchResponse:
        return await self.repository.batch_competitor_opportunities(
            self.settings.default_organization_id,
            project_id,
            request,
        )

    async def retry_failed_initial_build(
        self,
        project_id: str,
    ) -> KeywordBuildRunResponse:
        run = await self.repository.retry_failed_initial_build(
            self.settings.default_organization_id,
            project_id,
        )
        await self.dispatch_pending_workflows(limit=10)
        return run

    async def batch_status(
        self,
        project_id: str,
        request: KeywordBatchStatusRequest,
    ) -> KeywordBatchStatusResponse:
        return await self.repository.batch_status(
            self.settings.default_organization_id,
            project_id,
            request,
        )

    async def assign_tags(
        self,
        project_id: str,
        request: KeywordTagAssignmentRequest,
    ) -> KeywordTagAssignmentResponse:
        return await self.repository.assign_tags(
            self.settings.default_organization_id,
            project_id,
            request,
        )

    async def dispatch_pending_workflows(self, limit: int = 25) -> int:
        await self.repository.resume_ready_blocked_runs(
            self.settings.default_organization_id,
            service_started_at=self.started_at,
            dataforseo_environment_configured=bool(
                self.settings.dataforseo_login and self.settings.dataforseo_password
            ),
            ai_environment_configured=bool(
                self.settings.business_profile_ai_base_url
                and self.settings.business_profile_ai_api_key
            ),
            limit=limit,
        )
        dispatched = 0
        for record in await self.repository.list_pending_dispatches(limit):
            try:
                await self.launcher.start(record.task_payload, record.workflow_id)
            except Exception as exc:
                await self.repository.record_dispatch_failure(record.run_id, str(exc))
                continue
            await self.repository.mark_dispatch_succeeded(record.run_id)
            dispatched += 1
        for record in await self.repository.list_pending_metric_dispatches(limit):
            try:
                await self.launcher.start_metrics(
                    record.task_payload,
                    record.workflow_id,
                )
            except Exception as exc:
                await self.repository.record_metric_dispatch_failure(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                    message=str(exc),
                )
                continue
            await self.repository.mark_metric_dispatch_succeeded(
                record.run_id,
                expected_workflow_id=record.workflow_id,
            )
            dispatched += 1
        for record in await self.repository.claim_pending_competitor_analysis_dispatches(limit):
            try:
                await self.launcher.start_competitor_analysis(
                    record.task_payload, record.workflow_id
                )
            except Exception as exc:
                await self.repository.record_competitor_analysis_dispatch_failure(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                    message=str(exc),
                )
                continue
            await self.repository.mark_competitor_analysis_dispatch_succeeded(
                record.run_id,
                expected_workflow_id=record.workflow_id,
            )
            dispatched += 1
        return dispatched

    async def reconcile_active_runs(self, limit: int = 100) -> int:
        await self.repository.settle_stale_external_requests()
        now = datetime.now(UTC)
        cleanup_interval = max(
            self.settings.keyword_operational_cleanup_interval_seconds,
            300,
        )
        if (
            self._last_operational_cleanup_at is None
            or (now - self._last_operational_cleanup_at).total_seconds() >= cleanup_interval
        ):
            await self.repository.cleanup_operational_data(
                retention_days=self.settings.keyword_operational_retention_days,
            )
            self._last_operational_cleanup_at = now
        health = await self.repository.operational_health(
            self.settings.default_organization_id,
            task_queue=self.settings.keyword_task_queue,
            worker_stale_seconds=self.settings.keyword_worker_stale_seconds,
        )
        if not health.worker_healthy:
            waiting = await self.repository.mark_active_runs_waiting_for_worker(
                self.settings.default_organization_id,
                stale_seconds=self.settings.keyword_worker_stale_seconds,
            )
            if waiting or health.active_runs:
                logger.error(
                    "Keyword worker heartbeat is stale; active_runs=%s waiting_updated=%s",
                    health.active_runs,
                    waiting,
                )
            return 0

        now = datetime.now(UTC)
        records = await self.repository.list_active_workflows(
            self.settings.default_organization_id,
            limit,
        )
        semaphore = asyncio.Semaphore(
            max(1, min(self.settings.keyword_workflow_state_concurrency, 50))
        )

        async def reconcile_one(record: KeywordActiveWorkflowRecord) -> int:
            try:
                if record.dispatch_status == "pending":
                    return 0
                async with semaphore:
                    state = await asyncio.wait_for(
                        self.launcher.state(record.workflow_id),
                        timeout=max(
                            self.settings.keyword_workflow_state_timeout_seconds,
                            0.1,
                        ),
                    )
                if state in {"running", "unknown"}:
                    return 0
                age_seconds = max((now - record.updated_at).total_seconds(), 0)
                if state == "missing" and age_seconds < 60:
                    return 0
                recovered = await self.repository.requeue_orphaned_workflow(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                    max_recoveries=self.settings.keyword_workflow_orphan_recovery_limit,
                )
                return int(recovered)
            finally:
                await self.repository.mark_workflow_checked(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                )

        outcomes = await asyncio.gather(
            *(reconcile_one(record) for record in records),
            return_exceptions=True,
        )
        reconciled = 0
        for record, outcome in zip(records, outcomes, strict=True):
            if isinstance(outcome, BaseException):
                logger.warning(
                    "Unable to reconcile keyword workflow %s: %s",
                    record.workflow_id,
                    outcome,
                )
                continue
            reconciled += outcome
        competitor_records = await self.repository.list_active_competitor_analysis_workflows(
            self.settings.default_organization_id,
            limit,
        )

        async def reconcile_competitor_analysis(
            record: KeywordCompetitorAnalysisActiveWorkflowRecord,
        ) -> int:
            try:
                async with semaphore:
                    state = await asyncio.wait_for(
                        self.launcher.state(record.workflow_id),
                        timeout=max(
                            self.settings.keyword_workflow_state_timeout_seconds,
                            0.1,
                        ),
                    )
                if state in {"running", "unknown"}:
                    return 0
                age_seconds = max((now - record.updated_at).total_seconds(), 0)
                if state == "missing" and age_seconds < 60:
                    return 0
                recovered = await self.repository.requeue_orphaned_competitor_analysis_workflow(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                    max_recoveries=(self.settings.keyword_workflow_orphan_recovery_limit),
                )
                return int(recovered)
            finally:
                await self.repository.mark_competitor_analysis_workflow_checked(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                )

        competitor_outcomes = await asyncio.gather(
            *(reconcile_competitor_analysis(record) for record in competitor_records),
            return_exceptions=True,
        )
        for record, outcome in zip(
            competitor_records,
            competitor_outcomes,
            strict=True,
        ):
            if isinstance(outcome, BaseException):
                logger.warning(
                    "Unable to reconcile competitor analysis workflow %s: %s",
                    record.workflow_id,
                    outcome,
                )
                continue
            reconciled += outcome
        metric_records = await self.repository.list_active_metric_workflows(
            self.settings.default_organization_id,
            limit,
        )

        async def reconcile_metric(
            record: KeywordMetricActiveWorkflowRecord,
        ) -> int:
            try:
                async with semaphore:
                    state = await asyncio.wait_for(
                        self.launcher.state(record.workflow_id),
                        timeout=max(
                            self.settings.keyword_workflow_state_timeout_seconds,
                            0.1,
                        ),
                    )
                if state in {"running", "unknown"}:
                    return 0
                age_seconds = max((now - record.updated_at).total_seconds(), 0)
                if state == "missing" and age_seconds < 60:
                    return 0
                recovered = await self.repository.requeue_orphaned_metric_workflow(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                )
                return int(recovered)
            finally:
                await self.repository.mark_metric_workflow_checked(
                    record.run_id,
                    expected_workflow_id=record.workflow_id,
                )

        metric_outcomes = await asyncio.gather(
            *(reconcile_metric(record) for record in metric_records),
            return_exceptions=True,
        )
        for record, outcome in zip(metric_records, metric_outcomes, strict=True):
            if isinstance(outcome, BaseException):
                logger.warning(
                    "Unable to reconcile keyword metric workflow %s: %s",
                    record.workflow_id,
                    outcome,
                )
                continue
            reconciled += outcome
        return reconciled

    async def operational_health(self) -> KeywordOperationalHealthResponse:
        snapshot = await self.repository.operational_health(
            self.settings.default_organization_id,
            task_queue=self.settings.keyword_task_queue,
            worker_stale_seconds=self.settings.keyword_worker_stale_seconds,
        )
        degraded = (
            not snapshot.worker_healthy
            or snapshot.blocked_runs > 0
            or snapshot.stale_prepared_requests > 0
            or snapshot.uncertain_requests > 0
            or snapshot.charged_failed_requests > 0
            or snapshot.metric_refresh_exhausted > 0
            or snapshot.failed_metrics > 0
        )
        return KeywordOperationalHealthResponse(
            status="degraded" if degraded else "ok",
            worker_healthy=snapshot.worker_healthy,
            worker_last_seen_at=snapshot.worker_last_seen_at,
            active_runs=snapshot.active_runs,
            waiting_runs=snapshot.waiting_runs,
            blocked_runs=snapshot.blocked_runs,
            stale_prepared_requests=snapshot.stale_prepared_requests,
            uncertain_requests=snapshot.uncertain_requests,
            charged_failed_requests=snapshot.charged_failed_requests,
            metric_refresh_waiting=snapshot.metric_refresh_waiting,
            metric_refresh_running=snapshot.metric_refresh_running,
            metric_refresh_exhausted=snapshot.metric_refresh_exhausted,
            failed_metrics=snapshot.failed_metrics,
        )


def build_run_response(run: KeywordBuildRun) -> KeywordBuildRunResponse:
    now = datetime.now(UTC)
    end = run.finished_at or now
    elapsed = max((end - run.started_at).total_seconds(), 0) if run.started_at is not None else 0
    return KeywordBuildRunResponse(
        run_id=run.id,
        kind=run.kind,
        round_number=run.round_number,
        status=run.status,
        stage=run.stage,
        message=run.message,
        progress=run.progress,
        discovered_count=run.discovered_count,
        selected_count=run.selected_count,
        keyword_count=run.keyword_count,
        result_version=run.result_version,
        profile_source=run.profile_source,
        gap_status=run.gap_status,
        gap_message=run.gap_message,
        gap_count=run.gap_count,
        partial_failures=list(run.partial_failures or []),
        error_code=run.error_code,
        recovery_count=run.recovery_count,
        next_retry_at=run.next_retry_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        elapsed_seconds=elapsed,
    )


def external_issue_response(request: KeywordExternalRequest) -> KeywordExternalIssueResponse:
    return KeywordExternalIssueResponse(
        id=request.id,
        provider=request.provider,
        endpoint=request.endpoint,
        status=request.status,
        error_code=request.error_code,
        error_detail=request.error_detail,
        cost_usd=max(float(request.cost_usd or 0), 0),
        started_at=request.started_at,
        finished_at=request.finished_at,
    )


def competitor_analysis_run_response(
    run: KeywordCompetitorAnalysisRun,
) -> KeywordCompetitorAnalysisRunResponse:
    return KeywordCompetitorAnalysisRunResponse(
        run_id=run.id,
        target_domain=run.target_domain,
        country=run.country,
        language=run.language,
        mode=run.analysis_mode,
        requested_competitor_domains=list(run.requested_competitor_domains or []),
        discovery_method=run.discovery_method,
        discovery_keywords=list(run.discovery_keywords or []),
        discovery_result_types=list(run.discovery_result_types or []),
        discovery_include_subdomains=run.discovery_include_subdomains,
        discovery_sort=run.discovery_sort,
        discovery_limit=run.discovery_limit,
        discovery_offset=run.discovery_offset,
        gsc_query_evidence=list(run.gsc_query_evidence or []),
        query_metrics=list(run.query_metrics or []),
        serp_snapshots=list(run.serp_snapshots or []),
        cost_breakdown={
            str(key): max(float(value or 0), 0)
            for key, value in dict(run.cost_breakdown or {}).items()
        },
        landscape_summary=dict(run.landscape_summary or {}),
        directional_result=run.directional_result,
        market_summary=run.market_summary,
        local_market=dict(run.local_market or {}),
        status=run.status,
        stage=run.stage,
        message=run.message,
        progress=run.progress,
        competitor_limit=run.competitor_limit,
        keyword_limit=run.keyword_limit,
        discovered_count=run.discovered_count,
        analyzed_competitor_count=run.analyzed_competitor_count,
        completed_competitors=run.completed_competitors,
        failed_competitors=run.failed_competitors,
        raw_keyword_count=run.raw_keyword_count,
        unique_keyword_count=run.unique_keyword_count,
        discovery_cost_usd=max(float(run.discovery_cost_usd or 0), 0),
        total_cost_usd=max(float(run.total_cost_usd or 0), 0),
        error_code=run.error_code,
        recovery_count=run.recovery_count,
        started_at=run.started_at,
        finished_at=run.finished_at,
        created_at=run.created_at,
    )


def competitor_landscape_has_key(raw_payload: object, key: str) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    landscape = raw_payload.get("_landscape")
    return isinstance(landscape, dict) and key in landscape


def token_count(usage: dict[str, Any], *names: str) -> int:
    for name in names:
        value = usage.get(name)
        if isinstance(value, int) and not isinstance(value, bool):
            return max(value, 0)
    return 0


def keyword_item_response(
    keyword: Keyword,
    metric: KeywordMetric | None,
    primary_seed: str | None,
    sources: list[str],
    tags: list[KeywordTagResponse],
) -> KeywordListItemResponse:
    return KeywordListItemResponse(
        id=keyword.id,
        keyword=keyword.keyword,
        primary_seed=primary_seed,
        business_topic=keyword.business_topic,
        classification_confidence=keyword.classification_confidence,
        review_status=keyword.review_status,
        intent=metric.intent if metric else None,
        search_volume=metric.search_volume if metric else None,
        cpc=metric.cpc if metric else None,
        competition=metric.competition if metric else None,
        keyword_difficulty=metric.keyword_difficulty if metric else None,
        monthly_searches=list(metric.monthly_searches or []) if metric else [],
        priority_score=keyword.priority_score,
        priority_confidence=keyword.priority_confidence,
        priority_details=dict(keyword.priority_details or {}),
        sources=sources,
        tags=tags,
        status=keyword.status,
        metrics_status=keyword.metrics_status,
        metrics_updated_at=metric.fetched_at if metric else None,
        created_at=keyword.created_at,
        updated_at=keyword.updated_at,
    )


def keyword_order(sort: str, order: str):
    direction = asc if order == "asc" else desc
    fields = {
        "keyword": Keyword.keyword,
        "search_volume": KeywordMetric.search_volume,
        "difficulty": KeywordMetric.keyword_difficulty,
        "priority": Keyword.priority_score,
        "updated_at": Keyword.updated_at,
    }
    field = fields.get(sort, Keyword.priority_score)
    nulls_last = case((field.is_(None), 1), else_=0)
    return nulls_last, direction(field), asc(Keyword.normalized_keyword)


def competitor_opportunity_order(sort: str, order: str):
    direction = asc if order == "asc" else desc
    fields = {
        "keyword": KeywordCompetitorOpportunity.keyword,
        "opportunity_score": KeywordCompetitorOpportunity.opportunity_score,
        "search_volume": KeywordCompetitorOpportunity.search_volume,
        "difficulty": KeywordCompetitorOpportunity.keyword_difficulty,
        "best_rank": KeywordCompetitorOpportunity.best_competitor_rank,
        "competitor_count": KeywordCompetitorOpportunity.competitor_count,
        "updated_at": KeywordCompetitorOpportunity.updated_at,
    }
    field = fields.get(sort, KeywordCompetitorOpportunity.opportunity_score)
    nulls_last = case((field.is_(None), 1), else_=0)
    return (
        nulls_last,
        direction(field),
        asc(KeywordCompetitorOpportunity.normalized_keyword),
    )


def escape_like(value: str) -> str:
    return re.sub(r"([\\%_])", r"\\\1", value)


def normalize_competitor_domains(values: list[str], *, target_domain: str) -> list[str]:
    target = target_domain.casefold().removeprefix("www.").rstrip(".")
    domains: list[str] = []
    seen: set[str] = set()
    for value in values:
        candidate = value.strip().casefold()
        if not candidate:
            continue
        if "://" not in candidate:
            candidate = f"https://{candidate}"
        parsed = urlsplit(candidate)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.port not in {None, 80, 443}
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(f"无效的竞争对手域名: {value}")
        domain = parsed.hostname.casefold().rstrip(".").removeprefix("www.")
        if domain == target:
            raise ValueError("竞争对手不能与当前网站相同")
        if domain not in seen:
            seen.add(domain)
            domains.append(domain)
    if len(domains) > 5:
        raise ValueError("一次最多分析 5 个竞争对手")
    return domains


def competitor_opportunity_metric_provenance(
    opportunity: KeywordCompetitorOpportunity,
) -> dict[str, Any]:
    fields = (
        "search_volume",
        "cpc",
        "competition",
        "competition_level",
        "keyword_difficulty",
        "intent",
    )
    return {
        "provider_request_completed": True,
        "provider_null_fields": [field for field in fields if getattr(opportunity, field) is None],
    }


def normalize_saved_keyword(value: str) -> tuple[str, str]:
    keyword = " ".join(unicodedata.normalize("NFKC", value).strip().split())
    return keyword[:500], keyword.casefold()[:500]


def normalize_tags(values: list[str]) -> list[tuple[str, str]]:
    tags: list[tuple[str, str]] = []
    seen: set[str] = set()
    for value in values:
        name = " ".join(unicodedata.normalize("NFKC", value).strip().split())
        normalized = name.casefold()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        tags.append((name[:80], normalized[:80]))
    return tags


def build_keyword_service() -> KeywordService:
    settings = get_settings()
    return KeywordService(
        settings=settings,
        repository=SQLAlchemyKeywordRepository(session_factory),
        launcher=TemporalKeywordWorkflowLauncher(settings.keyword_task_queue),
    )
