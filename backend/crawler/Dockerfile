FROM golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/crawler ./cmd/crawler

FROM debian:bookworm-slim

RUN apt-get -o Acquire::Retries=10 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=10 -o Acquire::http::Timeout=60 install -y --no-install-recommends ca-certificates chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 crawler

ENV CRAWLER_BROWSER_EXECUTABLE=/usr/bin/chromium

COPY --from=builder /out/crawler /usr/local/bin/crawler

USER crawler
WORKDIR /home/crawler

CMD ["crawler"]
