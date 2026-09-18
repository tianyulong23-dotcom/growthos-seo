package crawler

import (
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultCrawlerUserAgent = "Mozilla/5.0 (Linux; Android 10; K) " +
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 " +
	"Mobile Safari/537.36 SEOPlatformBot/1.0"

const defaultRobotsUserAgent = "SEOPlatformBot"

type Config struct {
	TemporalAddress                  string
	TemporalNamespace                string
	TaskQueue                        string
	WorkerIdleTimeout                time.Duration
	UserAgent                        string
	RobotsUserAgent                  string
	RequestTimeout                   time.Duration
	SiteUnderstandingRequestTimeout  time.Duration
	BrowserTimeout                   time.Duration
	RequestDelay                     time.Duration
	RandomDelay                      time.Duration
	StatusRequestDelay               time.Duration
	StatusRandomDelay                time.Duration
	HTTPConcurrency                  int
	StatusConcurrency                int
	BrowserConcurrency               int
	BrowserWait                      time.Duration
	MaxBodyBytes                     int
	MaxRetries                       int
	ResourceCheckLimit               int
	SiteUnderstandingMaxRetries      int
	DiscoveryLimit                   int
	BrowserEnabled                   bool
	BrowserExecutable                string
	BrowserCacheDir                  string
	PrimaryProxyURL                  string
	FallbackProxyURL                 string
	DatabaseURL                      string
	S3EndpointURL                    string
	S3Region                         string
	S3Bucket                         string
	S3AccessKeyID                    string
	S3SecretAccessKey                string
	S3UsePathStyle                   bool
	S3CreateBucket                   bool
	PageSpeedAPIURL                  string
	PageSpeedAPIKey                  string
	BusinessProfileAIBaseURL         string
	BusinessProfileAIAPIKey          string
	BusinessProfileAIModel           string
	BusinessProfileAIProvider        string
	BusinessProfileAIReasoningEffort string
	BusinessProfileAITimeout         time.Duration
	BusinessProfileAIMaxRetries      int
	AISettingsEncryptionKey          string
	ProbeListenAddress               string
}

func LoadConfig() Config {
	return Config{
		TemporalAddress:   envString("TEMPORAL_ADDRESS", "localhost:7233"),
		TemporalNamespace: envString("TEMPORAL_NAMESPACE", "default"),
		TaskQueue:         envString("CRAWLER_TASK_QUEUE", "crawler-go"),
		WorkerIdleTimeout: envDuration("CRAWLER_WORKER_IDLE_TIMEOUT", 0),
		UserAgent:         envString("CRAWLER_USER_AGENT", defaultCrawlerUserAgent),
		RobotsUserAgent:   envString("CRAWLER_ROBOTS_USER_AGENT", defaultRobotsUserAgent),
		RequestTimeout:    envDuration("CRAWLER_REQUEST_TIMEOUT", 30*time.Second),
		SiteUnderstandingRequestTimeout: envDuration(
			"SITE_UNDERSTANDING_REQUEST_TIMEOUT",
			12*time.Second,
		),
		BrowserTimeout:     envDuration("CRAWLER_BROWSER_TIMEOUT", 45*time.Second),
		RequestDelay:       envDuration("CRAWLER_REQUEST_DELAY", 250*time.Millisecond),
		RandomDelay:        envDuration("CRAWLER_RANDOM_DELAY", 150*time.Millisecond),
		StatusRequestDelay: envDuration("CRAWLER_STATUS_REQUEST_DELAY", 50*time.Millisecond),
		StatusRandomDelay:  envDuration("CRAWLER_STATUS_RANDOM_DELAY", 50*time.Millisecond),
		HTTPConcurrency: envIntInRange(
			"CRAWLER_HTTP_CONCURRENCY",
			5,
			1,
			50,
		),
		StatusConcurrency: envIntInRange(
			"CRAWLER_STATUS_CONCURRENCY",
			5,
			1,
			50,
		),
		BrowserConcurrency: envIntInRange(
			"CRAWLER_BROWSER_CONCURRENCY",
			3,
			1,
			10,
		),
		BrowserWait:  envDuration("CRAWLER_BROWSER_WAIT", 3*time.Second),
		MaxBodyBytes: envInt("CRAWLER_MAX_BODY_BYTES", 5*1024*1024),
		MaxRetries:   envInt("CRAWLER_MAX_RETRIES", 3),
		ResourceCheckLimit: envIntInRange(
			"CRAWLER_RESOURCE_CHECK_LIMIT",
			50_000,
			1,
			50_000,
		),
		SiteUnderstandingMaxRetries: envInt(
			"SITE_UNDERSTANDING_MAX_RETRIES",
			2,
		),
		DiscoveryLimit:    envInt("CRAWLER_DISCOVERY_LIMIT", 500),
		BrowserEnabled:    envBool("CRAWLER_BROWSER_ENABLED", true),
		BrowserExecutable: os.Getenv("CRAWLER_BROWSER_EXECUTABLE"),
		BrowserCacheDir:   os.Getenv("CRAWLER_BROWSER_CACHE_DIR"),
		PrimaryProxyURL:   os.Getenv("CRAWLER_PROXY_URL"),
		FallbackProxyURL:  os.Getenv("CRAWLER_FALLBACK_PROXY_URL"),
		DatabaseURL:       databaseURL(),
		S3EndpointURL:     os.Getenv("S3_ENDPOINT_URL"),
		S3Region:          envString("S3_REGION", "us-east-1"),
		S3Bucket:          os.Getenv("S3_BUCKET"),
		S3AccessKeyID:     os.Getenv("S3_ACCESS_KEY_ID"),
		S3SecretAccessKey: os.Getenv("S3_SECRET_ACCESS_KEY"),
		S3UsePathStyle:    envBool("S3_USE_PATH_STYLE", false),
		S3CreateBucket:    envBool("S3_CREATE_BUCKET", false),
		PageSpeedAPIURL: envString(
			"PAGESPEED_API_URL",
			"https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
		),
		PageSpeedAPIKey: os.Getenv("GOOGLE_PAGESPEED_API_KEY"),
		BusinessProfileAIBaseURL: strings.TrimRight(
			os.Getenv("BUSINESS_PROFILE_AI_BASE_URL"),
			"/",
		),
		BusinessProfileAIAPIKey: os.Getenv("BUSINESS_PROFILE_AI_API_KEY"),
		BusinessProfileAIModel: envString(
			"BUSINESS_PROFILE_AI_MODEL",
			"gpt-5.5",
		),
		BusinessProfileAIProvider: envString("BUSINESS_PROFILE_AI_PROVIDER", "openai"),
		BusinessProfileAIReasoningEffort: envString(
			"BUSINESS_PROFILE_AI_REASONING_EFFORT",
			"medium",
		),
		BusinessProfileAITimeout: envDuration(
			"BUSINESS_PROFILE_AI_TIMEOUT",
			90*time.Second,
		),
		BusinessProfileAIMaxRetries: envNonNegativeInt(
			"BUSINESS_PROFILE_AI_MAX_RETRIES",
			1,
		),
		AISettingsEncryptionKey: os.Getenv("AI_SETTINGS_ENCRYPTION_KEY"),
		ProbeListenAddress: envString(
			"CRAWLER_PROBE_LISTEN_ADDRESS",
			":8091",
		),
	}
}

func databaseURL() string {
	if value := os.Getenv("CRAWLER_DATABASE_URL"); value != "" {
		return value
	}
	return os.Getenv("DATABASE_URL")
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envIntInRange(name string, fallback, lower, upper int) int {
	return min(max(envInt(name, fallback), lower), upper)
}

func envNonNegativeInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}

func envBool(name string, fallback bool) bool {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
