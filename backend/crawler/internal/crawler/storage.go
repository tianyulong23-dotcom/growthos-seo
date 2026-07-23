package crawler

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type StoredResult struct {
	RunID         string `json:"run_id"`
	ResultRef     string `json:"result_ref"`
	PageCount     int    `json:"page_count"`
	BacklinkCount int    `json:"backlink_count"`
}

type IssueRecalculationResult struct {
	RunID      string         `json:"run_id"`
	IssueCount int            `json:"issue_count"`
	Summary    map[string]int `json:"summary"`
}

type ResultStore interface {
	SaveResult(context.Context, Task, Result) (StoredResult, error)
	SaveProgress(context.Context, Task, Progress) error
}

type IssueRecalculationStore interface {
	RecalculateIssues(context.Context, Task) (IssueRecalculationResult, error)
	FailIssueRecalculation(context.Context, Task, string) error
}

type CheckpointStore interface {
	SaveCheckpoint(context.Context, Task, CrawlCheckpoint) error
	LoadCheckpoint(context.Context, Task) (CrawlCheckpoint, bool, error)
	DeleteCheckpoint(context.Context, Task) error
}

type PageArtifactProcessor interface {
	ProcessPage(context.Context, Task, Page, Resource) (Page, error)
}

type CrawlRepository interface {
	SaveProgress(context.Context, Task, Progress) error
	SaveResult(context.Context, Task, Result, string) error
	SaveCheckpoint(context.Context, Task, CrawlCheckpoint) error
	LoadCheckpoint(context.Context, Task) (CrawlCheckpoint, bool, error)
	DeleteCheckpoint(context.Context, Task) error
	Close()
}

type ObjectStore interface {
	Put(
		context.Context,
		string,
		string,
		string,
		[]byte,
	) (string, error)
}

type ProductionStore struct {
	repository CrawlRepository
	objects    ObjectStore
}

const siteUnderstandingExcerptLimit = 6000

func newProductionStore(repository CrawlRepository, objects ObjectStore) *ProductionStore {
	return &ProductionStore{repository: repository, objects: objects}
}

func (s *ProductionStore) Close() {
	s.repository.Close()
}

func (s *ProductionStore) SaveProgress(
	ctx context.Context,
	task Task,
	progress Progress,
) error {
	return s.repository.SaveProgress(ctx, task, progress)
}

func (s *ProductionStore) SaveCheckpoint(
	ctx context.Context,
	task Task,
	checkpoint CrawlCheckpoint,
) error {
	return s.repository.SaveCheckpoint(ctx, task, checkpoint)
}

func (s *ProductionStore) LoadCheckpoint(
	ctx context.Context,
	task Task,
) (CrawlCheckpoint, bool, error) {
	return s.repository.LoadCheckpoint(ctx, task)
}

func (s *ProductionStore) DeleteCheckpoint(
	ctx context.Context,
	task Task,
) error {
	return s.repository.DeleteCheckpoint(ctx, task)
}

func (s *ProductionStore) ProcessPage(
	ctx context.Context,
	task Task,
	page Page,
	resource Resource,
) (Page, error) {
	baseKey, err := pageArtifactBaseKey(task, page)
	if err != nil {
		return Page{}, err
	}

	if len(resource.Body) > 0 {
		page.RawHTMLRef, err = s.putCompressed(
			ctx,
			baseKey+"/raw.html.gz",
			defaultString(resource.ContentType, "text/html; charset=utf-8"),
			resource.Body,
		)
		if err != nil {
			return Page{}, fmt.Errorf("store raw page: %w", err)
		}
	}
	if page.MainHTML != "" {
		page.MainHTMLRef, err = s.putCompressed(
			ctx,
			baseKey+"/main.html.gz",
			"text/html; charset=utf-8",
			[]byte(page.MainHTML),
		)
		if err != nil {
			return Page{}, fmt.Errorf("store main HTML: %w", err)
		}
	}
	if page.MainText != "" {
		if page.WordCount == 0 {
			page.WordCount = len(strings.Fields(page.MainText))
		}
		if task.Type == TaskSiteUnderstanding && page.ContentExcerpt == "" {
			page.ContentExcerpt = truncateText(
				page.MainText,
				siteUnderstandingExcerptLimit,
			)
		}
		page.MainTextRef, err = s.putCompressed(
			ctx,
			baseKey+"/main.txt.gz",
			"text/plain; charset=utf-8",
			[]byte(page.MainText),
		)
		if err != nil {
			return Page{}, fmt.Errorf("store main text: %w", err)
		}
	}

	page.MainHTML = ""
	page.MainText = ""
	return page, nil
}

