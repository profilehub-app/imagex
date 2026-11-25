"""
Unit tests for IMAGEX Auto-Update Engine & Endpoints.
"""
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from src.server.server import app, APP_VERSION
from src.updater.updater import (
    parse_version,
    check_for_updates,
    get_update_status,
    apply_update_async,
    get_repo_name,
    is_git_repo
)


@pytest.fixture
def client():
    return TestClient(app)


def test_parse_version():
    """Validates semver extraction and tuple comparisons."""
    assert parse_version("v5.5.0") == (5, 5, 0)
    assert parse_version("5.5.0") == (5, 5, 0)
    assert parse_version("v5.6.0") > parse_version("v5.5.0")
    assert parse_version("v6.0.0") > parse_version("v5.9.9")
    assert parse_version("invalid") == (0, 0, 0)
    assert parse_version("") == (0, 0, 0)


def test_get_repo_name():
    """Validates default or detected repository string."""
    repo = get_repo_name()
    assert isinstance(repo, str)
    assert "/" in repo


def test_get_repo_name_frozen_uses_profilehub_default(monkeypatch):
    """Frozen executables must default to profilehub-app/imagex without legacy owner fallback."""
    monkeypatch.delenv("IMAGEX_GITHUB_REPO", raising=False)
    with patch("src.updater.updater.is_frozen", return_value=True):
        assert get_repo_name() == "profilehub-app/imagex"


def test_get_repo_name_honors_env_override_when_frozen(monkeypatch):
    """Frozen executables honor IMAGEX_GITHUB_REPO overrides."""
    monkeypatch.setenv("IMAGEX_GITHUB_REPO", "profilehub/custom-imagex")
    with patch("src.updater.updater.is_frozen", return_value=True):
        assert get_repo_name() == "profilehub/custom-imagex"


@pytest.mark.parametrize("bad_slug", ["../evil", "owner/..", "./.", "owner/repo.git", ".hidden/repo", "https://github.com/a/b"])
def test_get_repo_name_rejects_dot_segments_and_invalid_env(monkeypatch, bad_slug):
    """Dot segments and malformed IMAGEX_GITHUB_REPO values fall back safely."""
    monkeypatch.setenv("IMAGEX_GITHUB_REPO", bad_slug)
    with patch("src.updater.updater.is_frozen", return_value=True):
        assert get_repo_name() == "profilehub-app/imagex"


def test_api_health_version(client):
    """Verifies /api/health exposes the current APP_VERSION."""
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["version"] == APP_VERSION


def test_api_updates_check_mock(client):
    """Verifies /api/updates/check contract with mocked GitHub API response."""
    major, minor, patch_number = parse_version(APP_VERSION)
    latest_version = f"v{major}.{minor}.{patch_number + 1}"
    release_name = f"IMAGEX {latest_version}"
    mock_gh_response = {
        "tag_name": latest_version,
        "name": release_name,
        "body": "### Features\n- Autonomous updater\n- High speed streaming",
        "published_at": "2026-10-27T20:00:00Z",
        "html_url": f"https://example.com/releases/{latest_version}"
    }

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_cm = MagicMock()
        mock_cm.read.return_value = str(mock_gh_response).replace("'", '"').encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_cm

        res = client.get("/api/updates/check?force=true")
        assert res.status_code == 200
        data = res.json()
        assert data["update_available"] is True
        assert data["latest_version"] == latest_version
        assert data["release_name"] == release_name
        assert "release_notes" in data


def test_api_updates_status(client):
    """Verifies /api/updates/status returns valid state structure."""
    res = client.get("/api/updates/status")
    assert res.status_code == 200
    data = res.json()
    assert "status" in data
    assert "progress" in data
    assert "logs" in data
    assert isinstance(data["logs"], list)


def test_api_updates_apply_mock(client):
    """Verifies /api/updates/apply triggers async background updater."""
    with patch("src.updater.updater._execute_update_sequence"):
        res = client.post("/api/updates/apply")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] in ("started", "in_progress")
