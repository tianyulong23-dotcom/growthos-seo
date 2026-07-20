package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"seo/backend/crawler/internal/worker"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := worker.Run(ctx); err != nil {
		slog.Error("crawler worker stopped", "error", err)
		os.Exit(1)
	}
}
