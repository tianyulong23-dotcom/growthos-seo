package crawler

import (
	"context"
	"testing"
	"time"
)

func TestLoadConfigReadsBrowserCacheDir(t *testing.T) {
	t.Setenv("CRAWLER_BROWSER_CACHE_DIR", `C:\crawler\browser-cache`)

	config := LoadConfig()

	if config.BrowserCacheDir != `C:\crawler\browser-cache` {
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

func TestLoadConfigUsesVersionedQueueAndStaticFirstDefaults(t *testing.T) {
	t.Setenv("CRAWLER_TASK_QUEUE", "")
	t.Setenv("CRAWLER_BROWSER_ENABLED", "")

	config := LoadConfig()

	if config.TaskQueue != "growthos.crawling.v1" {
		t.Fatalf("task queue = %q", config.TaskQueue)
	}
	if config.BrowserEnabled {
		t.Fatal("browser fallback must be disabled by default")
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
		BrowserExecutable: `C:\browser\chrome.exe`,
	}

	if err := PrepareBrowser(context.Background(), &config); err != nil {
		t.Fatalf("prepare browser: %v", err)
	}
	if config.BrowserExecutable != `C:\browser\chrome.exe` {
		t.Fatalf("unexpected browser executable: %q", config.BrowserExecutable)
	}
}

func TestPrepareBrowserSkipsDisabledBrowser(t *testing.T) {
	config := Config{
		BrowserCacheDir: `C:\browser-cache`,
	}

	if err := PrepareBrowser(context.Background(), &config); err != nil {
		t.Fatalf("prepare browser: %v", err)
	}
	if config.BrowserExecutable != "" {
		t.Fatalf("unexpected browser executable: %q", config.BrowserExecutable)
	}
}
