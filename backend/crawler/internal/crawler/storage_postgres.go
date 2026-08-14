package crawler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var plaintextAISettingsPrefix = []byte("plaintext:v1:")

type PostgresCrawlRepository struct {
	pool                    *pgxpool.Pool
	aiSettingsEncryptionKey string
}

func NewPostgresCrawlRepository(
	ctx context.Context,
	databaseURL string,
	aiSettingsEncryptionKey string,
) (*PostgresCrawlRepository, error) {
	databaseURL = normalizePostgresURL(databaseURL)
	if databaseURL == "" {
		return nil, errors.New("CRAWLER_DATABASE_URL or DATABASE_URL is required")
	}
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("configure PostgreSQL: %w", err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = "public,platform,crawling,audit"
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("configure PostgreSQL pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect PostgreSQL: %w", err)
	}
	var schemaReady bool
	if err := pool.QueryRow(
		ctx,
		`
		SELECT
			to_regclass('platform.projects') IS NOT NULL
			AND to_regclass('crawling.crawl_runs') IS NOT NULL
			AND to_regclass('crawling.pages') IS NOT NULL
			AND to_regclass('crawling.page_snapshots') IS NOT NULL
			AND to_regclass('crawling.link_edges') IS NOT NULL
			AND to_regclass('crawling.backlink_checks') IS NOT NULL
			AND to_regclass('platform.site_profiles') IS NOT NULL
			AND to_regclass('audit.audit_issues') IS NOT NULL
			AND to_regclass('crawling.crawl_checkpoints') IS NOT NULL
			AND to_regclass('audit.pagespeed_results') IS NOT NULL
			AND to_regclass('crawling.external_resources') IS NOT NULL
			AND to_regclass('public.ai_provider_settings') IS NOT NULL
			AND to_regclass('public.site_profile_versions') IS NOT NULL
			AND to_regclass('crawling.business_profile_ai_calls') IS NOT NULL
		`,
	).Scan(&schemaReady); err != nil {
		pool.Close()
		return nil, fmt.Errorf("check PostgreSQL crawler schema: %w", err)
	}
	if !schemaReady {
		pool.Close()
		return nil, errors.New(
			"PostgreSQL crawler tables are missing; run the API Alembic migrations",
		)
	}
	return &PostgresCrawlRepository{
		pool:                    pool,
		aiSettingsEncryptionKey: aiSettingsEncryptionKey,
	}, nil
}

func NewProductionStore(ctx context.Context, config Config) (*ProductionStore, error) {
	repository, err := NewPostgresCrawlRepository(
		ctx,
		config.DatabaseURL,
		config.AISettingsEncryptionKey,
	)
	if err != nil {
		return nil, err
	}
	objects, err := NewS3ObjectStore(ctx, config)
	if err != nil {
		repository.Close()
		return nil, err
	}
	return newProductionStore(repository, objects), nil
}

func (r *PostgresCrawlRepository) Close() {
	r.pool.Close()
}

func (r *PostgresCrawlRepository) LoadAIProviderSettings(
	ctx context.Context,
	organizationID string,
) (AIProviderSettings, bool, error) {
	var settings AIProviderSettings
	var storedAPIKey []byte
	var requestTimeoutSeconds int
	err := r.pool.QueryRow(
		ctx,
		`
		SELECT
				provider,
				base_url,
				api_key_encrypted,
				COALESCE(NULLIF(business_model, ''), model),
				COALESCE(NULLIF(business_reasoning_effort, ''), reasoning_effort),
				request_timeout_seconds,
				max_retries
		FROM ai_provider_settings
		WHERE organization_id = $1
		`,
		organizationID,
	).Scan(
		&settings.Provider,
		&settings.BaseURL,
		&storedAPIKey,
		&settings.Model,
		&settings.ReasoningEffort,
		&requestTimeoutSeconds,
		&settings.MaxRetries,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return AIProviderSettings{}, false, nil
	}
	if err != nil {
		return AIProviderSettings{}, false, fmt.Errorf(
			"load AI provider settings: %w",
			err,
		)
	}
	apiKey, plaintext, err := decodePlaintextAIAPIKey(storedAPIKey)
	if err != nil {
		return AIProviderSettings{}, false, err
	}
	if plaintext {
		settings.APIKey = apiKey
	} else {
		if strings.TrimSpace(r.aiSettingsEncryptionKey) == "" {
			return AIProviderSettings{}, false, errors.New(
				"AI_SETTINGS_ENCRYPTION_KEY is required to load encrypted AI provider settings",
			)
		}
		if err := r.pool.QueryRow(
			ctx,
			`SELECT pgp_sym_decrypt(api_key_encrypted, $2)
			 FROM ai_provider_settings
			 WHERE organization_id = $1`,
			organizationID,
			r.aiSettingsEncryptionKey,
		).Scan(&settings.APIKey); err != nil {
			return AIProviderSettings{}, false, fmt.Errorf(
				"decrypt AI provider settings: %w",
				err,
			)
		}
	}
	settings.RequestTimeout = time.Duration(requestTimeoutSeconds) * time.Second
	return settings, true, nil
}

