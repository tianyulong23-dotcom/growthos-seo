from io import BytesIO

from botocore.exceptions import ClientError

from app.core.config import Settings
from app.modules.projects.object_storage import S3SiteIconReader


class FakeS3Client:
    def __init__(self, response: dict | Exception) -> None:
        self.response = response
        self.requests: list[dict] = []

    def get_object(self, **request: str) -> dict:
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def test_site_icon_reader_reads_the_project_run_object(monkeypatch) -> None:
    client = FakeS3Client(
        {
            "Body": BytesIO(b"icon"),
            "ContentType": "image/svg+xml",
        }
    )
    monkeypatch.setattr(
        "app.modules.projects.object_storage.boto3.client",
        lambda **_: client,
    )
    reader = S3SiteIconReader(
        Settings(
            app_env="test",
            s3_bucket="bucket",
            s3_endpoint_url="http://minio:9000",
        )
    )

    import asyncio

    icon = asyncio.run(reader.read_site_icon("org", "project", "run"))

    assert icon is not None
    assert icon.body == b"icon"
    assert icon.content_type == "image/svg+xml"
    assert client.requests == [
        {
            "Bucket": "bucket",
            "Key": "crawler/org/project/run/site-icon",
        }
    ]


def test_site_icon_reader_returns_none_for_missing_object(monkeypatch) -> None:
    error = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "missing"}},
        "GetObject",
    )
    monkeypatch.setattr(
        "app.modules.projects.object_storage.boto3.client",
        lambda **_: FakeS3Client(error),
    )
    reader = S3SiteIconReader(Settings(app_env="test"))

    import asyncio

    assert asyncio.run(reader.read_site_icon("org", "project", "run")) is None
