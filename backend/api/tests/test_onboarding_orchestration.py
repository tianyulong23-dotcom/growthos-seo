import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects import postgresql

from app.api.routes.projects import get_onboarding_service
from app.main import app
from app.modules.agent.models import AgentTimelineEvent
from app.modules.content.models import ArticleRun
from app.modules.content_plan.models import ContentPlanBatch
from app.modules.crawling.models import CrawlRun
from app.modules.keywords.models import KeywordBuildRun
from app.modules.onboarding.models import OnboardingRun, OnboardingStep
from app.modules.onboarding.service import (
    STEP_KEYS,
    SQLAlchemyOnboardingRepository,
    advance_onboarding,
    build_onboarding_records,
    onboarding_timeline_projection,
    onboarding_response,
)
from app.modules.projects.models import SiteProfile


def step_map(steps: list[OnboardingStep]) -> dict[str, OnboardingStep]:
    return {step.step_key: step for step in steps}


class TriggerCaptureSession:
    def __init__(self) -> None:
        self.values: list[dict[str, object]] = []

    async def execute(self, statement: object) -> None:
        compiled = statement.compile(dialect=postgresql.dialect())
        self.values.append(dict(compiled.params))


def capture_system_triggers(
    run: OnboardingRun,
    steps: dict[str, OnboardingStep],
    *,
    confirmed_at: datetime | None = None,
    keyword_status: str | None = None,
    batch_status: str | None = None,
    plan_item_count: int = 0,
) -> list[dict[str, object]]:
    session = TriggerCaptureSession()
    keyword_run = (
        SimpleNamespace(id="keywords-1", status=keyword_status)
        if keyword_status is not None
        else None
    )
    content_plan_batch = (
        SimpleNamespace(
            id="batch-1",
            source="automatic",
            target_count=30,
            status=batch_status,
        )
        if batch_status is not None
        else None
    )
    asyncio.run(
        SQLAlchemyOnboardingRepository._enqueue_agent_system_triggers(
            session,  # type: ignore[arg-type]
            run,
            steps,
            confirmed_at=confirmed_at,
            keyword_run=keyword_run,  # type: ignore[arg-type]
            content_plan_batch=content_plan_batch,  # type: ignore[arg-type]
            content_plan_item_count=plan_item_count,
        )
    )
    return session.values


def test_locked_step_acquires_run_before_step() -> None:
    run = OnboardingRun(
        id="run-1",
        organization_id="org-1",
        project_id="project-1",
        status="running",
        started_at=datetime(2026, 8, 12, 9, 0, tzinfo=UTC),
    )
    step = OnboardingStep(
        id="step-1",
        run_id=run.id,
        step_key="keyword_library",
        position=5,
        status="running",
        attempts=1,
    )

    class FakeSession:
        def __init__(self) -> None:
            self.locked_entities: list[type] = []

        async def scalar(self, statement):
            entity = statement.column_descriptions[0]["entity"]
            self.locked_entities.append(entity)
            return run if entity is OnboardingRun else step

    session = FakeSession()
    locked = asyncio.run(
        SQLAlchemyOnboardingRepository._locked_step(
            session,
            "org-1",
            "project-1",
            "keyword_library",
        )
    )

    assert locked is step
    assert session.locked_entities == [OnboardingRun, OnboardingStep]


def test_initial_state_runs_understanding_and_blocks_downstream_work() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    run, steps = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    statuses = {step.step_key: step.status for step in steps}

    assert run.status == "running"
    assert [step.step_key for step in steps] == list(STEP_KEYS)
    assert statuses == {
        "aris_welcome": "ready",
        "site_understanding": "running",
        "business_confirmation": "blocked",
        "technical_audit": "blocked",
        "keyword_library": "blocked",
        "content_plan": "blocked",
        "first_article": "blocked",
        "second_article": "blocked",
    }
    assert steps[1].attempts == 1
    assert steps[1].external_run_id == "understanding-1"


