package crawler

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

type fakeCrawlRepository struct {
	progress      Progress
	result        Result
	ref           string
	checkpoint    CrawlCheckpoint
	hasCheckpoint bool
}

func (r *fakeCrawlRepository) SaveProgress(
	_ context.Context,
	_ Task,
	progress Progress,
) error {
	r.progress = progress
	return nil
}

func (r *fakeCrawlRepository) SaveResult(
	_ context.Context,
	_ Task,
	result Result,
	ref string,
) error {
	r.result = result
	r.ref = ref
	return nil
}

func (r *fakeCrawlRepository) SaveCheckpoint(
	_ context.Context,
	_ Task,
	checkpoint CrawlCheckpoint,
) error {
	r.checkpoint = checkpoint
	r.hasCheckpoint = true
	return nil
}

func (r *fakeCrawlRepository) LoadCheckpoint(
	_ context.Context,
	_ Task,
) (CrawlCheckpoint, bool, error) {
	return r.checkpoint, r.hasCheckpoint, nil
}

func (r *fakeCrawlRepository) DeleteCheckpoint(
	_ context.Context,
	_ Task,
) error {
	r.checkpoint = CrawlCheckpoint{}
	r.hasCheckpoint = false
	return nil
}

func (*fakeCrawlRepository) Close() {}

type storedObject struct {
	contentType     string
	contentEncoding string
	body            []byte
}

type fakeObjectStore struct {
	objects map[string]storedObject
}

func (s *fakeObjectStore) Put(
	_ context.Context,
	key string,
	contentType string,
	contentEncoding string,
	body []byte,
) (string, error) {
	if s.objects == nil {
		s.objects = make(map[string]storedObject)
	}
	s.objects[key] = storedObject{
		contentType:     contentType,
		contentEncoding: contentEncoding,
		body:            append([]byte(nil), body...),
	}
	return "s3://seo-crawler/" + key, nil
}

func TestProductionStoreUploadsPageArtifacts(t *testing.T) {
	objects := &fakeObjectStore{}
	store := newProductionStore(&fakeCrawlRepository{}, objects)
	task := Task{OrganizationID: "org", ProjectID: "project", RunID: "run"}
	page := Page{
		URL:      "https://example.com/about",
		FinalURL: "https://example.com/about",
		MainHTML: "<main>About</main>",
		MainText: "About",
	}
	resource := Resource{
		ContentType: "text/html",
		Body:        []byte("<html>About</html>"),
	}

	stored, err := store.ProcessPage(context.Background(), task, page, resource)
	if err != nil {
		t.Fatalf("ProcessPage() returned an error: %v", err)
	}
	if stored.MainHTML != "" || stored.MainText != "" {
		t.Fatal("large page content was retained after upload")
	}
	if stored.WordCount != 1 {
		t.Fatalf("word count = %d", stored.WordCount)
	}
	if stored.RawHTMLRef == "" || stored.MainHTMLRef == "" || stored.MainTextRef == "" {
		t.Fatalf("artifact references = %#v", stored)
	}
	if len(objects.objects) != 3 {
		t.Fatalf("stored object count = %d", len(objects.objects))
	}
	for key, object := range objects.objects {
		if object.contentEncoding != "gzip" {
			t.Fatalf("%s content encoding = %q", key, object.contentEncoding)
		}
		if !strings.HasPrefix(key, "crawler/org/project/run/pages/") {
			t.Fatalf("unexpected object key %q", key)
		}
		if len(readGzip(t, object.body)) == 0 {
			t.Fatalf("%s has empty decompressed content", key)
		}
	}
}

