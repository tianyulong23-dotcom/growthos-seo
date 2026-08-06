# LOCAL-PRODUCT-017 Organization Gmail 复用、稳定 OAuth 和多项目选择

- 执行日期：`2026-08-06`
- 工作目录：`C:\Users\DELL\Documents\缝合\john3947-seo`
- 执行范围：仅 `LOCAL-PRODUCT-017`
- 最终状态：`PASS_CODE_EXTERNAL_ACTION_PENDING`
- Branch：`外链part`
- Baseline HEAD：`7cf0d479aee210d2d77c2fbad523958e9a78adca`
- 最终本地运行 ID：`20260806-201748`
- Stop boundary：未执行 `LOCAL-PRODUCT-018`

## 1. 结论

Gmail 授权已经从项目级凭证改为 Organization 级 Connection。ElephTV 和 AWOL 现在通过各自无令牌的
WebsiteProjectMailboxBinding 选择同一个 GmailConnection，不复制 Token、不重复 Consent，邮件业务
数据仍按 `websiteProjectId` 隔离。

AWOL 已在真实本地浏览器中完成现有账号复用：

- 页面显示 Organization 可用账号 `1` 个；
- 选择现有 Gmail 后，真实请求为
  `POST /api/v1/projects/awolvision-com-4ec81dca/backlinks/gmail-connections/select`；
- 请求返回 `200`；
- 本次页面会话没有调用 `/gmail-connections/connect`；
- 页面更新为已连接，ElephTV 与 AWOL 最终选择同一个 GmailConnection；
- 本轮没有创建 OAuth Attempt、SendIntent 或 SendAttempt。

新 Google Subject 的真实 OAuth 尚需在 Google Console 登记稳定 Redirect URI，并由用户完成 Google
登录、2FA 和 Consent，因此不声明完整真实 OAuth PASS。

## 2. 稳定 OAuth 回调

本地唯一正式 Redirect URI：

```text
http://localhost:7200/api/v1/backlinks/gmail-connections/callback
```

FastAPI、Core、Backlinks OpenAPI、Platform OpenAPI、generated client、运行 Manifest、初始化脚本和
配置脚本均使用同一地址。旧项目级 callback 暂时保留兼容，但同样只从服务端一次性 State 恢复上下文。

OAuth Attempt 持久化并校验：

- organization、workspace、website project、user、session；
- returnPath、redirectUri、state hash 和 PKCE Secret Reference；
- TTL、一次消费、Session/User 绑定和 replay 防护；
- returnPath 只允许当前项目的受控前端路径；
- callback 不信任浏览器传入的 project、email、connectionId 或 returnPath。

无 State 请求访问新旧 callback 均返回 `400`，证明路由存在且不会绕过 State。

## 3. Connection 与项目选择模型

Migration `0047_backlink_gmail_organization_reuse.sql` 完成以下模型迁移：

- GmailConnection active 唯一键为 `organization_id + google_subject`；
- Token Secret Reference 只保存在 GmailConnection；
- GmailWorkspaceBinding 只表达 Workspace 对 Connection 的使用权；
- WebsiteProjectMailboxBinding 只保存项目选择，不包含 Token 或 Secret Reference；
- 旧项目级 Workspace Binding 在升级时保留项目选择，再提升为可复用 Workspace Binding；
- Send、Thread、Message、Reply Match 和 Audit 的项目字段不变。

真实 PostgreSQL 18 最终事实：

| 检查                                      | 结果 |
| ----------------------------------------- | ---: |
| Active GmailConnection                    |    1 |
| Active GmailWorkspaceBinding              |    1 |
| Selected WebsiteProjectMailboxBinding     |    2 |
| 两个项目使用的不同 GmailConnection 数     |    1 |
| AWOL 已选择                               | true |
| ElephTV 已选择                            | true |
| Workspace Binding 仍携带 projectId        |    0 |
| Organization + Google Subject active 重复 |    0 |

Deployment manifest checksum：

```text
edbc3a4c48b1145cf0f6659fc9e1562aad10c56e70a7bce499cad4f178f15327
```

## 4. 稳定性和凭证安全