def test_business_confirmation_releases_audit_and_keywords_in_parallel() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    confirmed_at = started_at + timedelta(minutes=3)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    steps["site_understanding"].finished_at = confirmed_at - timedelta(seconds=30)

    advance_onboarding(run, steps, None)
    assert run.status == "waiting_for_confirmation"
    assert steps["business_confirmation"].status == "ready"
    assert steps["technical_audit"].status == "blocked"
    assert steps["keyword_library"].status == "blocked"

    advance_onboarding(run, steps, confirmed_at)
    assert run.status == "running"
    assert run.business_confirmed_at == confirmed_at
    assert steps["business_confirmation"].status == "completed"
    assert steps["technical_audit"].status == "ready"
    assert steps["keyword_library"].status == "ready"
    assert steps["content_plan"].status == "blocked"


def test_confirmation_enqueues_only_the_parallel_agent_work() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    confirmed_at = started_at + timedelta(minutes=3)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, confirmed_at)

    triggers = capture_system_triggers(run, steps, confirmed_at=confirmed_at)

    assert len(triggers) == 1
    assert triggers[0]["trigger"] == "business_profile_confirmed"
    assert triggers[0]["trusted_write_tools_json"] == [
        "start_technical_audit",
        "start_keyword_library",
    ]


def test_keyword_trigger_requires_a_usable_terminal_run() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["keyword_library"].status = "completed"

    for status in ("partial", "completed"):
        triggers = capture_system_triggers(
            run, steps, keyword_status=status
        )
        assert [item["trigger"] for item in triggers] == [
            "keyword_library_completed"
        ]
        assert triggers[0]["trusted_write_tools_json"] == ["start_content_plan"]

    for status in ("queued", "running", "failed"):
        assert capture_system_triggers(
            run, steps, keyword_status=status
        ) == []


def test_content_plan_trigger_requires_thirty_saved_items() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["content_plan"].status = "completed"

    assert capture_system_triggers(
        run,
        steps,
        batch_status="completed",
        plan_item_count=29,
    ) == []

    triggers = capture_system_triggers(
        run,
        steps,
        batch_status="completed",
        plan_item_count=30,
    )
    assert [item["trigger"] for item in triggers] == ["content_plan_completed"]
    assert triggers[0]["trusted_write_tools_json"] == ["start_articles"]
    assert "batch_id=batch-1" in str(triggers[0]["content"])


def test_content_plan_trigger_rejects_a_nonautomatic_batch() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["content_plan"].status = "completed"
    session = TriggerCaptureSession()

    asyncio.run(
        SQLAlchemyOnboardingRepository._enqueue_agent_system_triggers(
            session,  # type: ignore[arg-type]
            run,
            steps,
            confirmed_at=None,
            keyword_run=None,
            content_plan_batch=SimpleNamespace(
                id="batch-manual",
                source="manual",
                target_count=30,
                status="completed",
            ),  # type: ignore[arg-type]
            content_plan_item_count=30,
        )
    )

    assert session.values == []


def test_content_plan_only_waits_for_keywords_and_releases_two_articles() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, started_at + timedelta(minutes=2))

    steps["technical_audit"].status = "running"
    steps["keyword_library"].status = "completed"
    steps["keyword_library"].finished_at = started_at + timedelta(minutes=6)
    advance_onboarding(run, steps, run.business_confirmed_at)

    assert steps["technical_audit"].status == "running"
    assert steps["content_plan"].status == "ready"
    assert steps["first_article"].status == "blocked"
    assert steps["second_article"].status == "blocked"

    steps["content_plan"].status = "completed"
    steps["content_plan"].finished_at = started_at + timedelta(minutes=8)
    advance_onboarding(run, steps, run.business_confirmed_at)

    assert steps["first_article"].status == "ready"
    assert steps["second_article"].status == "ready"


def test_failed_parallel_step_does_not_block_its_sibling() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, started_at + timedelta(minutes=2))

    steps["technical_audit"].status = "failed"
    steps["technical_audit"].last_error_code = "crawler_unavailable"
    steps["keyword_library"].status = "running"
    advance_onboarding(run, steps, run.business_confirmed_at)

    assert steps["technical_audit"].status == "failed"
    assert steps["keyword_library"].status == "running"
    assert run.status == "running"