func (r *PostgresCrawlRepository) SaveAIProfileInvocation(
	ctx context.Context,
	task Task,
	invocation AIProfileInvocation,
) error {
	_, err := r.pool.Exec(
		ctx,
		`
		INSERT INTO crawling.business_profile_ai_calls (
			organization_id, project_id, run_id, provider, base_url, model,
			attempt, status, request_json, http_status, raw_response_json,
			raw_response_body, raw_model_output, parsed_output_json,
			elapsed_ms, prompt_tokens, completion_tokens, total_tokens,
			cost_usd, error_type, error_message, created_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb,
			$12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22
		)
		`,
		task.OrganizationID,
		task.ProjectID,
		task.RunID,
		invocation.Provider,
		invocation.BaseURL,
		invocation.Model,
		invocation.Attempt,
		invocation.Status,
		nullableJSON(invocation.RequestJSON),
		nullableInt(invocation.HTTPStatus),
		nullableJSON(invocation.RawResponseJSON),
		nullableString(invocation.RawResponseBody),
		nullableString(invocation.RawModelOutput),
		nullableJSON(invocation.ParsedOutputJSON),
		invocation.ElapsedMS,
		nullableInt(invocation.PromptTokens),
		nullableInt(invocation.CompletionTokens),
		nullableInt(invocation.TotalTokens),
		invocation.CostUSD,
		nullableString(invocation.ErrorType),
		nullableString(invocation.ErrorMessage),
		invocation.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("save business profile AI invocation: %w", err)
	}
	return nil
}

func nullableJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return []byte(value)
}

func decodePlaintextAIAPIKey(stored []byte) (string, bool, error) {
	if !bytes.HasPrefix(stored, plaintextAISettingsPrefix) {
		return "", false, nil
	}
	apiKey := stored[len(plaintextAISettingsPrefix):]
	if !utf8.Valid(apiKey) {
		return "", true, errors.New("stored plaintext AI API key is not valid UTF-8")
	}
	return string(apiKey), true, nil
}

func (r *PostgresCrawlRepository) SaveProgress(
	ctx context.Context,
	task Task,
	progress Progress,
) error {
	status := "running"
	var finishedAt any
	if progress.Stage == StageFailed {
		status = "failed"
		finishedAt = progress.OccurredAt
	}
	configSnapshot, err := json.Marshal(task)
	if err != nil {
		return fmt.Errorf("encode crawl config: %w", err)
	}
	_, err = r.pool.Exec(
		ctx,
		`
		INSERT INTO crawl_runs (
			run_id, organization_id, project_id, task_type, target_url, country, language,
			status, stage, message, discovered, processed, selected, config_snapshot,
			started_at, finished_at, updated_at
		)
		SELECT
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			$14::jsonb, $15, $16, now()
		WHERE EXISTS (
			SELECT 1
			FROM projects
			WHERE id = $3 AND organization_id = $2
		)
		ON CONFLICT (run_id) DO UPDATE SET
			status = EXCLUDED.status,
			stage = EXCLUDED.stage,
			message = EXCLUDED.message,
			discovered = EXCLUDED.discovered,
			processed = EXCLUDED.processed,
			selected = EXCLUDED.selected,
			config_snapshot = EXCLUDED.config_snapshot,
			started_at = COALESCE(crawl_runs.started_at, EXCLUDED.started_at),
			finished_at = CASE
				WHEN EXCLUDED.status = 'failed' THEN EXCLUDED.finished_at
				ELSE crawl_runs.finished_at
			END,
			updated_at = now()
		WHERE crawl_runs.status NOT IN ('paused', 'stopping', 'stopped')
		`,
		task.RunID,
		task.OrganizationID,
		task.ProjectID,
		task.Type,
		nullableString(task.TargetURL),
		nullableString(task.Country),
		nullableString(task.Language),
		status,
		progress.Stage,
		nullableString(progress.Message),
		progress.Discovered,
		progress.Processed,
		progress.Selected,
		configSnapshot,
		progress.OccurredAt,
		finishedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert crawl progress: %w", err)
	}
	return nil
}

