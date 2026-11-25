"""Shared writable base-directory resolution for source checkouts and PyInstaller executables."""
from __future__ import annotations

from pathlib import Path
import sys


def get_app_base_dir() -> Path:
    """Return the writable application root directory.

    When running as a frozen PyInstaller executable (`IMAGEX.exe`), returns the
    executable's directory (or its parent if inside a `dist/` folder) so local
    configuration and user data persist outside the ephemeral `sys._MEIPASS`
    extraction directory.
    """
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
        if base.name.lower() == "dist":
            base = base.parent
        return base
    return Path(__file__).resolve().parents[2]