def test_reconcile_only_projects_state_and_does_not_admit_ready_work() -> None:
    calls: list[tuple[str, str]] = []
    repository = SQLAlchemyOnboardingRepository(None)  # type: ignore[arg-type]

    async def reconcile_state(organization_id: str, project_id: str) -> None:
        calls.append((organization_id, project_id))

    repository._reconcile_project_state = reconcile_state  # type: ignore[method-assign]

    asyncio.run(repository.reconcile_project("org-1", "project-1"))

    assert calls == [("org-1", "project-1")]


def test_observe_started_step_binds_real_run_id_idempotently() -> None:
    run = OnboardingRun(
        id="run-1",
        organization_id="org-1",
        project_id="project-1",
        status="running",
        started_at=datetime(2026, 8, 12, 9, 0, tzinfo=UTC),
    )
    step = OnboardingStep(
        id="step-keywords",
        run_id=run.id,
        step_key="keyword_library",
        position=5,
        status="ready",
        attempts=0,
    )

    class FakeSession:
        def __init__(self) -> None:
            self.commit_count = 0

        async def scalar(self, statement):
            entity = statement.column_descriptions[0]["entity"]
            return run if entity is OnboardingRun else step

        async def commit(self) -> None:
            self.commit_count += 1

    class SessionContext:
        def __init__(self, session: FakeSession) -> None:
            self.session = session

        async def __aenter__(self) -> FakeSession:
            return self.session

        async def __aexit__(self, *_args) -> None:
            return None

    session = FakeSession()
    repository = SQLAlchemyOnboardingRepository(lambda: SessionContext(session))  # type: ignore[arg-type]

    asyncio.run(
        repository.observe_started_step(
            "org-1", "project-1", "keyword_library", "keywords-1"
        )
    )
    asyncio.run(
        repository.observe_started_step(
            "org-1", "project-1", "keyword_library", "keywords-1"
        )
    )

    assert step.status == "running"
    assert step.external_run_id == "keywords-1"
    assert step.attempts == 1
    assert step.started_at is not None
    assert session.commit_count == 2


