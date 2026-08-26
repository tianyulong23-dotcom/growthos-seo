package worker

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"

	"seo/backend/crawler/internal/crawler"
)

type contextCheckingStore struct {
	mu       sync.Mutex
	progress []crawler.Progress
}

type aiSettingsStore struct {
	contextCheckingStore
	settings crawler.AIProviderSettings
	found    bool
	err      error
}

func (s *aiSettingsStore) LoadAIProviderSettings(
	context.Context,
	string,
) (crawler.AIProviderSettings, bool, error) {
	return s.settings, s.found, s.err
}

func (s *contextCheckingStore) SaveResult(
	context.Context,
	crawler.Task,
	crawler.Result,
) (crawler.StoredResult, error) {
	return crawler.StoredResult{}, nil
}

func (s *contextCheckingStore) SaveProgress(
	ctx context.Context,
	_ crawler.Task,
	progress crawler.Progress,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.progress = append(s.progress, progress)
	return nil
}

type recalculationStore struct {
	result       crawler.IssueRecalculationResult
	err          error
	restoreCalls int
}

func (s *recalculationStore) SaveResult(
	context.Context,
	crawler.Task,
	crawler.Result,
) (crawler.StoredResult, error) {
	return crawler.StoredResult{}, nil
}

func (s *recalculationStore) SaveProgress(
	context.Context,
	crawler.Task,
	crawler.Progress,
) error {
	return nil
}

func (s *recalculationStore) RecalculateIssues(
	context.Context,
	crawler.Task,
) (crawler.IssueRecalculationResult, error) {
	return s.result, s.err
}

func (s *recalculationStore) FailIssueRecalculation(
	context.Context,
	crawler.Task,
	string,
) error {
	s.restoreCalls++
	return nil
}

func TestRunStopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := Run(ctx); err != nil {
		t.Fatalf("Run returned an error: %v", err)
	}
}

func TestAIProviderConfigUsesLatestStoredSettings(t *testing.T) {
	store := &aiSettingsStore{
		settings: crawler.AIProviderSettings{
			Provider:        "openrouter",
			BaseURL:         "https://stored.example/v1",
			APIKey:          "stored-key",
			Model:           "stored-model",
			ReasoningEffort: "high",
			RequestTimeout:  75 * time.Second,
			MaxRetries:      2,
		},
		found: true,
	}
	fallback := crawler.Config{
		BusinessProfileAIBaseURL: "https://environment.example/v1",
		BusinessProfileAIAPIKey:  "environment-key",
		BusinessProfileAIModel:   "environment-model",
	}

	config, err := aiProviderConfig(
		context.Background(),
		store,
		"organization",
		fallback,
	)

	if err != nil {
		t.Fatalf("aiProviderConfig() returned an error: %v", err)
	}
	if config.BusinessProfileAIBaseURL != store.settings.BaseURL ||
		config.BusinessProfileAIAPIKey != store.settings.APIKey ||
		config.BusinessProfileAIModel != store.settings.Model ||
		config.BusinessProfileAIProvider != store.settings.Provider ||
		config.BusinessProfileAIReasoningEffort != store.settings.ReasoningEffort ||
		config.BusinessProfileAITimeout != store.settings.RequestTimeout ||
		config.BusinessProfileAIMaxRetries != store.settings.MaxRetries {
		t.Fatalf("AI provider config = %#v", config)
	}
}

func TestAIProviderConfigKeepsEnvironmentFallbackWithoutStoredSettings(t *testing.T) {
	store := &aiSettingsStore{}
	fallback := crawler.Config{
		BusinessProfileAIBaseURL: "https://environment.example/v1",
		BusinessProfileAIAPIKey:  "environment-key",
		BusinessProfileAIModel:   "environment-model",
	}

	config, err := aiProviderConfig(
		context.Background(),
		store,
		"organization",
		fallback,
	)

	if err != nil {
		t.Fatalf("aiProviderConfig() returned an error: %v", err)
	}
	if config != fallback {
		t.Fatalf("AI provider config = %#v, want fallback", config)
	}
}

func TestActivityTrackerReportsIdleOnlyAfterActivityFinishes(t *testing.T) {
	tracker := newActivityTracker()
	finish := tracker.start()

	if _, idle := tracker.idleFor(time.Now()); idle {
		t.Fatal("tracker reported idle while an activity was running")
	}

	finish()
	if _, idle := tracker.idleFor(time.Now()); !idle {
		t.Fatal("tracker did not report idle after the activity finished")
	}
}

func TestWaitForWorkerExitStopsAfterIdleTimeout(t *testing.T) {
	tracker := newActivityTracker()
	done := make(chan struct{})

	go func() {
		waitForWorkerExit(context.Background(), 10*time.Millisecond, tracker)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop after the idle timeout")
	}
}

