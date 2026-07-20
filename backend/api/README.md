# FastAPI 后端

负责业务接口、权限、数据访问和任务创建。前端只能通过这里访问后端数据。

```bash
uv sync
uv run uvicorn app.main:app --reload
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
