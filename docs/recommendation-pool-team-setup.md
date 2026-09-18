# 推荐池团队交付与首次启动

## 交付内容

资源库已改为随仓库交付，不再要求访问作者电脑或另一个爬取项目。

| 内容 | 随 Git 交付 |
|---|---|
| 完整网站资源库 | `backend/core/resources/resource-library/bundled/publishers.sqlite`，49,742 条，16 个网站字段 |
| 数据校验与版本记录 | 同目录 `manifest.json`；构建时校验 SHA256、字段、行数和 SQLite 完整性 |
| 推荐池 V2、混合供给、批次和分页 | `backend/core/src`、`frontend/src` |
| Opportunity、联系人、草稿、邮件状态和发送校验 | 同一套现有前后端代码，不是另做简化演示 |
| API、任务契约及生成客户端 | `backend/contracts`、`frontend/src/api/generated` |
| 数据库结构和升级入口 | `backend/database`、`backend/core/src/modules/backlinks/db/migrations`、`backend/api/migrations` |
| API、Core、Worker、爬虫及启动工具 | `backend/api`、`backend/core`、`backend/crawler`、`backend/workers`、`scripts`、`deploy` |

网站库保留网站 URL、分类、语言、DR、月流量、Moz DA、价格及合作条款字段。
不包含作者的项目数据库、历史邮件、邮箱 OAuth 令牌、采集状态和密钥。
克隆得到的是完整功能代码和公共供应目录，不是作者账号及业务记录的复制品。
资源库是版本快照，不自动跟随原始爬取库更新。

## 运行前提

当前统一启动入口面向 Windows：PowerShell、Docker Desktop、Node.js 24.14.1、
npm、Python/uv 和 Go。依赖版本以各模块的锁文件为准。

资源文件和 Node Core 默认路径不依赖 Windows 用户名，也不依赖 shell 当前目录。
这不代表已有整套 Windows 启动脚本已经改造成 Linux 一键部署。
自行容器化 Core 时，必须同时包含 `dist`、`resources`、`package.json` 和安装好的
运行依赖；不能只复制 `dist`。外部库覆盖挂载必须为只读。

`deploy/compose/compose.yaml` 不是完整的推荐池独立启动入口，它没有直接定义
TypeScript Backlinks Core。使用现有 `scripts/dev-up.ps1`，它会启动基础设施、
运行数据库迁移、构建 Core，并启动 Core API/Worker、网关、前端和相关后台进程。

## 首次配置

在仓库根目录进行以下操作。配置文件已由 Git 忽略，不得加入提交。

```powershell
Copy-Item deploy/compose/.env.example deploy/compose/.env
Copy-Item backend/api/.env.example backend/api/.env
npm --prefix backend/core ci
npm --prefix frontend ci
npm --prefix backend/core run resource-library:check
```

如果目标文件已存在，先保留并检查，不要执行上述覆盖复制。
填写 `deploy/compose/.env` 的数据库密码、MinIO 密码和不少于 32 字符的随机
`PLATFORM_CONTEXT_SIGNING_KEY`。不要沿用示例密码。

资源库默认配置无需个人路径：

```dotenv
RESOURCE_LIBRARY_ENABLED=true
RESOURCE_LIBRARY_SQLITE_PATH=
AHREFS_CREDENTIAL_SECRET_REF=secret://growthos/local-product/ahrefs/provider-credential/v1
```

留空路径表示使用项目内数据库。显式相对路径从 `backend/core` 解析。
如要停用库分支，设置 `RESOURCE_LIBRARY_ENABLED=false`；显式错误路径会报库不可用，
不会静默替换成另一份库或伪装耗尽。

## 同事自己的凭据

完整业务运行仍需要各部署合法可用的 Ahrefs、DataForSEO、AI 和 Google OAuth 配置。
代码和资源库可共享，不等于付费供应商和 Gmail 能免配置使用。

