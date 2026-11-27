import json
from pathlib import Path
import sys
from unittest.mock import Mock

from src.browser import provisioning


def test_retry_requires_same_origin_and_loopback():
    check = provisioning.allows_local_retry
    assert check("127.0.0.1", "127.0.0.1:8100", "http://127.0.0.1:8100", "1")
    assert check("::1", "[::1]:8100", "http://[::1]:8100", "1")
    assert not check("192.168.0.1", "localhost:8100", "http://localhost:8100", "1")
    assert not check("127.0.0.1", "localhost:8100", "https://example.com", "1")
    assert not check("127.0.0.1", "app.example.com", "https://app.example.com", "1")
    assert not check("127.0.0.1", "localhost:8100", "http://localhost:8100", None)


def test_install_only_the_matching_shell_and_keep_private_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(provisioning, "is_managed", lambda: True)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "bundle"), raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "user"))
    monkeypatch.setenv("PLAYWRIGHT_DOWNLOAD_HOST", "https://unrelated.example")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", "some-other-browser-directory")
    provisioning.configure()
    assert Path(provisioning.os.environ["PLAYWRIGHT_BROWSERS_PATH"]) == tmp_path / "user" / "IMAGEX" / "pw"
    registry = provisioning._driver_dir() / "package" / "browsers.json"
    registry.parent.mkdir(parents=True)
    registry.write_text(json.dumps({"browsers": [{"name": "chromium-headless-shell", "revision": "1255"}]}))
    cache = provisioning._cache_dir()
    wrong = cache / "chromium_headless_shell-1234" / "chrome-headless-shell-win64" / "chrome-headless-shell.exe"
    wrong.parent.mkdir(parents=True)
    wrong.touch()
    assert not provisioning._browser_exists(True)

    def download(command, **kwargs):
        assert command[2:] == ["install", "--only-shell", "chromium"]
        assert "PLAYWRIGHT_DOWNLOAD_HOST" not in kwargs["env"]
        assert kwargs["env"]["PLAYWRIGHT_SKIP_BROWSER_GC"] == "1"
        actual = cache / "chromium_headless_shell-1255" / "chrome-headless-shell-win64" / "chrome-headless-shell.exe"
        actual.parent.mkdir(parents=True)
        actual.touch()
        (actual.parent.parent / "INSTALLATION_COMPLETE").touch()
        return Mock(returncode=0)

    fake = Mock(side_effect=download)
    monkeypatch.setattr(provisioning.subprocess, "run", fake)
    provisioning._install(True)
    provisioning._install(True)
    fake.assert_called_once()
    assert wrong.is_file()

