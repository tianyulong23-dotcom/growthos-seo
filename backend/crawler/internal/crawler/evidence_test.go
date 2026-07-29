package crawler

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

type recordingObjectStore struct {
	objects map[string]storedTestObject
}

type storedTestObject struct {
	contentType     string
	contentEncoding string
	body            []byte
}

func (s *recordingObjectStore) Put(
	_ context.Context,
	key string,
	contentType string,
	contentEncoding string,
	body []byte,
) (string, error) {
	if s.objects == nil {
		s.objects = make(map[string]storedTestObject)
	}
	s.objects[key] = storedTestObject{
		contentType:     contentType,
		contentEncoding: contentEncoding,
		body:            append([]byte(nil), body...),
	}
	return "s3://crawler-private/" + key, nil
}

func TestEvidenceRequestToTaskUsesDeterministicIdentity(t *testing.T) {
	request := testEvidenceRequest()

	first, err := request.ToTask()
	if err != nil {
		t.Fatalf("ToTask() returned an error: %v", err)
	}
	second, err := request.ToTask()
	if err != nil {
		t.Fatalf("second ToTask() returned an error: %v", err)
	}

	if first.RunID == "" || first.RunID != second.RunID {
		t.Fatalf("run IDs are not deterministic: %q, %q", first.RunID, second.RunID)
	}
	if first.OrganizationID != request.Tenant.OrganizationID ||
		first.ProjectID != request.Project.WebsiteProjectID {
		t.Fatalf("task ownership = %#v", first)
	}
	if first.Type != TaskBacklinkValidation ||
		len(first.URLs) != 1 ||
		len(first.ExpectedLinks) != 1 {
		t.Fatalf("task target mapping = %#v", first)
	}
}

func TestBuildEvidenceIncludesBacklinkSafetyDecisions(t *testing.T) {
	request := testEvidenceRequest()
	task, err := request.ToTask()
	if err != nil {
		t.Fatalf("ToTask() returned an error: %v", err)
	}
	checkedAt := time.Date(2026, 7, 24, 8, 30, 0, 0, time.UTC)
	result := Result{
		TaskType:         TaskBacklinkValidation,
		RunID:            task.RunID,
		CompletionStatus: CompletionComplete,
		Backlinks: []BacklinkResult{{
			URL:              "https://publisher.example/article",
			FinalURL:         "https://publisher.example/article-final",
			StatusCode:       200,
			RobotsDecision:   "allowed",
			SecurityDecision: "allowed",
			ResolvedIPs:      []string{"203.0.113.10"},
			RenderMode:       "static",
			NoIndex:          true,
			Redirects: []Redirect{{
				FromURL:          "https://publisher.example/article",
				URL:              "https://publisher.example/article-final",
				StatusCode:       301,
				SecurityDecision: "allowed",
				ResolvedIPs:      []string{"203.0.113.10"},
			}},
			FoundLinks: []Link{{
				URL:  "https://target.example/",
				Text: "Target",
				Rel:  "nofollow",
			}},
			CheckedAt: checkedAt,
		}},
		FinishedAt: checkedAt,
	}
	artifact := ArtifactRef{
		Key:         "crawler/org/project/run/backlink/page.json",
		URI:         "s3://crawler-private/crawler/org/project/run/backlink/page.json",
		ContentType: "application/json",
		SHA256:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		SizeBytes:   42,
	}

	evidence := BuildEvidence(request, result, []ArtifactRef{artifact}, nil)

	if evidence.Version != EvidenceVersion || evidence.PolicyVersion != SafeFetchPolicyVersion {
		t.Fatalf("evidence versions = %#v", evidence)
	}
	if len(evidence.BacklinkObservations) != 1 {
		t.Fatalf("backlink observations = %#v", evidence.BacklinkObservations)
	}
	observation := evidence.BacklinkObservations[0]
	if !observation.Present ||
		observation.SecurityDecision != "allowed" ||
		observation.RobotsDecision != "allowed" ||
		observation.RenderMode != "static" ||
		!observation.NoIndex {
		t.Fatalf("backlink evidence = %#v", observation)
	}
	if len(observation.RedirectChain) != 1 ||
		len(observation.ResolvedIPs) != 1 ||
		observation.Error != nil {
		t.Fatalf("backlink safety evidence = %#v", observation)
	}
	if len(evidence.ArtifactRefs) != 1 || evidence.ArtifactRefs[0].SHA256 != artifact.SHA256 {
		t.Fatalf("artifact refs = %#v", evidence.ArtifactRefs)
	}
}

