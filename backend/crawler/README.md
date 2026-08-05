# Go Crawler Worker

统一负责三类后台任务：

- `site_understanding`：创建项目时默认抓取 5 个代表页面，上限 10 个，用于识别网站业务。
- `technical_audit`：技术审查使用的站内抓取。
- `backlink_validation`：验证已知外链页面及目标链接。

`site_understanding` 只使用 Go HTTP + Colly 获取服务器返回的 HTML，不启动浏览器。
其他任务可按任务配置使用 Rod + Chromium。HTTP 抓取执行响应大小限制和 SSRF 检查；
浏览器请求还会逐个拦截并拒绝私网地址。

本模块不提供独立前端。FastAPI 创建 Temporal Workflow，Agent 区只读取任务进度：

```text
正在分析网站
已发现页面
正在整理重要页面
网站资料整理完成
```

默认只抓根域及其 `www` 对应地址。只有任务明确传入 `additional_hosts` 时才抓指定
子域名；未传入时直接忽略其他子域名，不询问用户。

```bash
go test ./...
go run ./cmd/crawler
```

主要环境变量：

```text
TEMPORAL_ADDRESS
TEMPORAL_NAMESPACE
CRAWLER_TASK_QUEUE
CRAWLER_WORKER_IDLE_TIMEOUT
CRAWLER_USER_AGENT
CRAWLER_ROBOTS_USER_AGENT
CRAWLER_REQUEST_TIMEOUT
CRAWLER_BROWSER_TIMEOUT
CRAWLER_REQUEST_DELAY
CRAWLER_RANDOM_DELAY
CRAWLER_STATUS_REQUEST_DELAY
CRAWLER_STATUS_RANDOM_DELAY
CRAWLER_HTTP_CONCURRENCY
CRAWLER_STATUS_CONCURRENCY
CRAWLER_BROWSER_CONCURRENCY
CRAWLER_MAX_BODY_BYTES
CRAWLER_MAX_RETRIES
CRAWLER_RESOURCE_CHECK_LIMIT
CRAWLER_DISCOVERY_LIMIT
CRAWLER_BROWSER_ENABLED
CRAWLER_BROWSER_EXECUTABLE
CRAWLER_BROWSER_CACHE_DIR
CRAWLER_PROXY_URL
CRAWLER_FALLBACK_PROXY_URL
CRAWLER_DATABASE_URL
DATABASE_URL
S3_ENDPOINT_URL
S3_REGION
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_USE_PATH_STYLE
S3_CREATE_BUCKET
```

爬虫不写本地结果文件。PostgreSQL 保存任务进度、页面资料、链接和外链检查结果；
原始 HTML、正文 HTML、正文文本和完整结果 JSON 压缩后保存到 S3。开发环境使用
MinIO 提供兼容 S3 的接口。

本地开发统一使用项目脚本启动：

```powershell
.\scripts\dev-up.ps1
```

脚本只常驻 PostgreSQL、Redis、MinIO、Temporal、API 和前端，不会常驻爬虫
Worker。API 提交抓取任务时会自动启动本地 Worker；任务结束且连续空闲 120 秒后，
Worker 会自行退出。Worker 启动时会检查 PostgreSQL、爬虫数据表和 S3 Bucket，
任何一项不可用都会直接退出，不会退回本地文件存储。
