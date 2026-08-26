from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.modules.projects.contracts import (
    GenerationInputPinsContract,
    ProjectArchiveRestoreContract,
    ProjectDeleteAssessmentContract,
    ProjectDependencyContract,
    ProjectLifecycleContract,
    ProjectOutreachProfileContract,
    SharedSeoEvidenceSnapshotContract,
    assert_generation_input_pins_match,
)
from app.modules.projects.schemas import PublishPromotionTargetRequest


def generation_pins() -> GenerationInputPinsContract:
    return GenerationInputPinsContract(
        organization_id="org-1",
        project_id="project-1",
        project_context_version=4,
        site_profile_version_id="site-profile-v4",
        outreach_profile_version_id="outreach-profile-v2",
        promotion_target_version_id="promotion-target-v2",
        keyword_evidence_snapshot_ids=["keyword-snapshot-1"],
        shared_evidence_snapshot_ids=["performance-snapshot-1"],
        market="US",
        qualification_contract_version="qualification-v1",
    )


def test_lifecycle_contract_rejects_incomplete_archive_state() -> None:
    with pytest.raises(ValidationError):
        ProjectLifecycleContract(
            project_id="project-1",
            lifecycle_version=2,
            status="ARCHIVED",
        )


def test_archive_contract_preserves_dependent_history() -> None:
    contract = ProjectArchiveRestoreContract(
        project_id="project-1",
        expected_lifecycle_version=2,
        operation="ARCHIVE",
    )

    assert contract.preserve_dependencies is True


def test_destructive_delete_contract_rejects_orphaned_history() -> None:
    assessment = ProjectDeleteAssessmentContract(
        project_id="project-1",
        dependencies=[
            ProjectDependencyContract(
                project_id="project-1",
                owner_module="BACKLINKS",
                record_type="outreach_opportunity",
                record_id="opportunity-1",
            ),
            ProjectDependencyContract(
                project_id="project-1",
                owner_module="REPORT",
                record_type="placement_report",
                record_id="report-1",
            ),
        ],
    )

    with pytest.raises(ValueError, match="would orphan retained"):
        assessment.assert_destructive_delete_allowed()

    ProjectDeleteAssessmentContract(project_id="project-1").assert_destructive_delete_allowed()


def test_delete_assessment_rejects_cross_project_dependencies() -> None:
    with pytest.raises(ValidationError, match="assessed project"):
        ProjectDeleteAssessmentContract(
            project_id="project-1",
            dependencies=[
                ProjectDependencyContract(
                    project_id="project-2",
                    owner_module="BACKLINKS",
                    record_type="outreach_opportunity",
                    record_id="opportunity-2",
                )
            ],
        )


def test_outreach_profile_normalizes_confirmed_intent() -> None:
    profile = ProjectOutreachProfileContract(
        organization_id="org-1",
        project_id="project-1",
        profile_version_id="outreach-profile-v2",
        promotion_target_version_id="promotion-target-v2",
        keywords_and_topics=[" seo ", "seo"],
        products_and_services=["SEO platform"],
        target_urls=["https://example.com/seo"],
        target_audiences=["Marketing teams"],
        partnership_goals=["Editorial links"],
        market="US",
        location="United States",
        language="en",
        authorized_discovery_sources=["keywords", "gsc"],
        immutable_fingerprint="sha256:profile-v2",
    )

    assert profile.keywords_and_topics == ["seo"]
    assert profile.profile_version_id != profile.promotion_target_version_id


def test_shared_evidence_requires_a_valid_freshness_window() -> None:
    fetched_at = datetime(2026, 8, 15, tzinfo=UTC)
    with pytest.raises(ValidationError):
        SharedSeoEvidenceSnapshotContract(
            organization_id="org-1",
            project_id="project-1",
            evidence_type="keyword-serp",
            source_module="keywords",
            source_record_id="keyword-run-1",
            source_version="keyword-run-v1",
            provider="dataforseo",
            endpoint="serp/google/organic/live/advanced",
            normalized_parameters={"keyword": "seo platform"},
            request_fingerprint="sha256:request-1",
            market="US",
            location="United States",
            language="en",
            fetched_at=fetched_at,
            expires_at=fetched_at - timedelta(seconds=1),
            provider_request_id="provider-request-1",
            provider_task_id="provider-task-1",
            cost_micros=2000,
            artifact_ref="artifact://keyword-run-1",
            status="ready",
        )


def test_generation_pins_reject_project_fact_substitution() -> None:
    expected = generation_pins()

    with pytest.raises(ValueError, match="bound to different project facts"):
        assert_generation_input_pins_match(
            expected,
            expected.model_copy(update={"site_profile_version_id": "site-profile-v5"}),
        )
    with pytest.raises(ValueError, match="bound to different project facts"):
        assert_generation_input_pins_match(
            expected,
            expected.model_copy(update={"keyword_evidence_snapshot_ids": ["keyword-snapshot-2"]}),
        )

    assert_generation_input_pins_match(expected, expected.model_copy())


def test_promotion_target_publish_accepts_only_authoritative_references() -> None:
    request = PublishPromotionTargetRequest(
        approved_keyword_ids=["keyword-2", "keyword-1", "keyword-2"],
        published_target_ids=["publication-1"],
        expected_project_context_version=4,
        expected_site_profile_version_id="profile-v4",
    )

    assert request.approved_keyword_ids == ["keyword-2", "keyword-1"]

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        PublishPromotionTargetRequest.model_validate(
            {
                "approved_keyword_ids": ["keyword-1"],
                "published_target_ids": [],
                "expected_project_context_version": 4,
                "expected_site_profile_version_id": "profile-v4",
                "partnershipGoals": ["Get authoritative backlinks"],
            }
        )

    with pytest.raises(ValidationError, match="至少需要一个"):
        PublishPromotionTargetRequest(
            expected_project_context_version=4,
            expected_site_profile_version_id="profile-v4",
        )