def test_keyword_run_state_drives_onboarding_and_releases_content_plan() -> None:
    started_at = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    confirmed_at = started_at + timedelta(minutes=3)
    run, rows = build_onboarding_records(
        "org-1", "project-1", started_at, "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, confirmed_at)
    keyword_run = KeywordBuildRun(
        id="keywords-1",
        organization_id="org-1",
        project_id="project-1",
        kind="initial",
        round_number=1,
        status="queued",
        stage="queued",
        message="正在准备关键词库",
        created_at=confirmed_at,
        updated_at=confirmed_at,
    )

    SQLAlchemyOnboardingRepository._sync_keyword_step(
        steps["keyword_library"], keyword_run
    )
    assert steps["keyword_library"].status == "running"
    assert steps["keyword_library"].external_run_id == "keywords-1"
    assert steps["keyword_library"].attempts == 1

    SQLAlchemyOnboardingRepository._sync_keyword_step(
        steps["keyword_library"], keyword_run
    )
    assert steps["keyword_library"].attempts == 1

    keyword_run.status = "completed"
    keyword_run.finished_at = confirmed_at + timedelta(minutes=4)
    SQLAlchemyOnboardingRepository._sync_keyword_step(
        steps["keyword_library"], keyword_run
    )
    advance_onboarding(run, steps, confirmed_at)

    assert steps["keyword_library"].status == "completed"
    assert steps["keyword_library"].finished_at == keyword_run.finished_at
    assert steps["content_plan"].status == "ready"


def test_failed_keyword_run_is_visible_in_onboarding() -> None:
    step = OnboardingStep(
        id="step-keywords",
        run_id="onboarding-1",
        step_key="keyword_library",
        position=5,
        status="ready",
        attempts=0,
    )
    keyword_run = KeywordBuildRun(
        id="keywords-failed",
        organization_id="org-1",
        project_id="project-1",
        kind="initial",
        round_number=1,
        status="failed",
        stage="failed",
        message="关键词构建失败",
        error_code="provider_failed",
        error_detail="provider request failed",
        created_at=datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        updated_at=datetime(2026, 8, 12, 9, 6, tzinfo=UTC),
    )

    SQLAlchemyOnboardingRepository._sync_keyword_step(step, keyword_run)

    assert step.status == "failed"
    assert step.external_run_id == "keywords-failed"
    assert step.last_error_code == "provider_failed"
    assert step.last_error_message == "provider request failed"


def test_real_downstream_runs_drive_onboarding_steps() -> None:
    now = datetime(2026, 8, 12, 9, 10, tzinfo=UTC)
    audit_step = OnboardingStep(
        id="step-audit",
        run_id="onboarding-1",
        step_key="technical_audit",
        position=4,
        status="ready",
        attempts=0,
    )
    audit_run = CrawlRun(
        run_id="audit-1",
        organization_id="org-1",
        project_id="project-1",
        task_type="technical_audit",
        status="running",
        stage="crawling",
        processed=42,
        created_at=now,
    )
    SQLAlchemyOnboardingRepository._sync_audit_step(audit_step, audit_run)
    assert audit_step.status == "running"
    assert audit_step.external_run_id == "audit-1"
    assert audit_step.attempts == 1

    audit_run.status = "completed"
    audit_run.finished_at = now + timedelta(minutes=3)
    SQLAlchemyOnboardingRepository._sync_audit_step(audit_step, audit_run)
    assert audit_step.status == "completed"

    plan_step = OnboardingStep(
        id="step-plan",
        run_id="onboarding-1",
        step_key="content_plan",
        position=6,
        status="running",
        attempts=1,
    )
    batch = ContentPlanBatch(
        id="batch-1",
        organization_id="org-1",
        project_id="project-1",
        source="automatic",
        target_count=30,
        status="completed",
        stage="scheduled",
        country="US",
        language="en",
        timezone="UTC",
        workflow_id="content-plan:automatic:batch-1",
        idempotency_key="onboarding:run-1:content-plan",
        request_hash="hash",
        finished_at=now + timedelta(minutes=8),
    )
    SQLAlchemyOnboardingRepository._sync_content_plan_step(
        plan_step, batch, plan_item_count=30
    )
    assert plan_step.status == "completed"
    assert plan_step.external_run_id == "batch-1"

    article_step = OnboardingStep(
        id="step-article",
        run_id="onboarding-1",
        step_key="first_article",
        position=7,
        status="running",
        attempts=1,
    )
    article_run = ArticleRun(
        id="article-run-1",
        article_id="article-1",
        organization_id="org-1",
        project_id="project-1",
        workflow_id="article-generation:article-run-1",
        status="completed_with_warnings",
        stage="completed",
        progress=100,
        finished_at=now + timedelta(minutes=15),
    )
    SQLAlchemyOnboardingRepository._sync_article_step(article_step, article_run)
    assert article_step.status == "completed"
    assert article_step.external_run_id == "article-run-1"


def test_completed_content_plan_requires_all_thirty_real_items() -> None:
    step = OnboardingStep(
        id="step-plan",
        run_id="onboarding-1",
        step_key="content_plan",
        position=6,
        status="running",
        attempts=1,
    )
    batch = ContentPlanBatch(
        id="batch-incomplete",
        organization_id="org-1",
        project_id="project-1",
        source="automatic",
        target_count=30,
        status="completed",
        stage="scheduled",
        country="US",
        language="en",
        timezone="UTC",
        workflow_id="content-plan:automatic:batch-incomplete",
        idempotency_key="onboarding:run-1:content-plan",
        request_hash="hash",
    )

    SQLAlchemyOnboardingRepository._sync_content_plan_step(
        step, batch, plan_item_count=29
    )

    assert step.status == "failed"
    assert step.last_error_code == "content_plan_items_incomplete"


def test_retry_resets_only_the_failed_step() -> None:
    run = OnboardingRun(
        id="run-1",
        organization_id="org-1",
        project_id="project-1",
        status="running",
        started_at=datetime(2026, 8, 12, 9, 0, tzinfo=UTC),
    )
    failed = OnboardingStep(
        id="step-1",
        run_id=run.id,
        step_key="technical_audit",
        position=4,
        status="failed",
        attempts=1,
        external_run_id="audit-1",
        last_error_code="timeout",
        last_error_message="audit timed out",
        started_at=run.started_at,
        finished_at=run.started_at + timedelta(minutes=1),
    )
    keyword = OnboardingStep(
        id="step-2",
        run_id=run.id,
        step_key="keyword_library",
        position=5,
        status="running",
        attempts=1,
        external_run_id="keywords-1",
    )

    from app.modules.onboarding.service import _make_ready

    _make_ready(failed)

    assert failed.status == "ready"
    assert failed.attempts == 1
    assert failed.external_run_id is None
    assert failed.last_error_code is None
    assert failed.last_error_message is None
    assert failed.started_at is None
    assert failed.finished_at is None
    assert keyword.status == "running"
    assert keyword.external_run_id == "keywords-1"


def test_model_constraints_cover_step_identity_and_status() -> None:
    run_constraints = {item.name for item in OnboardingRun.__table__.constraints}
    step_constraints = {item.name for item in OnboardingStep.__table__.constraints}

    assert "uq_onboarding_runs_project" in run_constraints
    assert "ck_onboarding_runs_status" in run_constraints
    assert "uq_onboarding_steps_run_key" in step_constraints
    assert "ck_onboarding_steps_status" in step_constraints
    assert "ck_onboarding_steps_attempts" in step_constraints
    assert SQLAlchemyOnboardingRepository is not None


def test_onboarding_timeline_tracks_real_crawl_and_profile_states() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-1",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="running",
        stage="extracting_pages",
    )

    extracting = onboarding_timeline_projection(
        "project-1", crawl_run, None, None
    )
    assert [(event["title"], event["status"]) for event in extracting] == [
        (extracting[0]["title"], "completed"),
        ("检查网站入口", "completed"),
        ("寻找核心页面", "completed"),
        ("读取核心页面", "running"),
    ]

    crawl_run.stage = "generating_profile"
    generating = onboarding_timeline_projection(
        "project-1", crawl_run, None, None
    )
    assert [(event["title"], event["status"]) for event in generating[1:]] == [
        ("检查网站入口", "completed"),
        ("寻找核心页面", "completed"),
        ("读取核心页面", "completed"),
        ("理解业务", "running"),
    ]

    profile = SiteProfile(
        project_id="project-1",
        source_run_id="understanding-1",
        profile_json={
            "business_name": "Example",
            "business_summary": "为成长型团队提供项目管理软件。",
            "products_services": ["项目管理", "团队协作"],
            "target_audiences": ["成长型团队", "项目负责人"],
            "value_propositions": ["集中管理任务与协作"],
            "key_pages": [
                {"title": "Example 项目管理", "url": "https://example.com"},
                {"title": "产品功能", "url": "https://example.com/features"},
            ],
        },
        confidence=0.8,
    )
    ready = onboarding_timeline_projection("project-1", crawl_run, profile, None)
    assert "接下来几分钟" in ready[0]["title"]
    assert "30 篇内容计划" in ready[0]["title"]
    by_key = {event["event_key"]: event for event in ready}
    core_pages = by_key["onboarding:core-pages:understanding-1"]
    business = by_key["onboarding:business-understanding:understanding-1"]
    assert "Example" in core_pages["content"]
    assert "Example 项目管理" not in core_pages["content"]
    assert "已完成" not in core_pages["content"]
    assert "这是我目前对 Example 的理解" in business["content"]
    assert "**它做什么**\n\n为成长型团队提供项目管理软件。" in business["content"]
    assert "**主要产品**\n\n项目管理；团队协作" in business["content"]
    assert "**主要客户**\n\n成长型团队；项目负责人" in business["content"]
    assert "**客户为什么选择它**\n\n集中管理任务与协作" in business["content"]
    assert "网站公开页面" in business["content"]
    confirmation = ready[-1]
    assert confirmation["status"] == "waiting"
    assert "重点确认主要客户" in confirmation["content"]
    assert "关键词库和内容计划" in confirmation["content"]
    assert confirmation["action"] == {
        "label": "确认业务资料",
        "href": "/projects/project-1/settings/business",
    }

    confirmed_at = datetime(2026, 8, 12, 9, 5, tzinfo=UTC)
    confirmed = onboarding_timeline_projection(
        "project-1", crawl_run, profile, confirmed_at
    )[-1]
    assert confirmed["status"] == "completed"
    assert confirmed["action"] == {}
    assert "下一步" in confirmed["content"]
    assert "搜索机会" in confirmed["content"]