func TestEvidenceStoreRetriesReuseKeysAndHashes(t *testing.T) {
	objects := &recordingObjectStore{}
	store := newEvidenceStore(objects)
	request := testEvidenceRequest()
	task, err := request.ToTask()
	if err != nil {
		t.Fatalf("ToTask() returned an error: %v", err)
	}
	result := Result{
		TaskType:         task.Type,
		RunID:            task.RunID,
		CompletionStatus: CompletionComplete,
		FinishedAt:       time.Date(2026, 7, 24, 8, 30, 0, 0, time.UTC),
	}

	first, err := store.SaveEvidence(context.Background(), request, result, nil)
	if err != nil {
		t.Fatalf("first SaveEvidence() returned an error: %v", err)
	}
	second, err := store.SaveEvidence(context.Background(), request, result, nil)
	if err != nil {
		t.Fatalf("second SaveEvidence() returned an error: %v", err)
	}

	if len(objects.objects) != 2 {
		t.Fatalf("unique object count = %d, want 2", len(objects.objects))
	}
	if len(first.ArtifactRefs) != 2 || len(second.ArtifactRefs) != 2 {
		t.Fatalf("artifact refs = %d, %d", len(first.ArtifactRefs), len(second.ArtifactRefs))
	}
	for index := range first.ArtifactRefs {
		if first.ArtifactRefs[index] != second.ArtifactRefs[index] {
			t.Fatalf("retry changed artifact %d: %#v != %#v", index, first.ArtifactRefs[index], second.ArtifactRefs[index])
		}
	}
	for key, object := range objects.objects {
		if len(object.body) == 0 || object.contentType != "application/json" {
			t.Fatalf("stored object %q = %#v", key, object)
		}
		var decoded any
		if err := json.Unmarshal(object.body, &decoded); err != nil {
			t.Fatalf("stored object %q is not JSON: %v", key, err)
		}
	}
}

func TestBuildEvidenceMarshalsEmptyCollectionsAsArrays(t *testing.T) {
	request := testEvidenceRequest()
	request.Target.ExpectedLinks = nil
	task, err := request.ToTask()
	if err != nil {
		t.Fatalf("ToTask() returned an error: %v", err)
	}
	evidence := BuildEvidence(
		request,
		Result{
			TaskType:   task.Type,
			RunID:      task.RunID,
			FinishedAt: time.Date(2026, 7, 24, 8, 30, 0, 0, time.UTC),
			Pages: []Page{{
				URL:       "https://publisher.example/article",
				FinalURL:  "https://publisher.example/article",
				FetchedAt: time.Date(2026, 7, 24, 8, 29, 0, 0, time.UTC),
			}},
			Backlinks: []BacklinkResult{{
				URL:       "https://publisher.example/article",
				CheckedAt: time.Date(2026, 7, 24, 8, 29, 0, 0, time.UTC),
			}},
		},
		nil,
		nil,
	)

	body, err := json.Marshal(evidence)
	if err != nil {
		t.Fatalf("json.Marshal() returned an error: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("json.Unmarshal() returned an error: %v", err)
	}
	for _, field := range []string{
		"artifactRefs",
		"pages",
		"contactObservations",
		"backlinkObservations",
		"technicalObservations",
	} {
		if _, ok := document[field].([]any); !ok {
			t.Fatalf("%s is not a JSON array: %#v", field, document[field])
		}
	}
	pages := document["pages"].([]any)
	page := pages[0].(map[string]any)
	for _, field := range []string{
		"headings",
		"structuredData",
		"resolvedIps",
		"redirectChain",
		"artifactKeys",
	} {
		if _, ok := page[field].([]any); !ok {
			t.Fatalf("page %s is not a JSON array: %#v", field, page[field])
		}
	}
	if len(evidence.BacklinkObservations) != 0 {
		t.Fatalf("empty found links produced observations: %#v", evidence.BacklinkObservations)
	}
}

func TestBuildEvidenceEmitsObservedLinksWhenNoTargetsWereRequested(t *testing.T) {
	request := testEvidenceRequest()
	request.Target.ExpectedLinks = nil
	task, err := request.ToTask()
	if err != nil {
		t.Fatalf("ToTask() returned an error: %v", err)
	}
	evidence := BuildEvidence(
		request,
		Result{
			TaskType: task.Type,
			RunID:    task.RunID,
			Backlinks: []BacklinkResult{{
				URL: "https://publisher.example/article",
				FoundLinks: []Link{{
					URL:  "https://target.example/",
					Text: "Target",
				}},
				CheckedAt: time.Date(2026, 7, 24, 8, 29, 0, 0, time.UTC),
			}},
			FinishedAt: time.Date(2026, 7, 24, 8, 30, 0, 0, time.UTC),
		},
		nil,
		nil,
	)

	if len(evidence.BacklinkObservations) != 1 {
		t.Fatalf("backlink observations = %#v", evidence.BacklinkObservations)
	}
	observation := evidence.BacklinkObservations[0]
	if observation.TargetURL != "https://target.example/" || !observation.Present {
		t.Fatalf("observed backlink = %#v", observation)
	}
}

func testEvidenceRequest() EvidenceRequestV1 {
	return EvidenceRequestV1{
		Version:   EvidenceRequestVersion,
		RequestID: "request-001",
		TaskType:  TaskBacklinkValidation,
		Tenant: EvidenceTenant{
			OrganizationID: "org",
			WorkspaceID:    "workspace",
		},
		Project: EvidenceProject{
			WebsiteProjectID:  "project",
			WebsiteProjectKey: "project-key",
		},
		Target: EvidenceTarget{
			URLs:          []string{"https://publisher.example/article"},
			ExpectedLinks: []string{"https://target.example/"},
		},
		Options: EvidenceOptions{Rendering: RenderingAuto},
		RequestedBy: EvidenceRequestedBy{
			ModuleID:      "backlinks",
			ActorID:       "actor",
			CorrelationID: "correlation",
		},
		RequestedAt: time.Date(2026, 7, 24, 8, 0, 0, 0, time.UTC),
	}
}
