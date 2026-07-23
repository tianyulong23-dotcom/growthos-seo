package crawler

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestProductionStorageIntegration(t *testing.T) {
	if os.Getenv("CRAWLER_STORAGE_INTEGRATION") != "1" {
		t.Skip("set CRAWLER_STORAGE_INTEGRATION=1 to test PostgreSQL and S3")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, err := NewProductionStore(ctx, LoadConfig())
	if err != nil {
		t.Fatalf("NewProductionStore() returned an error: %v", err)
	}
	defer store.Close()

	suffix := time.Now().UTC().UnixNano()
	task := Task{
		OrganizationID: "integration",
		ProjectID:      fmt.Sprintf("storage-%d", suffix),
		RunID:          fmt.Sprintf("storage-integration-%d", suffix),
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	}
	repository, ok := store.repository.(*PostgresCrawlRepository)
	if !ok {
		t.Fatal("production store did not use PostgreSQL")
	}
	if _, err := repository.pool.Exec(
		ctx,
		`
		INSERT INTO projects (
			id, organization_id, name, domain, country, language
		)
		VALUES ($1, $2, $3, $4, $5, $6)
		`,
		task.ProjectID,
		task.OrganizationID,
		"Storage integration",
		fmt.Sprintf("storage-%d.example.com", suffix),
		task.Country,
		task.Language,
	); err != nil {
		t.Fatalf("create integration project: %v", err)
	}

	now := time.Now().UTC()
	if err := store.SaveProgress(ctx, task, Progress{
		Stage:      StageExtracting,
		Message:    "testing storage",
		Processed:  1,
		Selected:   1,
		OccurredAt: now,
	}); err != nil {
		t.Fatalf("SaveProgress() returned an error: %v", err)
	}

	page, err := store.ProcessPage(
		ctx,
		task,
		Page{
			URL:        "https://example.com/",
			FinalURL:   "https://example.com/",
			StatusCode: 200,
			Title:      "Example",
			MainHTML:   "<main>Example</main>",
			MainText:   "Example",
			FetchedAt:  now,
		},
		Resource{
			ContentType: "text/html; charset=utf-8",
			Body:        []byte("<html><main>Example</main></html>"),
		},
	)
	if err != nil {
		t.Fatalf("ProcessPage() returned an error: %v", err)
	}
	stored, err := store.SaveResult(ctx, task, Result{
		TaskType:   task.Type,
		RunID:      task.RunID,
		Pages:      []Page{page},
		StartedAt:  now,
		FinishedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("SaveResult() returned an error: %v", err)
	}
	if stored.PageCount != 1 || stored.ResultRef == "" {
		t.Fatalf("stored result = %#v", stored)
	}
}
