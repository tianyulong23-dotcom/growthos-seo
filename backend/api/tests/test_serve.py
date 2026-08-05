import asyncio
from types import SimpleNamespace

from app import serve


def test_windows_entrypoint_supplies_selector_loop_factory(monkeypatch) -> None:
    settings = SimpleNamespace(
        api_host="127.0.0.1",
        api_port=7200,
        api_workers=1,
        api_log_level="info",
    )
    captured: dict[str, object] = {}

    monkeypatch.setattr(serve, "get_settings", lambda: settings)
    monkeypatch.setattr(serve.sys, "platform", "win32")
    monkeypatch.setattr(
        serve.uvicorn,
        "run",
        lambda app, **options: captured.update(app=app, **options),
    )

    serve.main()

    loop_factory = captured["loop"]
    assert callable(loop_factory)
    assert captured["access_log"] is False
    loop = loop_factory()
    try:
        assert isinstance(loop, asyncio.SelectorEventLoop)
    finally:
        loop.close()