- 继续使用 `google-auth-library` 和 `@googleapis/gmail`，未增加 IMAP/SMTP 主链。
- Refresh 使用 PostgreSQL advisory lock，避免只靠单进程 Promise 去重。
- `invalid_grant` 只把对应 Connection 标记为 `REAUTH_REQUIRED`。
- Disconnect 先立即停用本地凭证；远端 revoke 失败写入受控重试。
- production runtime 启动时执行 Token Refresh Health Check，不创建发送。
- 本地回复同步继续使用持久化 polling，并保留未来 watch/history/PubSub Adapter 边界。
- 当前运行日志共扫描 `8` 个文件，Token、Code、PKCE 和 Client Secret 模式命中 `0`。
- 真实浏览器 localStorage 和 sessionStorage 均为空。

当前日志检查发现一次 `ClientDisconnect`，来源是浏览器中止重复邮件列表读取；服务状态仍为 `ok`，
后续同一路由请求返回 `200`，不是 Gmail、数据库或迁移故障。

## 5. 前端与真实浏览器

Gmail 页面现在显示：

- Organization 已连接账号列表；
- 当前项目选择的账号；
- `CONNECTED`、`REAUTH_REQUIRED`、`TOKEN_REVOKED`、`DISCONNECTED`；
- 最近错误类别；
- “选择已有账号”和“授权新账号”两个明确动作。

真实 AWOL 页面在选择前显示“组织可用账号 1 个；选择已有账号不会再次打开 Google 授权”，选择后
显示现有 Gmail 已连接，并恢复同步状态区域。页面未显示 Token 或 Secret Reference。

验收截图：

```text
output/playwright/local-product-017-awol-gmail-reuse.png
```

## 6. 验证证据

| 验证                                       | 结果                      |
| ------------------------------------------ | ------------------------- |
| Backlinks migration manifest               | `40` files through `0047` |
| Gmail migration/repository integration     | `2` files, `10/10`        |
| OAuth/API/runtime/disconnect targeted pack | `9` files, `49/49`        |
| Core typecheck                             | PASS                      |
| 017 targeted ESLint                        | PASS                      |
| FastAPI gateway tests                      | `19/19`                   |
| Backlinks OpenAPI baseline                 | `61` paths                |
| Generated Backlinks client                 | `62` operations           |
| Generated Platform client                  | `6` operations            |
| Frontend build                             | PASS                      |
| Frontend lint                              | PASS, zero warnings       |
| Gmail reuse focused Playwright             | `1/1`                     |
| Full desktop Playwright                    | `4/4`                     |
| Mobile Playwright                          | `1/1`                     |
| Keyboard a11y Playwright                   | `1/1`                     |

Core 全量 ESLint 仍命中 015/016 推荐模块中的 `6` 个既有规则问题，包括受限 vendor import 和
non-null assertion；017 涉及文件的定向 ESLint 已通过，本任务未扩大范围修改这些推荐模块。

## 7. 最终运行状态与零发送

| 组件/能力                            | 结果                      |
| ------------------------------------ | ------------------------- |
| Frontend `http://localhost:5173`     | HTTP 200                  |
| FastAPI `http://localhost:7200`      | HTTP 200                  |
| Private Core `http://127.0.0.1:7301` | HTTP 200                  |
| PostgreSQL 18                        | healthy                   |
| Alembic head                         | `20260806_0009`           |
| Backlinks head                       | `0047`                    |
| Temporal                             | healthy / namespace ready |
| Gmail Send                           | disabled                  |
| Gmail Sync                           | disabled                  |

数据库存在 `2026-08-02` 和 `2026-08-03` 的两组历史 Gmail 发送验收记录。本轮运行
`20260806-201748` 启动后：

| 副作用        | 增量 |
| ------------- | ---: |
| OAuth Attempt |    0 |
| SendIntent    |    0 |
| SendAttempt   |    0 |

## 8. 唯一剩余外部动作

在对应 Google Cloud OAuth Client 的 Authorized redirect URIs 中登记以下精确地址：

```text
http://localhost:7200/api/v1/backlinks/gmail-connections/callback
```

登记后，只有授权新的 Google Subject 或现有账号重新授权时才需要进入 Google 登录/2FA/Consent。
ElephTV、AWOL 和后续同 Organization/Workspace 项目复用现有账号时不再进入 OAuth。
