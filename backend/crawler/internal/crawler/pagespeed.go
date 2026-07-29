package crawler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type PageSpeedAnalyzer interface {
	Analyze(context.Context, []Page) []PageSpeedResult
}

type GooglePageSpeedAnalyzer struct {
	endpoint string
	apiKey   string
	client   *http.Client
	retries  int
}

func NewGooglePageSpeedAnalyzer(config Config) *GooglePageSpeedAnalyzer {
	endpoint := strings.TrimSpace(config.PageSpeedAPIURL)
	if endpoint == "" {
		endpoint = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
	}
	timeout := config.RequestTimeout
	if timeout < 60*time.Second {
		timeout = 60 * time.Second
	}
	return &GooglePageSpeedAnalyzer{
		endpoint: endpoint,
		apiKey:   config.PageSpeedAPIKey,
		client:   &http.Client{Timeout: timeout},
		retries:  3,
	}
}

func (a *GooglePageSpeedAnalyzer) Analyze(
	ctx context.Context,
	pages []Page,
) []PageSpeedResult {
	selected := selectPagesForPageSpeed(pages)
	results := make([]PageSpeedResult, 0, len(selected)*2)
	for _, pageURL := range selected {
		for _, strategy := range []string{"mobile", "desktop"} {
			if ctx.Err() != nil {
				return results
			}
			results = append(results, a.analyzePage(ctx, pageURL, strategy))
		}
	}
	return results
}

func (a *GooglePageSpeedAnalyzer) analyzePage(
	ctx context.Context,
	pageURL string,
	strategy string,
) PageSpeedResult {
	result := PageSpeedResult{
		URL:        pageURL,
		Strategy:   strategy,
		Metrics:    map[string]any{},
		AnalyzedAt: time.Now().UTC(),
	}
	for attempt := 0; attempt <= a.retries; attempt++ {
		requestURL, err := url.Parse(a.endpoint)
		if err != nil {
			result.Error = fmt.Sprintf("invalid PageSpeed API URL: %v", err)
			return result
		}
		query := requestURL.Query()
		query.Set("url", pageURL)
		query.Set("strategy", strategy)
		for _, category := range []string{
			"performance",
			"accessibility",
			"best-practices",
			"seo",
		} {
			query.Add("category", category)
		}
		if a.apiKey != "" {
			query.Set("key", a.apiKey)
		}
		requestURL.RawQuery = query.Encode()

		request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		response, err := a.client.Do(request)
		if err != nil {
			if attempt < a.retries && ctx.Err() == nil {
				if !waitForRetry(ctx, 3*time.Second) {
					return result
				}
				continue
			}
			result.Error = fmt.Sprintf("network error: %v", err)
			return result
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
		response.Body.Close()
		if readErr != nil {
			result.Error = fmt.Sprintf("read PageSpeed response: %v", readErr)
			return result
		}
		if response.StatusCode == http.StatusOK {
			if err := decodePageSpeedResponse(body, &result); err != nil {
				result.Error = err.Error()
			}
			return result
		}
		if response.StatusCode == http.StatusTooManyRequests && attempt < a.retries {
			delay := time.Duration(math.Pow(2, float64(attempt))*float64(time.Second)) +
				time.Duration(rand.IntN(1000))*time.Millisecond
			if !waitForRetry(ctx, delay) {
				return result
			}
			continue
		}
		result.Error = fmt.Sprintf("API returned status %d", response.StatusCode)
		return result
	}
	return result
}

func selectPagesForPageSpeed(pages []Page) []string {
	homepage := ""
	shortestPath := int(^uint(0) >> 1)
	for _, page := range pages {
		if page.StatusCode != http.StatusOK {
			continue
		}
		pageURL := defaultString(page.FinalURL, page.URL)
		parsed, err := url.Parse(pageURL)
		if err != nil {
			continue
		}
		path := strings.Trim(parsed.Path, "/")
		if path == "" {
			homepage = pageURL
			break
		}
		if len(path) < shortestPath {
			homepage = pageURL
			shortestPath = len(path)
		}
	}

	selected := make([]string, 0, 3)
	if homepage != "" {
		selected = append(selected, homepage)
	}
	for _, page := range pages {
		if len(selected) >= 3 || page.StatusCode != http.StatusOK {
			continue
		}
		pageURL := defaultString(page.FinalURL, page.URL)
		if pageURL == homepage {
			continue
		}
		parsed, err := url.Parse(pageURL)
		if err != nil {
			continue
		}
		path := strings.Trim(parsed.Path, "/")
		if path == "" || strings.Contains(path, "/") {
			continue
		}
		if !containsString(selected, pageURL) {
			selected = append(selected, pageURL)
		}
	}
	return selected
}

func decodePageSpeedResponse(body []byte, result *PageSpeedResult) error {
	var payload struct {
		LighthouseResult struct {
			Categories map[string]struct {
				Score *float64 `json:"score"`
			} `json:"categories"`
			Audits map[string]struct {
				NumericValue *float64 `json:"numericValue"`
			} `json:"audits"`
		} `json:"lighthouseResult"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("decode PageSpeed response: %w", err)
	}
	result.PerformanceScore = categoryScore(payload.LighthouseResult.Categories, "performance")
	result.AccessibilityScore = categoryScore(payload.LighthouseResult.Categories, "accessibility")
	result.BestPracticesScore = categoryScore(payload.LighthouseResult.Categories, "best-practices")
	result.SEOScore = categoryScore(payload.LighthouseResult.Categories, "seo")
	result.Metrics = map[string]any{}
	addSecondsMetric(result.Metrics, payload.LighthouseResult.Audits, "first_contentful_paint", "first-contentful-paint")
	addSecondsMetric(result.Metrics, payload.LighthouseResult.Audits, "largest_contentful_paint", "largest-contentful-paint")
	addRoundedMetric(result.Metrics, payload.LighthouseResult.Audits, "cumulative_layout_shift", "cumulative-layout-shift", 3, 1)
	addRoundedMetric(result.Metrics, payload.LighthouseResult.Audits, "first_input_delay", "max-potential-fid", 2, 1)
	addSecondsMetric(result.Metrics, payload.LighthouseResult.Audits, "speed_index", "speed-index")
	addSecondsMetric(result.Metrics, payload.LighthouseResult.Audits, "time_to_interactive", "interactive")
	return nil
}

func categoryScore(
	categories map[string]struct {
		Score *float64 `json:"score"`
	},
	name string,
) *int {
	category, exists := categories[name]
	if !exists || category.Score == nil {
		return nil
	}
	value := int(math.Round(*category.Score * 100))
	return &value
}

func addSecondsMetric(
	metrics map[string]any,
	audits map[string]struct {
		NumericValue *float64 `json:"numericValue"`
	},
	name string,
	auditName string,
) {
	addRoundedMetric(metrics, audits, name, auditName, 2, 1000)
}

func addRoundedMetric(
	metrics map[string]any,
	audits map[string]struct {
		NumericValue *float64 `json:"numericValue"`
	},
	name string,
	auditName string,
	places int,
	divisor float64,
) {
	audit, exists := audits[auditName]
	if !exists || audit.NumericValue == nil {
		return
	}
	scale := math.Pow(10, float64(places))
	metrics[name] = math.Round((*audit.NumericValue/divisor)*scale) / scale
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
