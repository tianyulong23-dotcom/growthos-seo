package crawler

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path"
	"strings"
	"sync"
)

type ObjectStore interface {
	Put(
		context.Context,
		string,
		string,
		string,
		[]byte,
	) (string, error)
}

type ArtifactRef struct {
	Key             string `json:"key"`
	URI             string `json:"uri"`
	ContentType     string `json:"contentType"`
	ContentEncoding string `json:"contentEncoding,omitempty"`
	SHA256          string `json:"sha256"`
	SizeBytes       int64  `json:"sizeBytes"`
}

type PageArtifactProcessor interface {
	ProcessPage(context.Context, Task, Page, Resource) (Page, error)
}

type CheckpointStore interface {
	SaveCheckpoint(context.Context, Task, CrawlCheckpoint) error
	LoadCheckpoint(context.Context, Task) (CrawlCheckpoint, bool, error)
}

type EvidenceStore struct {
	objects ObjectStore
	mu      sync.Mutex
	refs    map[string][]ArtifactRef
}

func NewEvidenceStore(ctx context.Context, config Config) (*EvidenceStore, error) {
	objects, err := NewS3ObjectStore(ctx, config)
	if err != nil {
		return nil, err
	}
	return newEvidenceStore(objects), nil
}

func newEvidenceStore(objects ObjectStore) *EvidenceStore {
	return &EvidenceStore{
		objects: objects,
		refs:    make(map[string][]ArtifactRef),
	}
}

func (store *EvidenceStore) ProcessPage(
	ctx context.Context,
	task Task,
	page Page,
	resource Resource,
) (Page, error) {
	artifacts := []struct {
		name        string
		contentType string
		body        []byte
		assign      func(string)
	}{
		{
			name:        "raw.html",
			contentType: defaultString(resource.ContentType, "text/html; charset=utf-8"),
			body:        resource.Body,
			assign:      func(key string) { page.RawHTMLRef = key },
		},
		{
			name:        "main.html",
			contentType: "text/html; charset=utf-8",
			body:        []byte(page.MainHTML),
			assign:      func(key string) { page.MainHTMLRef = key },
		},
		{
			name:        "main.txt",
			contentType: "text/plain; charset=utf-8",
			body:        []byte(page.MainText),
			assign:      func(key string) { page.MainTextRef = key },
		},
	}
	for _, artifact := range artifacts {
		if len(artifact.body) == 0 {
			continue
		}
		key := path.Join(objectPrefix(task), "pages", pageArtifactID(page), artifact.name+".gz")
		ref, err := store.putGzip(ctx, key, artifact.contentType, artifact.body)
		if err != nil {
			return Page{}, err
		}
		store.record(task.RunID, ref)
		artifact.assign(key)
	}
	return page, nil
}

func (store *EvidenceStore) SaveEvidence(
	ctx context.Context,
	request EvidenceRequestV1,
	result Result,
	executionErr error,
) (EvidenceV1, error) {
	task, err := request.ToTask()
	if err != nil {
		return EvidenceV1{}, err
	}
	result.RunID = task.RunID
	prefix := objectPrefix(task)
	resultBody, err := json.Marshal(result)
	if err != nil {
		return EvidenceV1{}, err
	}
	resultRef, err := store.put(
		ctx,
		path.Join(prefix, "crawl-result.v1.json"),
		"application/json",
		"",
		resultBody,
	)
	if err != nil {
		return EvidenceV1{}, err
	}
	store.record(task.RunID, resultRef)

	evidence := BuildEvidence(request, result, store.evidenceInputs(task.RunID), executionErr)
	evidenceBody, err := json.Marshal(evidence)
	if err != nil {
		return EvidenceV1{}, err
	}
	evidenceRef, err := store.put(
		ctx,
		path.Join(prefix, "evidence.v1.json"),
		"application/json",
		"",
		evidenceBody,
	)
	if err != nil {
		return EvidenceV1{}, err
	}
	store.record(task.RunID, evidenceRef)
	evidence.ArtifactRefs = store.artifacts(task.RunID)
	return evidence, nil
}

func (store *EvidenceStore) SaveCheckpoint(
	context.Context,
	Task,
	CrawlCheckpoint,
) error {
	return nil
}

func (store *EvidenceStore) LoadCheckpoint(
	context.Context,
	Task,
) (CrawlCheckpoint, bool, error) {
	return CrawlCheckpoint{}, false, nil
}

func (store *EvidenceStore) putGzip(
	ctx context.Context,
	key string,
	contentType string,
	body []byte,
) (ArtifactRef, error) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(body); err != nil {
		return ArtifactRef{}, err
	}
	if err := writer.Close(); err != nil {
		return ArtifactRef{}, err
	}
	return store.put(ctx, key, contentType, "gzip", compressed.Bytes())
}

func (store *EvidenceStore) put(
	ctx context.Context,
	key string,
	contentType string,
	contentEncoding string,
	body []byte,
) (ArtifactRef, error) {
	sum := sha256.Sum256(body)
	uri, err := store.objects.Put(ctx, key, contentType, contentEncoding, body)
	if err != nil {
		return ArtifactRef{}, err
	}
	return ArtifactRef{
		Key:             key,
		URI:             uri,
		ContentType:     contentType,
		ContentEncoding: contentEncoding,
		SHA256:          hex.EncodeToString(sum[:]),
		SizeBytes:       int64(len(body)),
	}, nil
}

func (store *EvidenceStore) record(runID string, ref ArtifactRef) {
	store.mu.Lock()
	defer store.mu.Unlock()
	refs := store.refs[runID]
	for index := range refs {
		if refs[index].Key == ref.Key {
			refs[index] = ref
			store.refs[runID] = refs
			return
		}
	}
	store.refs[runID] = append(refs, ref)
}

func (store *EvidenceStore) artifacts(runID string) []ArtifactRef {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]ArtifactRef(nil), store.refs[runID]...)
}

func (store *EvidenceStore) evidenceInputs(runID string) []ArtifactRef {
	refs := store.artifacts(runID)
	result := make([]ArtifactRef, 0, len(refs))
	for _, ref := range refs {
		if strings.HasSuffix(ref.Key, "/evidence.v1.json") {
			continue
		}
		result = append(result, ref)
	}
	return result
}

func objectPrefix(task Task) string {
	return path.Join(
		"crawler",
		cleanObjectSegment(task.OrganizationID),
		cleanObjectSegment(task.ProjectID),
		cleanObjectSegment(task.RunID),
	)
}

func pageArtifactID(page Page) string {
	value := defaultString(page.FinalURL, page.URL)
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

func cleanObjectSegment(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "/", "_")
	value = strings.ReplaceAll(value, "\\", "_")
	if value == "" {
		return "unknown"
	}
	return value
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

var _ PageArtifactProcessor = (*EvidenceStore)(nil)
var _ CheckpointStore = (*EvidenceStore)(nil)
