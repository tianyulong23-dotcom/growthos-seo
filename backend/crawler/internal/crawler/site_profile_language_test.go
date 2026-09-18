package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIProfileFailureReasons(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{"bad request", &aiHTTPStatusError{statusCode: 400}, "模型服务拒绝请求，请检查业务识别模型和接口配置"},
		{"invalid parameters", &aiHTTPStatusError{statusCode: 422}, "模型服务拒绝请求，请检查业务识别模型和接口配置"},
		{"missing endpoint", &aiHTTPStatusError{statusCode: 404}, "模型或接口不存在，请检查 AI 模型设置"},
		{"authentication", &aiHTTPStatusError{statusCode: 401}, "模型服务鉴权失败"},
		{"permission", &aiHTTPStatusError{statusCode: 403}, "模型服务鉴权失败"},
		{"rate limited", &aiHTTPStatusError{statusCode: 429}, "模型服务请求过多"},
		{"unavailable", &aiHTTPStatusError{statusCode: 503}, "模型服务暂时不可用"},
		{"timeout", context.DeadlineExceeded, "模型请求超时"},
		{"invalid JSON", errors.New("decode synthesized business profile"), "模型返回格式无效"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := AIProfileFailureReason(fmt.Errorf("wrapped: %w", test.err)); got != test.want {
				t.Fatalf("reason=%q want=%q", got, test.want)
			}
		})
	}
}

func TestAIProfileReportsUnsupportedModelWithoutRetryOrLeakingProviderText(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"type":"invalid_request_error","message":"The 'example-mini' model is not supported when using Codex with a ChatGPT account. private-provider-detail"}}`)
	}))
	defer server.Close()
	synthesizer := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL:    server.URL,
		BusinessProfileAIAPIKey:     "test-key",
		BusinessProfileAIModel:      "example-mini",
		BusinessProfileAIMaxRetries: 2,
	})
	_, traces, err := synthesizer.SynthesizeWithTrace(context.Background(),
		Task{TargetURL: "https://example.com", Language: "pt-BR"}, nil, SiteProfile{})
	if err == nil || calls != 1 || len(traces) != 1 || traces[0].HTTPStatus != 400 {
		t.Fatalf("calls=%d traces=%+v err=%v", calls, traces, err)
	}
	if got := AIProfileFailureReason(err); got != "当前业务识别模型不受此服务或账户支持，请在 AI 模型设置中更换业务识别模型" {
		t.Fatalf("failure reason = %q", got)
	}
	if strings.Contains(err.Error(), "private-provider-detail") {
		t.Fatal("provider response must not leak into public errors")
	}
}

func TestAIProfilePreservesMultilingualEvidenceAndFields(t *testing.T) {
	for _, fixture := range []struct {
		language, description, product, audience string
	}{
		{"pt-BR", "Aplicativo para assistir a filmes e séries online.", "Aplicativo de filmes e séries", "Pessoas que assistem a filmes online"},
		{"es", "Aplicación para ver películas y series.", "Aplicación de películas", "Espectadores de películas"},
		{"zh-CN", "为企业提供在线协作软件。", "在线协作软件", "企业团队"},
		{"ja", "企業向けの業務管理ソフトウェア。", "業務管理ソフトウェア", "企業"},
		{"en", "Collaboration software for business teams.", "Collaboration software", "Business teams"},
	} {
		t.Run(fixture.language, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				var payload profileEvidencePayload
				if err := json.Unmarshal([]byte(strings.SplitN(request.Messages[1].Content, "\n", 2)[1]), &payload); err != nil {
					t.Fatal(err)
				}
				if payload.RequestedLanguage != fixture.language || len(payload.Pages) != 1 ||
					payload.Pages[0].Description != fixture.description ||
					payload.Pages[0].Language != fixture.language {
					t.Fatalf("language or original evidence lost: %+v", payload)
				}
				writeAIProfileResponse(t, w, aiProfileOutput{
					BusinessName: "Example", BusinessType: "Software", BusinessModel: "software",
					BusinessSummary:  fixture.description,
					ProductsServices: []string{fixture.product}, TargetAudiences: []string{fixture.audience},
					ValuePropositions: []string{fixture.description},
					Evidence: []aiProfileEvidence{{
						Field: "business_summary", Value: fixture.description,
						PageID: "page_001", Quote: fixture.description,
					}},
				})
			}))
			defer server.Close()
			pages := []Page{{URL: "https://example.com", Title: "Example", Language: fixture.language, Description: fixture.description}}
			profile, err := NewAIProfileSynthesizer(Config{
				BusinessProfileAIBaseURL: server.URL, BusinessProfileAIAPIKey: "test-key", BusinessProfileAIModel: "test-model",
			}).Synthesize(context.Background(), Task{TargetURL: pages[0].URL, Language: fixture.language},
				pages, SiteProfile{})
			if err != nil || !SiteProfileReady(profile) || profile.BusinessSummary != fixture.description ||
				profile.ProductsServices[0] != fixture.product || profile.TargetAudiences[0] != fixture.audience {
				t.Fatalf("profile=%+v err=%v", profile, err)
			}
			if len(profile.Evidence) != 1 || profile.Evidence[0].Quote != fixture.description {
				t.Fatalf("original-language evidence lost: %+v", profile.Evidence)
			}
		})
	}
}
