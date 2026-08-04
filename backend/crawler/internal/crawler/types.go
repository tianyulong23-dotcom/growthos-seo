package crawler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type TaskType string

const (
	TaskSiteUnderstanding  TaskType = "site_understanding"
	TaskTechnicalAudit     TaskType = "technical_audit"
	TaskBacklinkValidation TaskType = "backlink_validation"

	siteUnderstandingMinimumPages = 3
	siteUnderstandingDefaultPages = 5
	siteUnderstandingHardLimit    = 10
	technicalAuditHardLimit       = 5000
)

type ScopeMode string

const (
	ScopeDomain     ScopeMode = "domain"
	ScopeSubdomains ScopeMode = "subdomains"
	ScopeDirectory  ScopeMode = "directory"
)

type RenderingMode string

const (
	RenderingAuto RenderingMode = "auto"
	RenderingOff  RenderingMode = "off"
	RenderingAll  RenderingMode = "all"
)

type Task struct {
	OrganizationID    string        `json:"organization_id"`
	ProjectID         string        `json:"project_id"`
	RunID             string        `json:"run_id"`
	Type              TaskType      `json:"type"`
	TargetURL         string        `json:"target_url"`
	Country           string        `json:"country"`
	Language          string        `json:"language"`
	MaxPages          int           `json:"max_pages,omitempty"`
	Scope             ScopeMode     `json:"scope,omitempty"`
	Directory         string        `json:"directory,omitempty"`
	Rendering         RenderingMode `json:"rendering,omitempty"`
	AllowedPaths      []string      `json:"allowed_paths,omitempty"`
	ExcludedPaths     []string      `json:"excluded_paths,omitempty"`
	IssueExclusions   []string      `json:"issue_exclusion_patterns,omitempty"`
	IgnoredParameters []string      `json:"ignored_parameters,omitempty"`
	AdditionalHosts   []string      `json:"additional_hosts,omitempty"`
	URLs              []string      `json:"urls,omitempty"`
	ExpectedLinks     []string      `json:"expected_links,omitempty"`
	EnablePageSpeed   bool          `json:"enable_pagespeed,omitempty"`
	EnableDuplication *bool         `json:"enable_duplication_check,omitempty"`
	DuplicationLimit  *float64      `json:"duplication_threshold,omitempty"`
}

func (t Task) Validate() error {
	if strings.TrimSpace(t.OrganizationID) == "" {
		return errors.New("organization_id is required")
	}
	if strings.TrimSpace(t.ProjectID) == "" {
		return errors.New("project_id is required")
	}
	if strings.TrimSpace(t.RunID) == "" {
		return errors.New("run_id is required")
	}
	switch t.Type {
	case TaskSiteUnderstanding, TaskTechnicalAudit:
		if strings.TrimSpace(t.TargetURL) == "" {
			return errors.New("target_url is required")
		}
		if strings.TrimSpace(t.Country) == "" {
			return errors.New("country is required")
		}
		if strings.TrimSpace(t.Language) == "" {
			return errors.New("language is required")
		}
		for _, host := range t.AdditionalHosts {
			if strings.TrimSpace(host) == "" {
				return errors.New("additional_hosts cannot contain empty values")
			}
		}
		switch t.ScopeMode() {
		case ScopeDomain, ScopeSubdomains:
		case ScopeDirectory:
			if strings.TrimSpace(t.Directory) == "" {
				return errors.New("directory is required for directory scope")
			}
		default:
			return fmt.Errorf("unsupported scope %q", t.Scope)
		}
		switch t.RenderingMode() {
		case RenderingAuto, RenderingOff, RenderingAll:
		default:
			return fmt.Errorf("unsupported rendering mode %q", t.Rendering)
		}
		if t.DuplicationLimit != nil &&
			(*t.DuplicationLimit < 0 || *t.DuplicationLimit > 1) {
			return errors.New("duplication_threshold must be between 0 and 1")
		}
		if t.Type == TaskTechnicalAudit && t.MaxPages > technicalAuditHardLimit {
			return fmt.Errorf("max_pages cannot exceed %d", technicalAuditHardLimit)
		}
	case TaskBacklinkValidation:
		if len(t.URLs) == 0 {
			return errors.New("urls are required for backlink validation")
		}
	default:
		return fmt.Errorf("unsupported task type %q", t.Type)
	}
	return nil
}

