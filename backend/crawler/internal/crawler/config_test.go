package crawler

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigUsesMobileCrawlerUserAgent(t *testing.T) {
	t.Setenv("CRAWLER_USER_AGENT", "")
	t.Setenv("CRAWLER_ROBOTS_USER_AGENT", "")

	config := LoadConfig()

	if !strings.Contains(config.UserAgent, "Mobile") ||
		!strings.Contains(config.UserAgent, "SEOPlatformBot/1.0") {
		t.Fatalf("crawler user agent is not mobile: %q", config.UserAgent)
	}
	if config.RobotsUserAgent != "SEOPlatformBot" {
		t.Fatalf("robots user agent = %q, want SEOPlatformBot", config.RobotsUserAgent)
	}
}

func TestLoadConfigReadsBrowserCacheDir(t *testing.T) {
	t.Setenv("CRAWLER_BROWSER_CACHE_DIR", `E:\seo-v4\storage\runtime\browser`)

	config := LoadConfig()

	if config.BrowserCacheDir != `E:\seo-v4\storage\runtime\browser` {
		t.Fatalf("unexpected browser cache dir: %q", config.BrowserCacheDir)
	}
}

func TestLoadConfigReadsWorkerIdleTimeout(t *testing.T) {
	t.Setenv("CRAWLER_WORKER_IDLE_TIMEOUT", "2m")

	config := LoadConfig()

	if config.WorkerIdleTimeout != 2*time.Minute {
		t.Fatalf("unexpected worker idle timeout: %s", config.WorkerIdleTimeout)
	}
}

func TestLoadConfigReadsBusinessProfileAISettings(t *testing.T) {
	t.Setenv("BUSINESS_PROFILE_AI_BASE_URL", "https://models.example.test/v1")
	t.Setenv("BUSINESS_PROFILE_AI_API_KEY", "test-key")
	t.Setenv("BUSINESS_PROFILE_AI_MODEL", "test-model")
	t.Setenv("BUSINESS_PROFILE_AI_TIMEOUT", "12s")
	t.Setenv("BUSINESS_PROFILE_AI_MAX_RETRIES", "2")
	t.Setenv("AI_SETTINGS_ENCRYPTION_KEY", "encryption-key")

	config := LoadConfig()

	if config.BusinessProfileAIBaseURL != "https://models.example.test/v1" {
		t.Fatalf("AI base URL = %q", config.BusinessProfileAIBaseURL)
	}
	if config.BusinessProfileAIAPIKey != "test-key" {
		t.Fatalf("AI API key = %q", config.BusinessProfileAIAPIKey)
	}
	if config.BusinessProfileAIModel != "test-model" {
		t.Fatalf("AI model = %q", config.BusinessProfileAIModel)
	}
	if config.BusinessProfileAITimeout != 12*time.Second {
		t.Fatalf("AI timeout = %s", config.BusinessProfileAITimeout)
	}
	if config.BusinessProfileAIMaxRetries != 2 {
		t.Fatalf("AI max retries = %d", config.BusinessProfileAIMaxRetries)
	}
	if config.AISettingsEncryptionKey != "encryption-key" {
		t.Fatalf("AI settings encryption key was not loaded")
	}
}

func TestLoadConfigAllowsDisablingBusinessProfileAIRetries(t *testing.T) {
	t.Setenv("BUSINESS_PROFILE_AI_MAX_RETRIES", "0")

	config := LoadConfig()

	if config.BusinessProfileAIMaxRetries != 0 {
		t.Fatalf("AI max retries = %d, want 0", config.BusinessProfileAIMaxRetries)
	}
}

func TestLoadConfigUsesLibreCrawlConcurrencyAndBrowserWaitDefaults(t *testing.T) {
	t.Setenv("CRAWLER_HTTP_CONCURRENCY", "")
	t.Setenv("CRAWLER_STATUS_CONCURRENCY", "")
	t.Setenv("CRAWLER_BROWSER_CONCURRENCY", "")
	t.Setenv("CRAWLER_BROWSER_WAIT", "")
	t.Setenv("CRAWLER_REQUEST_DELAY", "")
	t.Setenv("CRAWLER_RANDOM_DELAY", "")
	t.Setenv("CRAWLER_STATUS_REQUEST_DELAY", "")
	t.Setenv("CRAWLER_STATUS_RANDOM_DELAY", "")
	t.Setenv("CRAWLER_RESOURCE_CHECK_LIMIT", "")

	config := LoadConfig()

	if config.HTTPConcurrency != 5 {
		t.Fatalf("HTTP concurrency = %d, want 5", config.HTTPConcurrency)
	}
	if config.StatusConcurrency != 5 {
		t.Fatalf("status concurrency = %d, want 5", config.StatusConcurrency)
	}
	if config.BrowserConcurrency != 3 {
		t.Fatalf("browser concurrency = %d, want 3", config.BrowserConcurrency)
	}
	if config.BrowserWait != 3*time.Second {
		t.Fatalf("browser wait = %s, want 3s", config.BrowserWait)
	}
	if config.RequestDelay != 250*time.Millisecond ||
		config.RandomDelay != 150*time.Millisecond {
		t.Fatalf(
			"request delays = %s + %s, want 250ms + 150ms",
			config.RequestDelay,
			config.RandomDelay,
		)
	}
	if config.StatusRequestDelay != 50*time.Millisecond ||
		config.StatusRandomDelay != 50*time.Millisecond {
		t.Fatalf(
			"status delays = %s + %s, want 50ms + 50ms",
			config.StatusRequestDelay,
			config.StatusRandomDelay,
		)
	}
	if config.ResourceCheckLimit != 50_000 {
		t.Fatalf("resource check limit = %d, want 50000", config.ResourceCheckLimit)
	}
}

func TestLoadConfigBoundsCrawlerConcurrency(t *testing.T) {
	t.Setenv("CRAWLER_HTTP_CONCURRENCY", "500")
	t.Setenv("CRAWLER_STATUS_CONCURRENCY", "0")
	t.Setenv("CRAWLER_BROWSER_CONCURRENCY", "20")

	config := LoadConfig()

	if config.HTTPConcurrency != 50 {
		t.Fatalf("HTTP concurrency = %d, want 50", config.HTTPConcurrency)
	}
	if config.StatusConcurrency != 5 {
		t.Fatalf("status concurrency = %d, want fallback 5", config.StatusConcurrency)
	}
	if config.BrowserConcurrency != 10 {
		t.Fatalf("browser concurrency = %d, want 10", config.BrowserConcurrency)
	}
}

func TestPrepareBrowserKeepsConfiguredExecutable(t *testing.T) {
	config := Config{
		BrowserEnabled:    true,
		BrowserExecutable: `E:\browser\chrome.exe`,
	}

	if err := PrepareBrowser(context.Background(), &config); err != nil {
		t.Fatalf("prepare browser: %v", err)
	}
	if config.BrowserExecutable != `E:\browser\chrome.exe` {
		t.Fatalf("unexpected browser executable: %q", config.BrowserExecutable)
	}
}

func TestPrepareBrowserSkipsDisabledBrowser(t *testing.T) {
	config := Config{
		BrowserCacheDir: `E:\browser-cache`,
	}

	if err := PrepareBrowser(context.Background(), &config); err != nil {
		t.Fatalf("prepare browser: %v", err)
	}
	if config.BrowserExecutable != "" {
		t.Fatalf("unexpected browser executable: %q", config.BrowserExecutable)
	}
}
