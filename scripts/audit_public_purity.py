"""Public repository purity auditor.

Scans all git-tracked and non-ignored candidate public files to ensure zero
literal private/adult external site names, domains, or CDN tokens can leak
into the public repository.
"""
from __future__ import annotations

import base64
from pathlib import Path
import re
import subprocess
import sys

# Encoded strictly so the auditor itself contains zero literal forbidden tokens.
_FORBIDDEN_TOKENS_B64: tuple[str, ...] = (
    "cG9ybmh1Yg==",
    "eHZpZGVvcw==",
    "eGhhbXN0ZXI=",
    "ZXBvcm5lcg==",
    "eG54eA==",
    "eW91cG9ybg==",
    "cmVkdHViZQ==",
    "cG9ybnBpY3M=",
    "cG9ybnBpY3NocQ==",
    "dmlwZXJnaXJscw==",
    "bnVkb2dyYW0=",
    "aW14LnRv",
    "cGl4aG9zdA==",
    "aW1hZ2ViYW0=",
    "aW1hZ2V2ZW51ZQ==",
    "dHVyYm9pbWFnZWhvc3Q=",
    "cGltcGFuZGhvc3Q=",
    "aW1nYm94",
    "YWNpZGltZw==",
    "ZXJvbWU=",
    "YnVua3I=",
    "Y3liZXJkcm9w",
    "Y29vbWVy",
    "a2Vtb25v",
    "b25seWZhbnM=",
    "ZmFuc2x5",
    "cmVkZ2lmcw==",
    "Z2Z5Y2F0",
    "c3BhbmtiYW5n",
    "cGhuY2Ru",
    "eGhjZG4=",
    "eHYtY2Ru",
)

_BINARY_EXTS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
        ".ico",
        ".svg",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".mp4",
        ".webm",
        ".zip",
        ".exe",
        ".dll",
        ".pyd",
        ".pyc",
        ".lock",
    }
)


def decode_forbidden_tokens() -> tuple[str, ...]:
    return tuple(base64.b64decode(item.encode("ascii")).decode("utf-8") for item in _FORBIDDEN_TOKENS_B64)


def build_forbidden_pattern() -> re.Pattern[str]:
    tokens = decode_forbidden_tokens()
    return re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(t) for t in tokens) + r")(?![a-z0-9])", re.IGNORECASE)


def list_candidate_files(repo_root: Path) -> list[Path]:
    tracked = subprocess.check_output(["git", "ls-files"], cwd=repo_root, text=True).splitlines()
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard"], cwd=repo_root, text=True
    ).splitlines()
    seen: set[str] = set()
    out: list[Path] = []
    for rel in (*tracked, *untracked):
        norm = rel.strip().replace("\\", "/")
        if not norm or norm in seen:
            continue
        if norm in {"package-lock.json", "frontend-mobile-preview/package-lock.json", ".gitignore"}:
            continue
        if norm.startswith(".github/"):
            continue
        seen.add(norm)
        fp = repo_root / norm
        if fp.is_file() and fp.suffix.lower() not in _BINARY_EXTS:
            out.append(fp)
    return out


def scan_paths(paths: list[Path], repo_root: Path) -> list[tuple[str, int]]:
    pat = build_forbidden_pattern()
    flagged: list[tuple[str, int]] = []
    for fp in paths:
        try:
            text = fp.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        hits = sum(1 for _ in pat.finditer(text))
        if hits:
            rel = fp.resolve().relative_to(repo_root.resolve()).as_posix()
            flagged.append((rel, hits))
    return flagged


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    candidates = list_candidate_files(repo_root)
    flagged = scan_paths(candidates, repo_root)
    if not flagged:
        print(f"OK: scanned {len(candidates)} candidate public files; 0 forbidden references found.")
        return 0
    print(f"FAIL: found forbidden references in {len(flagged)} file(s) out of {len(candidates)} scanned:")
    for rel, count in flagged:
        print(f"  - {rel} ({count} match(es))")
    return 1


if __name__ == "__main__":
    sys.exit(main())