def test_onboarding_timeline_does_not_cut_business_profile_sentences() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-long-copy",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="completed",
        stage="completed",
    )
    long_summary = (
        "ElephTV offers premium streaming entertainment focused on live sports, "
        "international blockbusters, exclusive African movies, and viewing on "
        "Android phones, TV boxes, smart TVs, and Windows devices without cutting "
        "the final device name."
    )
    profile = SiteProfile(
        project_id="project-1",
        source_run_id="understanding-long-copy",
        profile_json={
            "business_name": "ElephTV",
            "business_summary": long_summary,
            "products_services": [
                "Streaming entertainment access on Android, TV boxes, smart TVs, and Windows devices"
            ],
            "target_audiences": ["South African home entertainment viewers"],
            "value_propositions": ["Live sports and African movies across devices"],
        },
        confidence=0.8,
    )

    events = onboarding_timeline_projection("project-1", crawl_run, profile, None)
    content = next(
        event["content"]
        for event in events
        if event["event_key"]
        == "onboarding:business-understanding:understanding-long-copy"
    )

    assert long_summary in content
    assert "Windows devices" in content
    assert "…" not in content


def test_onboarding_timeline_names_missing_business_information() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-partial",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="partial",
        stage="completed",
    )
    profile = SiteProfile(
        project_id="project-1",
        source_run_id="understanding-partial",
        profile_json={
            "business_name": "Example",
            "business_type": "软件服务",
            "products_services": ["项目管理"],
            "target_audiences": [],
            "value_propositions": [],
        },
        confidence=0.6,
    )

    events = onboarding_timeline_projection("project-1", crawl_run, profile, None)
    content = next(
        event["content"]
        for event in events
        if event["event_key"]
        == "onboarding:business-understanding:understanding-partial"
    )

    assert "**主要客户**\n\n还没有识别到" in content
    assert "**客户为什么选择它**\n\n还没有识别到" in content
    assert "还需要你补充或确认：主要客户、客户选择它的原因。" in content