新增 `team:credentials:init` 供首次安装使用，不依赖作者的历史
`live-auth-manifest.json` 或运行目录。它只写现有加密 secret store 及非密钥 AI
配置，不请求供应商、不连接 Gmail、不发送邮件。

给命令的标准输入提供以下 JSON 结构。下面的 API key、模型和计费数字是填写示意，
必须替换为团队实际配置，不能把示例价格作为供应商报价或预算依据：

```json
{
  "ahrefs": { "apiKey": "REPLACE" },
  "dataforseo": { "login": "REPLACE", "password": "REPLACE" },
  "google": { "clientSecret": "REPLACE" },
  "ai": {
    "apiKey": "REPLACE",
    "providerRef": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "modelId": "REPLACE",
    "discoveryModelId": "REPLACE",
    "modelVersion": "REPLACE",
    "maxCalls": 1,
    "timeoutMs": 30000,
    "maxInputTokens": 1000,
    "maxOutputTokens": 1000,
    "absoluteBudgetUsd": 0.1,
    "inputCostUsdPerMillionTokens": 1,
    "outputCostUsdPerMillionTokens": 1
  }
}
```

可以从密码管理器直接管道输入，或使用 Git 忽略的本地临时文件。例如在仓库根目录：

```powershell
$env:PLATFORM_SECRET_STORE_ROOT = Join-Path $env:LOCALAPPDATA "GrowthOS/team/secrets"
Get-Content -Raw storage/team-credentials.json | npm --prefix backend/core run team:credentials:init
```

`secrets` 目标必须尚不存在；命令不覆盖现有凭据或配置。
成功后删除临时明文文件，限制加密存储目录的访问权限。不要把密钥直接放入命令行参数、
提交说明或 `.env.example`。不要把作者的加密存储目录连同主密钥一起上传。

在 `deploy/compose/.env` 中填写：

- `PLATFORM_SECRET_STORE_ROOT`：与上面相同的、同事自己的绝对路径。
- `GOOGLE_OAUTH_CLIENT_ID`：同事或团队 Google OAuth 应用的 Client ID。
- `GOOGLE_OAUTH_CLIENT_SECRET_REF`：保留示例中的固定 secret 引用。
- `API_HOST_PORT`：如使用文档中的回调，设为 `7200`。
- `GOOGLE_OAUTH_REDIRECT_URI` 和 `BACKLINKS_OAUTH_CALLBACK_URL`：
  与 Google 应用登记的回调完全一致；示例为
  `http://localhost:7200/api/v1/backlinks/gmail-connections/callback`。
- `BACKLINKS_OAUTH_FRONTEND_ORIGIN`：与实际前端地址一致，示例为
  `http://localhost:5173`。

初始化生成的 `backlinks-worker.env` 位于 secret-store 目录的父目录，
现有启动脚本从那里读取 AI 模型和预算。无需旧电脑生成的额外清单。
Gmail 仍需在应用中由同事本人完成 OAuth 授权，邮件仍需按现有审批和发送校验处理。
如果需要浏览器供应商，另提供 `BROWSER_WORKER_ENDPOINT` 对应的服务；
只有配置 URL 不代表该外部服务已经运行。

## 启动及检查

