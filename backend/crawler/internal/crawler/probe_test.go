package crawler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type probeFetcherFunc func(context.Context, string) (Resource, error)

func (function probeFetcherFunc) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	return function(ctx, rawURL)
}

func TestProbeServiceReportsCrossDomainRedirectEvidence(t *testing.T) {
	service := &ProbeService{
		concurrency: 2,
		fetcher: probeFetcherFunc(func(_ context.Context, rawURL string) (Resource, error) {
			return Resource{
				URL:         rawURL,
				FinalURL:    "https://eduone.jp/",
				StatusCode:  http.StatusOK,
				ContentType: "text/html; charset=utf-8",
				Body: []byte("<html lang=\"ja\"><title>Elephant TV</title>" +
					"<body><h1>Education video service</h1></body></html>"),
				Redirects: []Redirect{{
					FromURL: rawURL,
					URL:     "https://eduone.jp/",
				}},
			}, nil
		}),
	}
	body := bytes.NewBufferString(`{
		"country":"ZA",
		"language":"en",
		"candidates":[{
			"domain":"en.e-lephant.tv",
			"urls":["https://en.e-lephant.tv/member/"]
		}]
	}`)
	request := httptest.NewRequest(http.MethodPost, "/v1/probe", body)
	response := httptest.NewRecorder()

	service.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload ProbeResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	result := payload.Results[0]
	if result.Status != "redirected" {
		t.Fatalf("status = %q, want redirected", result.Status)
	}
	if result.FinalDomain != "eduone.jp" {
		t.Fatalf("final domain = %q, want eduone.jp", result.FinalDomain)
	}
	if result.Title != "Elephant TV" || len(result.Redirects) != 1 {
		t.Fatalf("missing page or redirect evidence: %#v", result)
	}
}

func TestProbeFetchClassificationSeparatesBlockedTemporaryAndUnsafe(t *testing.T) {
	tests := []struct {
		name     string
		resource Resource
		err      error
		want     string
	}{
		{
			name:     "blocked",
			resource: Resource{StatusCode: http.StatusForbidden, ContentType: "text/html"},
			want:     "blocked",
		},
		{
			name:     "temporary",
			resource: Resource{StatusCode: http.StatusBadGateway, ContentType: "text/html"},
			want:     "temporarily_unavailable",
		},
		{
			name: "unsafe",
			err:  errors.New("blocked resolved address 127.0.0.1"),
			want: "unsafe_target",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyProbeFetch(test.resource, test.err); got != test.want {
				t.Fatalf("status = %q, want %q", got, test.want)
			}
		})
	}
}

func TestProbeServiceHealth(t *testing.T) {
	service := &ProbeService{}
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	response := httptest.NewRecorder()

	service.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestProbeServiceRendersSharedBrowserWorkerContract(t *testing.T) {
	requestedAt := "2026-09-02T12:00:00Z"
	service := &ProbeService{
		renderFetcher: probeFetcherFunc(func(_ context.Context, rawURL string) (Resource, error) {
			return Resource{
				URL:         rawURL,
				FinalURL:    "https://www.publisher.com/reviews",
				StatusCode:  http.StatusOK,
				ContentType: "text/html; charset=utf-8",
				Body: []byte("<html lang=\"en\"><head><title>Publisher reviews</title></head>" +
					"<body><main>Independent streaming reviews.</main></body></html>"),
				Rendered:  true,
				FetchedAt: time.Date(2026, 9, 2, 12, 0, 1, 0, time.UTC),
			}, nil
		}),
	}
	body := bytes.NewBufferString(`{
		"version":"crawler.evidence.request.v1",
		"requestId":"request-1",
		"taskType":"seo_assessment",
		"tenant":{"organizationId":"organization-1","workspaceId":"workspace-1"},
		"project":{"websiteProjectId":"project-1"},
		"target":{"urls":["https://publisher.com/reviews"]},
		"requestedBy":{"moduleId":"backlinks","actorId":"actor-1"},
		"requestedAt":"` + requestedAt + `"
	}`)
	request := httptest.NewRequest(http.MethodPost, "/render", body)
	response := httptest.NewRecorder()

	service.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload RenderResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.FinalURL != "https://www.publisher.com/reviews" ||
		payload.Evidence.Version != "crawler.evidence.v1" ||
		payload.Evidence.Outcome != "completed" ||
		len(payload.Evidence.Pages) != 1 ||
		!payload.Evidence.Pages[0].Rendered ||
		payload.Evidence.Pages[0].RenderMode != "browser" {
		t.Fatalf("unexpected render response: %#v", payload)
	}
}

func TestProbeServiceRenderFailsClosedWithoutBrowser(t *testing.T) {
	service := &ProbeService{}
	request := httptest.NewRequest(http.MethodPost, "/render", bytes.NewBufferString(`{}`))
	response := httptest.NewRecorder()

	service.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestNormalizedProbeURLsRejectsAnotherCandidateHost(t *testing.T) {
	urls := normalizedProbeURLs(ProbeCandidate{
		Domain: "candidate.example",
		URLs: []string{
			"https://unrelated.example/result",
			"https://www.candidate.example/result",
		},
	})

	if len(urls) != 2 {
		t.Fatalf("urls = %#v, want ranking URL and root URL", urls)
	}
	if urls[0] != "https://www.candidate.example/result" || urls[1] != "https://candidate.example/" {
		t.Fatalf("unexpected normalized urls: %#v", urls)
	}
}