def test_onboarding_timeline_exposes_real_downstream_progress() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-1",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="completed",
        stage="completed",
    )
    profile = SiteProfile(
        project_id="project-1",
        source_run_id="understanding-1",
        profile_json={"business_name": "Example"},
        confidence=0.8,
    )
    run, rows = build_onboarding_records(
        "org-1", "project-1", datetime(2026, 8, 12, 9, tzinfo=UTC), "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, datetime(2026, 8, 12, 9, 5, tzinfo=UTC))
    steps["technical_audit"].status = "running"
    steps["technical_audit"].attempts = 1
    steps["keyword_library"].status = "completed"
    steps["keyword_library"].attempts = 1
    steps["content_plan"].status = "running"
    steps["content_plan"].attempts = 1

    keyword_run = KeywordBuildRun(
        id="keywords-1",
        organization_id="org-1",
        project_id="project-1",
        kind="initial",
        round_number=1,
        status="completed",
        stage="completed",
        progress=100,
        keyword_count=18,
        created_at=datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        updated_at=datetime(2026, 8, 12, 9, 8, tzinfo=UTC),
    )
    batch = ContentPlanBatch(
        id="batch-1",
        organization_id="org-1",
        project_id="project-1",
        source="automatic",
        target_count=30,
        status="building_previews",
        stage="d4_previews",
        selected_count=30,
        valid_pack_count=12,
        country="US",
        language="en",
        timezone="UTC",
        workflow_id="content-plan:automatic:batch-1",
        idempotency_key="onboarding:run-1:content-plan",
        request_hash="hash",
    )

    events = onboarding_timeline_projection(
        "project-1",
        crawl_run,
        profile,
        datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        steps=steps,
        keyword_run=keyword_run,
        content_plan_batch=batch,
        content_plan_item_count=0,
    )
    by_title = {event["title"]: event for event in events}

    assert by_title["技术审核"]["status"] == "running"
    assert by_title["关键词库"]["status"] == "completed"
    assert "18 个" in str(by_title["关键词库"]["content"])
    assert by_title["30 篇内容计划"]["status"] == "running"
    assert "12/30" in str(by_title["30 篇内容计划"]["content"])
    assert by_title["技术审核"]["metadata"]["retryable"] is False
    assert by_title["关键词库"]["metadata"]["retryable"] is False
    assert by_title["30 篇内容计划"]["metadata"]["retryable"] is False


def test_onboarding_timeline_discloses_partial_keyword_result() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-1",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="completed",
        stage="completed",
    )
    profile = SiteProfile(
        project_id="project-1",
        source_run_id="understanding-1",
        profile_json={"business_name": "Example"},
        confidence=0.8,
    )
    run, rows = build_onboarding_records(
        "org-1", "project-1", datetime(2026, 8, 12, 9, tzinfo=UTC), "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, datetime(2026, 8, 12, 9, 5, tzinfo=UTC))
    steps["keyword_library"].status = "completed"
    keyword_run = KeywordBuildRun(
        id="keywords-partial",
        organization_id="org-1",
        project_id="project-1",
        kind="initial",
        round_number=1,
        status="partial",
        stage="partial",
        progress=100,
        keyword_count=438,
        created_at=datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        updated_at=datetime(2026, 8, 12, 9, 8, tzinfo=UTC),
    )

    events = onboarding_timeline_projection(
        "project-1",
        crawl_run,
        profile,
        datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        steps=steps,
        keyword_run=keyword_run,
    )
    keyword_event = next(event for event in events if event["title"] == "关键词库")

    assert keyword_event["status"] == "completed"
    assert keyword_event["metadata"]["source_status"] == "partial"
    assert "部分完成" in str(keyword_event["content"])
    assert "438 个可继续使用" in str(keyword_event["content"])


def test_onboarding_timeline_only_marks_recoverable_failures_retryable() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-1",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="completed",
        stage="completed",
    )
    profile = SiteProfile(
        project_id="project-1",
        source_run_id="understanding-1",
        profile_json={"business_name": "Example"},
        confidence=0.8,
    )
    run, rows = build_onboarding_records(
        "org-1", "project-1", datetime(2026, 8, 12, 9, tzinfo=UTC), "understanding-1"
    )
    steps = step_map(rows)
    steps["site_understanding"].status = "completed"
    advance_onboarding(run, steps, datetime(2026, 8, 12, 9, 5, tzinfo=UTC))
    for step_key in ("technical_audit", "keyword_library", "content_plan"):
        steps[step_key].status = "failed"

    keyword_run = KeywordBuildRun(
        id="keywords-cancelled",
        organization_id="org-1",
        project_id="project-1",
        kind="initial",
        round_number=1,
        status="cancelled",
        stage="cancelled",
        progress=50,
        created_at=datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        updated_at=datetime(2026, 8, 12, 9, 6, tzinfo=UTC),
    )
    batch = ContentPlanBatch(
        id="batch-retryable",
        organization_id="org-1",
        project_id="project-1",
        source="automatic",
        target_count=30,
        status="needs_attention",
        stage="d3_failed",
        country="US",
        language="en",
        timezone="UTC",
        workflow_id="content-plan:automatic:batch-retryable",
        idempotency_key="onboarding:run-1:content-plan",
        request_hash="hash",
        error_code="seed_decision_contract_invalid",
    )

    events = onboarding_timeline_projection(
        "project-1",
        crawl_run,
        profile,
        datetime(2026, 8, 12, 9, 5, tzinfo=UTC),
        steps=steps,
        keyword_run=keyword_run,
        content_plan_batch=batch,
    )
    by_title = {event["title"]: event for event in events}

    assert by_title["技术审核"]["metadata"]["retryable"] is True
    assert by_title["关键词库"]["metadata"]["retryable"] is False
    assert by_title["30 篇内容计划"]["metadata"]["retryable"] is True


