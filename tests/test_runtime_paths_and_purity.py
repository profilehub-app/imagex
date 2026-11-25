from __future__ import annotations

import base64
from pathlib import Path
import sys

from src.core import runtime_paths
from src.server import connector_registry, integrated_sources_service


def test_get_app_base_dir_frozen_strips_dist(tmp_path: Path, monkeypatch):
    dist_dir = tmp_path / "dist"
    dist_dir.mkdir(parents=True)
    fake_exe = dist_dir / "IMAGEX.exe"
    fake_exe.write_text("", encoding="utf-8")

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(fake_exe))

    assert runtime_paths.get_app_base_dir() == tmp_path.resolve()


def test_get_app_base_dir_frozen_direct_folder(tmp_path: Path, monkeypatch):
    fake_exe = tmp_path / "IMAGEX.exe"
    fake_exe.write_text("", encoding="utf-8")

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(fake_exe))

    assert runtime_paths.get_app_base_dir() == tmp_path.resolve()


def test_connector_and_integrated_paths_use_runtime_base_dir(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("IMAGEX_CONNECTORS_FILE", raising=False)
    monkeypatch.delenv("IMAGEX_INTEGRATED_SOURCES_FILE", raising=False)
    monkeypatch.setattr(runtime_paths, "get_app_base_dir", lambda: tmp_path)

    assert connector_registry.get_default_local_connectors_path() == tmp_path / "config" / "connectors.local.json"
    assert integrated_sources_service.get_integrated_sources_path() == tmp_path / "data" / "integrated_sources.json"


def test_purity_scanner_detects_forbidden_tokens_and_passes_clean_files(tmp_path: Path):
    import scripts.audit_public_purity as purity

    clean = tmp_path / "clean.py"
    clean.write_text('BASE = "https://portal.example/videos"\n', encoding="utf-8")

    dirty = tmp_path / "dirty.py"
    sample_token = base64.b64decode(purity._FORBIDDEN_TOKENS_B64[0]).decode("utf-8")
    dirty.write_text(f'SITE = "{sample_token}.example"\n', encoding="utf-8")

    assert purity.scan_paths([clean], tmp_path) == []
    flagged = purity.scan_paths([clean, dirty], tmp_path)
    assert flagged == [("dirty.py", 1)]