确认各模块依赖和凭据配置后，在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1
```

这不是只读检查：会迁移目标数据库并启动业务消费者。
首次使用自己的独立数据库和 Compose 项目名，避免连接作者的数据库。
既有环境启动前先备份，并检查等待任务；消费者恢复可能执行已排队的付费任务。

先只检查基础环境、不运行推荐任务时，配置以下四项必须保持一致：

```dotenv
GROWTHOS_RUNTIME_MODE=MAINTENANCE
BACKLINKS_WORKER_EXECUTION_MODE=quiesced
PLATFORM_BACKGROUND_DISPATCH_ENABLED=false
BACKLINKS_PROJECT_PROJECTION_ENABLED=false
```

正式运行使用 `PRODUCT`、`normal`、`true`、`true`。
维护模式不处理推荐生成，不应将维护模式页面可打开当作业务验收通过。

按启动输出打开前端并检查 `/api/v1/runtime-status`，确认构建一致、数据库迁移完成、
Core API/Worker 就绪。然后验证项目资料、推荐生成、35 条分页、Opportunity、
联系人确认、草稿及 Gmail 连接。真实发送需单独确认，不能用自动测试代替。

本次已验证项目内库、换目录匹配、首次凭据存储和聚焦代码测试；
尚未在同事电脑上完成首次安装、外部服务接通和真实项目全链路验收。

## 提交前避免遗漏

### SEO 与联系人页面地址

推荐生成的正式 Worker 在冻结发布快照前调用 V2 批量指标服务，
不依赖 `.codex-checkpoints` 中的诊断或恢复脚本。DataForSEO 的三个 bulk
端点必须保留在 `deploy/compose/.env` 的 allowlist 中，且部署需有自己的有效凭据、
预算和请求授权。请求来源、缓存、幂等及未知扣费保护仍然生效。
自然搜索 ETV、DataForSEO Rank 与资源库 Ahrefs DR 是不同指标，不能相互冒充。
供应商未收录的网站可以返回空值，不能填入假数值；迁移也不会重写旧发布批次的空值。

数据库迁移 `0103` 将抓取后实际页面地址及页面类型保存在原有租户隔离的页面证据表中。
静态抓取和已获准的浏览器抓取都记录最终跳转地址，发布快照和列表共用该证据。
联系表单、登录、访问验证和拒绝访问分别展示对应入口；搜索框和订阅框不是联系表单。
历史记录只有状态、没有页面证据时，界面仅提供“访问网站”，不会猜测 `/contact` 等路径。
更新后产生的新抓取证据才能提供直接页面入口，数据库迁移本身不会重新爬取网站。

升级顺序为备份、按 deployment manifest 迁移、构建并统一启动 Core API/Worker、
再检查前端。不要把新 Core 代码接到尚未执行 `0103` 的旧结构上。
`scripts/dev-up.ps1` 识别 `0102` 和 `0103`，不会把已完成迁移当成旧版本再次执行。
运行迁移或恢复 Worker 可能唤醒原有业务任务，须先检查队列，不要为验证链接自动重跑付费任务。

不消耗供应商额度的回归入口：

```powershell
npm --prefix backend/core run migration:backlinks:check
npm --prefix backend/core run resource-library:check
cd backend/core
npx vitest run test/unit/contact-enrichment-activity.test.ts test/unit/recommendation-pool-v2-metric-runtime.test.ts test/unit/recommendation-portability.test.ts --maxWorkers=1
npx vitest run test/backlinks/integration/recommendation-pool-v2-phase4-canonical-batch.test.ts test/backlinks/integration/recommendation-feed-phase6.test.ts --maxWorkers=1
```

集成测试使用随机名称的隔离数据库，不连接业务项目；需要 Docker 测试容器，
或给 `BACKLINKS_TEST_POSTGRES_ADMIN_URL` 配置允许创建测试库的独立 PostgreSQL。
上述是源码和数据库回归，不代表已在另一台机器完成真实供应商验收。

只在本机存在的未跟踪文件不会自动进入 GitHub。不能只提交资源库或前端：
需要把相应后端实现、迁移、契约、生成客户端、启动工具、数据文件和锁文件一起审查提交。
当前工作区还有其他任务的大量修改，不能不经审查执行 `git add .`。

提交前至少运行：

```powershell
npm --prefix backend/core run resource-library:check
npm --prefix backend/core run build
git status --short
git diff --cached --stat
git ls-files backend/core/resources/resource-library/bundled
```

最后一项必须列出数据库和 manifest，提交里也必须包含完整功能实现。
提交推送后，应在全新目录 clone，再按本文安装验收，不能用原目录缓存依赖代替。
本次没有替用户执行 commit/push，也没有上传资源库或任何凭据到 GitHub。

团队内部使用和对外公开分发不是同一件事。对外公开仓库前，另确认来源数据的共享权限；
本次数据打包不代表已经取得第三方再分发许可。
