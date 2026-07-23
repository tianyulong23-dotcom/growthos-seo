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
