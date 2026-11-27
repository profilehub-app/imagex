"""Provision the exact Playwright Chromium revision in a private Windows cache."""
import asyncio
from ipaddress import ip_address
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
from threading import Lock, Thread
from urllib.parse import urlsplit

log = logging.getLogger(__name__)
_install_lock = Lock()
_state_lock = Lock()
_thread = None
_state = "starting"
_timeout = 600


def is_managed():
    return sys.platform == "win32" and getattr(sys, "frozen", False)


def _driver_dir():
    return Path(sys._MEIPASS) / "playwright" / "driver"


def _bundled_dir():
    return Path(sys._MEIPASS) / "b"


def _cache_dir():
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    return local / "IMAGEX" / "pw"


def configure():
    if is_managed():
        browser_dir = _bundled_dir() if _bundled_dir().is_dir() else _cache_dir()
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(browser_dir)
        os.environ["PLAYWRIGHT_NODEJS_PATH"] = str(_driver_dir() / "node.exe")


def _browser_exists(headless):
    name = "chromium-headless-shell" if headless else "chromium"
    pattern = "chrome-headless-shell-win*/chrome-headless-shell.exe" if headless else "chrome-win*/chrome.exe"
    registry = _driver_dir() / "package" / "browsers.json"
    browsers = json.loads(registry.read_text(encoding="utf-8"))["browsers"]
    revision = next(x["revision"] for x in browsers if x["name"] == name)
    if not re.fullmatch(r"[0-9]+", revision):
        raise ValueError("Invalid Playwright browser revision")
    root = Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]) / f"{name.replace('-', '_')}-{revision}"
    return (root / "INSTALLATION_COMPLETE").is_file() and any(p.is_file() for p in root.glob(pattern))


def _install(headless):
    with _install_lock:
        if _browser_exists(headless):
            return
        if _bundled_dir().is_dir():
            raise RuntimeError("Incomplete offline Chromium package")
        driver = _driver_dir()
        env = os.environ.copy()
        # Use the distribution service configured by Playwright, never an app-provided URL.
        env.pop("PLAYWRIGHT_DOWNLOAD_HOST", None)
        env.pop("PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", None)
        env["PLAYWRIGHT_SKIP_BROWSER_GC"] = "1"
        command = [str(driver / "node.exe"), str(driver / "package" / "cli.js"), "install"]
        if headless:
            command.append("--only-shell")
        command.append("chromium")
        result = subprocess.run(command, env=env, capture_output=True, text=True,
                                errors="replace", timeout=_timeout,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode or not _browser_exists(headless):
            log.warning("Playwright installer failed (code %s)", result.returncode)
            raise RuntimeError("Playwright Chromium could not be installed")


def snapshot():
    if not is_managed():
        return {"phase": "unmanaged"}
    with _state_lock:
        return {"phase": _state}


def _prepare():
    global _state
    try:
        _install(True)
    except Exception as exc:
        log.warning("Chromium preparation failed: %s", type(exc).__name__)
        phase = "failed"
    else:
        phase = "ready"
    with _state_lock:
        _state = phase


def prepare(*, retry=False):
    global _thread, _state
    if not is_managed():
        return snapshot()
    with _state_lock:
        if _state == "ready" or (_state == "failed" and not retry) or (_thread and _thread.is_alive()):
            return {"phase": _state}
        _state = "preparing"
        _thread = Thread(target=_prepare, name="imagex-chromium-setup", daemon=True)
        _thread.start()
        return {"phase": _state}


async def require_browser(*, headless=True, wait=False):
    if not is_managed():
        return
    if headless and not wait:
        phase = prepare()["phase"]
        if phase != "ready":
            raise RuntimeError("Chromium is not ready. See the ImageX setup notice and retry.")
        return
    # Explicit headed operation or a self-test: wait in a worker, never on the UI loop.
    await asyncio.to_thread(_install, headless)


def allows_local_retry(client, host, origin, marker):
    """Only the same-origin desktop UI may restart a failed setup."""
    if marker != "1" or not client or not host or not origin:
        return False
    try:
        target = urlsplit("http://" + host)
        caller = urlsplit(origin)
        local_host = target.hostname == "localhost" or ip_address(target.hostname or "").is_loopback
        return (ip_address(client).is_loopback and local_host and
                caller.scheme in {"http", "https"} and caller.netloc.lower() == target.netloc.lower())
    except ValueError:
        return False
