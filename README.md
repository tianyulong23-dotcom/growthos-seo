# seo

`seo` 项目的统一代码仓库。顶层只区分前端和后端，后端内部再按语言和职责分开。

## 当前目录

```text
seo/
  frontend/                 React + TypeScript + Vite + Shadcn UI
  backend/
    api/                    FastAPI 业务接口
    workers/                Python 分析、AI、接入和发布 Worker
    crawler/                Go 普通网页抓取 Worker
    browser-worker/         Node.js + Playwright 渲染 Worker
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

## Browser Worker

```bash
cd backend/browser-worker
npm ci
npm run typecheck
npm test
```

## Git 协作

- 使用一个仓库和 `main` 分支。
- 提交前先拉取远程更新，避免覆盖其他成员的修改。
- 后端成员在 `backend/` 下各自负责的模块中开发。
- 公共前端组件统一放在 `frontend/src/components`。
- 前端请求统一放在 `frontend/src/api`，不能直接访问数据库或 Redis。