func (r *PostgresCrawlRepository) SaveCheckpoint(
	ctx context.Context,
	task Task,
	checkpoint CrawlCheckpoint,
) error {
	data, err := json.Marshal(checkpoint)
	if err != nil {
		return fmt.Errorf("encode crawl checkpoint: %w", err)
	}
	if _, err := r.pool.Exec(
		ctx,
		`
		INSERT INTO crawl_checkpoints (run_id, checkpoint, updated_at)
		VALUES ($1, $2::jsonb, now())
		ON CONFLICT (run_id) DO UPDATE SET
			checkpoint = EXCLUDED.checkpoint,
			updated_at = now()
		`,
		task.RunID,
		data,
	); err != nil {
		return fmt.Errorf("save crawl checkpoint: %w", err)
	}
	if _, err := r.pool.Exec(
		ctx,
		"UPDATE crawl_runs SET can_resume = true, updated_at = now() WHERE run_id = $1",
		task.RunID,
	); err != nil {
		return fmt.Errorf("mark crawl run resumable: %w", err)
	}
	return nil
}

func (r *PostgresCrawlRepository) LoadCheckpoint(
	ctx context.Context,
	task Task,
) (CrawlCheckpoint, bool, error) {
	var data []byte
	err := r.pool.QueryRow(
		ctx,
		"SELECT checkpoint FROM crawl_checkpoints WHERE run_id = $1",
		task.RunID,
	).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return CrawlCheckpoint{}, false, nil
	}
	if err != nil {
		return CrawlCheckpoint{}, false, fmt.Errorf("load crawl checkpoint: %w", err)
	}
	var checkpoint CrawlCheckpoint
	if err := json.Unmarshal(data, &checkpoint); err != nil {
		return CrawlCheckpoint{}, false, fmt.Errorf("decode crawl checkpoint: %w", err)
	}
	return checkpoint, true, nil
}

func (r *PostgresCrawlRepository) DeleteCheckpoint(
	ctx context.Context,
	task Task,
) error {
	if _, err := r.pool.Exec(
		ctx,
		"DELETE FROM crawl_checkpoints WHERE run_id = $1",
		task.RunID,
	); err != nil {
		return fmt.Errorf("delete crawl checkpoint: %w", err)
	}
	return nil
}

