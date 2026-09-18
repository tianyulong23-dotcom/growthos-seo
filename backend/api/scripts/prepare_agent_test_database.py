"""Initialize the fixed local Agent test database without copying business data."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

from dotenv import dotenv_values
import psycopg
from psycopg import sql
from sqlalchemy.engine import URL

API_ROOT = Path(__file__).resolve().parents[1]
ROOT = API_ROOT.parents[1]
DATABASE = "seo_agent_v11_test"


def main() -> None:
    config = dotenv_values(ROOT / "deploy" / "compose" / ".env")
    password = config.get("POSTGRES_PASSWORD")
    if not password:
        raise SystemExit("Local compose POSTGRES_PASSWORD is required")
    connection = {
        "host": "127.0.0.1",
        "port": int(config.get("POSTGRES_HOST_PORT") or "5432"),
        "user": "postgres",
        "password": password,
        "connect_timeout": 10,
    }
    with psycopg.connect(**connection, dbname="postgres", autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (DATABASE,)
        ).fetchone()
        if not exists:
            conn.execute(
                sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
                    sql.Identifier(DATABASE)
                )
            )
        print(f"{DATABASE}: {'existing' if exists else 'created'}", flush=True)

    # Roles belong to the shared cluster; only create schemas in the test DB.
    with psycopg.connect(**connection, dbname=DATABASE) as conn:
        for schema in (
            "platform", "audit", "crawling", "keywords", "content",
            "backlinks", "reporting",
        ):
            owner = f"growthos_{schema}_owner"
            if not conn.execute(
                "SELECT 1 FROM pg_roles WHERE rolname = %s", (owner,)
            ).fetchone():
                raise SystemExit(f"Existing local cluster role required: {owner}")
            conn.execute(
                sql.SQL("CREATE SCHEMA IF NOT EXISTS {} AUTHORIZATION {}").format(
                    sql.Identifier(schema), sql.Identifier(owner)
                )
            )
        conn.execute(
            sql.SQL(
                "ALTER DATABASE {} SET search_path TO public, platform, crawling, audit"
            ).format(sql.Identifier(DATABASE))
        )
    url = URL.create(
        "postgresql+asyncpg", username="postgres", password=password,
        host="127.0.0.1", port=connection["port"], database=DATABASE,
    ).render_as_string(hide_password=False)
    environment = {
        **os.environ, "APP_ENV": "test", "DATABASE_URL": url,
        "PYTHONIOENCODING": "utf-8",
    }
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_ROOT, env=environment, check=True,
    )
    with psycopg.connect(**connection, dbname=DATABASE) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == DATABASE
        version = conn.execute("SELECT version_num FROM alembic_version").fetchall()
        count = conn.execute(
            "SELECT count(*) FROM platform.projects"
        ).fetchone()[0]
        print(f"Migration heads: {[row[0] for row in version]}")
        print(f"Project rows: {count}; no business data copied")


if __name__ == "__main__":
    main()
