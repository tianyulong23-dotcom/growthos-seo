from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin, urlsplit

from app.modules.content.asset_security import AssetSecurityError, SecureUrlImporter
from app.modules.content.document import normalize_document


LINK_RULESET_VERSION = "article-links-v1"


@dataclass(frozen=True)
class LinkOccurrence:
    link_id: str
    node_id: str
    node_type: str
    start: int
    end: int
    anchor_text: str
    href: str
    target: str | None
    rel: str | None
    title: str | None
    paragraph_key: str


def stable_link_id(
    node_id: str, node_type: str, start: int, end: int, href: str
) -> str:
    payload = json.dumps(
        [node_id, node_type, start, end, href],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "lnk_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def extract_links(document: dict[str, Any]) -> list[LinkOccurrence]:
    normalized = normalize_document(document)
    found: list[LinkOccurrence] = []

    def visit(node: dict[str, Any], parent_key: str) -> None:
        attrs = dict(node.get("attrs") or {})
        node_type = str(node.get("type") or "")
        node_id = str(attrs.get("node_id") or parent_key)
        current_key = node_id if node_type in {"paragraph", "heading", "blockquote"} else parent_key
        if node_type in {"paragraph", "heading", "blockquote", "codeBlock"}:
            offset = 0
            for child in node.get("content", []):
                if child.get("type") != "text":
                    offset += 1 if child.get("type") == "hardBreak" else 0
                    continue
                text = str(child.get("text") or "")
                for mark in child.get("marks", []):
                    if mark.get("type") != "link":
                        continue
                    link_attrs = dict(mark.get("attrs") or {})
                    href = str(link_attrs.get("href") or "")
                    found.append(
                        LinkOccurrence(
                            stable_link_id(node_id, "text", offset, offset + len(text), href),
                            node_id,
                            "text",
                            offset,
                            offset + len(text),
                            text,
                            href,
                            link_attrs.get("target"),
                            link_attrs.get("rel"),
                            link_attrs.get("title"),
                            current_key,
                        )
                    )
                offset += len(text)
        if node_type in {"bookmark", "button"}:
            href = str(attrs.get("url") or attrs.get("href") or "")
            label = str(attrs.get("title") or attrs.get("label") or "")
            found.append(
                LinkOccurrence(
                    stable_link_id(node_id, node_type, 0, len(label), href),
                    node_id,
                    node_type,
                    0,
                    len(label),
                    label,
                    href,
                    attrs.get("target"),
                    attrs.get("rel"),
                    attrs.get("title"),
                    current_key,
                )
            )
        for child in node.get("content", []):
            if child.get("type") != "text":
                visit(child, current_key)

    for index, block in enumerate(normalized.get("content", [])):
        visit(block, f"root-{index}")
    return found


def normalize_domain(value: str | None) -> str:
    raw = (value or "").strip().lower().rstrip(".")
    if "://" in raw:
        raw = (urlsplit(raw).hostname or "").lower().rstrip(".")
    return raw.removeprefix("www.")


def classify_link(href: str, project_domain: str) -> str:
    if href.startswith("/") and not href.startswith("//"):
        return "internal"
    parsed = urlsplit(href)
    hostname = normalize_domain(parsed.hostname)
    domain = normalize_domain(project_domain)
    if hostname and domain and (hostname == domain or hostname.endswith(f".{domain}")):
        return "internal"
    return "external"


def absolute_link(href: str, project_domain: str) -> str:
    if href.startswith("/"):
        return urljoin(f"https://{normalize_domain(project_domain)}/", href)
    return href


async def analyze_links(
    document: dict[str, Any],
    *,
    project_domain: str,
    competitor_domain: str | None,
    importer: SecureUrlImporter,
    check_external: bool = True,
) -> dict[str, Any]:
    links = extract_links(document)
    duplicates: dict[tuple[str, str], int] = {}
    for link in links:
        key = (link.paragraph_key, link.href)
        duplicates[key] = duplicates.get(key, 0) + 1
    checked: dict[str, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []
    checked_at = datetime.now(UTC)
    competitor = normalize_domain(competitor_domain)
    for link in links:
        link_kind = classify_link(link.href, project_domain)
        rel_tokens = set((link.rel or "").split())
        issues: list[dict[str, Any]] = []
        if not link.href:
            issues.append(_issue("empty_href", "error", "链接地址不能为空", "edit_link"))
        if not link.anchor_text.strip():
            issues.append(_issue("empty_anchor", "error", "链接文本不能为空", "edit_link"))
        if link.target == "_blank" and not {"noopener", "noreferrer"}.issubset(rel_tokens):
            issues.append(
                _issue("unsafe_blank_rel", "error", "新窗口链接缺少安全 rel", "edit_link")
            )
        if duplicates.get((link.paragraph_key, link.href), 0) > 1:
            issues.append(
                _issue("duplicate_target", "warning", "同一段落重复链接到相同目标", "focus_link")
            )
        hostname = normalize_domain(urlsplit(absolute_link(link.href, project_domain)).hostname)
        if competitor and (hostname == competitor or hostname.endswith(f".{competitor}")):
            issues.append(
                _issue("competitor_domain", "warning", "链接指向项目竞品域名", "confirm_link")
            )
        probe: dict[str, Any] = {
            "status": "not_checked" if link_kind == "internal" or not check_external else "unknown",
            "status_code": None,
            "final_url": absolute_link(link.href, project_domain),
            "redirect_chain": [],
            "error_code": None,
        }
        target_url = absolute_link(link.href, project_domain)
        if check_external and link_kind == "external":
            cached = checked.get(target_url)
            if cached is None:
                try:
                    response = await importer.probe(target_url)
                    probe = {
                        "status": _probe_status(response.status_code, response.redirect_chain),
                        "status_code": response.status_code,
                        "final_url": response.final_url,
                        "redirect_chain": list(response.redirect_chain),
                        "error_code": None,
                    }
                except AssetSecurityError as exc:
                    probe = {
                        "status": "unknown",
                        "status_code": None,
                        "final_url": target_url,
                        "redirect_chain": [],
                        "error_code": exc.code,
                    }
                checked[target_url] = probe
            else:
                probe = cached
            if probe["status"] == "broken":
                issues.append(_issue("broken_link", "error", "目标返回 4xx", "edit_link"))
            elif probe["status"] == "server_error":
                issues.append(
                    _issue("temporary_server_error", "warning", "目标暂时返回 5xx", "retry_check")
                )
            elif probe["status"] == "unknown":
                issues.append(
                    _issue("check_unknown", "warning", "链接检查未完成，保留上次或未知状态", "retry_check")
                )
        overall = "error" if any(item["severity"] == "error" for item in issues) else "warning" if issues else "passed"
        results.append(
            {
                "link_id": link.link_id,
                "node_id": link.node_id,
                "node_type": link.node_type,
                "start": link.start,
                "end": link.end,
                "anchor_text": link.anchor_text,
                "href": link.href,
                "final_url": probe["final_url"],
                "link_kind": link_kind,
                "target": link.target,
                "rel": link.rel,
                "title": link.title,
                "status": overall,
                "http_status": probe["status"],
                "status_code": probe["status_code"],
                "redirect_chain": probe["redirect_chain"],
                "check_error_code": probe["error_code"],
                "evidence": issues,
                "checked_at": checked_at.isoformat(),
            }
        )
    return {
        "ruleset_version": LINK_RULESET_VERSION,
        "checked_at": checked_at.isoformat(),
        "summary": {
            "total": len(results),
            "internal": sum(item["link_kind"] == "internal" for item in results),
            "external": sum(item["link_kind"] == "external" for item in results),
            "errors": sum(item["status"] == "error" for item in results),
            "warnings": sum(item["status"] == "warning" for item in results),
        },
        "links": results,
    }


def _issue(rule_id: str, severity: str, message: str, action: str) -> dict[str, str]:
    return {
        "rule_id": rule_id,
        "rule_version": "1",
        "severity": severity,
        "message": message,
        "action": action,
    }


def _probe_status(status_code: int, redirects: tuple[str, ...]) -> str:
    if 200 <= status_code < 400:
        return "redirect" if redirects else "ok"
    if 400 <= status_code < 500:
        return "broken"
    if status_code >= 500:
        return "server_error"
    return "unknown"
