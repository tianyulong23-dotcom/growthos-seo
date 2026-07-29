package worker

import (
	"context"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"

	"seo/backend/crawler/internal/crawler"
)

func TestRunStopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := Run(ctx); err != nil {
		t.Fatalf("Run returned an error: %v", err)
	}
}

func TestTemporalBindingsUseVersionedCrawlingNamespace(t *testing.T) {
	if TaskQueue != "growthos.crawling.v1" {
		t.Fatalf("TaskQueue = %q", TaskQueue)
	}
	if WorkflowName != "crawlingEvidenceV1Workflow" {
		t.Fatalf("WorkflowName = %q", WorkflowName)
	}
	if ActivityName != "crawlingCollectEvidenceV1" {
		t.Fatalf("ActivityName = %q", ActivityName)
	}
	if PauseSignalName != "crawlingPauseV1" ||
		StopSignalName != "crawlingStopV1" ||
		ProgressQueryName != "crawlingProgressV1" {
		t.Fatalf(
			"signal/query names = %q, %q, %q",
			PauseSignalName,
			StopSignalName,
			ProgressQueryName,
		)
	}
}

func TestEvidenceWorkflowReturnsVersionedEvidence(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(
		func(context.Context, crawler.EvidenceRequestV1) (crawler.EvidenceV1, error) {
			return crawler.EvidenceV1{
				Version:    crawler.EvidenceVersion,
				EvidenceID: "evidence-001",
				RequestID:  "request-001",
				RunID:      "run-001",
				Outcome:    crawler.EvidenceOutcomeCompleted,
			}, nil
		},
		activity.RegisterOptions{Name: ActivityName},
	)
	request := crawler.EvidenceRequestV1{
		Version:   crawler.EvidenceRequestVersion,
		RequestID: "request-001",
	}

	env.ExecuteWorkflow(EvidenceWorkflow, request)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow returned an error: %v", err)
	}
	var evidence crawler.EvidenceV1
	if err := env.GetWorkflowResult(&evidence); err != nil {
		t.Fatalf("GetWorkflowResult() returned an error: %v", err)
	}
	if evidence.Version != crawler.EvidenceVersion ||
		evidence.RequestID != request.RequestID {
		t.Fatalf("workflow result = %#v", evidence)
	}
}

func TestEvidenceWorkflowPauseAndStopReturnCancelledEvidence(t *testing.T) {
	for _, signalName := range []string{PauseSignalName, StopSignalName} {
		t.Run(signalName, func(t *testing.T) {
			var suite testsuite.WorkflowTestSuite
			env := suite.NewTestWorkflowEnvironment()
			env.RegisterActivityWithOptions(
				func(
					ctx context.Context,
					_ crawler.EvidenceRequestV1,
				) (crawler.EvidenceV1, error) {
					<-ctx.Done()
					return crawler.EvidenceV1{}, ctx.Err()
				},
				activity.RegisterOptions{Name: ActivityName},
			)
			request := validEvidenceRequest()
			env.RegisterDelayedCallback(func() {
				encodedProgress, err := env.QueryWorkflow(ProgressQueryName)
				if err != nil {
					t.Fatalf("QueryWorkflow() returned an error: %v", err)
				}
				var progress crawler.Progress
				if err := encodedProgress.Get(&progress); err != nil {
					t.Fatalf("query result decode returned an error: %v", err)
				}
				if progress.Message == "" {
					t.Fatal("workflow progress query returned an empty message")
				}
				env.SignalWorkflow(signalName, nil)
			}, time.Second)

			env.ExecuteWorkflow(EvidenceWorkflow, request)
			if err := env.GetWorkflowError(); err != nil {
				t.Fatalf("workflow returned an error: %v", err)
			}
			var evidence crawler.EvidenceV1
			if err := env.GetWorkflowResult(&evidence); err != nil {
				t.Fatalf("GetWorkflowResult() returned an error: %v", err)
			}
			if evidence.Outcome != crawler.EvidenceOutcomeCancelled ||
				evidence.PolicyVersion != crawler.SafeFetchPolicyVersion ||
				evidence.RequestID != request.RequestID {
				t.Fatalf("cancelled workflow result = %#v", evidence)
			}
		})
	}
}

func validEvidenceRequest() crawler.EvidenceRequestV1 {
	return crawler.EvidenceRequestV1{
		Version:   crawler.EvidenceRequestVersion,
		RequestID: "request-001",
		TaskType:  crawler.TaskBacklinkValidation,
		Tenant: crawler.EvidenceTenant{
			OrganizationID: "org",
			WorkspaceID:    "workspace",
		},
		Project: crawler.EvidenceProject{
			WebsiteProjectID:  "project",
			WebsiteProjectKey: "project-key",
		},
		Target: crawler.EvidenceTarget{
			URLs: []string{"https://publisher.example/article"},
		},
	}
}
