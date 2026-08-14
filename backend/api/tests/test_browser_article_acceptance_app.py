from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path


def test_acceptance_workflow_controller_records_each_run_once(monkeypatch) -> None:
    database_url = "postgresql+asyncpg://acceptance@127.0.0.1/seo_content_stage2_test"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", database_url)
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parent))
    sys.modules.pop("browser_article_acceptance_app", None)

    module = importlib.import_module("browser_article_acceptance_app")
    controller = module.AcceptanceWorkflowController()

    asyncio.run(controller.start("run-1"))
    asyncio.run(controller.start("run-1"))

    assert controller.started == ["run-1"]
