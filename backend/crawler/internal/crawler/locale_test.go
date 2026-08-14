package crawler

import "testing"

func TestLocaleMatchQualityAcceptsPrimaryLanguageAcrossRegionalVariants(t *testing.T) {
	tests := []struct {
		language string
		country  string
		actual   string
	}{
		{language: "en", country: "SG", actual: "en-SG"},
		{language: "en-SG", country: "SG", actual: "en"},
	}

	for _, test := range tests {
		if quality := localeMatchQuality(test.language, test.country, test.actual); quality == 0 {
			t.Fatalf("localeMatchQuality(%q, %q, %q) = 0, want a match", test.language, test.country, test.actual)
		}
	}
}
