package crawler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	EvidenceRequestVersion = "crawler.evidence.request.v1"
	EvidenceVersion        = "crawler.evidence.v1"
	SafeFetchPolicyVersion = "safefetch.gold.v1"

	EvidenceOutcomeCompleted = "completed"
	EvidenceOutcomePartial   = "partial"
	EvidenceOutcomeFailed    = "failed"
	EvidenceOutcomeCancelled = "cancelled"
)

type EvidenceRequestV1 struct {
	Version     string              `json:"version"`
	RequestID   string              `json:"requestId"`
	TaskType    TaskType            `json:"taskType"`
	Tenant      EvidenceTenant      `json:"tenant"`
	Project     EvidenceProject     `json:"project"`
	Target      EvidenceTarget      `json:"target"`
	Options     EvidenceOptions     `json:"options"`
	RequestedBy EvidenceRequestedBy `json:"requestedBy"`
	RequestedAt time.Time           `json:"requestedAt"`
}

type EvidenceTenant struct {
	OrganizationID string `json:"organizationId"`
	WorkspaceID    string `json:"workspaceId"`
}

type EvidenceProject struct {
	WebsiteProjectID  string `json:"websiteProjectId"`
	WebsiteProjectKey string `json:"websiteProjectKey"`
}

type EvidenceTarget struct {
	TargetURL     string   `json:"targetUrl,omitempty"`
	URLs          []string `json:"urls,omitempty"`
	ExpectedLinks []string `json:"expectedLinks,omitempty"`
	Country       string   `json:"country,omitempty"`
	Language      string   `json:"language,omitempty"`
}

type EvidenceOptions struct {
	MaxPages                     int           `json:"maxPages,omitempty"`
	Scope                        ScopeMode     `json:"scope,omitempty"`
	Directory                    string        `json:"directory,omitempty"`
	Rendering                    RenderingMode `json:"rendering,omitempty"`
	AllowedPaths                 []string      `json:"allowedPaths,omitempty"`
	ExcludedPaths                []string      `json:"excludedPaths,omitempty"`
	IgnoredParameters            []string      `json:"ignoredParameters,omitempty"`
	AdditionalHosts              []string      `json:"additionalHosts,omitempty"`
	CollectPageSpeedEvidence     bool          `json:"collectPageSpeedEvidence,omitempty"`
	CollectDuplicateContent      *bool         `json:"collectDuplicateContentEvidence,omitempty"`
	DuplicateSimilarityThreshold *float64      `json:"duplicateSimilarityThreshold,omitempty"`
}

type EvidenceRequestedBy struct {
	ModuleID      string `json:"moduleId"`
	ActorID       string `json:"actorId"`
	CorrelationID string `json:"correlationId"`
}

func (request EvidenceRequestV1) ToTask() (Task, error) {
	if request.Version != EvidenceRequestVersion {
		return Task{}, fmt.Errorf("unsupported evidence request version %q", request.Version)
	}
	if strings.TrimSpace(request.RequestID) == "" {
		return Task{}, errors.New("requestId is required")
	}
	runID := stableID(
		"crawl-run",
		request.Tenant.WorkspaceID,
		request.Project.WebsiteProjectID,
		request.RequestID,
	)
	task := Task{
		OrganizationID:    request.Tenant.OrganizationID,
		ProjectID:         request.Project.WebsiteProjectID,
		RunID:             runID,
		Type:              request.TaskType,
		TargetURL:         request.Target.TargetURL,
		Country:           request.Target.Country,
		Language:          request.Target.Language,
		MaxPages:          request.Options.MaxPages,
		Scope:             request.Options.Scope,
		Directory:         request.Options.Directory,
		Rendering:         request.Options.Rendering,
		AllowedPaths:      append([]string(nil), request.Options.AllowedPaths...),
		ExcludedPaths:     append([]string(nil), request.Options.ExcludedPaths...),
		IgnoredParameters: append([]string(nil), request.Options.IgnoredParameters...),
		AdditionalHosts:   append([]string(nil), request.Options.AdditionalHosts...),
		URLs:              append([]string(nil), request.Target.URLs...),
		ExpectedLinks:     append([]string(nil), request.Target.ExpectedLinks...),
		EnablePageSpeed:   request.Options.CollectPageSpeedEvidence,
		EnableDuplication: request.Options.CollectDuplicateContent,
		DuplicationLimit:  request.Options.DuplicateSimilarityThreshold,
	}
	if err := task.Validate(); err != nil {
		return Task{}, err
	}
	return task, nil
}