func TestCrawlWorkflowReturnsStoredResult(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(
		func(context.Context, crawler.Task) (crawler.StoredResult, error) {
			return crawler.StoredResult{
				RunID:     "run",
				ResultRef: "s3://crawler-results/run.json",
				PageCount: 12,
			}, nil
		},
		activity.RegisterOptions{Name: runTaskActivityName},
	)

	task := crawler.Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           crawler.TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	}
	env.ExecuteWorkflow(CrawlWorkflow, task)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow returned an error: %v", err)
	}

	var result crawler.StoredResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("GetWorkflowResult() returned an error: %v", err)
	}
	if result.RunID != "run" || result.PageCount != 12 {
		t.Fatalf("workflow result = %#v", result)
	}
}

func TestCrawlWorkflowPauseCancelsActivityWithoutFailingWorkflow(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	var cancelled atomic.Bool
	env.SetOnActivityCanceledListener(func(*activity.Info) {
		cancelled.Store(true)
	})
	env.RegisterActivityWithOptions(
		func(ctx context.Context, _ crawler.Task) (crawler.StoredResult, error) {
			<-ctx.Done()
			return crawler.StoredResult{}, ctx.Err()
		},
		activity.RegisterOptions{Name: runTaskActivityName},
	)
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow("pause", nil)
	}, time.Second)

	task := crawler.Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           crawler.TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	}
	env.ExecuteWorkflow(CrawlWorkflow, task)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow returned an error: %v", err)
	}
	if !cancelled.Load() {
		t.Fatal("activity was not cancelled")
	}
}

func TestRecalculateIssuesWorkflowReturnsActivityResult(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(
		func(context.Context, crawler.Task) (crawler.IssueRecalculationResult, error) {
			return crawler.IssueRecalculationResult{
				RunID:      "run",
				IssueCount: 7,
				Summary:    map[string]int{"health_score": 91},
			}, nil
		},
		activity.RegisterOptions{Name: recalculateActivityName},
	)

	env.ExecuteWorkflow(
		RecalculateIssuesWorkflow,
		crawler.Task{RunID: "run"},
	)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow returned an error: %v", err)
	}
	var result crawler.IssueRecalculationResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("GetWorkflowResult() returned an error: %v", err)
	}
	if result.RunID != "run" || result.IssueCount != 7 {
		t.Fatalf("workflow result = %#v", result)
	}
}

func TestRecalculateIssuesActivityRestoresPreviousResultOnFailure(t *testing.T) {
	store := &recalculationStore{err: errors.New("database unavailable")}
	activities := &Activities{Store: store}

	_, err := activities.RecalculateIssues(
		context.Background(),
		crawler.Task{RunID: "run"},
	)
	if err == nil {
		t.Fatal("RecalculateIssues() returned nil error")
	}
	if store.restoreCalls != 1 {
		t.Fatalf("restore call count = %d", store.restoreCalls)
	}
}

func TestActivityHeartbeaterRepeatsLatestProgress(t *testing.T) {
	records := make(chan crawler.Progress, 16)
	initial := crawler.Progress{
		Stage:      crawler.StageAnalyzing,
		Message:    "analyzing",
		OccurredAt: time.Now().UTC(),
	}
	heartbeater := startActivityHeartbeater(
		5*time.Millisecond,
		initial,
		func(progress crawler.Progress) {
			records <- progress
		},
	)
	defer heartbeater.Stop()

	if got := receiveProgress(t, records); got.Stage != crawler.StageAnalyzing {
		t.Fatalf("initial heartbeat stage = %q", got.Stage)
	}
	if got := receiveProgress(t, records); got.Stage != crawler.StageAnalyzing {
		t.Fatalf("periodic heartbeat stage = %q", got.Stage)
	}

	updated := crawler.Progress{
		Stage:      crawler.StageExtracting,
		Message:    "extracting",
		Processed:  1,
		OccurredAt: time.Now().UTC(),
	}
	heartbeater.Update(updated)
	for {
		if got := receiveProgress(t, records); got.Stage == crawler.StageExtracting {
			break
		}
	}
	if got := receiveProgress(t, records); got.Stage != crawler.StageExtracting {
		t.Fatalf("repeated heartbeat stage = %q", got.Stage)
	}
}

func TestSaveFailureIgnoresCancelledActivityContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := &contextCheckingStore{}
	activities := &Activities{Store: store}
	task := crawler.Task{RunID: "run"}

	activities.saveFailure(ctx, task, "website crawl failed")

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.progress) != 1 {
		t.Fatalf("saved progress count = %d", len(store.progress))
	}
	if store.progress[0].Stage != crawler.StageFailed {
		t.Fatalf("saved progress stage = %q", store.progress[0].Stage)
	}
}