func TestProductionStoreRetainsSiteUnderstandingExcerpt(t *testing.T) {
	objects := &fakeObjectStore{}
	store := newProductionStore(&fakeCrawlRepository{}, objects)
	task := Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           TaskSiteUnderstanding,
	}
	page := Page{
		URL:      "https://example.com/",
		FinalURL: "https://example.com/",
		MainText: "A platform for finance teams to automate monthly reporting.",
	}

	stored, err := store.ProcessPage(
		context.Background(),
		task,
		page,
		Resource{Body: []byte("<html></html>")},
	)
	if err != nil {
		t.Fatalf("ProcessPage() returned an error: %v", err)
	}
	if stored.MainText != "" {
		t.Fatal("full main text was retained after upload")
	}
	if stored.ContentExcerpt != page.MainText {
		t.Fatalf("content excerpt = %q", stored.ContentExcerpt)
	}
}

func TestProductionStoreSavesResultReference(t *testing.T) {
	repository := &fakeCrawlRepository{}
	objects := &fakeObjectStore{}
	store := newProductionStore(repository, objects)
	task := Task{OrganizationID: "org", ProjectID: "project", RunID: "run"}
	result := Result{
		RunID:     task.RunID,
		Pages:     []Page{{URL: "https://example.com"}},
		StartedAt: time.Now().UTC(),
	}

	stored, err := store.SaveResult(context.Background(), task, result)
	if err != nil {
		t.Fatalf("SaveResult() returned an error: %v", err)
	}
	if stored.ResultRef != "s3://seo-crawler/crawler/org/project/run/result.json" {
		t.Fatalf("result reference = %q", stored.ResultRef)
	}
	if repository.ref != stored.ResultRef || len(repository.result.Pages) != 1 {
		t.Fatalf("repository result = %#v, ref = %q", repository.result, repository.ref)
	}
}

func TestProductionStorePersistsSiteIconAndUsesPlatformURL(t *testing.T) {
	repository := &fakeCrawlRepository{}
	objects := &fakeObjectStore{}
	store := newProductionStore(repository, objects)
	task := Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           TaskSiteUnderstanding,
	}
	result := Result{
		RunID: task.RunID,
		Pages: []Page{{
			URL:                "https://example.com",
			FaviconURL:         "https://example.com/favicon.png",
			FaviconContentType: "image/png",
			FaviconBody:        []byte("png"),
		}},
		SiteProfile: &SiteProfile{
			BusinessName: "Example",
			FaviconURL:   "https://example.com/favicon.png",
		},
		StartedAt: time.Now().UTC(),
	}

	_, err := store.SaveResult(context.Background(), task, result)
	if err != nil {
		t.Fatalf("SaveResult() returned an error: %v", err)
	}

	key := "crawler/org/project/run/site-icon"
	if object, ok := objects.objects[key]; !ok {
		t.Fatalf("site icon object %q was not stored", key)
	} else if object.contentType != "image/png" || string(object.body) != "png" {
		t.Fatalf("stored site icon = %#v", object)
	}
	wantURL := "/api/v1/projects/project/favicon?v=run"
	if repository.result.SiteProfile == nil ||
		repository.result.SiteProfile.FaviconURL != wantURL {
		t.Fatalf("site profile favicon URL = %#v", repository.result.SiteProfile)
	}
	if repository.result.Pages[0].FaviconURL != wantURL {
		t.Fatalf("page favicon URL = %q", repository.result.Pages[0].FaviconURL)
	}
	if len(repository.result.Pages[0].FaviconBody) != 0 {
		t.Fatal("favicon bytes were retained after storage")
	}
}

func TestNormalizePostgresURLAcceptsSQLAlchemyDriverName(t *testing.T) {
	got := normalizePostgresURL("postgresql+psycopg://postgres:secret@localhost/seo")
	want := "postgresql://postgres:secret@localhost/seo"
	if got != want {
		t.Fatalf("normalizePostgresURL() = %q, want %q", got, want)
	}
}

func readGzip(t *testing.T, data []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("gzip.NewReader() returned an error: %v", err)
	}
	defer reader.Close()
	result, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip content: %v", err)
	}
	return result
}
