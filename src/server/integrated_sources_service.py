"""
Local opt-in source registry for IMAGEX Timeline (Option A).

Keeps all platform adapters and connector definitions available in code while ensuring
clean downloads/clones start with zero pre-installed sources and zero preloaded feeds.
Active source integrations are stored locally in gitignored `data/integrated_sources.json`.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import threading
from typing import Any
from urllib.parse import urlparse

from ..core import runtime_paths
from . import connector_registry
from . import profile_favorites_service

_DEFAULT_INTEGRATED_SOURCES_PATH = runtime_paths.get_app_base_dir() / "data" / "integrated_sources.json"
_STORAGE_LOCK = threading.Lock()
_HOSTNAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
_EXPLICIT_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")

_RESERVED_ROOT_SEGMENTS = frozenset(
    {
        "home",
        "explore",
        "feed",
        "feeds",
        "subscriptions",
        "trending",
        "discover",
        "popular",
        "recent",
        "latest",
        "best",
        "new",
        "verified",
        "videos",
        "photos",
        "albums",
        "gifs",
        "playlists",
        "shorts",
        "search",
        "categories",
        "tags",
        "settings",
        "login",
        "signin",
        "signup",
        "register",
        "about",
        "privacy",
        "terms",
        "help",
        "i",
        "intent",
        "hashtag",
        "notifications",
        "messages",
        "compose",
    }
)

_BUILTIN_PLATFORMS: tuple[dict[str, Any], ...] = (
    {
        "id": "youtube",
        "displayName": "YouTube",
        "originUrl": "https://youtube.com",
        "domains": ("youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"),
        "kind": "builtin",
        "iconKind": "youtube",
    },
    {
        "id": "x",
        "displayName": "X",
        "originUrl": "https://x.com",
        "domains": ("x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"),
        "kind": "builtin",
        "iconKind": "x",
    },
    {
        "id": "pinterest",
        "displayName": "Pinterest",
        "originUrl": "https://pinterest.com",
        "domains": ("pinterest.com", "br.pinterest.com", "pin.it"),
        "kind": "builtin",
        "iconKind": "pinterest",
    },
    {
        "id": "imgur",
        "displayName": "Imgur",
        "originUrl": "https://imgur.com",
        "domains": ("imgur.com", "i.imgur.com"),
        "kind": "builtin",
        "iconKind": "imgur",
    },
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_integrated_sources_path() -> Path:
    override = (os.environ.get("IMAGEX_INTEGRATED_SOURCES_FILE") or "").strip()
    if override:
        return Path(override)
    return runtime_paths.get_app_base_dir() / "data" / "integrated_sources.json"


def _clean_host(raw_host: str) -> str:
    host = (raw_host or "").strip().lower().split(":", 1)[0]
    if host.startswith("www."):
        host = host[4:]
    return host


def _host_matches_domain(host: str, domain: str) -> bool:
    clean_d = _clean_host(domain)
    if not clean_d:
        return False
    return host == clean_d or host.endswith(f".{clean_d}")


def _normalize_source_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    sid = str(raw.get("id") or raw.get("sourceId") or "").strip().lower()
    if not sid:
        return None
    adapter = connector_registry.get_native_adapter(sid)
    if adapter is not None:
        sid = adapter.id
    display_name = adapter.display_name if adapter else str(raw.get("displayName") or sid.title()).strip() or sid
    origin_url = adapter.origin_url if adapter else str(raw.get("originUrl") or f"https://{sid}.com").strip()
    kind = "builtin" if adapter else str(raw.get("kind") or "builtin").strip() or "builtin"
    domains = list(adapter.domains) if adapter else [str(d).strip().lower() for d in (raw.get("domains") or []) if str(d).strip()]
    return {
        "id": sid,
        "displayName": display_name,
        "originUrl": origin_url,
        "domains": domains,
        "kind": kind,
        "addedVia": str(raw.get("addedVia") or origin_url).strip(),
        "integratedAt": str(raw.get("integratedAt") or _now_iso()).strip(),
    }


def _atomic_write_payload(path: Path, sources: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".json.tmp")
    payload = {
        "version": 1,
        "updatedAt": _now_iso(),
        "sources": sources,
    }
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def _native_catalog_entry(adapter: connector_registry.NativeAdapter) -> dict[str, Any]:
    return {
        "id": adapter.id, "displayName": adapter.display_name, "originUrl": adapter.origin_url,
        "domains": adapter.domains, "kind": "builtin", "iconKind": "connector",
    }


def _builtin_lookup() -> dict[str, dict[str, Any]]:
    return {
        **{item["id"]: item for item in _BUILTIN_PLATFORMS},
        **{row.id: _native_catalog_entry(row) for row in connector_registry.load_connector_bundle().native_adapters},
    }


def _find_catalog_entry(source_id: str) -> dict[str, Any] | None:
    sid = (source_id or "").strip().lower()
    adapter = connector_registry.get_native_adapter(sid)
    if adapter is not None:
        return _native_catalog_entry(adapter)
    builtins = _builtin_lookup()
    if sid in builtins:
        return builtins[sid]
    conn = connector_registry.get_connector_descriptor(sid)
    if conn is not None:
        return {
            "id": conn.id,
            "displayName": conn.display_name,
            "originUrl": conn.effective_base_url() or f"https://{conn.id}",
            "domains": tuple(conn.domains),
            "kind": "connector",
            "iconKind": getattr(conn, "icon_kind", "connector"),
        }
    return None


def _migrate_from_existing_favorites() -> list[dict[str, Any]]:
    """
    On local machines upgrading with saved creators in favorite_profiles.json,
    seed only the sites explicitly referenced by saved profiles (never un-added defaults).
    Fresh clones without favorite_profiles.json get [].
    """
    fav_path = profile_favorites_service.FAVORITES_FILE
    if not isinstance(fav_path, Path):
        fav_path = Path(str(fav_path))
    if not fav_path.exists():
        return []
    try:
        saved = profile_favorites_service.load_favorite_profiles(strict=True)
    except Exception:
        return []
    seen_ids: set[str] = set()
    migrated: list[dict[str, Any]] = []
    for entry in saved:
        if not isinstance(entry, dict):
            continue
        raw_site = str(entry.get("site") or "").strip().lower()
        raw_url = str(entry.get("url") or "").strip()
        if not raw_site and raw_url:
            match = resolve_integration_url(raw_url)
            if match.get("supported"):
                raw_site = str(match.get("sourceId") or "").strip().lower()
        if not raw_site or raw_site in seen_ids:
            continue
        meta = _find_catalog_entry(raw_site) or {
            "id": raw_site,
            "displayName": raw_site.title(),
            "originUrl": f"https://{raw_site}.com",
            "domains": (),
            "kind": "builtin",
        }
        norm = _normalize_source_record(
            {
                "id": meta["id"],
                "displayName": meta["displayName"],
                "originUrl": meta["originUrl"],
                "domains": list(meta.get("domains") or ()),
                "kind": meta.get("kind", "builtin"),
                "addedVia": raw_url or meta["originUrl"],
                "integratedAt": _now_iso(),
            }
        )
        if norm is not None:
            seen_ids.add(norm["id"])
            migrated.append(norm)
    return migrated


def _read_locked(path: Path) -> list[dict[str, Any]]:
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return []
        raw_list = raw.get("sources") if isinstance(raw, dict) else raw
        if not isinstance(raw_list, list):
            return []
        cleaned: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            norm = _normalize_source_record(item)
            if norm and norm["id"] not in seen:
                seen.add(norm["id"])
                cleaned.append(norm)
        return cleaned

    migrated = _migrate_from_existing_favorites()
    if migrated:
        _atomic_write_payload(path, migrated)
    return migrated


def load_integrated_sources() -> list[dict[str, Any]]:
    path = get_integrated_sources_path()
    with _STORAGE_LOCK:
        return _read_locked(path)


def get_integrated_source_ids() -> set[str]:
    return {item["id"] for item in load_integrated_sources()}


def list_supported_integration_catalog() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in _builtin_lookup().values():
        seen.add(item["id"])
        out.append(
            {
                "id": item["id"],
                "displayName": item["displayName"],
                "originUrl": item["originUrl"],
                "domains": list(item["domains"]),
                "kind": item["kind"],
                "iconKind": item["iconKind"],
            }
        )
    for conn in (
        *connector_registry.list_catalog_descriptors(),
        *connector_registry.list_forum_descriptors(),
        *connector_registry.list_video_portal_descriptors(),
    ):
        if conn.id in seen:
            continue
        seen.add(conn.id)
        out.append(
            {
                "id": conn.id,
                "displayName": conn.display_name,
                "originUrl": conn.effective_base_url(),
                "domains": list(conn.domains),
                "kind": "connector",
                "iconKind": getattr(conn, "icon_kind", "connector"),
            }
        )
    return out


def _normalize_http_url(raw_url: str) -> str | None:
    text = (raw_url or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return None
    if _EXPLICIT_SCHEME_RE.match(text):
        lower = text.lower()
        if not (lower.startswith("http://") or lower.startswith("https://")):
            return None
    else:
        if "." not in text.split("/", 1)[0]:
            return None
        text = f"https://{text}"

    try:
        parsed = urlparse(text)
    except Exception:
        return None
    if parsed.scheme not in {"http", "https"}:
        return None
    host = _clean_host(parsed.netloc)
    if not host or not _HOSTNAME_RE.match(host):
        return None
    return parsed.geturl()


def _extract_profile_hint(
    source_id: str,
    normalized_url: str,
    connector: Any | None = None,
) -> tuple[str, str | None]:
    parsed = urlparse(normalized_url)
    segments = [seg for seg in parsed.path.split("/") if seg]
    if not segments:
        return ("network", None)

    first = segments[0].lower()
    if first in _RESERVED_ROOT_SEGMENTS:
        return ("network", None)

    if connector is not None:
        url_hints = dict(getattr(connector, "url_hints", {}) or {})
        entity_prefixes = [str(p).strip("/").lower() for p in (url_hints.get("entityPrefixes") or [])]
        if first in entity_prefixes and len(segments) >= 2:
            handle = segments[1].lstrip("@")
            return ("profile", f"@{handle}" if handle else None)
        if parsed.path.strip("/") in {"", "popular", "recent", "latest", "best", "verified"}:
            return ("network", None)
        return ("profile", f"@{segments[-1].lstrip('@')}")

    if source_id == "youtube":
        if first.startswith("@"):
            return ("profile", segments[0])
        if first in {"channel", "c", "user"} and len(segments) >= 2:
            return ("profile", segments[1] if segments[1].startswith("@") else f"@{segments[1]}")
        return ("network", None)

    if source_id == "x":
        handle = segments[0].lstrip("@")
        return ("profile", f"@{handle}" if handle else None)

    if source_id == "pinterest":
        handle = segments[0].lstrip("@")
        return ("profile", f"@{handle}" if handle else None)

    if source_id == "imgur":
        if first == "user" and len(segments) >= 2:
            return ("profile", f"@{segments[1].lstrip('@')}")
        if len(segments) >= 1 and first not in {"t", "r", "gallery", "a"}:
            return ("profile", f"@{segments[0].lstrip('@')}")
        return ("network", None)

    if first in {"profile", "profiles", "channel", "channels", "model", "models", "users", "creator", "creators", "artists"} and len(segments) >= 2:
        return ("profile", f"@{segments[1].lstrip('@')}")

    return ("network", None)


def resolve_integration_url(raw_url: str) -> dict[str, Any]:
    normalized = _normalize_http_url(raw_url)
    if not normalized:
        return {
            "ok": False,
            "matched": False,
            "supported": False,
            "reason": "invalid_url",
        }

    parsed = urlparse(normalized)
    host = _clean_host(parsed.netloc)

    adapter = connector_registry.native_adapter_for_url(normalized)
    if adapter is not None:
        level, handle = _extract_profile_hint(adapter.id, normalized)
        if level == "network" and any(pattern.fullmatch(parsed.path) for pattern in adapter.profile_paths):
            segments = [part for part in parsed.path.split("/") if part]
            level, handle = "profile", ("@" + segments[1].lstrip("@")) if len(segments) > 1 else None
        return {
            **_native_catalog_entry(adapter), "ok": True, "matched": True, "supported": True,
            "sourceId": adapter.id, "level": level, "targetUrl": normalized,
            "suggestedHandle": handle,
        }
    connector = connector_registry.find_connector_for_url(normalized)
    if connector is not None:
        level, handle = _extract_profile_hint(connector.id, normalized, connector=connector)
        return {
            "ok": True,
            "matched": True,
            "supported": True,
            "sourceId": connector.id,
            "displayName": connector.display_name,
            "kind": "connector",
            "originUrl": connector.effective_base_url(),
            "domains": list(connector.domains) or [host],
            "level": level,
            "targetUrl": normalized,
            "suggestedHandle": handle,
            "iconKind": getattr(connector, "icon_kind", "connector"),
        }

    for entry in _BUILTIN_PLATFORMS:
        if any(_host_matches_domain(host, domain) for domain in entry["domains"]):
            level, handle = _extract_profile_hint(entry["id"], normalized)
            return {
                "ok": True,
                "matched": True,
                "supported": True,
                "sourceId": entry["id"],
                "displayName": entry["displayName"],
                "kind": "builtin",
                "originUrl": entry["originUrl"],
                "domains": list(entry["domains"]),
                "level": level,
                "targetUrl": normalized,
                "suggestedHandle": handle,
                "iconKind": entry["iconKind"],
            }

    return {
        "ok": False,
        "matched": False,
        "supported": False,
        "host": host,
        "targetUrl": normalized,
        "reason": "unsupported_domain",
    }


def integrate_url(raw_url: str) -> dict[str, Any]:
    resolved = resolve_integration_url(raw_url)
    path = get_integrated_sources_path()
    with _STORAGE_LOCK:
        current = _read_locked(path)
        if not resolved.get("ok") or not resolved.get("supported"):
            return {
                "ok": False,
                "matched": False,
                "supported": bool(resolved.get("supported")),
                "reason": resolved.get("reason", "unsupported_domain"),
                "host": resolved.get("host"),
                "sources": current,
            }

        source_id = str(resolved["sourceId"]).lower()
        existing = next((row for row in current if row["id"] == source_id), None)
        already_integrated = existing is not None
        if not already_integrated:
            new_row = _normalize_source_record(
                {
                    "id": source_id,
                    "displayName": resolved["displayName"],
                    "originUrl": resolved["originUrl"],
                    "domains": resolved.get("domains") or [],
                    "kind": resolved.get("kind") or "builtin",
                    "addedVia": resolved["targetUrl"],
                    "integratedAt": _now_iso(),
                }
            )
            if new_row is not None:
                current = [*current, new_row]
                _atomic_write_payload(path, current)

        integration_payload = {
            **resolved,
            "alreadyIntegrated": already_integrated,
        }
        return {
            "ok": True,
            "matched": True,
            "supported": True,
            "integration": integration_payload,
            "sources": current,
        }


def remove_integrated_source(source_id: str) -> list[dict[str, Any]]:
    sid = (source_id or "").strip().lower()
    path = get_integrated_sources_path()
    with _STORAGE_LOCK:
        current = _read_locked(path)
        updated = [row for row in current if row["id"] != sid]
        _atomic_write_payload(path, updated)
        return updated


def clear_integrated_sources() -> list[dict[str, Any]]:
    path = get_integrated_sources_path()
    with _STORAGE_LOCK:
        _atomic_write_payload(path, [])
        return []
