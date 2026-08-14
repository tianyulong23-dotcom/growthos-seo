from __future__ import annotations

import asyncio
import os
from uuid import uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.agent.models import (
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentSystemTrigger,
)
from app.modules.agent.repository import AgentRepository
from app.modules.keywords.models import KeywordBuildRun
from app.modules.onboarding.models import OnboardingRun
from app.modules.onboarding.service import (
    OnboardingStepConflictError,
    SQLAlchemyOnboardingRepository,
)

pytestmark = pytest.mark.anyio


def _database_url() -> str:
    value = os.getenv("ONBOARDING_API_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("ONBOARDING_API_TEST_DATABASE_URL is required for PostgreSQL tests")
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


async def test_step_claim_failure_retry_and_completion_are_durable() -> None:
    engine = create_async_engine(
        _database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling, audit",
            }
        },
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyOnboardingRepository(sessions)
    token = uuid4().hex
    organization_id = f"onboarding-org-{token}"
    project_id = f"onboarding-project-{token}"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (
                        :project_id, :organization_id, 'Onboarding repository test',
                        :domain, 'US', 'en'
                    )
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.commit()

        await repository.ensure_started(organization_id, project_id)
        await repository.claim_step(
            organization_id,
            project_id,
            "site_understanding",
            "understanding-1",
        )
        await repository.fail_step(
            organization_id,
            project_id,
            "site_understanding",
            "temporary_failure",
            "The first attempt failed.",
        )
        await repository.retry_step(organization_id, project_id, "site_understanding")

        run, steps = (await repository.get(organization_id, project_id)) or (None, [])
        assert run is not None
        by_key = {step.step_key: step for step in steps}
        assert by_key["site_understanding"].status == "ready"
        assert by_key["site_understanding"].attempts == 1
        assert by_key["site_understanding"].external_run_id is None
        assert by_key["site_understanding"].last_error_code is None
        assert by_key["aris_welcome"].status == "ready"
        assert by_key["aris_welcome"].attempts == 0

        await repository.claim_step(
            organization_id,
            project_id,
            "site_understanding",
            "understanding-2",
        )
        with pytest.raises(OnboardingStepConflictError, match="step_not_ready:running"):
            await repository.claim_step(
                organization_id,
                project_id,
                "site_understanding",
                "understanding-duplicate",
            )

        await repository.complete_step(
            organization_id,
            project_id,
            "site_understanding",
            "understanding-2",
        )
        await repository.complete_step(
            organization_id,
            project_id,
            "site_understanding",
            "understanding-2",
        )
        with pytest.raises(OnboardingStepConflictError, match="external_run_id_conflict"):
            await repository.complete_step(
                organization_id,
                project_id,
                "site_understanding",
                "understanding-3",
            )

        _, completed_steps = (await repository.get(organization_id, project_id)) or (None, [])
        completed = {step.step_key: step for step in completed_steps}["site_understanding"]
        assert completed.status == "completed"
        assert completed.attempts == 2
        assert completed.external_run_id == "understanding-2"
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_concurrent_reconcile_and_step_claim_do_not_deadlock() -> None:
    engine = create_async_engine(
        _database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling, audit",
            }
        },
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyOnboardingRepository(sessions)
    token = uuid4().hex
    organization_id = f"onboarding-concurrency-org-{token}"
    project_id = f"onboarding-concurrency-project-{token}"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (
                        :project_id, :organization_id, 'Onboarding concurrency test',
                        :domain, 'US', 'en'
                    )
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.commit()

        await repository.ensure_started(organization_id, project_id)
        async def claim_if_ready(external_run_id: str) -> None:
            try:
                await repository.claim_step(
                    organization_id,
                    project_id,
                    "site_understanding",
                    external_run_id,
                )
            except OnboardingStepConflictError:
                pass

        for _ in range(20):
            await asyncio.wait_for(
                asyncio.gather(
                    repository._reconcile_project_state(organization_id, project_id),
                    claim_if_ready(f"understanding-{uuid4().hex}"),
                ),
                timeout=10,
            )
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_confirmed_profile_creates_one_durable_agent_trigger() -> None:
    engine = create_async_engine(
        _database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling, audit",
            }
        },
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyOnboardingRepository(sessions)
    token = uuid4().hex
    organization_id = f"onboarding-keyword-org-{token}"
    project_id = f"onboarding-keyword-project-{token}"
    crawl_run_id = f"onboarding-keyword-crawl-{token}"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language,
                        understanding_run_id
                    )
                    VALUES (
                        :project_id, :organization_id, 'Onboarding keyword test',
                        :domain, 'US', 'en', :crawl_run_id
                    )
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                    "crawl_run_id": crawl_run_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO crawl_runs (
                        run_id, organization_id, project_id, task_type, status,
                        stage, discovered, processed, selected, page_count,
                        backlink_count, config_snapshot, summary
                    )
                    VALUES (
                        :crawl_run_id, :organization_id, :project_id,
                        'site_understanding', 'completed', 'completed',
                        1, 1, 1, 1, 0, '{}'::jsonb, '{}'::jsonb
                    )
                    """
                ),
                {
                    "crawl_run_id": crawl_run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO site_profiles (
                        project_id, source_run_id, profile_json, user_overrides, confidence
                    )
                    VALUES (
                        :project_id, :crawl_run_id,
                        jsonb_build_object(
                            'business_name', 'Onboarding keyword test',
                            'confirmed_at', '2026-08-12T09:05:00+00:00'
                        ),
                        '{}'::jsonb, 0.9
                    )
                    """
                ),
                {"project_id": project_id, "crawl_run_id": crawl_run_id},
            )
            await session.commit()

        await repository._reconcile_project_state(organization_id, project_id)
        await repository._reconcile_project_state(organization_id, project_id)

        async with sessions() as session:
            run_count = await session.scalar(
                select(func.count())
                .select_from(KeywordBuildRun)
                .where(KeywordBuildRun.project_id == project_id)
            )
            triggers = list(
                (
                    await session.scalars(
                        select(AgentSystemTrigger).where(
                            AgentSystemTrigger.organization_id == organization_id,
                            AgentSystemTrigger.project_id == project_id,
                        )
                    )
                ).all()
            )
            assert run_count == 0
            assert len(triggers) == 1
            assert triggers[0].trigger == "business_profile_confirmed"
            assert triggers[0].status == "pending"
            assert triggers[0].trusted_write_tools_json == [
                "start_technical_audit",
                "start_keyword_library",
            ]

        _, steps = (await repository.get(organization_id, project_id)) or (None, [])
        by_key = {step.step_key: step for step in steps}
        assert by_key["business_confirmation"].status == "completed"
        assert by_key["keyword_library"].status == "ready"
        assert by_key["keyword_library"].external_run_id is None
        assert by_key["keyword_library"].attempts == 0
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.execute(
                text("DELETE FROM crawl_runs WHERE run_id = :crawl_run_id"),
                {"crawl_run_id": crawl_run_id},
            )
            await session.commit()
        await engine.dispose()


