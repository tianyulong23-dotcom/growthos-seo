package crawler

import (
	"context"
	"testing"
	"time"
)

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
}

func TestLoadConfigUsesLibreCrawlConcurrencyAndBrowserWaitDefaults(t *testing.T) {
	t.Setenv("CRAWLER_HTTP_CONCURRENCY", "")
	t.Setenv("CRAWLER_BROWSER_CONCURRENCY", "")
	t.Setenv("CRAWLER_BROWSER_WAIT", "")

	config := LoadConfig()

	if config.HTTPConcurrency != 5 {
		t.Fatalf("HTTP concurrency = %d, want 5", config.HTTPConcurrency)
	}
	if config.BrowserConcurrency != 3 {
		t.Fatalf("browser concurrency = %d, want 3", config.BrowserConcurrency)
	}
	if config.BrowserWait != 3*time.Second {
		t.Fatalf("browser wait = %s, want 3s", config.BrowserWait)
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