type EvidenceV1 struct {
	Version               string                 `json:"version"`
	PolicyVersion         string                 `json:"policyVersion"`
	EvidenceID            string                 `json:"evidenceId"`
	RequestID             string                 `json:"requestId"`
	TaskType              TaskType               `json:"taskType"`
	Tenant                EvidenceTenant         `json:"tenant"`
	Project               EvidenceProject        `json:"project"`
	RunID                 string                 `json:"runId"`
	Outcome               string                 `json:"outcome"`
	CollectedAt           time.Time              `json:"collectedAt"`
	ExecutionError        *EvidenceError         `json:"executionError"`
	ArtifactRefs          []ArtifactRef          `json:"artifactRefs"`
	Pages                 []PageObservation      `json:"pages"`
	ContactObservations   []ContactObservation   `json:"contactObservations"`
	BacklinkObservations  []BacklinkObservation  `json:"backlinkObservations"`
	TechnicalObservations []TechnicalObservation `json:"technicalObservations"`
}

type EvidenceError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type PageObservation struct {
	RequestedURL       string             `json:"requestedUrl"`
	FinalURL           string             `json:"finalUrl"`
	StatusCode         int                `json:"statusCode"`
	ContentType        string             `json:"contentType,omitempty"`
	Title              string             `json:"title,omitempty"`
	CanonicalURL       string             `json:"canonicalUrl,omitempty"`
	Language           string             `json:"language,omitempty"`
	Headings           []string           `json:"headings"`
	VisibleTextExcerpt string             `json:"visibleTextExcerpt"`
	StructuredData     []any              `json:"structuredData"`
	Rendered           bool               `json:"rendered"`
	RenderMode         string             `json:"renderMode"`
	RobotsDecision     string             `json:"robotsDecision"`
	SecurityDecision   string             `json:"securityDecision"`
	ResolvedIPs        []string           `json:"resolvedIps"`
	RedirectChain      []EvidenceRedirect `json:"redirectChain"`
	NoIndex            bool               `json:"noindex"`
	Error              *EvidenceError     `json:"error"`
	FetchedAt          time.Time          `json:"fetchedAt"`
	ArtifactKeys       []string           `json:"artifactKeys"`
}

type ContactObservation struct {
	Email                string  `json:"email"`
	SourceURL            string  `json:"sourceUrl"`
	DOMPath              string  `json:"domPath,omitempty"`
	VisibleText          string  `json:"visibleText"`
	StructuredRole       string  `json:"structuredRole,omitempty"`
	ObservedRole         string  `json:"observedRole,omitempty"`
	ExtractionConfidence float64 `json:"extractionConfidence"`
	ExtractorVersion     string  `json:"extractorVersion"`
}

type BacklinkObservation struct {
	SourceURL        string             `json:"sourceUrl"`
	TargetURL        string             `json:"targetUrl"`
	AnchorText       string             `json:"anchorText,omitempty"`
	Rel              string             `json:"rel,omitempty"`
	DOMPath          string             `json:"domPath,omitempty"`
	VisibleText      string             `json:"visibleText,omitempty"`
	Present          bool               `json:"present"`
	StatusCode       int                `json:"statusCode"`
	FinalURL         string             `json:"finalUrl,omitempty"`
	RobotsDecision   string             `json:"robotsDecision"`
	SecurityDecision string             `json:"securityDecision"`
	ResolvedIPs      []string           `json:"resolvedIps"`
	RenderMode       string             `json:"renderMode"`
	RedirectChain    []EvidenceRedirect `json:"redirectChain"`
	NoIndex          bool               `json:"noindex"`
	Error            *EvidenceError     `json:"error"`
	ObservedAt       time.Time          `json:"observedAt"`
}

