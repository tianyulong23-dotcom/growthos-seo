import asyncio
from typing import Protocol
from urllib.parse import quote

import boto3
from botocore.config import Config

from app.core.config import Settings


class AuditObjectCleaner(Protocol):
    async def delete_run_objects(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> None: ...


class NoopAuditObjectCleaner:
    async def delete_run_objects(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> None:
        return None


class S3AuditObjectCleaner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def delete_run_objects(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> None:
        prefix = "/".join(
            (
                "crawler",
                quote(organization_id.strip(), safe=""),
                quote(project_id.strip(), safe=""),
                quote(run_id.strip(), safe=""),
                "",
            )
        )
        await asyncio.to_thread(self._delete_prefix, prefix)

    def _delete_prefix(self, prefix: str) -> None:
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

        continuation_token: str | None = None
        while True:
            request: dict = {
                "Bucket": self.settings.s3_bucket,
                "Prefix": prefix,
                "MaxKeys": 1000,
            }
            if continuation_token:
                request["ContinuationToken"] = continuation_token
            response = client.list_objects_v2(**request)
            objects = [{"Key": item["Key"]} for item in response.get("Contents", [])]
            if objects:
                client.delete_objects(
                    Bucket=self.settings.s3_bucket,
                    Delete={"Objects": objects, "Quiet": True},
                )
            if not response.get("IsTruncated"):
                return
            continuation_token = response.get("NextContinuationToken")
