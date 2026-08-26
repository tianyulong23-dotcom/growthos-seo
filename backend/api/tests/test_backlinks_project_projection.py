import asyncio
import json
import os
from uuid import uuid4

import pytest
from fastapi.responses import Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.projects.backlinks_projection import (
    PROJECT_CONTEXT_EVENT_TYPE,
    ProjectContextProjectionDispatcher,
    ProjectContextProjector,
    _fingerprint,
    _retryable_upstream_status,
)
from app.modules.projects.service import SQLAlchemyProjectRepository


class RecordingPublisher:
    def __init__(self, statuses: list[int]) -> None:
        self._statuses = statuses
        self.calls: list[tuple[ResolvedPlatformRequestContext, str, dict[str, object]]] = []

    async def publish_project_context(
        self,
        *,
        resolved: ResolvedPlatformRequestContext,
        website_project_key: str,
        payload: dict[str, object],
    ) -> Response:
        self.calls.append((resolved, website_project_key, payload))
        status = self._statuses.pop(0)
        return Response(
            content='{"accepted":true}' if status < 300 else '{"accepted":false}',
            status_code=status,
            media_type="application/json",
        )


def _database_url() -> str:
    value = os.getenv("BACKLINKS_PROJECT_PROJECTION_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("BACKLINKS_PROJECT_PROJECTION_TEST_DATABASE_URL is required")
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


def _resolved(project_id: str) -> ResolvedPlatformRequestContext:
    return ResolvedPlatformRequestContext(
        actor=PlatformActor(
            user_id="44444444-4444-4444-8444-444444444444",
            session_id="projection-test",
            roles=("owner",),
        ),
        tenant=PlatformTenant(
            organization_id="11111111-1111-4111-8111-111111111111",
            workspace_id="22222222-2222-4222-8222-222222222222",
        ),
        project=PlatformProject(
            website_project_id=project_id,
            website_project_key=project_id,
        ),
        permissions=("backlinks:read", "backlinks:write"),
        correlation_id=f"projection-test-{project_id}",
    )


def test_profile_version_change_changes_projection_fingerprint() -> None:
    stable_facts = {
        "projectStatus": "ACTIVE",
        "canonicalDomain": "example.com",
        "locale": "en",
        "countryCode": "US",
        "targetMarket": "US",
        "promotionTargetVersionId": "promotion-version-1",
        "products": ["Analytics"],
        "keywords": ["analytics"],
        "targetUrls": ["https://example.com/analytics"],
        "targetAudiences": ["Teams"],
        "partnershipGoals": ["Earn relevant editorial backlinks"],
        "inputComplete": True,
    }

    before = _fingerprint(
        {
            "projectionFingerprintVersion": 2,
            **stable_facts,
            "profileVersionId": "profile-version-1",
            "authorizedDiscoverySources": ["WEBSITE_PROJECT"],
            "sharedEvidence": [],
        }
    )
    after = _fingerprint(
        {
            "projectionFingerprintVersion": 2,
            **stable_facts,
            "profileVersionId": "profile-version-2",
            "authorizedDiscoverySources": ["WEBSITE_PROJECT"],
            "sharedEvidence": [],
        }
    )

    assert after != before


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (400, False),
        (408, True),
        (425, True),
        (429, True),
        (499, False),
        (500, True),
        (503, True),
    ],
)
def test_projection_delivery_retryability(
    status_code: int,
    expected: bool,
) -> None:
    assert _retryable_upstream_status(status_code) is expected


async def _cleanup(
    sessions: async_sessionmaker[AsyncSession],
    project_id: str,
) -> None:
    async with sessions() as session, session.begin():
        for table in (
            "platform.project_outbox_events",
            "platform.project_audit_events",
            "platform.promotion_target_versions",
            "platform.website_profile_versions",
            "platform.site_profiles",
        ):
            await session.execute(
                text(f"DELETE FROM {table} WHERE project_id = :project_id"),
                {"project_id": project_id},
            )
        await session.execute(
            text("DELETE FROM crawling.crawl_runs WHERE project_id = :project_id"),
            {"project_id": project_id},
        )
        await session.execute(
            text("DELETE FROM platform.projects WHERE id = :project_id"),
            {"project_id": project_id},
        )


