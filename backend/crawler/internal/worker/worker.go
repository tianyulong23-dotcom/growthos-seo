package worker

import (
	"context"
	"log/slog"
)

func Run(ctx context.Context) error {
	slog.Info("crawler worker started")
	<-ctx.Done()
	slog.Info("crawler worker stopped")
	return nil
}