def test_completed_timeline_event_refreshes_copy_without_regressing_status() -> None:
    original_time = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)
    refreshed_time = original_time + timedelta(minutes=5)
    event = AgentTimelineEvent(
        id="event-1",
        organization_id="org-1",
        project_id="project-1",
        conversation_id="conversation-1",
        event_key="onboarding:business-understanding:understanding-1",
        sequence=3,
        kind="task",
        status="completed",
        title="业务理解",
        content="业务资料已生成。",
        action_json={},
        metadata_json={"source": "site_understanding"},
        created_at=original_time,
        updated_at=original_time,
    )

    class FakeSession:
        async def scalar(self, _statement):
            return event

    async def refresh() -> tuple[bool, bool]:
        changed = await SQLAlchemyOnboardingRepository._upsert_agent_timeline_event(
            FakeSession(),
            "org-1",
            "project-1",
            "conversation-1",
            {
                "event_key": event.event_key,
                "kind": "task",
                "status": "completed",
                "title": "业务理解结果",
                "content": "我目前对这个网站的判断：\n\n- **目标客户**：成长型团队",
                "metadata": {"source": "site_understanding"},
            },
            refreshed_time,
        )
        regressed = await SQLAlchemyOnboardingRepository._upsert_agent_timeline_event(
            FakeSession(),
            "org-1",
            "project-1",
            "conversation-1",
            {
                "event_key": event.event_key,
                "kind": "task",
                "status": "running",
                "title": "业务理解",
                "content": "正在重新整理业务资料。",
                "metadata": {"source": "site_understanding"},
            },
            refreshed_time + timedelta(minutes=1),
        )
        return changed, regressed

    changed, regressed = asyncio.run(refresh())

    assert changed is True
    assert regressed is False
    assert event.status == "completed"
    assert event.title == "业务理解结果"
    assert "**目标客户**：成长型团队" in event.content
    assert event.updated_at == refreshed_time


