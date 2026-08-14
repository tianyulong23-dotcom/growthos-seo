from __future__ import annotations

import asyncio
import os
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.agent.models import (
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentRunStep,
)
from app.modules.agent.repository import AgentRepository
from app.modules.projects.models import Project

pytestmark = pytest.mark.anyio


def _database_url() -> str:
    value = os.getenv("AGENT_BUDGET_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("AGENT_BUDGET_TEST_DATABASE_URL is required for PostgreSQL tests")
    value = value.replace("postgresql://", "postgresql+asyncpg://", 1)
    if make_url(value).database != "seo_agent_v11_test":
        pytest.fail("Agent budget tests may only use seo_agent_v11_test")
    return value


async def _seed_run(
    sessions: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    token = uuid4().hex
    project_id = f"agent-budget-project-{token}"
    conversation_id = f"agent-budget-conversation-{token}"
    message_id = f"agent-budget-message-{token}"
    run_id = f"agent-budget-run-{token}"
    async with sessions() as session:
        session.add(Project(
            id=project_id,
            organization_id=f"agent-budget-org-{token}",
            name="Agent budget repository test",
            domain=f"{token}.example.test",
            country="US",
            language="en",
        ))
        await session.flush()
        session.add(AgentConversation(
            id=conversation_id,
            organization_id=f"agent-budget-org-{token}",
            project_id=project_id,
            created_by="agent-budget-test",
            title="Agent budget test",
        ))
        await session.flush()
        session.add(AgentMessage(
            id=message_id,
            conversation_id=conversation_id,
            run_id=run_id,
            role="user",
            content="Run paid tools within the budget",
            metadata_json={},
            client_request_id=token,
        ))
        await session.flush()
        session.add(AgentRun(
            id=run_id,
            conversation_id=conversation_id,
            user_message_id=message_id,
            workflow_id=f"agent-budget:{token}",
            status="running",
            current_step=0,
            model_snapshot={},
            limits_json={},
        ))
        await session.commit()
    return project_id, run_id


async def test_paid_tool_reservation_is_idempotent_and_concurrency_safe() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = AgentRepository(sessions)
    project_id, run_id = await _seed_run(sessions)
    try:
        results = await asyncio.gather(
            repository.reserve_paid_tool_budget(
                run_id, "tool-call-a", "start_keyword_library", 0.6, 1.0
            ),
            repository.reserve_paid_tool_budget(
                run_id, "tool-call-b", "start_content_plan", 0.6, 1.0
            ),
        )

        assert sorted(result["allowed"] for result in results) == [False, True]
        winning_call = "tool-call-a" if results[0]["allowed"] else "tool-call-b"
        repeated = await repository.reserve_paid_tool_budget(
            run_id, winning_call, "ignored_on_retry", 0.6, 1.0
        )
        assert repeated["allowed"] is True

        async with sessions() as session:
            reservation_count = int(await session.scalar(
                select(func.count()).select_from(AgentRunStep).where(
                    AgentRunStep.run_id == run_id,
                    AgentRunStep.step_type == "budget",
                    AgentRunStep.name == "paid_tool_reservation",
                )
            ) or 0)
        assert reservation_count == 1
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == project_id))
            await session.commit()
        await engine.dispose()


async def test_real_billing_and_unsettled_reservations_share_the_same_budget() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = AgentRepository(sessions)
    project_id, run_id = await _seed_run(sessions)
    try:
        first = await repository.reserve_paid_tool_budget(
            run_id, "keyword-start", "start_keyword_library", 0.5, 3.0
        )
        assert first["allowed"] is True
        await repository.add_step(
            run_id,
            "model",
            "chat.completions",
            {},
            {},
            1,
            usage={"cost": 0.2, "cost_currency": "USD"},
        )
        await repository.add_step(
            run_id,
            "tool",
            "get_keyword_library_status",
            {},
            {
                "data": {
                    "billing": {
                        "source": "keyword_external_requests",
                        "reference_id": "keyword-run-1",
                        "reported_cost_usd": 0.8,
                        "complete": True,
                    }
                }
            },
            1,
            usage={"cost": 0.0, "cost_currency": "USD"},
        )
        second = await repository.reserve_paid_tool_budget(
            run_id, "plan-start", "start_content_plan", 0.5, 3.0
        )
        assert second["allowed"] is True

        rejected = await repository.reserve_paid_tool_budget(
            run_id, "article-start", "start_articles", 0.5, 1.9
        )
        assert rejected == {
            "allowed": False,
            "projected_cost": 2.0,
            "limit": 1.9,
        }

        usage = await repository.run_usage(run_id)
        assert usage["model_cost"] == 0.2
        assert usage["tool_cost"] == 0.8
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == project_id))
            await session.commit()
        await engine.dispose()
