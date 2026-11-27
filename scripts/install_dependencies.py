"""Install the Python packages and the browser that matches this Playwright build."""

import argparse
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="Install hermetic Chromium for PyInstaller")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    requirements = root / ("requirements-build.txt" if args.build else "requirements.txt")
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(requirements)], check=True, cwd=root)
    env = os.environ.copy()
    if args.build:
        env["PLAYWRIGHT_BROWSERS_PATH"] = "0"
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, cwd=root, env=env)


if __name__ == "__main__":
    main()
