package crawler

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func CollectEvidence(
	ctx context.Context,
	config Config,
	store *EvidenceStore,
	request EvidenceRequestV1,
	reporter ProgressReporter,
) (EvidenceV1, error) {
	if store == nil {
		return EvidenceV1{}, errors.New("evidence store is required")
	}
	task, err := request.ToTask()
	if err != nil {
		return EvidenceV1{}, err
	}

	limiter := NewRequestLimiter(config.RequestDelay, config.RandomDelay)
	httpFetcher, err := NewHTTPFetcherWithLimiter(config, limiter)
	if err != nil {
		return EvidenceV1{}, fmt.Errorf("create HTTP fetcher: %w", err)
	}

	var pageFetcher Fetcher = httpFetcher
	var browser *BrowserFetcher
	if config.BrowserEnabled && task.RenderingMode() != RenderingOff {
		browser = NewBrowserFetcherWithLimiter(config, limiter)
		defer browser.Close()
		pageFetcher = HybridFetcher{
			HTTP:               httpFetcher,
			Browser:            browser,
			Mode:               task.RenderingMode(),
			HTTPConcurrency:    config.HTTPConcurrency,
			BrowserConcurrency: config.BrowserConcurrency,
		}
	}

	engine := NewEngine(
		config,
		httpFetcher,
		pageFetcher,
		reporter,
		WithPageArtifactProcessor(store),
		WithCheckpointStore(store),
	)
	result, runErr := engine.Run(ctx, task)
	result.TaskType = task.Type
	result.RunID = task.RunID
	result.FinishedAt = time.Now().UTC()

	persistCtx := ctx
	cancel := func() {}
	if ctx.Err() != nil {
		persistCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	}
	defer cancel()

	evidence, saveErr := store.SaveEvidence(persistCtx, request, result, runErr)
	if saveErr != nil {
		return evidence, errors.Join(runErr, fmt.Errorf("save crawler evidence: %w", saveErr))
	}
	return evidence, runErr
}