async def test_system_trigger_waits_for_idle_and_materializes_once() -> None:
    engine = create_async_engine(
        _database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling, audit",
            }
        },
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    onboarding = SQLAlchemyOnboardingRepository(sessions)
    agents = AgentRepository(sessions)
    token = uuid4().hex
    organization_id = f"agent-trigger-org-{token}"
    project_id = f"agent-trigger-project-{token}"
    busy_message_id = f"agent-trigger-message-{token}"
    busy_run_id = f"agent-trigger-run-{token}"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (
                        :project_id, :organization_id, 'Agent trigger test',
                        :domain, 'US', 'en'
                    )
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.commit()

        await onboarding.ensure_started(organization_id, project_id)
        await onboarding._reconcile_project_state(organization_id, project_id)

        async with sessions() as session:
            onboarding_run = await session.scalar(
                select(OnboardingRun).where(OnboardingRun.project_id == project_id)
            )
            assert onboarding_run is not None
            assert onboarding_run.agent_conversation_id is not None
            conversation_id = onboarding_run.agent_conversation_id
            conversation = await session.get(AgentConversation, conversation_id)
            assert conversation is not None
            session.add(
                AgentMessage(
                    id=busy_message_id,
                    conversation_id=conversation_id,
                    run_id=busy_run_id,
                    role="user",
                    content="Keep this conversation busy.",
                    metadata_json={},
                    client_request_id=f"busy-{token}",
                )
            )
            await session.flush()
            conversation.active_message_id = busy_message_id
            session.add(
                AgentRun(
                    id=busy_run_id,
                    conversation_id=conversation_id,
                    user_message_id=busy_message_id,
                    workflow_id=f"agent:{busy_run_id}",
                    status="running",
                    limits_json={},
                )
            )
            await session.commit()

        first = await agents.enqueue_system_trigger(
            organization_id,
            project_id,
            "business_profile_confirmed",
            "profile-v1",
            "Start the approved onboarding work.",
            ("start_technical_audit", "start_keyword_library"),
        )
        repeated = await agents.enqueue_system_trigger(
            organization_id,
            project_id,
            "business_profile_confirmed",
            "profile-v1",
            "Start the approved onboarding work.",
            ("start_technical_audit", "start_keyword_library"),
        )
        assert repeated.id == first.id

        assert await agents.materialize_pending_system_triggers({}) == []
        async with sessions() as session:
            pending = await session.get(AgentSystemTrigger, first.id)
            assert pending is not None
            assert pending.status == "pending"
            assert pending.message_id is None
            assert pending.run_id is None
            trigger_count = await session.scalar(
                select(func.count())
                .select_from(AgentSystemTrigger)
                .where(AgentSystemTrigger.project_id == project_id)
            )
            assert trigger_count == 1
            busy_run = await session.get(AgentRun, busy_run_id)
            assert busy_run is not None
            busy_run.status = "completed"
            await session.commit()

        materialized = await asyncio.gather(
            agents.materialize_pending_system_triggers({}),
            agents.materialize_pending_system_triggers({}),
        )
        created_runs = [run for result in materialized for run in result]
        assert len(created_runs) == 1

        async with sessions() as session:
            dispatched = await session.get(AgentSystemTrigger, first.id)
            assert dispatched is not None
            assert dispatched.status == "dispatched"
            assert dispatched.message_id is not None
            assert dispatched.run_id == created_runs[0].id
            hidden_message = await session.get(AgentMessage, dispatched.message_id)
            assert hidden_message is not None
            assert hidden_message.metadata_json == {
                "hidden_from_user": True,
                "trusted_system_trigger": True,
                "system_trigger": "business_profile_confirmed",
                "trusted_write_tools": [
                    "start_technical_audit",
                    "start_keyword_library",
                ],
            }
            generated_run_count = await session.scalar(
                select(func.count())
                .select_from(AgentRun)
                .where(
                    AgentRun.conversation_id == conversation_id,
                    AgentRun.id != busy_run_id,
                )
            )
            assert generated_run_count == 1

            source_run = await session.get(AgentRun, created_runs[0].id)
            assert source_run is not None
            source_run.status = "failed"
            await session.commit()

        retried = await asyncio.gather(
            agents.retry_system_trigger_run(
                organization_id,
                project_id,
                created_runs[0].id,
                {"max_model_calls": 12},
            ),
            agents.retry_system_trigger_run(
                organization_id,
                project_id,
                created_runs[0].id,
                {"max_model_calls": 12},
            ),
        )
        assert retried[0][1].id == retried[1][1].id
        assert retried[0][0].id == retried[1][0].id

        async with sessions() as session:
            retried_message = await session.get(AgentMessage, retried[0][0].id)
            assert retried_message is not None
            assert retried_message.content == "Start the approved onboarding work."
            assert retried_message.metadata_json == {
                "hidden_from_user": True,
                "trusted_system_trigger": True,
                "system_trigger": "business_profile_confirmed",
                "trusted_write_tools": [
                    "start_technical_audit",
                    "start_keyword_library",
                ],
                "retry_of_run_id": created_runs[0].id,
            }
            generated_run_count = await session.scalar(
                select(func.count())
                .select_from(AgentRun)
                .where(
                    AgentRun.conversation_id == conversation_id,
                    AgentRun.id != busy_run_id,
                )
            )
            assert generated_run_count == 2
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()
