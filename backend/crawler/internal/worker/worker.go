package worker

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"seo/backend/crawler/internal/crawler"
)

const (
	runTaskActivityName           = "Activities.RunTask"
	recalculateActivityName       = "Activities.RecalculateIssues"
	activityHeartbeatInterval     = 10 * time.Second
	failurePersistenceTimeout     = 10 * time.Second
	recalculationActivityTimeout  = 30 * time.Minute
	technicalAuditActivityTimeout = 6 * time.Hour
	siteUnderstandingTotalTimeout = 30 * time.Minute
)

func Run(ctx context.Context) error {
	if ctx.Err() != nil {
		return nil
	}

	config := crawler.LoadConfig()
	if config.BrowserEnabled {
		slog.Info(
			"preparing crawler browser",
			"cache_dir",
			config.BrowserCacheDir,
		)
		if err := crawler.PrepareBrowser(ctx, &config); err != nil {
			return err
		}
		slog.Info(
			"crawler browser ready",
			"executable",
			config.BrowserExecutable,
		)
	}
	store, err := crawler.NewProductionStore(ctx, config)
	if err != nil {
		return err
	}
	defer store.Close()
	temporalClient, err := client.Dial(client.Options{
		HostPort:  config.TemporalAddress,
		Namespace: config.TemporalNamespace,
	})
	if err != nil {
		return err
	}
	defer temporalClient.Close()

	temporalWorker := worker.New(temporalClient, config.TaskQueue, worker.Options{})
	temporalWorker.RegisterWorkflow(CrawlWorkflow)
	temporalWorker.RegisterWorkflow(RecalculateIssuesWorkflow)
	tracker := newActivityTracker()
	activities := &Activities{Config: config, Store: store, tracker: tracker}
	temporalWorker.RegisterActivityWithOptions(
		activities.RunTask,
		activity.RegisterOptions{Name: runTaskActivityName},
	)
	temporalWorker.RegisterActivityWithOptions(
		activities.RecalculateIssues,
		activity.RegisterOptions{Name: recalculateActivityName},
	)
	if err := temporalWorker.Start(); err != nil {
		return err
	}

	slog.Info("crawler worker started", "task_queue", config.TaskQueue)
	waitForWorkerExit(ctx, config.WorkerIdleTimeout, tracker)
	temporalWorker.Stop()
	slog.Info("crawler worker stopped")
	return nil
}

type Activities struct {
	Config  crawler.Config
	Store   crawler.ResultStore
	tracker *activityTracker
}

func (a *Activities) RecalculateIssues(
	ctx context.Context,
	task crawler.Task,
) (crawler.IssueRecalculationResult, error) {
	finishActivity := a.startActivity()
	defer finishActivity()

	store, ok := a.Store.(crawler.IssueRecalculationStore)
	if !ok {
		return crawler.IssueRecalculationResult{}, errors.New(
			"crawler result store does not support issue recalculation",
		)
	}
	result, err := store.RecalculateIssues(ctx, task)
	if err == nil {
		return result, nil
	}
	restoreCtx, cancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		failurePersistenceTimeout,
	)
	defer cancel()
	restoreErr := store.FailIssueRecalculation(
		restoreCtx,
		task,
		"Issue recalculation failed; previous results were preserved",
	)
	if restoreErr != nil {
		return crawler.IssueRecalculationResult{}, errors.Join(err, restoreErr)
	}
	return crawler.IssueRecalculationResult{}, err
}

