# 后端

后端包含业务接口、后台任务、网页抓取和跨模块契约。不同语言保留独立的依赖和测试，
但都属于同一个后端。

```text
backend/
  api/               FastAPI、PostgreSQL、Redis 和任务创建
  workers/           Python 分析、AI、第三方接入和发布任务
  crawler/           Go 普通网页抓取
  browser-worker/    Playwright 动态网页渲染
  contracts/         跨语言共享的数据格式
  tests/             后端完整流程、契约和性能测试
```

前端只能通过 `api/` 访问后端能力。Worker 和爬虫不直接向前端提供接口。