def test_onboarding_timeline_reports_the_real_failed_activity() -> None:
    crawl_run = CrawlRun(
        run_id="understanding-failed",
        organization_id="org-1",
        project_id="project-1",
        task_type="site_understanding",
        status="failed",
        stage="extracting_pages",
        message="internal provider details",
    )

    events = onboarding_timeline_projection("project-1", crawl_run, None, None)

    assert events[-1]["title"] == "读取核心页面"
    assert events[-1]["status"] == "failed"
    assert "internal provider details" not in str(events[-1]["content"])


def test_onboarding_route_returns_the_durable_step_projection() -> None:
    run, steps = build_onboarding_records(
        "org-1",
        "project-1",
        datetime(2026, 8, 12, 9, 0, tzinfo=UTC),
        "understanding-1",
    )

    class FakeOnboardingService:
        async def get(self, project_id: str):
            assert project_id == "project-1"
            return onboarding_response(run, steps)

    app.dependency_overrides[get_onboarding_service] = FakeOnboardingService

    async def request() -> tuple[int, dict]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/projects/project-1/onboarding")
            return response.status_code, response.json()

    try:
        status_code, payload = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 200
    assert payload["project_id"] == "project-1"
    assert [step["key"] for step in payload["steps"]] == list(STEP_KEYS)
    assert payload["steps"][1]["status"] == "running"
