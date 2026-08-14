import base64
import hashlib
import hmac
import json
import unittest
from datetime import UTC, datetime
from pathlib import Path

from app.core.platform_request_context import (
    PLATFORM_CONTEXT_HEADER,
    PLATFORM_CONTEXT_SIGNATURE_HEADER,
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformCollectionContext,
    ResolvedPlatformRequestContext,
    issue_platform_request_context_v1,
    strip_untrusted_platform_context_headers,
)


TEST_SIGNING_KEY = b"test-only-platform-context-key-32-bytes"
NOW = datetime(2026, 7, 23, 9, 30, tzinfo=UTC)


class PlatformRequestContextProducerTest(unittest.TestCase):
    def test_strips_browser_context_and_signs_only_resolved_platform_facts(self) -> None:
        forwarded = strip_untrusted_platform_context_headers(
            {
                "Authorization": "Bearer public-session",
                "X-GrowthOS-Platform-Context": "browser-forged-context",
                "x-growthos-platform-context-signature": "v1=browser-forged-signature",
            }
        )
        self.assertEqual(forwarded, {"Authorization": "Bearer public-session"})

        resolved = ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="user-arch-004",
                session_id="session-arch-004",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="org-authoritative",
                workspace_id="workspace-authoritative",
            ),
            project=PlatformProject(
                website_project_id="project-authoritative",
                website_project_key="project-key",
            ),
            permissions=("backlinks:read", "backlinks:write"),
            correlation_id="correlation-arch-004",
        )

        headers = issue_platform_request_context_v1(
            resolved,
            signing_key=TEST_SIGNING_KEY,
            now=NOW,
        )
        encoded_payload = headers[PLATFORM_CONTEXT_HEADER]
        payload = json.loads(
            base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
        )

        self.assertEqual(payload["version"], "PlatformRequestContext.v1")
        self.assertEqual(payload["issuer"], "growthos-platform-gateway")
        self.assertEqual(payload["audience"], "growthos-backlinks-core")
        self.assertEqual(payload["tenant"]["organizationId"], "org-authoritative")
        self.assertEqual(payload["project"]["websiteProjectId"], "project-authoritative")
        self.assertEqual(payload["project"]["websiteProjectKey"], "project-key")
        self.assertEqual(payload["issuedAt"], "2026-07-23T09:30:00.000Z")
        self.assertEqual(payload["expiresAt"], "2026-07-23T09:30:30.000Z")

        expected_signature = hmac.new(
            TEST_SIGNING_KEY,
            f"PlatformRequestContext.v1.{encoded_payload}".encode(),
            hashlib.sha256,
        ).digest()
        expected_encoded_signature = base64.urlsafe_b64encode(
            expected_signature
        ).rstrip(b"=").decode()
        self.assertEqual(
            headers[PLATFORM_CONTEXT_SIGNATURE_HEADER],
            f"v1={expected_encoded_signature}",
        )

    def test_contract_schema_locks_required_context_dimensions(self) -> None:
        schema_path = (
            Path(__file__).parents[2]
            / "contracts"
            / "json-schema"
            / "platform-request-context.v1.schema.json"
        )
        schema = json.loads(schema_path.read_text(encoding="utf-8"))

        self.assertEqual(
            schema["properties"]["version"]["const"],
            "PlatformRequestContext.v1",
        )
        self.assertEqual(schema["additionalProperties"], False)
        self.assertEqual(
            set(schema["required"]),
            {
                "version",
                "issuer",
                "audience",
                "issuedAt",
                "expiresAt",
                "correlationId",
                "actor",
                "tenant",
                "project",
                "permissions",
            },
        )

    def test_signs_collection_context_without_a_project(self) -> None:
        resolved = ResolvedPlatformCollectionContext(
            actor=PlatformActor("user-1", "session-1", ("member",)),
            tenant=PlatformTenant("org-1", "workspace-1"),
            permissions=("backlinks:read",),
            correlation_id="correlation-1",
        )

        headers = issue_platform_request_context_v1(
            resolved,
            signing_key=TEST_SIGNING_KEY,
            now=NOW,
        )
        encoded_payload = headers[PLATFORM_CONTEXT_HEADER]
        payload = json.loads(
            base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
        )

        self.assertIsNone(payload["project"])

    def test_rejects_unsafe_signing_and_expiry_inputs(self) -> None:
        resolved = ResolvedPlatformRequestContext(
            actor=PlatformActor("user-1", "session-1", ("member",)),
            tenant=PlatformTenant("org-1", "workspace-1"),
            project=PlatformProject("project-1", "project-key"),
            permissions=("backlinks:read",),
            correlation_id="correlation-1",
        )

        with self.assertRaises(ValueError):
            issue_platform_request_context_v1(
                resolved,
                signing_key=b"too-short",
                now=NOW,
            )
        with self.assertRaises(ValueError):
            issue_platform_request_context_v1(
                resolved,
                signing_key=TEST_SIGNING_KEY,
                now=NOW,
                ttl_seconds=61,
            )


if __name__ == "__main__":
    unittest.main()
