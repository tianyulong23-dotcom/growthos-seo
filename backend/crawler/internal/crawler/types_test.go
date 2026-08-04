package crawler

import "testing"

func TestTaskPageLimit(t *testing.T) {
	tests := []struct {
		name string
		task Task
		want int
	}{
		{
			name: "site understanding defaults to 5",
			task: Task{Type: TaskSiteUnderstanding},
			want: 5,
		},
		{
			name: "site understanding cannot exceed 10",
			task: Task{Type: TaskSiteUnderstanding, MaxPages: 200},
			want: 10,
		},
		{
			name: "site understanding can request a smaller limit",
			task: Task{Type: TaskSiteUnderstanding, MaxPages: 5},
			want: 5,
		},
		{
			name: "audit accepts an explicit limit",
			task: Task{Type: TaskTechnicalAudit, MaxPages: 2500},
			want: 2500,
		},
		{
			name: "audit cannot exceed the hard limit",
			task: Task{Type: TaskTechnicalAudit, MaxPages: 6000},
			want: 5000,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.task.PageLimit(); got != test.want {
				t.Fatalf("PageLimit() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestTaskRejectsAuditLimitAboveHardLimit(t *testing.T) {
	task := Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       5001,
	}

	if err := task.Validate(); err == nil {
		t.Fatal("Validate() accepted an audit limit above 5000")
	}
}

func TestSiteTaskRequiresCountryAndLanguage(t *testing.T) {
	task := Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
	}
	if err := task.Validate(); err == nil {
		t.Fatal("Validate() accepted a site task without country and language")
	}

	task.Country = "US"
	task.Language = "en"
	if err := task.Validate(); err != nil {
		t.Fatalf("Validate() returned an error: %v", err)
	}
}

func TestSiteUnderstandingUsesRequestedRenderingMode(t *testing.T) {
	task := Task{
		Type:      TaskSiteUnderstanding,
		Rendering: RenderingAll,
	}

	if got := task.RenderingMode(); got != RenderingAll {
		t.Fatalf("RenderingMode() = %q, want %q", got, RenderingAll)
	}
}

func TestTaskDuplicationDefaultsMatchLibreCrawl(t *testing.T) {
	task := Task{}

	if !task.DuplicationCheckEnabled() {
		t.Fatal("DuplicationCheckEnabled() = false, want true")
	}
	if got := task.DuplicationThreshold(); got != 0.85 {
		t.Fatalf("DuplicationThreshold() = %f, want 0.85", got)
	}
}

func TestTaskRejectsDuplicationThresholdOutsideRange(t *testing.T) {
	base := Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	}

	for _, value := range []float64{-0.01, 1.01} {
		task := base
		task.DuplicationLimit = &value
		if err := task.Validate(); err == nil {
			t.Fatalf("Validate() accepted duplication threshold %f", value)
		}
	}
}