func (a *Activities) RunTask(ctx context.Context, task crawler.Task) (crawler.StoredResult, error) {
	finishActivity := a.startActivity()
	defer finishActivity()

	initialProgress := crawler.Progress{
		Stage:      crawler.StageAnalyzing,
		Message:    "网站抓取已开始",
		OccurredAt: time.Now().UTC(),
	}
	heartbeater := startActivityHeartbeater(
		activityHeartbeatInterval,
		initialProgress,
		func(progress crawler.Progress) {
			activity.RecordHeartbeat(ctx, progress)
		},
	)
	defer heartbeater.Stop()

	processor, ok := a.Store.(crawler.PageArtifactProcessor)
	if !ok {
		err := errors.New(
			"crawler result store does not support page artifact storage",
		)
		a.saveFailure(ctx, task, "网站抓取初始化失败")
		return crawler.StoredResult{}, err
	}
	checkpointStore, ok := a.Store.(crawler.CheckpointStore)
	if !ok {
		err := errors.New(
			"crawler result store does not support checkpoint storage",
		)
		a.saveFailure(ctx, task, "网站抓取初始化失败")
		return crawler.StoredResult{}, err
	}
	taskConfig := a.Config
	if task.Type == crawler.TaskSiteUnderstanding {
		taskConfig.RequestTimeout = taskConfig.SiteUnderstandingRequestTimeout
		taskConfig.MaxRetries = taskConfig.SiteUnderstandingMaxRetries
	}
	limiter := crawler.NewRequestLimiter(
		taskConfig.RequestDelay,
		taskConfig.RandomDelay,
	)
	httpFetcher, err := crawler.NewHTTPFetcherWithLimiter(taskConfig, limiter)
	if err != nil {
		a.saveFailure(ctx, task, "网站抓取初始化失败")
		return crawler.StoredResult{}, err
	}
	var pageFetcher crawler.Fetcher = httpFetcher
	if task.Type != crawler.TaskSiteUnderstanding {
		browserFetcher := crawler.NewBrowserFetcherWithLimiter(taskConfig, limiter)
		defer browserFetcher.Close()
		pageFetcher = crawler.HybridFetcher{
			HTTP:               httpFetcher,
			Browser:            browserFetcher,
			Mode:               task.RenderingMode(),
			HTTPConcurrency:    taskConfig.HTTPConcurrency,
			BrowserConcurrency: taskConfig.BrowserConcurrency,
		}
	}

	reporter := crawler.ProgressReporterFunc(func(progress crawler.Progress) {
		heartbeater.Update(progress)
		if err := a.Store.SaveProgress(ctx, task, progress); err != nil {
			slog.Error("save crawler progress", "run_id", task.RunID, "error", err)
		}
		slog.Info(
			"crawler progress",
			"run_id", task.RunID,
			"stage", progress.Stage,
			"message", progress.Message,
			"processed", progress.Processed,
		)
	})
	engine := crawler.NewEngine(
		taskConfig,
		httpFetcher,
		pageFetcher,
		reporter,
		crawler.WithPageArtifactProcessor(processor),
		crawler.WithCheckpointStore(checkpointStore),
	)
	result, err := engine.Run(ctx, task)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return crawler.StoredResult{RunID: task.RunID}, err
		}
		a.saveFailure(ctx, task, failureMessage(task, err))
		return crawler.StoredResult{}, err
	}
	if task.Type == crawler.TaskSiteUnderstanding {
		generatingProgress := crawler.Progress{
			Stage:      crawler.StageGenerating,
			Message:    "正在生成业务资料",
			Discovered: len(result.Pages),
			Processed:  len(result.Pages),
			Selected:   len(result.Pages),
			OccurredAt: time.Now().UTC(),
		}
		reporter.Report(generatingProgress)
		fallback := crawler.BuildSiteProfile(task, result.Pages)
		result.SiteProfile = &fallback
		aiConfig, settingsErr := aiProviderConfig(
			ctx,
			a.Store,
			task.OrganizationID,
			taskConfig,
		)
		if settingsErr != nil {
			slog.Warn(
				"load AI provider settings; using environment configuration",
				"run_id",
				task.RunID,
				"error",
				settingsErr,
			)
		}
		synthesizer := crawler.NewAIProfileSynthesizer(aiConfig)
		if synthesizer.Configured() {
			profile, synthErr := synthesizer.Synthesize(
				ctx,
				task,
				result.Pages,
				fallback,
			)
			if synthErr != nil {
				result.CompletionStatus = crawler.CompletionPartial
				result.CompletionNote = "AI 整理失败，已使用规则生成业务资料：" +
					aiSynthesisFailureReason(synthErr)
				slog.Warn(
					"business profile AI synthesis failed; using deterministic profile",
					"run_id",
					task.RunID,
					"error",
					synthErr,
				)
			} else {
				applySynthesizedProfile(&result, profile)
			}
		} else {
			result.CompletionStatus = crawler.CompletionPartial
			result.CompletionNote = "AI 整理未配置，已使用规则生成业务资料"
			slog.Warn(
				"business profile AI is not configured; using deterministic profile",
				"run_id",
				task.RunID,
			)
		}
	}
	result.FinishedAt = time.Now().UTC()
	stored, err := a.Store.SaveResult(ctx, task, result)
	if err != nil {
		a.saveFailure(ctx, task, "网站抓取结果保存失败")
		return crawler.StoredResult{}, err
	}
	return stored, nil
}

