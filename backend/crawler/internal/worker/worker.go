package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	temporalworker "go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"seo/backend/crawler/internal/crawler"
)

const (
	TaskQueue         = "growthos.crawling.v1"
	WorkflowName      = "crawlingEvidenceV1Workflow"
	ActivityName      = "crawlingCollectEvidenceV1"
	PauseSignalName   = "crawlingPauseV1"
	StopSignalName    = "crawlingStopV1"
	ProgressQueryName = "crawlingProgressV1"
)

type Activities struct {
	Config crawler.Config
	Store  *crawler.EvidenceStore
}

func (a *Activities) CollectEvidence(
	ctx context.Context,
	request crawler.EvidenceRequestV1,
) (crawler.EvidenceV1, error) {
	reporter := crawler.ProgressReporterFunc(func(progress crawler.Progress) {
		activity.RecordHeartbeat(ctx, progress)
	})
	return crawler.CollectEvidence(ctx, a.Config, a.Store, request, reporter)
}

func EvidenceWorkflow(
	ctx workflow.Context,
	request crawler.EvidenceRequestV1,
) (crawler.EvidenceV1, error) {
	progress := crawler.Progress{
		Stage:      crawler.StageAnalyzing,
		Message:    "crawler evidence activity scheduled",
		OccurredAt: workflow.Now(ctx),
	}
	if err := workflow.SetQueryHandler(ctx, ProgressQueryName, func() (crawler.Progress, error) {
		return progress, nil
	}); err != nil {
		return crawler.EvidenceV1{}, err
	}

	activityCtx, cancelActivity := workflow.WithCancel(workflow.WithActivityOptions(
		ctx,
		workflow.ActivityOptions{
			StartToCloseTimeout: 2 * time.Hour,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy: &temporal.RetryPolicy{
				InitialInterval:    5 * time.Second,
				BackoffCoefficient: 2,
				MaximumInterval:    2 * time.Minute,
				MaximumAttempts:    3,
			},
		},
	))
	future := workflow.ExecuteActivity(activityCtx, ActivityName, request)

	var evidence crawler.EvidenceV1
	var activityErr error
	interrupted := false
	selector := workflow.NewSelector(ctx)
	selector.AddFuture(future, func(completed workflow.Future) {
		activityErr = completed.Get(ctx, &evidence)
	})
	for _, signalName := range []string{PauseSignalName, StopSignalName} {
		signal := workflow.GetSignalChannel(ctx, signalName)
		selector.AddReceive(signal, func(channel workflow.ReceiveChannel, _ bool) {
			var payload any
			channel.Receive(ctx, &payload)
			interrupted = true
			cancelActivity()
		})
	}
	selector.Select(ctx)

	if !interrupted {
		return evidence, activityErr
	}
	task, err := request.ToTask()
	if err != nil {
		return crawler.EvidenceV1{}, err
	}
	now := workflow.Now(ctx)
	return crawler.BuildEvidence(
		request,
		crawler.Result{
			TaskType:   task.Type,
			RunID:      task.RunID,
			FinishedAt: now,
		},
		nil,
		context.Canceled,
	), nil
}

func Run(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return nil
	}

	config := crawler.LoadConfig()
	config.TaskQueue = TaskQueue
	if err := crawler.PrepareBrowser(ctx, &config); err != nil {
		return err
	}
	store, err := crawler.NewEvidenceStore(ctx, config)
	if err != nil {
		return fmt.Errorf("create evidence store: %w", err)
	}
	temporalClient, err := client.Dial(client.Options{
		HostPort:  config.TemporalAddress,
		Namespace: config.TemporalNamespace,
	})
	if err != nil {
		return fmt.Errorf("connect Temporal: %w", err)
	}
	defer temporalClient.Close()

	runner := temporalworker.New(temporalClient, config.TaskQueue, temporalworker.Options{})
	runner.RegisterWorkflowWithOptions(
		EvidenceWorkflow,
		workflow.RegisterOptions{Name: WorkflowName},
	)
	runner.RegisterActivityWithOptions(
		(&Activities{Config: config, Store: store}).CollectEvidence,
		activity.RegisterOptions{Name: ActivityName},
	)
	if err := runner.Start(); err != nil {
		return fmt.Errorf("start crawler worker: %w", err)
	}
	defer runner.Stop()

	slog.Info("crawler worker started", "task_queue", config.TaskQueue)
	if config.WorkerIdleTimeout > 0 {
		timer := time.NewTimer(config.WorkerIdleTimeout)
		defer timer.Stop()
		select {
		case <-ctx.Done():
		case <-timer.C:
		}
	} else {
		<-ctx.Done()
	}
	slog.Info("crawler worker stopped", "cause", context.Cause(ctx))
	if err := ctx.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}
