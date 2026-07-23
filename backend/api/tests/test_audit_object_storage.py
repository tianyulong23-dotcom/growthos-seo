import asyncio
from typing import Any

from app.core.config import Settings
from app.modules.audit.object_storage import S3AuditObjectCleaner


class FakeS3Client:
    def __init__(self) -> None:
        self.list_requests: list[dict[str, Any]] = []
        self.delete_requests: list[dict[str, Any]] = []

    def list_objects_v2(self, **request: Any) -> dict[str, Any]:
        self.list_requests.append(request)
        return {
            "Contents": [
                {"Key": f"{request['Prefix']}result.json"},
                {"Key": f"{request['Prefix']}pages/page.html.gz"},
            ],
            "IsTruncated": False,
        }

    def delete_objects(self, **request: Any) -> None:
        self.delete_requests.append(request)


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
                    {
                        "Key": (
                            "crawler/acme%2Fteam/project/run/pages/page.html.gz"
                        )
                    },
                ],
                "Quiet": True,
            },
        }
    ]