func (t Task) ScopeMode() ScopeMode {
	if t.Scope == "" {
		return ScopeDomain
	}
	return t.Scope
}

func (t Task) RenderingMode() RenderingMode {
	if t.Rendering == "" {
		return RenderingAuto
	}
	return t.Rendering
}

func (t Task) DuplicationCheckEnabled() bool {
	if t.EnableDuplication == nil {
		return true
	}
	return *t.EnableDuplication
}

func (t Task) DuplicationThreshold() float64 {
	if t.DuplicationLimit == nil {
		return duplicateSimilarityThreshold
	}
	return *t.DuplicationLimit
}

func (t Task) PageLimit() int {
	switch t.Type {
	case TaskSiteUnderstanding:
		if t.MaxPages > 0 {
			return min(t.MaxPages, siteUnderstandingHardLimit)
		}
		return siteUnderstandingDefaultPages
	case TaskTechnicalAudit:
		if t.MaxPages > 0 {
			return min(t.MaxPages, technicalAuditHardLimit)
		}
		return 1000
	case TaskBacklinkValidation:
		return len(t.URLs)
	default:
		return 0
	}
}

type ProgressStage string

const (
	StageAnalyzing     ProgressStage = "analyzing_site"
	StageDiscovering   ProgressStage = "discovering_pages"
	StageSelecting     ProgressStage = "selecting_pages"
	StageExtracting    ProgressStage = "extracting_pages"
	StageGenerating    ProgressStage = "generating_profile"
	StageCheckingLinks ProgressStage = "checking_links"
	StagePageSpeed     ProgressStage = "pagespeed"
	StageCompleted     ProgressStage = "completed"
	StageFailed        ProgressStage = "failed"
)

type CompletionStatus string

const (
	CompletionComplete CompletionStatus = "complete"
	CompletionPartial  CompletionStatus = "partial"
)

type Progress struct {
	Stage      ProgressStage `json:"stage"`
	Message    string        `json:"message"`
	Discovered int           `json:"discovered,omitempty"`
	Processed  int           `json:"processed,omitempty"`
	Selected   int           `json:"selected,omitempty"`
	OccurredAt time.Time     `json:"occurred_at"`
}

type ProgressReporter interface {
	Report(Progress)
}

type ProgressReporterFunc func(Progress)

func (f ProgressReporterFunc) Report(progress Progress) {
	f(progress)
}

type Link struct {
	URL          string `json:"url"`
	Text         string `json:"text,omitempty"`
	Rel          string `json:"rel,omitempty"`
	InNavigation bool   `json:"in_navigation,omitempty"`
	IsInternal   bool   `json:"is_internal"`
	TargetDomain string `json:"target_domain,omitempty"`
	TargetStatus *int   `json:"target_status,omitempty"`
	Placement    string `json:"placement,omitempty"`
}

type SEOImage struct {
	Src     string `json:"src"`
	Alt     string `json:"alt,omitempty"`
	Title   string `json:"title,omitempty"`
	Width   string `json:"width,omitempty"`
	Height  string `json:"height,omitempty"`
	Loading string `json:"loading,omitempty"`
}

type BrokenImage struct {
	URL        string `json:"url"`
	StatusCode int    `json:"status,omitempty"`
	Error      string `json:"error,omitempty"`
}

type HreflangLink struct {
	Language string `json:"hreflang"`
	URL      string `json:"href"`
}

type SchemaMicrodata struct {
	Type       string            `json:"type,omitempty"`
	Properties map[string]string `json:"properties,omitempty"`
}

