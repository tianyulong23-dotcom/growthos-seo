from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

settings = get_settings()
engine = create_async_engine(
    settings.database_url,
    pool_pre_ping=True,
    connect_args={
        "server_settings": {
            "search_path": "public, platform, crawling, audit",
        }
    },
)
session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
