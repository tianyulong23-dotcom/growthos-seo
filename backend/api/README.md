# FastAPI 后端

负责业务接口、权限、数据访问和任务创建。前端只能通过这里访问后端数据。

开发启动：

```bash
uv sync
uv run uvicorn app.main:app --reload
```

正式启动不使用 reload：

```bash
uv run python -m app.serve
```

检查：

```bash
uv run ruff check .
uv run pytest
```

数据库迁移统一使用：

```bash
uv run alembic upgrade head
```

正式进程启动前必须先由数据库运维角色独立执行共享部署清单中的迁移。
应用进程不会自动执行迁移。`/health` 只证明进程存活，`/ready` 会检查
PostgreSQL 18、迁移表、Temporal Server 和私有 Backlinks Core。
