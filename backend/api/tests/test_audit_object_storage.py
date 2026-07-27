import asyncio
from typing import Any

import pytest

from app.core.config import Settings
from app.modules.audit.object_storage import S3AuditObjectCleaner


class FakeS3Client:
    def __init__(self) -> None:
        self.list_requests: list[dict[str, Any]] = []
        self.delete_requests: list[dict[str, Any]] = []
        self.delete_errors: list[dict[str, str]] = []

    def list_objects_v2(self, **request: Any) -> dict[str, Any]:
        self.list_requests.append(request)
        return {
            "Contents": [
                {"Key": f"{request['Prefix']}result.json"},
                {"Key": f"{request['Prefix']}pages/page.html.gz"},
            ],
            "IsTruncated": False,
        }

    def delete_objects(self, **request: Any) -> dict[str, Any]:
        self.delete_requests.append(request)
        return {"Errors": self.delete_errors}


def test_s3_cleaner_deletes_every_object_under_the_run_prefix(monkeypatch: Any) -> None:
    client = FakeS3Client()
    monkeypatch.setattr(
        "app.modules.audit.object_storage.boto3.client",
        lambda **_: client,
    )
    cleaner = S3AuditObjectCleaner(
        Settings(
            app_env="test",
            s3_endpoint_url="http://localhost:9000",
            s3_bucket="seo-crawler",
            s3_access_key_id="minioadmin",
            s3_secret_access_key="minioadmin",
            s3_use_path_style=True,
        )
    )

    asyncio.run(cleaner.delete_run_objects("acme/team", "project", "run"))

    assert client.list_requests == [
        {
            "Bucket": "seo-crawler",
            "Prefix": "crawler/acme%2Fteam/project/run/",
            "MaxKeys": 1000,
        }
    ]
    assert client.delete_requests == [
        {
            "Bucket": "seo-crawler",
            "Delete": {
                "Objects": [
                    {"Key": "crawler/acme%2Fteam/project/run/result.json"},
                    {"Key": ("crawler/acme%2Fteam/project/run/pages/page.html.gz")},
                ],
                "Quiet": True,
            },
        }
    ]


def test_s3_cleaner_reports_partial_delete_failures(monkeypatch: Any) -> None:
    client = FakeS3Client()
    client.delete_errors = [
        {
            "Key": "crawler/acme/project/run/result.json",
            "Code": "AccessDenied",
        }
    ]
    monkeypatch.setattr(
        "app.modules.audit.object_storage.boto3.client",
        lambda **_: client,
    )
    cleaner = S3AuditObjectCleaner(
        Settings(
            app_env="test",
            s3_endpoint_url="http://localhost:9000",
            s3_bucket="seo-crawler",
            s3_access_key_id="minioadmin",
            s3_secret_access_key="minioadmin",
            s3_use_path_style=True,
        )
    )

    with pytest.raises(RuntimeError, match="result.json"):
        asyncio.run(cleaner.delete_run_objects("acme", "project", "run"))


def test_s3_cleaner_deletes_every_object_under_the_project_prefix(
    monkeypatch: Any,
) -> None:
    client = FakeS3Client()
    monkeypatch.setattr(
        "app.modules.audit.object_storage.boto3.client",
        lambda **_: client,
    )
    cleaner = S3AuditObjectCleaner(
        Settings(
            app_env="test",
            s3_endpoint_url="http://localhost:9000",
            s3_bucket="seo-crawler",
            s3_access_key_id="minioadmin",
            s3_secret_access_key="minioadmin",
            s3_use_path_style=True,
        )
    )

    asyncio.run(cleaner.delete_project_objects("acme", "project"))

    assert client.list_requests[0]["Prefix"] == "crawler/acme/project/"
