from app.modules.content.models import (
    Article,
    ArticleAssetBinding,
    ArticleAutosave,
    ArticlePublication,
    ArticleReviewDecision,
    ArticleRun,
    ArticleVersion,
    AssetVariant,
    ContentAsset,
)
from app.modules.content_plan.models import (
    ContentPlanBatch,
    ContentPlanCandidate,
    ContentPlanExternalRequest,
    ContentPlanItem,
    ContentPlanItemKeyword,
    ContentPlanPreparation,
    ContentPlanPreparationKeyword,
    ContentPlanPreparationRelation,
    ContentPlanSerpSnapshot,
    ContentPlanSettings,
)


def constraint_names(model: type) -> set[str]:
    return {
        constraint.name
        for constraint in model.__table__.constraints
        if constraint.name is not None
    }


def index_names(model: type) -> set[str]:
    return {index.name for index in model.__table__.indexes}


def constraint_sql(model: type, name: str) -> str:
    return str(
        next(
            constraint.sqltext
            for constraint in model.__table__.constraints
            if constraint.name == name
        )
    )


def test_content_plan_models_expose_the_d2_tables_and_constraints() -> None:
    assert ContentPlanBatch.__tablename__ == "content_plan_batches"
    assert ContentPlanCandidate.__tablename__ == "content_plan_candidates"
    assert ContentPlanPreparation.__tablename__ == "content_plan_preparations"
    assert ContentPlanPreparationKeyword.__tablename__ == (
        "content_plan_preparation_keywords"
    )
    assert ContentPlanPreparationRelation.__tablename__ == (
        "content_plan_preparation_relations"
    )
    assert ContentPlanSerpSnapshot.__tablename__ == "content_plan_serp_snapshots"
    assert ContentPlanItem.__tablename__ == "content_plan_items"
    assert ContentPlanItemKeyword.__tablename__ == "content_plan_item_keywords"
    assert ContentPlanExternalRequest.__tablename__ == (
        "content_plan_external_requests"
    )
    assert ContentPlanSettings.__tablename__ == "content_plan_settings"
    assert ArticleReviewDecision.__tablename__ == "article_review_decisions"

    assert "ck_content_plan_batches_status" in constraint_names(ContentPlanBatch)
    assert "ck_content_plan_batches_source_target_count" in constraint_names(
        ContentPlanBatch
    )
    assert "uq_content_plan_batches_idempotency" in constraint_names(ContentPlanBatch)
    assert "uq_content_plan_batches_active_automatic_project" in index_names(
        ContentPlanBatch
    )
    assert "uq_content_plan_candidates_batch_source_rank" in constraint_names(
        ContentPlanCandidate
    )
    assert "uq_content_plan_candidates_selected_order" in index_names(
        ContentPlanCandidate
    )
    assert "uq_content_plan_preparations_batch_current_order" in index_names(
        ContentPlanPreparation
    )
    assert "uq_content_plan_preparation_keywords_primary" in index_names(
        ContentPlanPreparationKeyword
    )
    assert "uq_content_plan_serp_snapshots_current" in index_names(
        ContentPlanSerpSnapshot
    )
    assert "uq_content_plan_items_active_publish_date" in index_names(ContentPlanItem)
    assert "uq_content_plan_items_active_seed" in index_names(ContentPlanItem)
    assert "uq_content_plan_item_keywords_primary" in index_names(
        ContentPlanItemKeyword
    )
    assert "uq_content_plan_external_requests_request_key" in constraint_names(
        ContentPlanExternalRequest
    )
    assert "ck_content_plan_settings_cadence" in constraint_names(ContentPlanSettings)
    assert "ck_content_plan_settings_anchor" in constraint_names(ContentPlanSettings)


def test_content_plan_state_constraints_include_every_documented_state() -> None:
    batch_status_sql = constraint_sql(
        ContentPlanBatch, "ck_content_plan_batches_status"
    )
    for status in (
        "queued",
        "selecting_seeds",
        "expanding",
        "building_packs",
        "supplementing",
        "building_previews",
        "creating_items",
        "scheduling",
        "completed",
        "needs_attention",
        "cancelled",
    ):
        assert f"'{status}'" in batch_status_sql

    preparation_state_sql = constraint_sql(
        ContentPlanPreparation, "ck_content_plan_preparations_state"
    )
    for state in (
        "selected",
        "expanding",
        "expanded",
        "classifying",
        "coverage_check",
        "pack_ready",
        "serp_preview",
        "preview_ready",
        "invalid",
        "classification_failed",
        "coverage_check_failed",
        "preview_failed",
        "cancelled",
        "superseded",
    ):
        assert f"'{state}'" in preparation_state_sql


def test_article_model_keeps_review_state_separate_from_publication_quality() -> None:
    assert Article.__table__.c.review_status.nullable is True
    assert Article.__table__.c.review_version.nullable is False
    assert Article.__table__.c.publication_blocked_reason.nullable is True
    assert "ck_articles_review_status" in constraint_names(Article)
    assert "ck_articles_publication_blocked_reason" in constraint_names(Article)
    assert "ck_article_review_decisions_decision" in constraint_names(
        ArticleReviewDecision
    )


def test_article_production_models_expose_document_run_and_publication_contracts() -> None:
    assert Article.__table__.c.document_json.nullable is False
    assert Article.__table__.c.document_schema_version.nullable is False
    assert Article.__table__.c.current_content_hash.nullable is False
    assert Article.__table__.c.current_version_number.nullable is False
    assert ArticleRun.__table__.c.request_hash.nullable is True
    assert ArticleVersion.__table__.c.content_json.nullable is False
    assert ArticleVersion.__table__.c.document_snapshot.nullable is False
    assert ArticleVersion.__table__.c.metadata_snapshot.nullable is False
    assert ArticleVersion.__table__.c.asset_manifest.nullable is False
    assert ArticleVersion.__table__.c.content_hash.nullable is False
    assert "ck_article_publications_status" in constraint_names(ArticlePublication)
    assert "ck_article_publications_attempt" in constraint_names(ArticlePublication)
    assert "uq_article_publications_idempotency" in constraint_names(
        ArticlePublication
    )
    assert "ix_article_publications_article_created" in index_names(
        ArticlePublication
    )
    assert "uq_article_publications_active_article" in index_names(
        ArticlePublication
    )


def test_article_editor_foundation_models_keep_lifecycles_separate() -> None:
    assert "uq_article_autosaves_client_sequence" in constraint_names(ArticleAutosave)
    assert "uq_article_autosaves_idempotency" in constraint_names(ArticleAutosave)
    assert "ix_article_autosaves_latest" in index_names(ArticleAutosave)
    assert "ix_article_autosaves_expiry" in index_names(ArticleAutosave)

    assert "ck_content_assets_type" in constraint_names(ContentAsset)
    assert "ck_content_assets_status" in constraint_names(ContentAsset)
    assert "uq_content_assets_project_hash" in constraint_names(ContentAsset)
    assert "uq_asset_variants_transform" in constraint_names(AssetVariant)
    assert "uq_article_asset_bindings_active" in index_names(ArticleAssetBinding)
