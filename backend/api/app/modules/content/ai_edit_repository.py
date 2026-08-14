from __future__ import annotations

import hmac
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import Article, ArticleAIEditOperation, ContentAuditEvent
from app.modules.content.repository import ContentAuditContext


TERMINAL_STATUSES = {"accepted", "rejected", "cancelled", "failed", "stale"}
WORKER_AUDIT = ContentAuditContext(
    actor_id="content-worker",
    effective_role="system",
    request_id=None,
    correlation_id=None,
)


class AIEditRepositoryError(Exception):
    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class AIEditRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    @staticmethod
    def token_hash(token: str) -> str:
        return sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _audit(
        session: AsyncSession,
        *,
        operation: ArticleAIEditOperation,
        audit: ContentAuditContext,
        action: str,
        before: dict[str, Any] | None = None,
        after: dict[str, Any] | None = None,
        reason: str | None = None,
    ) -> None:
        session.add(
            ContentAuditEvent(
                id=str(uuid4()),
                project_id=operation.project_id,
                article_id=operation.article_id,
                actor_id=audit.actor_id,
                effective_role=audit.effective_role,
                action=action,
                target_type="article_ai_edit_operation",
                target_id=operation.id,
                version_number=None,
                before_state=before,
                after_state=after,
                reason=reason,
                policy_version="article-ai-edit.v1",
                request_id=audit.request_id,
                correlation_id=audit.correlation_id,
            )
        )

    async def create(
        self,
        *,
        values: dict[str, Any],
        stream_token: str,
        audit: ContentAuditContext,
        active_limit: int,
        hourly_limit: int,
        monthly_token_limit: int,
    ) -> tuple[ArticleAIEditOperation, bool]:
        async with self.sessions() as session:
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
                {"key": f"ai-edit:{values['project_id']}"},
            )
            existing = await session.scalar(
                select(ArticleAIEditOperation).where(
                    ArticleAIEditOperation.article_id == values["article_id"],
                    ArticleAIEditOperation.created_by == values["created_by"],
                    ArticleAIEditOperation.idempotency_key == values["idempotency_key"],
                )
            )
            if existing is not None:
                if existing.request_hash != values["request_hash"]:
                    raise AIEditRepositoryError("ai_edit_idempotency_conflict")
                existing.stream_token_hash = self.token_hash(stream_token)
                existing.stream_expires_at = values["stream_expires_at"]
                await session.commit()
                return existing, False

            article = await session.scalar(
                select(Article).where(
                    Article.id == values["article_id"],
                    Article.organization_id == values["organization_id"],
                    Article.project_id == values["project_id"],
                )
            )
            if article is None:
                raise AIEditRepositoryError("article_not_found")
            if article.review_version != values["base_review_version"]:
                raise AIEditRepositoryError("ai_edit_review_version_stale")

            now = datetime.now(UTC)
            active = await session.scalar(
                select(func.count())
                .select_from(ArticleAIEditOperation)
                .where(
                    ArticleAIEditOperation.project_id == values["project_id"],
                    ArticleAIEditOperation.status.in_(("queued", "streaming")),
                )
            )
            if int(active or 0) >= active_limit:
                raise AIEditRepositoryError("ai_edit_concurrency_limit", retryable=True)
            hourly = await session.scalar(
                select(func.count())
                .select_from(ArticleAIEditOperation)
                .where(
                    ArticleAIEditOperation.project_id == values["project_id"],
                    ArticleAIEditOperation.created_at >= now - timedelta(hours=1),
                )
            )
            if int(hourly or 0) >= hourly_limit:
                raise AIEditRepositoryError("ai_edit_rate_limit", retryable=True)
            month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            monthly_tokens = await session.scalar(
                select(
                    func.coalesce(
                        func.sum(
                            ArticleAIEditOperation.input_tokens
                            + ArticleAIEditOperation.output_tokens
                        ),
                        0,
                    )
                ).where(
                    ArticleAIEditOperation.project_id == values["project_id"],
                    ArticleAIEditOperation.created_at >= month_start,
                )
            )
            if int(monthly_tokens or 0) >= monthly_token_limit:
                raise AIEditRepositoryError("ai_edit_quota_exhausted")

            operation = ArticleAIEditOperation(
                **values,
                stream_token_hash=self.token_hash(stream_token),
            )
            session.add(operation)
            self._audit(
                session,
                operation=operation,
                audit=audit,
                action="article.ai_edit_created",
                after={
                    "status": "queued",
                    "command": operation.command,
                    "scope": operation.scope,
                    "input_hash": operation.input_hash,
                    "prompt_version": operation.prompt_version,
                },
            )
            try:
                await session.commit()
            except IntegrityError as exc:
                raise AIEditRepositoryError("ai_edit_idempotency_conflict") from exc
            return operation, True

    async def get(
        self, organization_id: str, project_id: str, article_id: str, operation_id: str
    ) -> ArticleAIEditOperation:
        async with self.sessions() as session:
            operation = await session.scalar(
                select(ArticleAIEditOperation).where(
                    ArticleAIEditOperation.id == operation_id,
                    ArticleAIEditOperation.organization_id == organization_id,
                    ArticleAIEditOperation.project_id == project_id,
                    ArticleAIEditOperation.article_id == article_id,
                )
            )
            if operation is None:
                raise AIEditRepositoryError("ai_edit_not_found")
            return operation

    async def get_for_worker(self, operation_id: str) -> ArticleAIEditOperation:
        async with self.sessions() as session:
            operation = await session.get(ArticleAIEditOperation, operation_id)
            if operation is None:
                raise AIEditRepositoryError("ai_edit_not_found")
            return operation

    async def get_article(self, organization_id: str, project_id: str, article_id: str) -> Article:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article is None:
                raise AIEditRepositoryError("article_not_found")
            return article

    async def get_by_stream_token(
        self, project_id: str, article_id: str, operation_id: str, token: str
    ) -> ArticleAIEditOperation:
        async with self.sessions() as session:
            operation = await session.scalar(
                select(ArticleAIEditOperation).where(
                    ArticleAIEditOperation.id == operation_id,
                    ArticleAIEditOperation.project_id == project_id,
                    ArticleAIEditOperation.article_id == article_id,
                )
            )
            if operation is None:
                raise AIEditRepositoryError("ai_edit_not_found")
            if operation.stream_expires_at <= datetime.now(UTC):
                raise AIEditRepositoryError("ai_edit_stream_token_expired")
            supplied = self.token_hash(token)
            if not hmac.compare_digest(operation.stream_token_hash, supplied):
                raise AIEditRepositoryError("ai_edit_stream_token_invalid")
            return operation

    async def worker_start(
        self, operation_id: str, *, provider: str, model: str, retry: bool = False
    ) -> ArticleAIEditOperation | None:
        async with self.sessions() as session:
            operation = await session.scalar(
                select(ArticleAIEditOperation)
                .where(ArticleAIEditOperation.id == operation_id)
                .with_for_update()
            )
            if operation is None or operation.status not in {"queued", "streaming"}:
                return None
            if operation.status == "streaming" and not retry:
                return None
            operation.status = "streaming"
            operation.provider = provider
            operation.model = model
            if retry:
                operation.candidate_text = None
                operation.candidate_metadata_json = None
                operation.candidate_slice_json = None
                operation.output_hash = None
            operation.started_at = datetime.now(UTC)
            operation.stream_revision += 1
            self._audit(
                session,
                operation=operation,
                audit=WORKER_AUDIT,
                action="article.ai_edit_streaming",
                before={"status": "streaming" if retry else "queued"},
                after={
                    "status": "streaming",
                    "provider": provider,
                    "model": model,
                    "activity_retry": retry,
                },
            )
            await session.commit()
            return operation

    async def append_chunk(self, operation_id: str, chunk: str) -> bool:
        async with self.sessions() as session:
            operation = await session.scalar(
                select(ArticleAIEditOperation)
                .where(ArticleAIEditOperation.id == operation_id)
                .with_for_update()
            )
            if operation is None or operation.status != "streaming":
                return False
            operation.candidate_text = (operation.candidate_text or "") + chunk
            if len(operation.candidate_text) > 120_000:
                raise AIEditRepositoryError("ai_edit_candidate_too_large")
            operation.stream_revision += 1
            await session.commit()
            return True

    async def worker_complete(
        self,
        operation_id: str,
        *,
        candidate_text: str | None,
        candidate_metadata: dict[str, Any] | None,
        candidate_slice: dict[str, Any] | None,
        output_hash: str,
        input_tokens: int,
        output_tokens: int,
        latency_ms: int,
    ) -> bool:
        async with self.sessions() as session:
            operation = await session.scalar(
                select(ArticleAIEditOperation)
                .where(ArticleAIEditOperation.id == operation_id)
                .with_for_update()
            )
            if operation is None or operation.status != "streaming":
                return False
            operation.status = "ready"
            operation.candidate_text = candidate_text
            operation.candidate_metadata_json = candidate_metadata
            operation.candidate_slice_json = candidate_slice
            operation.output_hash = output_hash
            operation.input_tokens = max(0, input_tokens)
            operation.output_tokens = max(0, output_tokens)
            operation.latency_ms = max(0, latency_ms)
            operation.completed_at = datetime.now(UTC)
            operation.stream_revision += 1
            self._audit(
                session,
                operation=operation,
                audit=WORKER_AUDIT,
                action="article.ai_edit_ready",
                before={"status": "streaming"},
                after={
                    "status": "ready",
                    "output_hash": output_hash,
                    "input_tokens": operation.input_tokens,
                    "output_tokens": operation.output_tokens,
                },
            )
            await session.commit()
            return True

    async def worker_fail(
        self, operation_id: str, *, code: str, detail: str, latency_ms: int | None = None
    ) -> bool:
        async with self.sessions() as session:
            operation = await session.scalar(
                select(ArticleAIEditOperation)
                .where(ArticleAIEditOperation.id == operation_id)
                .with_for_update()
            )
            if operation is None or operation.status not in {"queued", "streaming"}:
                return False
            before_status = operation.status
            operation.status = "failed"
            operation.error_code = code[:100]
            operation.error_detail = detail[:500]
            operation.latency_ms = latency_ms
            operation.completed_at = datetime.now(UTC)
            operation.stream_revision += 1
            self._audit(
                session,
                operation=operation,
                audit=WORKER_AUDIT,
                action="article.ai_edit_failed",
                before={"status": before_status},
                after={"status": "failed", "error_code": operation.error_code},
            )
            await session.commit()
            return True

    async def mark_stale(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        *,
        code: str,
        audit: ContentAuditContext,
    ) -> ArticleAIEditOperation:
        async with self.sessions() as session:
            operation = await self._locked(
                session, organization_id, project_id, article_id, operation_id
            )
            if operation.status == "ready":
                operation.status = "stale"
                operation.error_code = code[:100]
                operation.decided_at = datetime.now(UTC)
                operation.stream_revision += 1
                self._audit(
                    session,
                    operation=operation,
                    audit=audit,
                    action="article.ai_edit_stale",
                    before={"status": "ready"},
                    after={"status": "stale", "error_code": operation.error_code},
                )
                await session.commit()
            elif operation.status != "stale":
                raise AIEditRepositoryError("ai_edit_not_acceptable")
            return operation

    async def cancel(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        *,
        audit: ContentAuditContext,
    ) -> ArticleAIEditOperation:
        async with self.sessions() as session:
            operation = await self._locked(
                session, organization_id, project_id, article_id, operation_id
            )
            if operation.status in {"queued", "streaming"}:
                before = operation.status
                operation.status = "cancelled"
                operation.cancelled_at = datetime.now(UTC)
                operation.decided_at = operation.cancelled_at
                operation.stream_revision += 1
                self._audit(
                    session,
                    operation=operation,
                    audit=audit,
                    action="article.ai_edit_cancelled",
                    before={"status": before},
                    after={"status": "cancelled"},
                )
                await session.commit()
            return operation

    async def reject(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        *,
        reason: str | None,
        audit: ContentAuditContext,
    ) -> ArticleAIEditOperation:
        async with self.sessions() as session:
            operation = await self._locked(
                session, organization_id, project_id, article_id, operation_id
            )
            if operation.status == "ready":
                operation.status = "rejected"
                operation.decided_at = datetime.now(UTC)
                operation.stream_revision += 1
                self._audit(
                    session,
                    operation=operation,
                    audit=audit,
                    action="article.ai_edit_rejected",
                    before={"status": "ready"},
                    after={"status": "rejected"},
                    reason=reason,
                )
                await session.commit()
            elif operation.status != "rejected":
                raise AIEditRepositoryError("ai_edit_not_rejectable")
            return operation

    async def accept(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        *,
        mode: str,
        request_hash: str,
        idempotency_key: str,
        actor_id: str,
        current_review_version: int,
        current_document_hash: str,
        result: dict[str, Any],
        audit: ContentAuditContext,
    ) -> tuple[ArticleAIEditOperation, bool]:
        async with self.sessions() as session:
            operation = await self._locked(
                session, organization_id, project_id, article_id, operation_id
            )
            if operation.status == "accepted":
                if (
                    operation.accept_idempotency_key != idempotency_key
                    or operation.accept_request_hash != request_hash
                ):
                    raise AIEditRepositoryError("ai_edit_accept_idempotency_conflict")
                return operation, False
            if operation.status != "ready":
                raise AIEditRepositoryError("ai_edit_not_acceptable")
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if (
                article is None
                or article.review_version != current_review_version
                or operation.base_review_version != current_review_version
                or operation.document_hash != current_document_hash
            ):
                operation.status = "stale"
                operation.error_code = "ai_edit_stale"
                operation.decided_at = datetime.now(UTC)
                operation.stream_revision += 1
                self._audit(
                    session,
                    operation=operation,
                    audit=audit,
                    action="article.ai_edit_stale",
                    before={"status": "ready"},
                    after={"status": "stale"},
                )
                await session.commit()
                raise AIEditRepositoryError("ai_edit_stale")
            operation.status = "accepted"
            operation.accepted_by = actor_id
            operation.accept_idempotency_key = idempotency_key
            operation.accept_request_hash = request_hash
            operation.accepted_mode = mode
            operation.accepted_result_json = result
            operation.decided_at = datetime.now(UTC)
            operation.stream_revision += 1
            self._audit(
                session,
                operation=operation,
                audit=audit,
                action="article.ai_edit_accepted",
                before={"status": "ready"},
                after={"status": "accepted", "mode": mode, "output_hash": operation.output_hash},
            )
            await session.commit()
            return operation, True

    async def _locked(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
    ) -> ArticleAIEditOperation:
        operation = await session.scalar(
            select(ArticleAIEditOperation)
            .where(
                ArticleAIEditOperation.id == operation_id,
                ArticleAIEditOperation.organization_id == organization_id,
                ArticleAIEditOperation.project_id == project_id,
                ArticleAIEditOperation.article_id == article_id,
            )
            .with_for_update()
        )
        if operation is None:
            raise AIEditRepositoryError("ai_edit_not_found")
        return operation