type EvidenceRedirect struct {
	FromURL          string   `json:"fromUrl,omitempty"`
	URL              string   `json:"url"`
	StatusCode       int      `json:"statusCode"`
	SecurityDecision string   `json:"securityDecision"`
	ResolvedIPs      []string `json:"resolvedIps"`
}

type TechnicalObservation struct {
	SourceURL  string    `json:"sourceUrl"`
	Code       string    `json:"code"`
	Category   string    `json:"category"`
	Value      any       `json:"value"`
	Details    any       `json:"details"`
	ObservedAt time.Time `json:"observedAt"`
}

func BuildEvidence(
	request EvidenceRequestV1,
	result Result,
	artifacts []ArtifactRef,
	executionErr error,
) EvidenceV1 {
	collectedAt := result.FinishedAt
	if collectedAt.IsZero() {
		collectedAt = time.Now().UTC()
	}
	outcome := EvidenceOutcomeCompleted
	switch {
	case errors.Is(executionErr, context.Canceled):
		outcome = EvidenceOutcomeCancelled
	case executionErr != nil:
		outcome = EvidenceOutcomeFailed
	case result.CompletionStatus == CompletionPartial:
		outcome = EvidenceOutcomePartial
	}
	evidence := EvidenceV1{
		Version:               EvidenceVersion,
		PolicyVersion:         SafeFetchPolicyVersion,
		EvidenceID:            stableID("evidence", request.RequestID),
		RequestID:             request.RequestID,
		TaskType:              request.TaskType,
		Tenant:                request.Tenant,
		Project:               request.Project,
		RunID:                 result.RunID,
		Outcome:               outcome,
		CollectedAt:           collectedAt,
		ExecutionError:        evidenceError(executionErr),
		ArtifactRefs:          cloneArtifactRefs(artifacts),
		Pages:                 buildPageObservations(result.Pages),
		ContactObservations:   []ContactObservation{},
		BacklinkObservations:  buildBacklinkObservations(request, result.Backlinks),
		TechnicalObservations: buildTechnicalObservations(result),
	}
	return evidence
}

func buildPageObservations(pages []Page) []PageObservation {
	observations := make([]PageObservation, 0, len(pages))
	for _, page := range pages {
		structured := make([]any, 0, len(page.StructuredData))
		for _, raw := range page.StructuredData {
			var value any
			if err := json.Unmarshal(raw, &value); err == nil {
				structured = append(structured, value)
			}
		}
		keys := nonEmptyStrings([]string{page.RawHTMLRef, page.MainHTMLRef, page.MainTextRef})
		observations = append(observations, PageObservation{
			RequestedURL:       page.URL,
			FinalURL:           defaultString(page.FinalURL, page.URL),
			StatusCode:         page.StatusCode,
			ContentType:        page.ContentType,
			Title:              page.Title,
			CanonicalURL:       page.Canonical,
			Language:           page.Language,
			Headings:           cloneStrings(page.Headings),
			VisibleTextExcerpt: truncate(page.MainText, 12000),
			StructuredData:     structured,
			Rendered:           page.Rendered,
			RenderMode:         page.RenderMode,
			RobotsDecision:     page.RobotsDecision,
			SecurityDecision:   page.SecurityDecision,
			ResolvedIPs:        cloneStrings(page.ResolvedIPs),
			RedirectChain:      buildEvidenceRedirects(page.Redirects),
			NoIndex:            page.NoIndex,
			Error:              evidenceErrorFromCode(page.ErrorType, page.Error),
			FetchedAt:          page.FetchedAt,
			ArtifactKeys:       keys,
		})
	}
	return observations
}

