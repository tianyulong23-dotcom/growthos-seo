package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	probeCandidateLimit = 50
	probeExcerptLimit   = 3000
)

type ProbeCandidate struct {
	Domain string   `json:"domain"`
	URLs   []string `json:"urls"`
}

type ProbeRequest struct {
	Country    string           `json:"country"`
	Language   string           `json:"language"`
	Candidates []ProbeCandidate `json:"candidates"`
}

type ProbeResult struct {
	Domain       string        `json:"domain"`
	RequestedURL string        `json:"requested_url,omitempty"`
	FinalURL     string        `json:"final_url,omitempty"`
	FinalDomain  string        `json:"final_domain,omitempty"`
	Status       string        `json:"status"`
	StatusCode   int           `json:"status_code,omitempty"`
	ContentType  string        `json:"content_type,omitempty"`
	Title        string        `json:"title,omitempty"`
	Description  string        `json:"description,omitempty"`
	H1           []string      `json:"h1,omitempty"`
	TextExcerpt  string        `json:"text_excerpt,omitempty"`
	Canonical    string        `json:"canonical,omitempty"`
	Language     string        `json:"language,omitempty"`
	Rendered     bool          `json:"rendered"`
	Redirects    []Redirect    `json:"redirects,omitempty"`
	Error        string        `json:"error,omitempty"`
	CheckedAt    time.Time     `json:"checked_at"`
	Checks       []ProbeResult `json:"checks,omitempty"`
}

type ProbeResponse struct {
	Results []ProbeResult `json:"results"`
}

type ProbeService struct {
	fetcher     Fetcher
	concurrency int
}

func NewProbeService(config Config) (*ProbeService, func(), error) {
	probeConfig := config
	probeConfig.RequestTimeout = minDuration(config.RequestTimeout, 20*time.Second)
	probeConfig.BrowserTimeout = minDuration(config.BrowserTimeout, 30*time.Second)
	probeConfig.MaxRetries = min(config.MaxRetries, 2)
	probeConfig.MaxBodyBytes = min(config.MaxBodyBytes, 2*1024*1024)
	limiter := NewRequestLimiter(probeConfig.RequestDelay, probeConfig.RandomDelay)
	httpFetcher, err := NewHTTPFetcherWithLimiter(probeConfig, limiter)
	if err != nil {
		return nil, nil, err
	}
	var fetcher Fetcher = httpFetcher
	closeService := func() {}
	if probeConfig.BrowserEnabled {
		browser := NewBrowserFetcherWithLimiter(probeConfig, limiter)
		fetcher = HybridFetcher{
			HTTP:               httpFetcher,
			Browser:            browser,
			Mode:               RenderingAuto,
			HTTPConcurrency:    probeConfig.HTTPConcurrency,
			BrowserConcurrency: probeConfig.BrowserConcurrency,
		}
		closeService = func() { _ = browser.Close() }
	}
	concurrency := positiveOrDefault(probeConfig.HTTPConcurrency, 5)
	if probeConfig.BrowserEnabled {
		concurrency = min(concurrency, positiveOrDefault(probeConfig.BrowserConcurrency, 3))
	}
	return &ProbeService{
		fetcher:     fetcher,
		concurrency: concurrency,
	}, closeService, nil
}

func (s *ProbeService) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet && request.URL.Path == "/health" {
		writeProbeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	if request.Method != http.MethodPost || request.URL.Path != "/v1/probe" {
		http.NotFound(writer, request)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 256*1024)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var payload ProbeRequest
	if err := decoder.Decode(&payload); err != nil {
		writeProbeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(payload.Candidates) == 0 || len(payload.Candidates) > probeCandidateLimit {
		writeProbeJSON(writer, http.StatusBadRequest, map[string]string{
			"error": "candidates must contain between 1 and 50 items",
		})
		return
	}

	ctx := withRequestLocale(request.Context(), payload.Language, payload.Country)
	results := make([]ProbeResult, len(payload.Candidates))
	semaphore := make(chan struct{}, s.concurrency)
	var group sync.WaitGroup
	for index, candidate := range payload.Candidates {
		group.Add(1)
		go func(resultIndex int, value ProbeCandidate) {
			defer group.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				results[resultIndex] = probeErrorResult(value.Domain, "temporarily_unavailable", ctx.Err())
				return
			}
			results[resultIndex] = s.probeCandidate(ctx, value)
		}(index, candidate)
	}
	group.Wait()
	writeProbeJSON(writer, http.StatusOK, ProbeResponse{Results: results})
}

func (s *ProbeService) probeCandidate(ctx context.Context, candidate ProbeCandidate) ProbeResult {
	urls := normalizedProbeURLs(candidate)
	if len(urls) == 0 {
		return probeErrorResult(candidate.Domain, "unsafe_target", errors.New("no valid public URL supplied"))
	}
	checks := make([]ProbeResult, 0, len(urls))
	for _, rawURL := range urls {
		resource, err := s.fetcher.Fetch(ctx, rawURL)
		checks = append(checks, buildProbeResult(candidate.Domain, rawURL, resource, err))
	}
	selected := checks[0]
	if len(checks) > 1 && probeIdentifiesSite(checks[len(checks)-1]) {
		selected = checks[len(checks)-1]
	} else if !probeIdentifiesSite(selected) {
		selected = checks[len(checks)-1]
	}
	selected.Checks = checks
	return selected
}