type Redirect struct {
	FromURL    string `json:"from_url,omitempty"`
	URL        string `json:"url"`
	StatusCode int    `json:"status_code,omitempty"`
}

type Page struct {
	URL                string            `json:"url"`
	FinalURL           string            `json:"final_url"`
	StatusCode         int               `json:"status_code"`
	ContentType        string            `json:"content_type,omitempty"`
	Title              string            `json:"title,omitempty"`
	Description        string            `json:"description,omitempty"`
	Canonical          string            `json:"canonical,omitempty"`
	Language           string            `json:"language,omitempty"`
	Charset            string            `json:"charset,omitempty"`
	H1                 []string          `json:"h1,omitempty"`
	H2                 []string          `json:"h2,omitempty"`
	H3                 []string          `json:"h3,omitempty"`
	Headings           []string          `json:"headings,omitempty"`
	MetaTags           map[string]string `json:"meta_tags,omitempty"`
	Viewport           string            `json:"viewport,omitempty"`
	Robots             string            `json:"robots,omitempty"`
	Author             string            `json:"author,omitempty"`
	Keywords           string            `json:"keywords,omitempty"`
	Generator          string            `json:"generator,omitempty"`
	ThemeColor         string            `json:"theme_color,omitempty"`
	FaviconURL         string            `json:"favicon_url,omitempty"`
	FaviconContentType string            `json:"-"`
	FaviconBody        []byte            `json:"-"`
	ManifestURL        string            `json:"manifest_url,omitempty"`
	LogoURL            string            `json:"logo_url,omitempty"`
	Links              []Link            `json:"links,omitempty"`
	InternalLinkCount  int               `json:"internal_links,omitempty"`
	ExternalLinkCount  int               `json:"external_links,omitempty"`
	Images             []SEOImage        `json:"images,omitempty"`
	BrokenImages       []BrokenImage     `json:"broken_images,omitempty"`
	Hreflang           []HreflangLink    `json:"hreflang,omitempty"`
	OpenGraph          map[string]string `json:"open_graph,omitempty"`
	TwitterTags        map[string]string `json:"twitter_tags,omitempty"`
	StructuredData     []json.RawMessage `json:"structured_data,omitempty"`
	SchemaMicrodata    []SchemaMicrodata `json:"schema_microdata,omitempty"`
	Analytics          map[string]any    `json:"analytics,omitempty"`
	LinkedFrom         []string          `json:"linked_from,omitempty"`
	MainText           string            `json:"main_text,omitempty"`
	ContentExcerpt     string            `json:"content_excerpt,omitempty"`
	MainHTML           string            `json:"main_html,omitempty"`
	WordCount          int               `json:"word_count,omitempty"`
	ResponseTimeMS     int               `json:"response_time_ms,omitempty"`
	SizeBytes          int64             `json:"size_bytes,omitempty"`
	Redirects          []Redirect        `json:"redirects,omitempty"`
	Error              string            `json:"error,omitempty"`
	ErrorType          string            `json:"error_type,omitempty"`
	RawHTMLRef         string            `json:"raw_html_ref,omitempty"`
	MainHTMLRef        string            `json:"main_html_ref,omitempty"`
	MainTextRef        string            `json:"main_text_ref,omitempty"`
	Rendered           bool              `json:"rendered"`
	Score              int               `json:"score,omitempty"`
	Depth              int               `json:"depth,omitempty"`
	DiscoveredFrom     string            `json:"discovered_from,omitempty"`
	FetchedAt          time.Time         `json:"fetched_at"`
}

type BacklinkResult struct {
	URL        string    `json:"url"`
	FinalURL   string    `json:"final_url,omitempty"`
	StatusCode int       `json:"status_code,omitempty"`
	FoundLinks []Link    `json:"found_links,omitempty"`
	Error      string    `json:"error,omitempty"`
	CheckedAt  time.Time `json:"checked_at"`
}

