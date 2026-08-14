package crawler

import (
	"net/http"
	"testing"
)

func TestNeedsBrowserForSuccessfulUnsupportedClientPage(t *testing.T) {
	resource := Resource{
		StatusCode:  http.StatusOK,
		ContentType: "text/html; charset=utf-8",
		Body:        []byte(`<!doctype html><html><body>Unsupported client. Please use a supported browser.</body></html>`),
	}

	if !needsBrowser(resource, nil) {
		t.Fatal("HTTP 200 unsupported-client shell did not trigger browser rendering")
	}
}