func (r *PostgresCrawlRepository) SaveResult(
	ctx context.Context,
	task Task,
	result Result,
	resultRef string,
) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var lockedProjectID string
	var understandingRunID string
	if err := tx.QueryRow(
		ctx,
		`
		SELECT id, COALESCE(understanding_run_id, '')
		FROM projects
		WHERE id = $1 AND organization_id = $2
		FOR UPDATE
		`,
		task.ProjectID,
		task.OrganizationID,
	).Scan(&lockedProjectID, &understandingRunID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return fmt.Errorf("lock crawl project: %w", err)
	}

	configSnapshot, err := json.Marshal(task)
	if err != nil {
		return fmt.Errorf("encode crawl config: %w", err)
	}
	summary, err := json.Marshal(buildStoredAuditSummary(result))
	if err != nil {
		return fmt.Errorf("encode crawl summary: %w", err)
	}
	resultStatus := storedResultStatus(task, result)

	if _, err := tx.Exec(
		ctx,
		`
		INSERT INTO crawl_runs (
			run_id, organization_id, project_id, task_type, target_url, country, language,
			status, stage, message, discovered, processed, selected, page_count,
			backlink_count, result_ref, config_snapshot, summary, can_resume,
			started_at, finished_at, updated_at
		)
		VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11, $11,
			$12, $13, $14::jsonb, $15::jsonb, false, $16, $17, now()
		)
		ON CONFLICT (run_id) DO UPDATE SET
			status = EXCLUDED.status,
			stage = EXCLUDED.stage,
			message = EXCLUDED.message,
			discovered = EXCLUDED.discovered,
			processed = EXCLUDED.processed,
			selected = EXCLUDED.selected,
			page_count = EXCLUDED.page_count,
			backlink_count = EXCLUDED.backlink_count,
			result_ref = EXCLUDED.result_ref,
			config_snapshot = EXCLUDED.config_snapshot,
			summary = EXCLUDED.summary,
			can_resume = false,
			started_at = EXCLUDED.started_at,
			finished_at = EXCLUDED.finished_at,
			updated_at = now()
		`,
		task.RunID,
		task.OrganizationID,
		task.ProjectID,
		task.Type,
		nullableString(task.TargetURL),
		nullableString(task.Country),
		nullableString(task.Language),
		resultStatus,
		StageCompleted,
		completionMessageForResult(task, result),
		len(result.Pages),
		len(result.Backlinks),
		resultRef,
		configSnapshot,
		summary,
		result.StartedAt,
		result.FinishedAt,
	); err != nil {
		return fmt.Errorf("upsert crawl result: %w", err)
	}

	if _, err := tx.Exec(ctx, "DELETE FROM link_edges WHERE run_id = $1", task.RunID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM page_snapshots WHERE run_id = $1", task.RunID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM backlink_checks WHERE run_id = $1", task.RunID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM audit_issues WHERE run_id = $1", task.RunID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM pagespeed_results WHERE run_id = $1", task.RunID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM external_resources WHERE run_id = $1", task.RunID); err != nil {
		return err
	}

	statusByURL := make(map[string]int, len(result.Pages)*2)
	linkedFromByURL := make(map[string][]string)
	for _, page := range result.Pages {
		requested := normalizeStoredURL(page.URL)
		final := normalizeStoredURL(defaultString(page.FinalURL, page.URL))
		statusByURL[requested] = page.StatusCode
		statusByURL[final] = page.StatusCode
		source := defaultString(page.FinalURL, page.URL)
		for _, link := range page.Links {
			target := normalizeStoredURL(link.URL)
			linkedFromByURL[target] = appendUniqueString(linkedFromByURL[target], source)
		}
	}
	pageIDs := make(map[string]int64, len(result.Pages)*2)
	for _, page := range result.Pages {
		page.LinkedFrom = linkedFromByURL[normalizeStoredURL(
			defaultString(page.FinalURL, page.URL),
		)]
		pageID, err := upsertPage(ctx, tx, task, page)
		if err != nil {
			return err
		}
		pageIDs[normalizeStoredURL(page.URL)] = pageID
		pageIDs[normalizeStoredURL(defaultString(page.FinalURL, page.URL))] = pageID
		if err := insertPageSnapshot(ctx, tx, task.RunID, pageID, page); err != nil {
			return err
		}
		if err := insertLinks(
			ctx,
			tx,
			task.RunID,
			pageID,
			page.Links,
			statusByURL,
		); err != nil {
			return err
		}
	}
	for _, issue := range result.Issues {
		if err := insertAuditIssue(ctx, tx, task.RunID, pageIDs, issue); err != nil {
			return err
		}
	}
	for _, item := range result.ExternalResources {
		if _, err := tx.Exec(
			ctx,
			`
			INSERT INTO external_resources (
				run_id, url, final_url, status_code, content_type, size_bytes,
				title, error, error_type, checked_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			`,
			task.RunID,
			item.URL,
			nullableString(item.FinalURL),
			nullableInt(item.StatusCode),
			nullableString(item.ContentType),
			item.SizeBytes,
			nullableString(item.Title),
			nullableString(item.Error),
			nullableString(item.ErrorType),
			item.CheckedAt,
		); err != nil {
			return fmt.Errorf("insert external resource %q: %w", item.URL, err)
		}
	}
	for _, item := range result.PageSpeed {
		metrics, err := json.Marshal(item.Metrics)
		if err != nil {
			return fmt.Errorf("encode PageSpeed metrics: %w", err)
		}
		if _, err := tx.Exec(
			ctx,
			`
			INSERT INTO pagespeed_results (
				run_id, url, strategy, performance_score, accessibility_score,
				best_practices_score, seo_score, metrics, error, analyzed_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
			`,
			task.RunID,
			item.URL,
			item.Strategy,
			nullableIntPointer(item.PerformanceScore),
			nullableIntPointer(item.AccessibilityScore),
			nullableIntPointer(item.BestPracticesScore),
			nullableIntPointer(item.SEOScore),
			metrics,
			nullableString(item.Error),
			item.AnalyzedAt,
		); err != nil {
			return fmt.Errorf("insert PageSpeed result: %w", err)
		}
	}
	for _, backlink := range result.Backlinks {
		foundLinks, err := json.Marshal(backlink.FoundLinks)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			ctx,
			`
			INSERT INTO backlink_checks (
				run_id, url, final_url, status_code, found_links, error, checked_at
			)
			VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
			`,
			task.RunID,
			backlink.URL,
			nullableString(backlink.FinalURL),
			nullableInt(backlink.StatusCode),
			foundLinks,
			nullableString(backlink.Error),
			backlink.CheckedAt,
		); err != nil {
			return fmt.Errorf("insert backlink check: %w", err)
		}
	}
	if task.Type == TaskSiteUnderstanding {
		profile := BuildSiteProfile(task, result.Pages)
		if result.SiteProfile != nil {
			profile = *result.SiteProfile
		}
		profileJSON, err := json.Marshal(profile)
		if err != nil {
			return fmt.Errorf("encode site profile: %w", err)
		}
		if _, err := tx.Exec(
			ctx,
			`
			INSERT INTO site_profile_versions (
				source_run_id, project_id, profile_json, confidence
			)
			VALUES ($1, $2, $3::jsonb, $4)
			ON CONFLICT (source_run_id) DO NOTHING
			`,
			task.RunID,
			task.ProjectID,
			profileJSON,
			profile.Confidence,
		); err != nil {
			return fmt.Errorf("insert site profile version: %w", err)
		}
		if _, err := tx.Exec(
			ctx,
			`
			INSERT INTO site_profiles (
				project_id, source_run_id, profile_json, confidence, updated_at
			)
			SELECT $1, $2, $3::jsonb, $4, now()
			WHERE $5
			ON CONFLICT (project_id) DO UPDATE SET
				source_run_id = EXCLUDED.source_run_id,
				profile_json = EXCLUDED.profile_json
					|| COALESCE(site_profiles.user_overrides, '{}'::jsonb),
				confidence = EXCLUDED.confidence,
				updated_at = now()
			`,
			task.ProjectID,
			task.RunID,
			profileJSON,
			profile.Confidence,
			understandingRunID == task.RunID,
		); err != nil {
			return fmt.Errorf("upsert site profile: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM crawl_checkpoints WHERE run_id = $1", task.RunID); err != nil {
		return fmt.Errorf("delete completed crawl checkpoint: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit crawl result: %w", err)
	}
	return nil
}

func (r *PostgresCrawlRepository) RecalculateIssues(
	ctx context.Context,
	task Task,
) (IssueRecalculationResult, error) {
	if task.Type != TaskTechnicalAudit {
		return IssueRecalculationResult{}, errors.New(
			"issue recalculation requires a technical audit task",
		)
	}
	if err := task.Validate(); err != nil {
		return IssueRecalculationResult{}, err
	}

	pages, pageIDs, err := r.loadIssueRecalculationPages(ctx, task)
	if err != nil {
		return IssueRecalculationResult{}, err
	}
	issues := (IssueDetector{
		ExclusionPatterns:  task.IssueExclusions,
		DuplicationEnabled: task.EnableDuplication,
		DuplicationLimit:   task.DuplicationLimit,
	}).Detect(pages)
	summaryMap := buildStoredAuditSummary(Result{Pages: pages, Issues: issues})
	configSnapshot, err := json.Marshal(task)
	if err != nil {
		return IssueRecalculationResult{}, fmt.Errorf("encode crawl config: %w", err)
	}
	summaryJSON, err := json.Marshal(summaryMap)
	if err != nil {
		return IssueRecalculationResult{}, fmt.Errorf("encode crawl summary: %w", err)
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return IssueRecalculationResult{}, err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var status string
	if err := tx.QueryRow(
		ctx,
		`
		SELECT status
		FROM crawl_runs
		WHERE run_id = $1
			AND organization_id = $2
			AND project_id = $3
			AND task_type = 'technical_audit'
		FOR UPDATE
		`,
		task.RunID,
		task.OrganizationID,
		task.ProjectID,
	).Scan(&status); errors.Is(err, pgx.ErrNoRows) {
		return IssueRecalculationResult{}, errors.New("audit run not found")
	} else if err != nil {
		return IssueRecalculationResult{}, fmt.Errorf("lock audit run: %w", err)
	}
	if status != "recalculating" {
		return IssueRecalculationResult{}, fmt.Errorf(
			"audit run is not recalculating: %s",
			status,
		)
	}

	if _, err := tx.Exec(
		ctx,
		"DELETE FROM audit_issues WHERE run_id = $1",
		task.RunID,
	); err != nil {
		return IssueRecalculationResult{}, fmt.Errorf("delete audit issues: %w", err)
	}
	for _, issue := range issues {
		if err := insertAuditIssue(ctx, tx, task.RunID, pageIDs, issue); err != nil {
			return IssueRecalculationResult{}, err
		}
	}
	if _, err := tx.Exec(
		ctx,
		`
		UPDATE crawl_runs
		SET status = 'completed',
			stage = 'completed',
			message = 'Technical audit issues recalculated',
			config_snapshot = $2::jsonb,
			summary = COALESCE(summary, '{}'::jsonb) || $3::jsonb,
			temporal_workflow_id = NULL,
			updated_at = now()
		WHERE run_id = $1
		`,
		task.RunID,
		configSnapshot,
		summaryJSON,
	); err != nil {
		return IssueRecalculationResult{}, fmt.Errorf("update audit run: %w", err)
	}
	if _, err := tx.Exec(
		ctx,
		`
		UPDATE projects
		SET audit_health = $4, updated_at = now()
		WHERE id = $1
			AND organization_id = $2
			AND audit_run_id = $3
		`,
		task.ProjectID,
		task.OrganizationID,
		task.RunID,
		summaryMap["health_score"],
	); err != nil {
		return IssueRecalculationResult{}, fmt.Errorf("update project health: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return IssueRecalculationResult{}, fmt.Errorf(
			"commit issue recalculation: %w",
			err,
		)
	}
	return IssueRecalculationResult{
		RunID:      task.RunID,
		IssueCount: len(issues),
		Summary:    summaryMap,
	}, nil
}

func (r *PostgresCrawlRepository) FailIssueRecalculation(
	ctx context.Context,
	task Task,
	message string,
) error {
	if strings.TrimSpace(message) == "" {
		message = "Issue recalculation failed; previous results were preserved"
	}
	_, err := r.pool.Exec(
		ctx,
		`
		UPDATE crawl_runs
		SET status = 'completed',
			stage = 'completed',
			message = $2,
			temporal_workflow_id = NULL,
			updated_at = now()
		WHERE run_id = $1
			AND organization_id = $3
			AND project_id = $4
			AND status = 'recalculating'
		`,
		task.RunID,
		message,
		task.OrganizationID,
		task.ProjectID,
	)
	if err != nil {
		return fmt.Errorf("restore audit after recalculation failure: %w", err)
	}
	return nil
}

func (r *PostgresCrawlRepository) loadIssueRecalculationPages(
	ctx context.Context,
	task Task,
) ([]Page, map[string]int64, error) {
	rows, err := r.pool.Query(
		ctx,
		`
		SELECT
			page_id, requested_url, final_url, status_code, title, description,
			canonical, language, h1, open_graph, twitter_tags, structured_data,
			schema_org, images, broken_images, word_count, rendered, size_bytes,
			response_time_ms, error, error_type, viewport, robots, fetched_at
		FROM page_snapshots
		WHERE run_id = $1
		ORDER BY page_id
		`,
		task.RunID,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("load audit pages: %w", err)
	}
	defer rows.Close()

	pages := make([]Page, 0)
	pageIDs := make(map[string]int64)
	for rows.Next() {
		var (
			pageID                                                int64
			page                                                  Page
			title, description, canonical, language, errText      *string
			errorType, viewport, robots                           *string
			h1, openGraph, twitterTags, structuredData, schemaOrg []byte
			images, brokenImages                                  []byte
		)
		if err := rows.Scan(
			&pageID,
			&page.URL,
			&page.FinalURL,
			&page.StatusCode,
			&title,
			&description,
			&canonical,
			&language,
			&h1,
			&openGraph,
			&twitterTags,
			&structuredData,
			&schemaOrg,
			&images,
			&brokenImages,
			&page.WordCount,
			&page.Rendered,
			&page.SizeBytes,
			&page.ResponseTimeMS,
			&errText,
			&errorType,
			&viewport,
			&robots,
			&page.FetchedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("scan audit page: %w", err)
		}
		page.Title = pointerString(title)
		page.Description = pointerString(description)
		page.Canonical = pointerString(canonical)
		page.Language = pointerString(language)
		page.Error = pointerString(errText)
		page.ErrorType = pointerString(errorType)
		page.Viewport = pointerString(viewport)
		page.Robots = pointerString(robots)
		for _, value := range []struct {
			data   []byte
			target any
		}{
			{h1, &page.H1},
			{openGraph, &page.OpenGraph},
			{twitterTags, &page.TwitterTags},
			{structuredData, &page.StructuredData},
			{schemaOrg, &page.SchemaMicrodata},
			{images, &page.Images},
			{brokenImages, &page.BrokenImages},
		} {
			if len(value.data) > 0 {
				if err := json.Unmarshal(value.data, value.target); err != nil {
					return nil, nil, fmt.Errorf(
						"decode audit page %q: %w",
						page.URL,
						err,
					)
				}
			}
		}
		pages = append(pages, page)
		pageIDs[normalizeStoredURL(page.URL)] = pageID
		pageIDs[normalizeStoredURL(defaultString(page.FinalURL, page.URL))] = pageID
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate audit pages: %w", err)
	}
	if len(pages) == 0 {
		return nil, nil, errors.New("audit run has no saved page snapshots")
	}
	return pages, pageIDs, nil
}

func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func storedResultStatus(task Task, result Result) string {
	if task.Type == TaskSiteUnderstanding &&
		result.CompletionStatus == CompletionPartial {
		return "partial"
	}
	return "completed"
}

func completionMessageForResult(task Task, result Result) string {
	if storedResultStatus(task, result) == "partial" {
		if strings.TrimSpace(result.CompletionNote) != "" {
			return result.CompletionNote
		}
		return "网站业务识别已部分完成"
	}
	if strings.TrimSpace(result.CompletionNote) != "" {
		return result.CompletionNote
	}
	return completionMessage(task.Type)
}

func completionMessage(taskType TaskType) string {
	switch taskType {
	case TaskSiteUnderstanding:
		return "网站业务识别已完成"
	case TaskTechnicalAudit:
		return "技术审计已完成"
	case TaskBacklinkValidation:
		return "外链检查已完成"
	default:
		return "任务已完成"
	}
}

func upsertPage(
	ctx context.Context,
	tx pgx.Tx,
	task Task,
	page Page,
) (int64, error) {
	normalizedURL := normalizeStoredURL(defaultString(page.FinalURL, page.URL))
	var pageID int64
	err := tx.QueryRow(
		ctx,
		`
		INSERT INTO pages (organization_id, project_id, normalized_url, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (organization_id, project_id, normalized_url) DO UPDATE SET
			updated_at = now()
		RETURNING id
		`,
		task.OrganizationID,
		task.ProjectID,
		normalizedURL,
	).Scan(&pageID)
	if err != nil {
		return 0, fmt.Errorf("upsert page %q: %w", normalizedURL, err)
	}
	return pageID, nil
}

func insertPageSnapshot(
	ctx context.Context,
	tx pgx.Tx,
	runID string,
	pageID int64,
	page Page,
) error {
	h1, _ := json.Marshal(page.H1)
	h2, _ := json.Marshal(page.H2)
	h3, _ := json.Marshal(page.H3)
	headings, _ := json.Marshal(page.Headings)
	metaTags, _ := json.Marshal(page.MetaTags)
	openGraph, _ := json.Marshal(page.OpenGraph)
	twitterTags, _ := json.Marshal(page.TwitterTags)
	structuredData, _ := json.Marshal(page.StructuredData)
	analytics, _ := json.Marshal(page.Analytics)
	images, _ := json.Marshal(page.Images)
	brokenImages, _ := json.Marshal(page.BrokenImages)
	hreflang, _ := json.Marshal(page.Hreflang)
	schemaOrg, _ := json.Marshal(page.SchemaMicrodata)
	redirects, _ := json.Marshal(page.Redirects)
	linkedFrom, _ := json.Marshal(page.LinkedFrom)
	_, err := tx.Exec(
		ctx,
		`
		INSERT INTO page_snapshots (
			run_id, page_id, requested_url, final_url, status_code, content_type, title,
			description, canonical, language, h1, headings, open_graph, structured_data,
			word_count, rendered, score, depth, discovered_from, raw_html_ref, main_html_ref,
			main_text_ref, fetched_at, size_bytes, response_time_ms, error, error_type,
			charset, viewport, robots, author, keywords, generator, theme_color,
			internal_links, external_links, h2, h3, meta_tags, twitter_tags, analytics,
			images, broken_images, hreflang, schema_org, redirects, linked_from
		)
		VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
			$13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23,
			$24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
			$37::jsonb, $38::jsonb, $39::jsonb, $40::jsonb, $41::jsonb,
			$42::jsonb, $43::jsonb, $44::jsonb, $45::jsonb, $46::jsonb,
			$47::jsonb
		)
		`,
		runID,
		pageID,
		page.URL,
		defaultString(page.FinalURL, page.URL),
		page.StatusCode,
		nullableString(page.ContentType),
		nullableString(page.Title),
		nullableString(page.Description),
		nullableString(page.Canonical),
		nullableString(page.Language),
		h1,
		headings,
		openGraph,
		structuredData,
		page.WordCount,
		page.Rendered,
		page.Score,
		page.Depth,
		nullableString(page.DiscoveredFrom),
		nullableString(page.RawHTMLRef),
		nullableString(page.MainHTMLRef),
		nullableString(page.MainTextRef),
		page.FetchedAt,
		page.SizeBytes,
		page.ResponseTimeMS,
		nullableString(page.Error),
		nullableString(page.ErrorType),
		nullableString(page.Charset),
		nullableString(page.Viewport),
		nullableString(page.Robots),
		nullableString(page.Author),
		nullableString(page.Keywords),
		nullableString(page.Generator),
		nullableString(page.ThemeColor),
		page.InternalLinkCount,
		page.ExternalLinkCount,
		h2,
		h3,
		metaTags,
		twitterTags,
		analytics,
		images,
		brokenImages,
		hreflang,
		schemaOrg,
		redirects,
		linkedFrom,
	)
	if err != nil {
		return fmt.Errorf("insert page snapshot %q: %w", page.URL, err)
	}
	return nil
}

func insertLinks(
	ctx context.Context,
	tx pgx.Tx,
	runID string,
	pageID int64,
	links []Link,
	statusByURL map[string]int,
) error {
	seen := make(map[string]struct{}, len(links))
	for _, link := range links {
		targetURL := normalizeStoredURL(link.URL)
		if _, exists := seen[targetURL]; exists {
			continue
		}
		seen[targetURL] = struct{}{}
		targetStatus := link.TargetStatus
		if targetStatus == nil {
			if status, exists := statusByURL[targetURL]; exists {
				targetStatus = &status
			}
		}
		targetDomain := link.TargetDomain
		if targetDomain == "" {
			if target, err := url.Parse(link.URL); err == nil {
				targetDomain = target.Host
			}
		}
		placement := link.Placement
		if placement == "" {
			placement = "body"
		}
		if _, err := tx.Exec(
			ctx,
			`
			INSERT INTO link_edges (
				run_id, source_page_id, target_url, anchor_text, rel, in_navigation,
				is_internal, target_domain, target_status, placement
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			`,
			runID,
			pageID,
			targetURL,
			nullableString(link.Text),
			nullableString(link.Rel),
			link.InNavigation,
			link.IsInternal,
			nullableString(targetDomain),
			nullableIntPointer(targetStatus),
			placement,
		); err != nil {
			return fmt.Errorf("insert link %q: %w", link.URL, err)
		}
	}
	return nil
}

func insertAuditIssue(
	ctx context.Context,
	tx pgx.Tx,
	runID string,
	pageIDs map[string]int64,
	issue Issue,
) error {
	pageID, exists := pageIDs[normalizeStoredURL(issue.URL)]
	var nullablePageID any
	if exists {
		nullablePageID = pageID
	}
	if _, err := tx.Exec(
		ctx,
		`
		INSERT INTO audit_issues (
			run_id, page_id, url, severity, category, code, issue, details,
			related_url, similarity
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		`,
		runID,
		nullablePageID,
		issue.URL,
		issue.Type,
		issue.Category,
		issue.Code,
		issue.Issue,
		issue.Details,
		nullableString(issue.RelatedURL),
		nullableFloat(issue.Similarity),
	); err != nil {
		return fmt.Errorf("insert audit issue %q: %w", issue.Code, err)
	}
	return nil
}

func buildStoredAuditSummary(result Result) map[string]int {
	errorsCount := 0
	warnings := 0
	notices := 0
	renderedPages := 0
	for _, issue := range result.Issues {
		switch issue.Type {
		case "error":
			errorsCount++
		case "warning":
			warnings++
		default:
			notices++
		}
	}
	for _, page := range result.Pages {
		if page.Rendered {
			renderedPages++
		}
	}
	pageCount := len(result.Pages)
	penalty := 0
	if pageCount > 0 {
		penalty = int(float64(errorsCount*5+warnings*2+notices)/float64(pageCount) + 0.5)
	}
	summary := map[string]int{
		"page_count":     pageCount,
		"health_score":   max(1, 100-penalty),
		"errors":         errorsCount,
		"warnings":       warnings,
		"notices":        notices,
		"rendered_pages": renderedPages,
	}
	if result.ResourceChecksTruncated {
		summary["resource_checks_truncated"] = 1
	}
	return summary
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func normalizePostgresURL(value string) string {
	value = strings.TrimSpace(value)
	for _, prefix := range []string{
		"postgresql+psycopg://",
		"postgresql+asyncpg://",
		"postgres+psycopg://",
	} {
		if strings.HasPrefix(value, prefix) {
			return "postgresql://" + strings.TrimPrefix(value, prefix)
		}
	}
	return value
}

func normalizeStoredURL(value string) string {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Fragment = ""
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String()
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableInt(value int) any {
	if value == 0 {
		return nil
	}
	return value
}

func nullableIntPointer(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloat(value float64) any {
	if value == 0 {
		return nil
	}
	return value
}
