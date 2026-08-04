# Temporal 契约

Workflow、Activity、Task Queue、重试策略和版本兼容规则放在这里。

## Go 爬虫

- Task Queue：`crawler-go`
- Workflow：`CrawlWorkflow`
- Activity：`Activities.RunTask`
- 输入契约：`../json-schema/crawler-task.schema.json`
- 输出：只返回结果引用和页面数量，不在 Temporal Payload 中传输页面正文。

Workflow ID 必须稳定：

```text
crawler:site_understanding:{project_id}
crawler:technical_audit:{run_id}
crawler:backlink_validation:{run_id}
```

创建项目时，FastAPI 在项目事务提交后启动
`crawler:site_understanding:{project_id}`。数据库唯一约束和固定 Workflow ID
共同保证初始化抓取只创建一次；Activity 内部失败重试仍属于同一次初始化。

## 共享模块契约

`registry.v1.json` 记录模块 Task Queue、Workflow/Activity 名称、数据库权限和
Provider Kill Switch 命名空间。当前 Go crawler 同时注册现有生产队列和
`growthos.crawling.v1` 证据队列；证据队列只返回证据和对象存储引用，不写入
Platform、Audit 或 Backlinks 的业务事实。

模块队列包括：

- `growthos.platform.v1`
- `growthos.audit.v1`
- `growthos.crawling.v1`
- `growthos.backlinks.v1`

Provider Kill Switch 使用 owner 前缀：

- `platform.business-profile-ai.v1`
- `audit.google-pagespeed.v1`
- `backlinks.dataforseo.v1`