func aiProviderConfig(
	ctx context.Context,
	store crawler.ResultStore,
	organizationID string,
	fallback crawler.Config,
) (crawler.Config, error) {
	settingsStore, ok := store.(crawler.AIProviderSettingsStore)
	if !ok {
		return fallback, nil
	}
	settings, found, err := settingsStore.LoadAIProviderSettings(
		ctx,
		organizationID,
	)
	if err != nil || !found {
		return fallback, err
	}
	fallback.BusinessProfileAIBaseURL = settings.BaseURL
	fallback.BusinessProfileAIAPIKey = settings.APIKey
	fallback.BusinessProfileAIModel = settings.Model
	fallback.BusinessProfileAITimeout = settings.RequestTimeout
	fallback.BusinessProfileAIMaxRetries = settings.MaxRetries
	return fallback, nil
}

func (a *Activities) startActivity() func() {
	if a.tracker == nil {
		return func() {}
	}
	return a.tracker.start()
}

type activityTracker struct {
	mu           sync.Mutex
	active       int
	lastActivity time.Time
}

func newActivityTracker() *activityTracker {
	return &activityTracker{lastActivity: time.Now()}
}

func (t *activityTracker) start() func() {
	t.mu.Lock()
	t.active++
	t.lastActivity = time.Now()
	t.mu.Unlock()

	return func() {
		t.mu.Lock()
		t.active--
		t.lastActivity = time.Now()
		t.mu.Unlock()
	}
}

func (t *activityTracker) idleFor(now time.Time) (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active > 0 {
		return 0, false
	}
	return now.Sub(t.lastActivity), true
}

func waitForWorkerExit(
	ctx context.Context,
	idleTimeout time.Duration,
	tracker *activityTracker,
) {
	if idleTimeout <= 0 {
		<-ctx.Done()
		return
	}

	interval := min(idleTimeout/4, time.Second)
	if interval <= 0 {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			idleFor, idle := tracker.idleFor(now)
			if idle && idleFor >= idleTimeout {
				slog.Info("crawler worker idle timeout reached", "idle_timeout", idleTimeout)
				return
			}
		}
	}
}

func applySynthesizedProfile(result *crawler.Result, profile crawler.SiteProfile) {
	result.SiteProfile = &profile
	if crawler.SiteProfileReady(profile) {
		result.CompletionStatus = crawler.CompletionComplete
		result.CompletionNote = ""
		return
	}
	result.CompletionStatus = crawler.CompletionPartial
	result.CompletionNote = "业务资料已生成，但部分页面证据不足，请检查后使用"
}

func aiSynthesisFailureReason(err error) string {
	if err == nil {
		return "模型服务暂时不可用"
	}
	reason := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, context.DeadlineExceeded),
		strings.Contains(reason, "timeout"),
		strings.Contains(reason, "deadline exceeded"):
		return "模型请求超时"
	case strings.Contains(reason, "http 401"),
		strings.Contains(reason, "http 403"):
		return "模型服务鉴权失败"
	case strings.Contains(reason, "http 429"):
		return "模型服务请求过多"
	case strings.Contains(reason, "decode"),
		strings.Contains(reason, "no choices"),
		strings.Contains(reason, "omitted"):
		return "模型返回格式无效"
	case strings.Contains(reason, "grounding"):
		return "模型引用证据无效"
	default:
		return "模型服务暂时不可用"
	}
}

func (a *Activities) saveFailure(ctx context.Context, task crawler.Task, message string) {
	persistCtx, cancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		failurePersistenceTimeout,
	)
	defer cancel()
	progress := crawler.Progress{
		Stage:      crawler.StageFailed,
		Message:    message,
		OccurredAt: time.Now().UTC(),
	}
	if err := a.Store.SaveProgress(persistCtx, task, progress); err != nil {
		slog.Error(
			"save crawler failure progress",
			"run_id",
			task.RunID,
			"error",
			err,
		)
	}
}

