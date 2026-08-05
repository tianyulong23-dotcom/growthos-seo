import asyncio
import selectors
import sys

import uvicorn

from app.core.config import get_settings


def _windows_selector_loop() -> asyncio.AbstractEventLoop:
    return asyncio.SelectorEventLoop(selectors.SelectSelector())


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        workers=settings.api_workers,
        log_level=settings.api_log_level,
        loop=_windows_selector_loop if sys.platform == "win32" else "auto",
        reload=False,
        proxy_headers=True,
        access_log=False,
    )


if __name__ == "__main__":
    main()
