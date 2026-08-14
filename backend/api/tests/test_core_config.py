from app.core.config import Settings


def test_default_cors_origins_cover_local_frontend_entrypoints() -> None:
    settings = Settings(_env_file=None)

    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]
