import asyncio
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import Settings


@dataclass(frozen=True)
class StoredSiteIcon:
    body: bytes
    content_type: str


class SiteIconReader(Protocol):
    async def read_site_icon(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> StoredSiteIcon | None: ...


class S3SiteIconReader:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def read_site_icon(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> StoredSiteIcon | None:
        key = "/".join(
            (
                "crawler",
                quote(organization_id.strip(), safe=""),
                quote(project_id.strip(), safe=""),
                quote(run_id.strip(), safe=""),
                "site-icon",
            )
        )
        return await asyncio.to_thread(self._read_object, key)

    def _read_object(self, key: str) -> StoredSiteIcon | None:
        client_options: dict = {
            "service_name": "s3",
            "region_name": self.settings.s3_region,
            "config": Config(
                s3={
                    "addressing_style": (
                        "path" if self.settings.s3_use_path_style else "auto"
                    )
                }
            ),
        }
        if self.settings.s3_endpoint_url:
            client_options["endpoint_url"] = self.settings.s3_endpoint_url
        if self.settings.s3_access_key_id and self.settings.s3_secret_access_key:
            client_options["aws_access_key_id"] = self.settings.s3_access_key_id
            client_options["aws_secret_access_key"] = self.settings.s3_secret_access_key
        client = boto3.client(**client_options)

        try:
            response = client.get_object(Bucket=self.settings.s3_bucket, Key=key)
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in {"NoSuchKey", "NoSuchObject", "404"}:
                return None
            raise

        return StoredSiteIcon(
            body=response["Body"].read(),
            content_type=response.get("ContentType") or "application/octet-stream",
        )
