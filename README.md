# seo

`seo` 项目的统一代码仓库。顶层只区分前端和后端，后端内部再按语言和职责分开。

## 当前目录

```text
seo/
  frontend/                 React + TypeScript + Vite + Shadcn UI
  backend/
    api/                    FastAPI 业务接口
    workers/                Python 分析、AI、接入和发布 Worker
    crawler/                Go 统一爬虫 Worker
    contracts/              OpenAPI、事件和任务契约
    tests/                  后端跨模块测试
  docs/                     项目文档
```

`storage/` 是本地运行产生的数据，不提交到 GitHub。

## 前端开发

要求安装 Node.js 24 和 npm。

```bash
cd frontend
npm ci
npm run dev
```

提交前执行：

```bash
npm run lint
npm run typecheck
npm run build
npm exec prettier -- --check .
```

## FastAPI 后端

```bash
cd backend/api
uv sync
uv run uvicorn app.main:app --reload
```

健康检查地址是 `http://localhost:8000/health`。

## Python Workers

```bash
cd backend/workers
uv sync
uv run python -m seo_workers --list
```

## Go 爬虫

```bash
cd backend/crawler
go test ./...
go run ./cmd/crawler
```

Go 爬虫通过 Temporal 后台运行，统一处理项目初始化、技术审查和已知外链验证。
项目初始化的网站业务识别只使用 Go HTTP + Colly；其他任务可按配置使用
Rod + Chromium。本模块不提供独立爬虫前端。
结构化抓取结果保存到 PostgreSQL，大页面内容保存到 S3；本地开发使用
`deploy/compose/compose.yaml` 启动 PostgreSQL 和 MinIO。

## Git 协作

- 使用一个仓库和 `main` 分支。
- 提交前先拉取远程更新，避免覆盖其他成员的修改。
- 后端成员在 `backend/` 下各自负责的模块中开发。
- 公共前端组件统一放在 `frontend/src/components`。
- 前端请求统一放在 `frontend/src/api`，不能直接访问数据库或 Redis。
