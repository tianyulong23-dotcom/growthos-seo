package worker

import (
	"context"
	"testing"
)

func TestRunStopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := Run(ctx); err != nil {
		t.Fatalf("Run returned an error: %v", err)
	}
}