func TestRunTaskPersistsFailureWhenActivityIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := &contextCheckingStore{}
	activities := &Activities{Store: store}
	task := crawler.Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           crawler.TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	}

	result, err := activities.handleRunFailure(ctx, task, context.Canceled)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("handleRunFailure() error = %v, want context.Canceled", err)
	}
	if result.RunID != task.RunID {
		t.Fatalf("handleRunFailure() result = %#v", result)
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.progress) != 1 {
		t.Fatalf("saved progress count = %d, want 1", len(store.progress))
	}
	if store.progress[0].Stage != crawler.StageFailed {
		t.Fatalf("saved progress stage = %q, want %q", store.progress[0].Stage, crawler.StageFailed)
	}
}

func TestFailureMessagePreservesSiteUnderstandingReason(t *testing.T) {
	message := failureMessage(
		crawler.Task{Type: crawler.TaskSiteUnderstanding},
		errors.New("未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US"),
	)

	want := "网站业务识别失败：未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US"
	if message != want {
		t.Fatalf("failureMessage() = %q, want %q", message, want)
	}
}

func TestFailureMessageDoesNotRenameTechnicalAudit(t *testing.T) {
	message := failureMessage(
		crawler.Task{Type: crawler.TaskTechnicalAudit},
		errors.New("connection refused"),
	)
	if message != "网站抓取失败" {
		t.Fatalf("failureMessage() = %q", message)
	}
}

func TestFailureMessageExplainsTechnicalAuditWithNoCrawlablePages(t *testing.T) {
	message := failureMessage(
		crawler.Task{Type: crawler.TaskTechnicalAudit},
		errors.New("technical audit returned no crawlable pages"),
	)
	if message != "技术审计失败：未抓取到可审计页面" {
		t.Fatalf("failureMessage() = %q", message)
	}
}

func TestApplySynthesizedProfileCompletesAUsableBusinessProfile(t *testing.T) {
	result := crawler.Result{
		CompletionStatus: crawler.CompletionPartial,
		CompletionNote:   "insufficient page roles",
	}
	profile := crawler.SiteProfile{
		BusinessName:      "Example",
		BusinessType:      "Software / SaaS",
		BusinessSummary:   "Example helps teams plan work.",
		TargetAudiences:   []string{"Product teams"},
		ProductsServices:  []string{"Planning software"},
		ValuePropositions: []string{"Fast collaborative planning"},
	}

	applySynthesizedProfile(&result, profile)

	if result.CompletionStatus != crawler.CompletionComplete {
		t.Fatalf("completion status = %q", result.CompletionStatus)
	}
	if result.CompletionNote != "" {
		t.Fatalf("completion note = %q", result.CompletionNote)
	}
	if result.SiteProfile == nil || result.SiteProfile.BusinessName != "Example" {
		t.Fatalf("site profile = %#v", result.SiteProfile)
	}
}

func TestApplySynthesizedProfileAcceptsPartialBusinessData(t *testing.T) {
	result := crawler.Result{
		CompletionStatus: crawler.CompletionPartial,
		CompletionNote:   "previous note",
	}
	profile := crawler.SiteProfile{
		BusinessName:     "Example",
		BusinessType:     "Software / SaaS",
		BusinessSummary:  "Example helps teams plan work.",
		ProductsServices: []string{"Planning software"},
	}

	applySynthesizedProfile(&result, profile)

	if result.CompletionStatus != crawler.CompletionComplete {
		t.Fatalf("completion status = %q", result.CompletionStatus)
	}
	if result.CompletionNote != "" {
		t.Fatalf("completion note = %q", result.CompletionNote)
	}
}

func TestSiteUnderstandingUsesBoundedActivityRetries(t *testing.T) {
	options := activityOptions(crawler.Task{Type: crawler.TaskSiteUnderstanding})

	if options.StartToCloseTimeout != 10*time.Minute {
		t.Fatalf("StartToCloseTimeout = %s", options.StartToCloseTimeout)
	}
	if options.ScheduleToCloseTimeout != 30*time.Minute {
		t.Fatalf("ScheduleToCloseTimeout = %s", options.ScheduleToCloseTimeout)
	}
	if options.RetryPolicy == nil || options.RetryPolicy.MaximumAttempts != 2 {
		t.Fatalf("RetryPolicy = %#v", options.RetryPolicy)
	}
}

func TestTechnicalAuditKeepsLongRunningActivityLimits(t *testing.T) {
	options := activityOptions(crawler.Task{Type: crawler.TaskTechnicalAudit})

	if options.StartToCloseTimeout != 6*time.Hour {
		t.Fatalf("StartToCloseTimeout = %s", options.StartToCloseTimeout)
	}
	if options.ScheduleToCloseTimeout != 6*time.Hour {
		t.Fatalf("ScheduleToCloseTimeout = %s", options.ScheduleToCloseTimeout)
	}
	if options.RetryPolicy == nil || options.RetryPolicy.MaximumAttempts != 3 {
		t.Fatalf("RetryPolicy = %#v", options.RetryPolicy)
	}
}

func receiveProgress(t *testing.T, records <-chan crawler.Progress) crawler.Progress {
	t.Helper()
	select {
	case progress := <-records:
		return progress
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for heartbeat")
		return crawler.Progress{}
	}
}