func normalizedProbeURLs(candidate ProbeCandidate) []string {
	values := append([]string(nil), candidate.URLs...)
	domain := strings.TrimSpace(candidate.Domain)
	if domain != "" {
		values = append(values, "https://"+domain+"/")
	}
	result := make([]string, 0, 2)
	for _, value := range values {
		target, err := parsedURL(value)
		if err != nil {
			continue
		}
		if !probeURLMatchesDomain(target, domain) {
			continue
		}
		normalized := target.String()
		if !slices.Contains(result, normalized) {
			result = append(result, normalized)
		}
		if len(result) == 2 {
			break
		}
	}
	return result
}

func probeURLMatchesDomain(target *url.URL, candidateDomain string) bool {
	domain := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(candidateDomain)), ".")
	host := strings.TrimSuffix(strings.ToLower(target.Hostname()), ".")
	if domain == "" || host == "" {
		return false
	}
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func probeIdentifiesSite(result ProbeResult) bool {
	return result.Status == "ok" || result.Status == "redirected" ||
		result.Status == "platform_or_login"
}

func buildProbeResult(domain, requestedURL string, resource Resource, fetchErr error) ProbeResult {
	contentType := resource.ContentType
	if strings.TrimSpace(contentType) == "" && len(resource.Body) > 0 {
		contentType = http.DetectContentType(resource.Body)
	}
	result := ProbeResult{
		Domain:       domain,
		RequestedURL: requestedURL,
		FinalURL:     resource.FinalURL,
		StatusCode:   resource.StatusCode,
		ContentType:  contentType,
		Rendered:     resource.Rendered,
		Redirects:    append([]Redirect(nil), resource.Redirects...),
		CheckedAt:    time.Now().UTC(),
	}
	if result.FinalURL == "" {
		result.FinalURL = requestedURL
	}
	if finalURL, err := url.Parse(result.FinalURL); err == nil {
		result.FinalDomain = strings.ToLower(finalURL.Hostname())
	}
	result.Status = classifyProbeFetch(resource, fetchErr)
	if fetchErr != nil {
		result.Error = fetchErr.Error()
	}
	resource.ContentType = contentType
	if strings.Contains(strings.ToLower(contentType), "html") && len(resource.Body) > 0 {
		if page, err := (Parser{}).Parse(resource, 0, "competitor_probe"); err == nil {
			result.Title = page.Title
			result.Description = page.Description
			result.H1 = append([]string(nil), page.H1...)
			result.TextExcerpt = truncateProbeText(page.MainText, probeExcerptLimit)
			result.Canonical = page.Canonical
			result.Language = page.Language
			if result.Status == "ok" || result.Status == "redirected" {
				result.Status = classifyProbePage(result)
			}
		}
	}
	return result
}

func classifyProbeFetch(resource Resource, fetchErr error) string {
	errorText := strings.ToLower(errorString(fetchErr))
	if strings.Contains(errorText, "blocked resolved address") ||
		strings.Contains(errorText, "blocked browser request") ||
		strings.Contains(errorText, "unsupported url scheme") {
		return "unsafe_target"
	}
	if strings.Contains(errorText, "too many redirects") {
		return "redirect_loop"
	}
	if strings.Contains(errorText, "no such host") ||
		strings.Contains(errorText, "hostname has no ip addresses") {
		return "permanently_unavailable"
	}
	if resource.StatusCode == http.StatusNotFound || resource.StatusCode == http.StatusGone {
		return "permanently_unavailable"
	}
	if resource.StatusCode == http.StatusUnauthorized || resource.StatusCode == http.StatusForbidden ||
		resource.StatusCode == http.StatusTooManyRequests {
		return "blocked"
	}
	if resource.StatusCode >= 500 || fetchErr != nil {
		return "temporarily_unavailable"
	}
	if !strings.Contains(strings.ToLower(resource.ContentType), "html") {
		return "non_html"
	}
	if len(resource.Redirects) > 0 || (resource.FinalURL != "" && resource.FinalURL != resource.URL) {
		return "redirected"
	}
	return "ok"
}

func classifyProbePage(result ProbeResult) string {
	content := strings.ToLower(strings.Join([]string{
		result.Title,
		result.Description,
		strings.Join(result.H1, " "),
		result.TextExcerpt,
	}, " "))
	soft404 := []string{"page not found", "404 not found", "page doesn't exist", "页面不存在", "找不到页面"}
	parked := []string{"domain is for sale", "buy this domain", "domain parking", "sedo domain parking"}
	blocked := []string{"captcha", "verify you are human", "access denied", "cf-chl-"}
	platformHosts := []string{
		"apps.apple.com", "play.google.com", "facebook.com", "instagram.com",
		"linkedin.com", "tiktok.com", "youtube.com", "x.com", "twitter.com",
	}
	for _, marker := range blocked {
		if strings.Contains(content, marker) {
			return "blocked"
		}
	}
	for _, marker := range append(soft404, parked...) {
		if strings.Contains(content, marker) {
			return "permanently_unavailable"
		}
	}
	finalURL, _ := url.Parse(result.FinalURL)
	for _, host := range platformHosts {
		if finalURL != nil && (finalURL.Hostname() == host || strings.HasSuffix(finalURL.Hostname(), "."+host)) {
			return "platform_or_login"
		}
	}
	if finalURL != nil && strings.Contains(strings.ToLower(finalURL.Path), "login") &&
		(strings.Contains(content, "sign in") || strings.Contains(content, "log in")) {
		return "platform_or_login"
	}
	return result.Status
}

func probeErrorResult(domain, status string, err error) ProbeResult {
	return ProbeResult{
		Domain:    domain,
		Status:    status,
		Error:     errorString(err),
		CheckedAt: time.Now().UTC(),
	}
}

func truncateProbeText(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit])
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func minDuration(left, right time.Duration) time.Duration {
	if left <= 0 {
		return right
	}
	return min(left, right)
}

func writeProbeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