func failureMessage(task crawler.Task, err error) string {
	if task.Type != crawler.TaskSiteUnderstanding {
		return "网站抓取失败"
	}
	if err == nil {
		return "网站业务识别失败"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "网站业务识别失败：网站响应超时"
	}

	reason := strings.TrimSpace(err.Error())
	lowerReason := strings.ToLower(reason)
	switch {
	case strings.Contains(lowerReason, "timeout"),
		strings.Contains(lowerReason, "deadline exceeded"):
		reason = "网站响应超时"
	case strings.Contains(lowerReason, "no usable html"):
		reason = "未抓取到可用于识别业务的 HTML 页面"
	case strings.Contains(lowerReason, "no such host"):
		reason = "无法解析网站域名"
	case strings.Contains(lowerReason, "connection refused"):
		reason = "无法连接网站"
	}
	if reason == "" {
		reason = "未获得可用于识别业务的页面"
	}
	return "网站业务识别失败：" + reason
}

type activityHeartbeater struct {
	mu       sync.RWMutex
	recordMu sync.Mutex
	progress crawler.Progress
	record   func(crawler.Progress)
	done     chan struct{}
	stopped  chan struct{}
	stopOnce sync.Once
}

func startActivityHeartbeater(
	interval time.Duration,
	initial crawler.Progress,
	record func(crawler.Progress),
) *activityHeartbeater {
	heartbeater := &activityHeartbeater{
		progress: initial,
		record:   record,
		done:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
	heartbeater.recordCurrent()
	go func() {
		defer close(heartbeater.stopped)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				heartbeater.recordCurrent()
			case <-heartbeater.done:
				return
			}
		}
	}()
	return heartbeater
}

func (h *activityHeartbeater) Update(progress crawler.Progress) {
	h.mu.Lock()
	h.progress = progress
	h.mu.Unlock()
	h.recordCurrent()
}

func (h *activityHeartbeater) Stop() {
	h.stopOnce.Do(func() {
		close(h.done)
		<-h.stopped
	})
}

func (h *activityHeartbeater) recordCurrent() {
	h.mu.RLock()
	progress := h.progress
	h.mu.RUnlock()

	h.recordMu.Lock()
	defer h.recordMu.Unlock()
	h.record(progress)
}

func CrawlWorkflow(ctx workflow.Context, task crawler.Task) (crawler.StoredResult, error) {
	options := activityOptions(task)
	activityCtx := workflow.WithActivityOptions(ctx, options)
	activityCtx, cancelActivity := workflow.WithCancel(activityCtx)
	future := workflow.ExecuteActivity(activityCtx, runTaskActivityName, task)

	var result crawler.StoredResult
	var activityErr error
	completed := false
	cancelledBySignal := false
	selector := workflow.NewSelector(ctx)
	selector.AddFuture(future, func(completedFuture workflow.Future) {
		activityErr = completedFuture.Get(ctx, &result)
		completed = true
	})
	for _, signalName := range []string{"pause", "stop"} {
		channel := workflow.GetSignalChannel(ctx, signalName)
		selector.AddReceive(channel, func(receiveChannel workflow.ReceiveChannel, _ bool) {
			receiveChannel.Receive(ctx, nil)
			cancelledBySignal = true
			cancelActivity()
		})
	}
	selector.Select(ctx)
	if cancelledBySignal {
		if !completed {
			_ = future.Get(ctx, &result)
		}
		return crawler.StoredResult{RunID: task.RunID}, nil
	}
	return result, activityErr
}

func RecalculateIssuesWorkflow(
	ctx workflow.Context,
	task crawler.Task,
) (crawler.IssueRecalculationResult, error) {
	activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: recalculationActivityTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    time.Minute,
			MaximumAttempts:    3,
		},
	})
	var result crawler.IssueRecalculationResult
	err := workflow.ExecuteActivity(
		activityCtx,
		recalculateActivityName,
		task,
	).Get(ctx, &result)
	return result, err
}

func activityOptions(task crawler.Task) workflow.ActivityOptions {
	options := workflow.ActivityOptions{
		ScheduleToCloseTimeout: technicalAuditActivityTimeout,
		StartToCloseTimeout:    technicalAuditActivityTimeout,
		HeartbeatTimeout:       30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    time.Minute,
			MaximumAttempts:    3,
		},
	}
	if task.Type == crawler.TaskSiteUnderstanding {
		options.ScheduleToCloseTimeout = siteUnderstandingTotalTimeout
		options.StartToCloseTimeout = 10 * time.Minute
		options.RetryPolicy.MaximumAttempts = 2
	}
	return options
}