def test_projection_is_transactional_idempotent_and_retries_exact_event() -> None:
    async def run() -> None:
        project_id = str(uuid4())
        engine = create_async_engine(
            _database_url(),
            connect_args={
                "server_settings": {
                    "search_path": "platform,crawling,audit,public",
                }
            },
            pool_pre_ping=True,
        )
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        resolved = _resolved(project_id)
        projector = ProjectContextProjector(sessions)
        publisher = RecordingPublisher([503, 202, 400, 202])
        dispatcher = ProjectContextProjectionDispatcher(sessions, publisher)
        crawl_run_id = str(uuid4())
        profile_version_id = str(uuid4())
        promotion_target_version_id = str(uuid4())

        try:
            async with sessions() as session, session.begin():
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.projects (
                          id, organization_id, workspace_id, project_key, status,
                          name, domain, country, target_market, language, health,
                          context_version, lifecycle_version
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_key, 'ACTIVE',
                          :name, :domain, 'ZA', 'ZA', 'en', 0, 1, 1
                        )
                        """
                    ),
                    {
                        "id": project_id,
                        "organization_id": resolved.tenant.organization_id,
                        "workspace_id": resolved.tenant.workspace_id,
                        "project_key": project_id,
                        "name": "Projection Test",
                        "domain": f"{project_id}.example.test",
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO crawling.crawl_runs (
                          run_id, organization_id, project_id, task_type, status,
                          stage, discovered, processed, selected, page_count,
                          backlink_count, config_snapshot, summary
                        ) VALUES (
                          :crawl_run_id, :organization_id, :project_id,
                          'site_understanding', 'completed', 'completed',
                          1, 1, 1, 1, 0, '{}'::jsonb, '{}'::jsonb
                        )
                        """
                    ),
                    {
                        "crawl_run_id": crawl_run_id,
                        "organization_id": resolved.tenant.organization_id,
                        "project_id": project_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.site_profiles (
                          project_id, source_run_id, profile_json,
                          user_overrides, confidence
                        ) VALUES (
                          :project_id, :crawl_run_id,
                          CAST(:profile_json AS jsonb), '{}'::jsonb, 0.9
                        )
                        """
                    ),
                    {
                        "project_id": project_id,
                        "crawl_run_id": crawl_run_id,
                        "profile_json": json.dumps(
                            {"confirmed_at": "2026-08-19T08:00:00+00:00"}
                        ),
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.website_profile_versions (
                          id, organization_id, workspace_id, project_id, version,
                          name, canonical_domain, country_code, target_market,
                          locale, products, input_required, created_by
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, 1,
                          'Projection Test', :domain, 'ZA', 'ZA', 'en',
                          CAST(:products AS jsonb), '[]'::jsonb, :created_by
                        )
                        """
                    ),
                    {
                        "id": profile_version_id,
                        "organization_id": resolved.tenant.organization_id,
                        "workspace_id": resolved.tenant.workspace_id,
                        "project_id": project_id,
                        "domain": f"{project_id}.example.test",
                        "products": '["Streaming", "Movies"]',
                        "created_by": resolved.actor.user_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.promotion_target_versions (
                          id, organization_id, workspace_id, project_id, version,
                          keywords, target_urls, target_audiences,
                          partnership_goals, input_required, created_by
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, 1,
                          CAST(:keywords AS jsonb), CAST(:target_urls AS jsonb),
                          CAST(:target_audiences AS jsonb),
                          CAST(:partnership_goals AS jsonb), '[]'::jsonb,
                          :created_by
                        )
                        """
                    ),
                    {
                        "id": promotion_target_version_id,
                        "organization_id": resolved.tenant.organization_id,
                        "workspace_id": resolved.tenant.workspace_id,
                        "project_id": project_id,
                        "keywords": '["streaming service in za", "example tv app"]',
                        "target_urls": f'["https://{project_id}.example.test/"]',
                        "target_audiences": (
                            '["English-speaking streaming viewers in South Africa"]'
                        ),
                        "partnership_goals": '["Earn relevant editorial backlinks"]',
                        "created_by": resolved.actor.user_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        UPDATE platform.projects
                           SET current_profile_version_id = :profile_version_id,
                               current_promotion_target_version_id =
                                 :promotion_target_version_id
                         WHERE id = :project_id
                        """
                    ),
                    {
                        "project_id": project_id,
                        "profile_version_id": profile_version_id,
                        "promotion_target_version_id": promotion_target_version_id,
                    },
                )

            first = await projector.ensure_projected(resolved)
            duplicate = await projector.ensure_projected(resolved)

            assert first.input_complete is True
            assert first.snapshot_version == 1
            assert duplicate == first

            failed = await dispatcher.dispatch_event(first.event_id)
            assert failed.status == "failed"
            assert failed.upstream_status == 503
            async with sessions() as session:
                failed_event = (
                    await session.execute(
                        text(
                            """
                            SELECT status, attempt_count, retryable, failure_code
                              FROM platform.project_outbox_events
                             WHERE id = :event_id
                            """
                        ),
                        {"event_id": first.event_id},
                    )
                ).mappings().one()
            assert dict(failed_event) == {
                "status": "failed",
                "attempt_count": 1,
                "retryable": True,
                "failure_code": "upstream_retryable",
            }

            retried = await dispatcher.dispatch_event(first.event_id)
            already_published = await dispatcher.dispatch_event(first.event_id)
            assert retried.status == "published"
            assert retried.upstream_status == 202
            async with sessions() as session:
                published_event = (
                    await session.execute(
                        text(
                            """
                            SELECT status, attempt_count, retryable, failure_code,
                                   last_error
                              FROM platform.project_outbox_events
                             WHERE id = :event_id
                            """
                        ),
                        {"event_id": first.event_id},
                    )
                ).mappings().one()
            assert dict(published_event) == {
                "status": "published",
                "attempt_count": 2,
                "retryable": True,
                "failure_code": None,
                "last_error": None,
            }
            assert already_published.status == "published"
            assert len(publisher.calls) == 2
            assert publisher.calls[0] == publisher.calls[1]
            assert publisher.calls[0][1] == project_id
            assert publisher.calls[0][2]["targetUrls"] == [
                f"https://{project_id}.example.test/"
            ]
            assert "sharedEvidence" not in publisher.calls[0][2]
            assert "authorizedDiscoverySources" not in publisher.calls[0][2]
            assert publisher.calls[0][2]["sharedSeoEvidence"]
            assert publisher.calls[0][2]["outreachProfile"]["profile"][
                "authorizedDiscoverySources"
            ] == ["WEBSITE_PROJECT", "CURATED_RESOURCE_LIBRARY"]

            changed_promotion_target_version_id = str(uuid4())
            async with sessions() as session, session.begin():
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.promotion_target_versions (
                          id, organization_id, workspace_id, project_id, version,
                          keywords, target_urls, target_audiences,
                          partnership_goals, input_required, created_by
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, 2,
                          CAST(:keywords AS jsonb), CAST(:target_urls AS jsonb),
                          CAST(:target_audiences AS jsonb),
                          CAST(:partnership_goals AS jsonb), '[]'::jsonb,
                          :created_by
                        )
                        """
                    ),
                    {
                        "id": changed_promotion_target_version_id,
                        "organization_id": resolved.tenant.organization_id,
                        "workspace_id": resolved.tenant.workspace_id,
                        "project_id": project_id,
                        "keywords": (
                            '["streaming service in za", "example tv app", '
                            '"example tv apk"]'
                        ),
                        "target_urls": f'["https://{project_id}.example.test/"]',
                        "target_audiences": (
                            '["English-speaking streaming viewers in South Africa"]'
                        ),
                        "partnership_goals": '["Earn relevant editorial backlinks"]',
                        "created_by": resolved.actor.user_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        UPDATE platform.projects
                           SET current_promotion_target_version_id = :version_id,
                               context_version = 2
                         WHERE id = :project_id
                        """
                    ),
                    {
                        "project_id": project_id,
                        "version_id": changed_promotion_target_version_id,
                    },
                )

            changed = await projector.ensure_projected(resolved)
            assert changed.event_id != first.event_id
            assert changed.snapshot_version == 2

            rejected_changed = await dispatcher.dispatch_event(changed.event_id)
            assert rejected_changed.status == "failed"
            assert rejected_changed.upstream_status == 400
            unresolved_health = await dispatcher.health_snapshot()
            assert unresolved_health["permanent_failed"] == 1
            assert unresolved_health["latest_failure_code"] == "upstream_rejected"
            assert len(publisher.calls) == 3

            async with sessions() as session, session.begin():
                await session.execute(
                    text(
                        """
                        UPDATE platform.projects
                           SET language = 'en-ZA'
                         WHERE id = :project_id
                        """
                    ),
                    {"project_id": project_id},
                )

            independent_change = await projector.ensure_projected(resolved)
            assert independent_change.event_id not in {
                first.event_id,
                changed.event_id,
            }
            assert independent_change.snapshot_version == 3
            published_independent = await dispatcher.dispatch_event(
                independent_change.event_id
            )
            assert published_independent.status == "published"
            resolved_health = await dispatcher.health_snapshot()
            assert resolved_health["permanent_failed"] == 0
            assert resolved_health["latest_failure_code"] is None
            assert resolved_health["latest_error"] is None
            assert len(publisher.calls) == 4

            async with sessions() as session:
                counts = (
                    await session.execute(
                        text(
                            """
                            SELECT
                              (SELECT count(*)
                                 FROM platform.website_profile_versions
                                WHERE project_id = :project_id) AS website_versions,
                              (SELECT count(*)
                                 FROM platform.promotion_target_versions
                                WHERE project_id = :project_id) AS promotion_versions,
                              (SELECT count(*)
                                 FROM platform.project_outbox_events
                                WHERE project_id = :project_id
                                  AND event_type = :event_type) AS outbox_events,
                              (SELECT count(*)
                                 FROM platform.project_audit_events
                                WHERE project_id = :project_id) AS audit_events
                            """
                        ),
                        {
                            "project_id": project_id,
                            "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                        },
                    )
                ).mappings().one()
                project = (
                    await session.execute(
                        text(
                            """
                            SELECT context_version, current_profile_version_id,
                                   current_promotion_target_version_id
                              FROM platform.projects
                             WHERE id = :project_id
                            """
                        ),
                        {"project_id": project_id},
                    )
                ).mappings().one()

            assert dict(counts) == {
                "website_versions": 1,
                "promotion_versions": 2,
                "outbox_events": 3,
                "audit_events": 3,
            }
            assert project["context_version"] == 3
            assert project["current_profile_version_id"]
            assert project["current_promotion_target_version_id"]
        finally:
            await _cleanup(sessions, project_id)
            await engine.dispose()

    asyncio.run(run())


def test_business_profile_confirmation_reuses_published_context_version() -> None:
    async def run() -> None:
        project_id = str(uuid4())
        organization_id = f"projection-confirmation-{project_id}"
        workspace_id = "projection-confirmation"
        crawl_run_id = str(uuid4())
        profile_version_id = str(uuid4())
        promotion_target_version_id = str(uuid4())
        engine = create_async_engine(
            _database_url(),
            connect_args={
                "server_settings": {
                    "search_path": "platform,crawling,audit,public",
                }
            },
            pool_pre_ping=True,
        )
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        projector = ProjectContextProjector(sessions)
        repository = SQLAlchemyProjectRepository(sessions, projector=projector)
        updates = {
            "business_name": "Projection Confirmation Test",
            "business_type": "Media",
            "business_summary": "Independent streaming and film coverage.",
            "target_audiences": ["South African viewers"],
            "products_services": ["live streaming", "film reviews"],
            "value_propositions": ["Independent coverage"],
            "ai_content_rules": "",
        }

        try:
            async with sessions() as session, session.begin():
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.projects (
                          id, organization_id, workspace_id, project_key, status,
                          name, domain, country, target_market, language, health,
                          context_version, lifecycle_version, understanding_run_id
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_key, 'ACTIVE',
                          :name, :domain, 'ZA', 'ZA', 'en', 0, 6, 1, :crawl_run_id
                        )
                        """
                    ),
                    {
                        "id": project_id,
                        "organization_id": organization_id,
                        "workspace_id": workspace_id,
                        "project_key": project_id,
                        "name": updates["business_name"],
                        "domain": f"{project_id}.example.test",
                        "crawl_run_id": crawl_run_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO crawling.crawl_runs (
                          run_id, organization_id, project_id, task_type, status,
                          stage, discovered, processed, selected, page_count,
                          backlink_count, config_snapshot, summary
                        ) VALUES (
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
                        INSERT INTO platform.site_profiles (
                          project_id, source_run_id, profile_json,
                          user_overrides, confidence
                        ) VALUES (
                          :project_id, :crawl_run_id,
                          CAST(:profile_json AS jsonb), '{}'::jsonb, 0.9
                        )
                        """
                    ),
                    {
                        "project_id": project_id,
                        "crawl_run_id": crawl_run_id,
                        "profile_json": json.dumps(updates),
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.website_profile_versions (
                          id, organization_id, workspace_id, project_id, version,
                          name, canonical_domain, country_code, target_market,
                          locale, products, input_required, created_by
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, 3,
                          :name, :domain, 'ZA', 'ZA', 'en',
                          CAST(:products AS jsonb),
                          '["PROJECTS:confirm_site_profile"]'::jsonb,
                          'projection-confirmation-fixture'
                        )
                        """
                    ),
                    {
                        "id": profile_version_id,
                        "organization_id": organization_id,
                        "workspace_id": workspace_id,
                        "project_id": project_id,
                        "name": updates["business_name"],
                        "domain": f"{project_id}.example.test",
                        "products": '["live streaming", "film reviews"]',
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.promotion_target_versions (
                          id, organization_id, workspace_id, project_id, version,
                          keywords, target_urls, target_audiences,
                          partnership_goals, input_required, created_by
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, 1,
                          '["South African streaming guide"]'::jsonb,
                          CAST(:target_urls AS jsonb),
                          '["South African viewers"]'::jsonb,
                          '["Earn editorial coverage"]'::jsonb,
                          '[]'::jsonb, 'projection-confirmation-fixture'
                        )
                        """
                    ),
                    {
                        "id": promotion_target_version_id,
                        "organization_id": organization_id,
                        "workspace_id": workspace_id,
                        "project_id": project_id,
                        "target_urls": (
                            f'["https://{project_id}.example.test/streaming"]'
                        ),
                    },
                )
                await session.execute(
                    text(
                        """
                        UPDATE platform.projects
                           SET current_profile_version_id = :profile_version_id,
                               current_promotion_target_version_id =
                                 :promotion_target_version_id
                         WHERE id = :project_id
                        """
                    ),
                    {
                        "project_id": project_id,
                        "profile_version_id": profile_version_id,
                        "promotion_target_version_id": promotion_target_version_id,
                    },
                )

            confirmed = await repository.update_business_profile(
                organization_id,
                project_id,
                updates,
            )
            replayed = await repository.update_business_profile(
                organization_id,
                project_id,
                updates,
            )

            async with sessions() as session:
                state = (
                    await session.execute(
                        text(
                            """
                            SELECT project.context_version,
                                   project.current_profile_version_id,
                                   profile.version AS profile_version,
                                   site.profile_json ->> 'confirmed_at' AS confirmed_at,
                                   (SELECT count(*)
                                      FROM platform.website_profile_versions
                                     WHERE project_id = :project_id) AS profile_count,
                                   (SELECT count(*)
                                      FROM platform.project_outbox_events
                                     WHERE project_id = :project_id
                                       AND event_type = :event_type) AS outbox_count,
                                   (SELECT count(*)
                                      FROM platform.project_audit_events
                                     WHERE project_id = :project_id) AS audit_count
                              FROM platform.projects project
                              JOIN platform.website_profile_versions profile
                                ON profile.id = project.current_profile_version_id
                              JOIN platform.site_profiles site
                                ON site.project_id = project.id
                             WHERE project.id = :project_id
                            """
                        ),
                        {
                            "project_id": project_id,
                            "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                        },
                    )
                ).mappings().one()
                projection_payload = await session.scalar(
                    text(
                        """
                        SELECT payload
                          FROM platform.project_outbox_events
                         WHERE project_id = :project_id
                           AND event_type = :event_type
                         ORDER BY created_at DESC
                         LIMIT 1
                        """
                    ),
                    {
                        "project_id": project_id,
                        "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                    },
                )

            assert confirmed.context_version == 7
            assert replayed.context_version == 7
            assert state["context_version"] == 7
            assert state["current_profile_version_id"] != profile_version_id
            assert state["profile_version"] == 4
            assert state["confirmed_at"]
            assert state["profile_count"] == 2
            assert state["outbox_count"] == 1
            assert state["audit_count"] == 2
            assert isinstance(projection_payload, dict)
            projection_request = projection_payload["request"]
            assert isinstance(projection_request, dict)
            assert projection_request["snapshotVersion"] == 7
            assert projection_request["profileVersionId"] == (
                state["current_profile_version_id"]
            )
        finally:
            await _cleanup(sessions, project_id)
            await engine.dispose()

    asyncio.run(run())
