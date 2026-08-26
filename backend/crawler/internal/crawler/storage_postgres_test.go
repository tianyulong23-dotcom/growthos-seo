package crawler

import (
	"strings"
	"testing"
)

func TestCompletionMessageMatchesTaskType(t *testing.T) {
	tests := []struct {
		taskType TaskType
		want     string
	}{
		{TaskSiteUnderstanding, "网站业务识别已完成"},
		{TaskTechnicalAudit, "技术审计已完成"},
		{TaskBacklinkValidation, "外链检查已完成"},
	}

	for _, test := range tests {
		if got := completionMessage(test.taskType); got != test.want {
			t.Fatalf("completionMessage(%q) = %q, want %q", test.taskType, got, test.want)
		}
	}
}

func TestStoredResultStatusOnlyMarksIncompleteUnderstandingAsPartial(t *testing.T) {
	tests := []struct {
		name   string
		task   Task
		result Result
		want   string
	}{
		{
			name:   "partial understanding",
			task:   Task{Type: TaskSiteUnderstanding},
			result: Result{CompletionStatus: CompletionPartial},
			want:   "partial",
		},
		{
			name:   "complete understanding",
			task:   Task{Type: TaskSiteUnderstanding},
			result: Result{CompletionStatus: CompletionComplete},
			want:   "completed",
		},
		{
			name:   "technical audit",
			task:   Task{Type: TaskTechnicalAudit},
			result: Result{CompletionStatus: CompletionPartial},
			want:   "completed",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := storedResultStatus(test.task, test.result); got != test.want {
				t.Fatalf("storedResultStatus() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCompletionMessageUsesSpecificDegradedReason(t *testing.T) {
	result := Result{
		CompletionStatus: CompletionPartial,
		CompletionNote:   "AI 整理失败，已使用规则生成业务资料：模型请求超时",
	}

	got := completionMessageForResult(Task{Type: TaskSiteUnderstanding}, result)
	if got != result.CompletionNote {
		t.Fatalf("completionMessageForResult() = %q, want %q", got, result.CompletionNote)
	}
}

func TestTechnicalAuditCompletionMessageUsesResourceWarning(t *testing.T) {
	result := Result{
		CompletionStatus: CompletionComplete,
		CompletionNote:   "部分附加资源未检查状态",
	}

	got := completionMessageForResult(Task{Type: TaskTechnicalAudit}, result)
	if got != result.CompletionNote {
		t.Fatalf("completionMessageForResult() = %q, want %q", got, result.CompletionNote)
	}
	summary := buildStoredAuditSummary(Result{ResourceChecksTruncated: true})
	if summary["resource_checks_truncated"] != 1 {
		t.Fatalf("summary = %#v", summary)
	}
}

func TestSiteProfileUpsertPreservesUserOverrides(t *testing.T) {
	if !strings.Contains(upsertSiteProfileSQL, "EXCLUDED.profile_json") ||
		!strings.Contains(
			upsertSiteProfileSQL,
			"COALESCE(site_profiles.user_overrides, '{}'::jsonb)",
		) {
		t.Fatal("site profile upsert no longer merges existing user overrides")
	}
	if strings.Contains(upsertSiteProfileSQL, "user_overrides =") {
		t.Fatal("site profile upsert overwrites the user_overrides column")
	}
}