func truncateText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit]))
}

func (s *ProductionStore) SaveResult(
	ctx context.Context,
	task Task,
	result Result,
) (StoredResult, error) {
	if task.Type == TaskSiteUnderstanding {
		if err := s.persistSiteIcon(ctx, task, &result); err != nil {
			return StoredResult{}, err
		}
	}
	data, err := json.Marshal(result)
	if err != nil {
		return StoredResult{}, fmt.Errorf("encode crawl result: %w", err)
	}
	key, err := runArtifactKey(task, "result.json")
	if err != nil {
		return StoredResult{}, err
	}
	resultRef, err := s.objects.Put(
		ctx,
		key,
		"application/json",
		"",
		data,
	)
	if err != nil {
		return StoredResult{}, fmt.Errorf("store crawl result: %w", err)
	}
	if err := s.repository.SaveResult(ctx, task, result, resultRef); err != nil {
		return StoredResult{}, fmt.Errorf("save crawl metadata: %w", err)
	}
	return StoredResult{
		RunID:         task.RunID,
		ResultRef:     resultRef,
		PageCount:     len(result.Pages),
		BacklinkCount: len(result.Backlinks),
	}, nil
}

func (s *ProductionStore) persistSiteIcon(
	ctx context.Context,
	task Task,
	result *Result,
) error {
	for index := range result.Pages {
		page := &result.Pages[index]
		if len(page.FaviconBody) == 0 {
			continue
		}
		key, err := runArtifactKey(task, "site-icon")
		if err != nil {
			return err
		}
		if _, err := s.objects.Put(
			ctx,
			key,
			defaultString(page.FaviconContentType, "application/octet-stream"),
			"",
			page.FaviconBody,
		); err != nil {
			return fmt.Errorf("store site icon: %w", err)
		}
		platformURL := fmt.Sprintf(
			"/api/v1/projects/%s/favicon?v=%s",
			url.PathEscape(task.ProjectID),
			url.QueryEscape(task.RunID),
		)
		page.FaviconURL = platformURL
		page.FaviconContentType = ""
		page.FaviconBody = nil
		if result.SiteProfile != nil {
			result.SiteProfile.FaviconURL = platformURL
		}
		return nil
	}
	return nil
}

func (s *ProductionStore) RecalculateIssues(
	ctx context.Context,
	task Task,
) (IssueRecalculationResult, error) {
	store, ok := s.repository.(IssueRecalculationStore)
	if !ok {
		return IssueRecalculationResult{}, errors.New(
			"crawler repository does not support issue recalculation",
		)
	}
	return store.RecalculateIssues(ctx, task)
}

func (s *ProductionStore) FailIssueRecalculation(
	ctx context.Context,
	task Task,
	message string,
) error {
	store, ok := s.repository.(IssueRecalculationStore)
	if !ok {
		return errors.New(
			"crawler repository does not support issue recalculation",
		)
	}
	return store.FailIssueRecalculation(ctx, task, message)
}

func (s *ProductionStore) putCompressed(
	ctx context.Context,
	key string,
	contentType string,
	data []byte,
) (string, error) {
	var output bytes.Buffer
	writer := gzip.NewWriter(&output)
	if _, err := writer.Write(data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	return s.objects.Put(ctx, key, contentType, "gzip", output.Bytes())
}

func pageArtifactBaseKey(task Task, page Page) (string, error) {
	pageURL := defaultString(page.FinalURL, page.URL)
	if strings.TrimSpace(pageURL) == "" {
		return "", errors.New("page URL is required for artifact storage")
	}
	sum := sha256.Sum256([]byte(normalizeStoredURL(pageURL)))
	hash := hex.EncodeToString(sum[:])
	runKey, err := runArtifactKey(task, "pages")
	if err != nil {
		return "", err
	}
	return runKey + "/" + hash, nil
}

func runArtifactKey(task Task, suffix string) (string, error) {
	parts := []string{
		safeStorageValue(task.OrganizationID),
		safeStorageValue(task.ProjectID),
		safeStorageValue(task.RunID),
	}
	for _, part := range parts {
		if part == "" {
			return "", errors.New("task identifiers cannot be empty")
		}
	}
	return strings.Join(
		[]string{"crawler", parts[0], parts[1], parts[2], strings.TrimPrefix(suffix, "/")},
		"/",
	), nil
}

func safeStorageValue(value string) string {
	return url.PathEscape(strings.TrimSpace(value))
}

func defaultString(value string, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