func buildBacklinkObservations(
	request EvidenceRequestV1,
	results []BacklinkResult,
) []BacklinkObservation {
	observations := make([]BacklinkObservation, 0)
	for _, result := range results {
		if len(request.Target.ExpectedLinks) == 0 {
			for _, link := range result.FoundLinks {
				observations = append(
					observations,
					backlinkObservation(result, link.URL, link),
				)
			}
			continue
		}
		found := make(map[string]Link, len(result.FoundLinks))
		for _, link := range result.FoundLinks {
			found[normalizeComparisonURL(link.URL)] = link
		}
		for _, targetURL := range request.Target.ExpectedLinks {
			link, present := found[normalizeComparisonURL(targetURL)]
			observation := backlinkObservation(result, targetURL, link)
			observation.Present = present
			observations = append(observations, observation)
		}
	}
	return observations
}

func backlinkObservation(
	result BacklinkResult,
	targetURL string,
	link Link,
) BacklinkObservation {
	return BacklinkObservation{
		SourceURL:        result.URL,
		TargetURL:        targetURL,
		AnchorText:       link.Text,
		Rel:              link.Rel,
		VisibleText:      link.Text,
		Present:          targetURL == "" || link.URL != "",
		StatusCode:       result.StatusCode,
		FinalURL:         result.FinalURL,
		RobotsDecision:   result.RobotsDecision,
		SecurityDecision: result.SecurityDecision,
		ResolvedIPs:      cloneStrings(result.ResolvedIPs),
		RenderMode:       result.RenderMode,
		RedirectChain:    buildEvidenceRedirects(result.Redirects),
		NoIndex:          result.NoIndex,
		Error:            evidenceErrorFromCode(result.ErrorType, result.Error),
		ObservedAt:       result.CheckedAt,
	}
}

func buildTechnicalObservations(result Result) []TechnicalObservation {
	observations := make([]TechnicalObservation, 0, len(result.Issues))
	for _, issue := range result.Issues {
		observations = append(observations, TechnicalObservation{
			SourceURL: issue.URL,
			Code:      issue.Code,
			Category:  issue.Category,
			Value:     issue.Issue,
			Details: map[string]any{
				"details":    issue.Details,
				"relatedUrl": issue.RelatedURL,
				"similarity": issue.Similarity,
			},
			ObservedAt: result.FinishedAt,
		})
	}
	return observations
}

func evidenceError(err error) *EvidenceError {
	if err == nil {
		return nil
	}
	return evidenceErrorFromCode(classifyFetchError(err), err.Error())
}

func evidenceErrorFromCode(code, message string) *EvidenceError {
	if strings.TrimSpace(message) == "" {
		return nil
	}
	if strings.TrimSpace(code) == "" {
		code = "crawler_error"
	}
	return &EvidenceError{
		Code:      code,
		Message:   truncate(message, 2000),
		Retryable: isRetryableErrorCode(code),
	}
}

func isRetryableErrorCode(code string) bool {
	switch code {
	case "timeout", "connection_refused", "dns_not_found", "connection_error", "rate_limited":
		return true
	default:
		return false
	}
}

func stableID(prefix string, values ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(values, "\x00")))
	return prefix + "-" + hex.EncodeToString(sum[:16])
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func nonEmptyStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return result
}

func cloneStrings(values []string) []string {
	return append(make([]string, 0, len(values)), values...)
}

func cloneArtifactRefs(values []ArtifactRef) []ArtifactRef {
	return append(make([]ArtifactRef, 0, len(values)), values...)
}

func buildEvidenceRedirects(redirects []Redirect) []EvidenceRedirect {
	result := make([]EvidenceRedirect, 0, len(redirects))
	for _, redirect := range redirects {
		result = append(result, EvidenceRedirect{
			FromURL:          redirect.FromURL,
			URL:              redirect.URL,
			StatusCode:       redirect.StatusCode,
			SecurityDecision: redirect.SecurityDecision,
			ResolvedIPs:      cloneStrings(redirect.ResolvedIPs),
		})
	}
	return result
}
