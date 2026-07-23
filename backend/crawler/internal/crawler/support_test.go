package crawler

import (
	"context"
	"errors"
	"sync"
)

type fakeFetcher struct {
	mu        sync.Mutex
	resources map[string]Resource
	errors    map[string]error
	calls     map[string]int
}

func (f *fakeFetcher) Fetch(_ context.Context, rawURL string) (Resource, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = make(map[string]int)
	}
	f.calls[rawURL]++
	resource, exists := f.resources[rawURL]
	if !exists {
		return Resource{}, errors.New("unexpected URL: " + rawURL)
	}
	return resource, f.errors[rawURL]
}

func (f *fakeFetcher) callCount(rawURL string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[rawURL]
}
