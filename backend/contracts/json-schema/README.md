# JSON Schema

前端、FastAPI、Go 和 Worker 共同使用的 JSON Schema 放在这里。

- `crawler-task.schema.json`：统一 Go 爬虫的任务输入。FastAPI 创建任务前必须按此校验。
- `crawler-evidence-request.v1.schema.json`：跨模块证据请求和去重信封。
- `crawler-evidence.v1.schema.json`：只包含页面、联系人、外链、技术观察和对象存储引用的证据输出；不包含项目、审计、机会或投放等业务状态。
- `platform-access-token.v1.schema.json`：平台访问令牌载荷。
- `platform-request-context.v1.schema.json`：平台网关向模块服务签发的请求上下文。