type Issue struct {
	Type       string  `json:"type"`
	Category   string  `json:"category"`
	Code       string  `json:"code"`
	Issue      string  `json:"issue"`
	Details    string  `json:"details"`
	URL        string  `json:"url"`
	RelatedURL string  `json:"related_url,omitempty"`
	Similarity float64 `json:"similarity,omitempty"`
}

type PageSpeedResult struct {
	URL                string         `json:"url"`
	Strategy           string         `json:"strategy"`
	PerformanceScore   *int           `json:"performance_score,omitempty"`
	AccessibilityScore *int           `json:"accessibility_score,omitempty"`
	BestPracticesScore *int           `json:"best_practices_score,omitempty"`
	SEOScore           *int           `json:"seo_score,omitempty"`
	Metrics            map[string]any `json:"metrics,omitempty"`
	Error              string         `json:"error,omitempty"`
	AnalyzedAt         time.Time      `json:"analyzed_at"`
}

type ExternalResource struct {
	URL         string    `json:"url"`
	FinalURL    string    `json:"final_url,omitempty"`
	StatusCode  int       `json:"status_code,omitempty"`
	ContentType string    `json:"content_type,omitempty"`
	SizeBytes   int64     `json:"size_bytes,omitempty"`
	Title       string    `json:"title,omitempty"`
	Error       string    `json:"error,omitempty"`
	ErrorType   string    `json:"error_type,omitempty"`
	CheckedAt   time.Time `json:"checked_at"`
}

type Result struct {
	TaskType                TaskType           `json:"task_type"`
	RunID                   string             `json:"run_id"`
	CompletionStatus        CompletionStatus   `json:"completion_status"`
	CompletionNote          string             `json:"completion_note,omitempty"`
	Pages                   []Page             `json:"pages,omitempty"`
	Issues                  []Issue            `json:"issues,omitempty"`
	ExternalResources       []ExternalResource `json:"external_resources,omitempty"`
	PageSpeed               []PageSpeedResult  `json:"pagespeed,omitempty"`
	ResourceChecksTruncated bool               `json:"resource_checks_truncated,omitempty"`
	Backlinks               []BacklinkResult   `json:"backlinks,omitempty"`
	SiteProfile             *SiteProfile       `json:"site_profile,omitempty"`
	StartedAt               time.Time          `json:"started_at"`
	FinishedAt              time.Time          `json:"finished_at"`
}

type CandidateState struct {
	URL             string  `json:"url"`
	Depth           int     `json:"depth"`
	DiscoveredFrom  string  `json:"discovered_from,omitempty"`
	AnchorText      string  `json:"anchor_text,omitempty"`
	Placement       string  `json:"placement,omitempty"`
	InNavigation    bool    `json:"in_navigation,omitempty"`
	FromSitemap     bool    `json:"from_sitemap,omitempty"`
	SitemapPriority float64 `json:"sitemap_priority,omitempty"`
	LocalePriority  int     `json:"locale_priority,omitempty"`
	Score           int     `json:"score,omitempty"`
}

type CrawlCheckpoint struct {
	Candidates        []CandidateState   `json:"candidates"`
	Processed         []string           `json:"processed"`
	Pages             []Page             `json:"pages"`
	Issues            []Issue            `json:"issues,omitempty"`
	ExternalResources []ExternalResource `json:"external_resources,omitempty"`
	Attempted         int                `json:"attempted"`
	ImageStatus       map[string]int     `json:"image_status,omitempty"`
	RejectedLanguages []string           `json:"rejected_languages,omitempty"`
}

type Resource struct {
	URL            string
	FinalURL       string
	StatusCode     int
	ContentType    string
	Header         map[string][]string
	Body           []byte
	Rendered       bool
	ProxyURL       string
	ResponseTimeMS int
	SizeBytes      int64
	Redirects      []Redirect
	Error          string
	ErrorType      string
	FetchedAt      time.Time
}

func parsedURL(raw string) (*url.URL, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, errors.New("URL is empty")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("parse URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, errors.New("URL hostname is empty")
	}
	return u, nil
}
