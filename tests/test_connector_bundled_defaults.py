"""Bundled default connectors must work out of the box, without any user-provided file."""
from __future__ import annotations

import json
from pathlib import Path
import sys

from src.core import runtime_paths
from src.server import connector_registry


def _catalog(sid: str, name: str, host: str) -> dict:
    return {"id": sid, "displayName": name, "baseUrl": f"https://{host}", "domains": [host]}


def _write(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_frozen_executable_loads_connectors_shipped_inside_bundle(tmp_path: Path, monkeypatch):
    bundle_dir = tmp_path / "bundle"
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    _write(bundle_dir / "config" / "connectors.local.json", {"catalogs": [_catalog("cat_shipped", "Shipped", "portal.example")]})

    monkeypatch.delenv("IMAGEX_CONNECTORS_FILE", raising=False)
    monkeypatch.delenv("IMAGEX_BUNDLED_CONNECTORS_FILE", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle_dir), raising=False)
    monkeypatch.setattr(runtime_paths, "get_app_base_dir", lambda: app_dir)
    connector_registry.clear_connector_cache()

    found = connector_registry.find_connector_for_url("https://portal.example/artists/jane/")
    assert found is not None and found.id == "cat_shipped"
    # The user's writable file stays next to the executable, never inside the read-only bundle.
    assert connector_registry.get_writable_connectors_path() == app_dir / "config" / "connectors.local.json"


def test_user_connectors_merge_over_bundled_defaults(tmp_path: Path, monkeypatch):
    bundled = _write(
        tmp_path / "bundled.json",
        {
            "catalogs": [
                _catalog("cat_shared", "Bundled Name", "shared.example"),
                _catalog("cat_default", "Default Only", "default.example"),
            ]
        },
    )
    user = _write(
        tmp_path / "user.json",
        {
            "catalogs": [_catalog("cat_shared", "User Name", "shared.example")],
            "forums": [{"id": "board_user", "displayName": "Board", "baseUrl": "https://board.example", "domains": ["board.example"]}],
        },
    )
    monkeypatch.setenv("IMAGEX_BUNDLED_CONNECTORS_FILE", str(bundled))
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(user))
    connector_registry.clear_connector_cache()

    catalogs = {c.id: c for c in connector_registry.list_catalog_descriptors()}
    assert set(catalogs) == {"cat_shared", "cat_default"}
    assert catalogs["cat_shared"].display_name == "User Name"
    assert [f.id for f in connector_registry.list_forum_descriptors()] == ["board_user"]


def test_bundled_defaults_apply_when_user_file_is_missing(tmp_path: Path, monkeypatch):
    bundled = _write(tmp_path / "bundled.json", {"catalogs": [_catalog("cat_default", "Default", "default.example")]})
    monkeypatch.setenv("IMAGEX_BUNDLED_CONNECTORS_FILE", str(bundled))
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(tmp_path / "missing.json"))
    connector_registry.clear_connector_cache()

    assert [c.id for c in connector_registry.list_catalog_descriptors()] == ["cat_default"]


def test_user_file_changes_are_picked_up_on_top_of_bundled_defaults(tmp_path: Path, monkeypatch):
    bundled = _write(tmp_path / "bundled.json", {"catalogs": [_catalog("cat_default", "Default", "default.example")]})
    user_path = tmp_path / "user.json"
    monkeypatch.setenv("IMAGEX_BUNDLED_CONNECTORS_FILE", str(bundled))
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(user_path))
    connector_registry.clear_connector_cache()
    assert [c.id for c in connector_registry.list_catalog_descriptors()] == ["cat_default"]

    _write(user_path, {"catalogs": [_catalog("cat_found", "Found", "found.example")]})
    ids = {c.id for c in connector_registry.list_catalog_descriptors()}
    assert ids == {"cat_default", "cat_found"}
