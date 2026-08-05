from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, LargeBinary, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class AIProviderSetting(Base):
    __tablename__ = "ai_provider_settings"
    __table_args__ = (
        CheckConstraint(
            "request_timeout_seconds BETWEEN 10 AND 180",
            name="ck_ai_provider_settings_request_timeout_seconds",
        ),
        CheckConstraint(
            "max_retries BETWEEN 0 AND 4",
            name="ck_ai_provider_settings_max_retries",
        ),
        CheckConstraint(
            "provider IN ('openai','anthropic','openrouter')",
            name="ck_ai_provider_settings_provider",
        ),
    )

    organization_id: Mapped[str] = mapped_column(Text, primary_key=True)
    provider: Mapped[str] = mapped_column(Text, nullable=False, server_default="openai")
    base_url: Mapped[str] = mapped_column(Text, nullable=False)
    api_key_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    request_timeout_seconds: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="90",
    )
    max_retries: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="4",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class GoogleAdsProviderSetting(Base):
    __tablename__ = "google_ads_provider_settings"

    organization_id: Mapped[str] = mapped_column(Text, primary_key=True)
    developer_token_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    client_secret_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    refresh_token_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    customer_id: Mapped[str] = mapped_column(Text, nullable=False)
    login_customer_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class DataForSEOProviderSetting(Base):
    __tablename__ = "dataforseo_provider_settings"

    organization_id: Mapped[str] = mapped_column(Text, primary_key=True)
    login: Mapped[str] = mapped_column(Text, nullable=False)
    password_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
