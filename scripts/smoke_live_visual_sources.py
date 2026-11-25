"""Manual smoke verifier for live configured browse/search/album connectors.

Usage:
  venv/Scripts/python.exe scripts/smoke_live_visual_sources.py          # safe no-network exit 0
  venv/Scripts/python.exe scripts/smoke_live_visual_sources.py --live   # queries configured local connectors
"""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import httpx


async def run_live_smoke() -> int:
    from src.server.connector_registry import list_catalog_descriptors, list_forum_descriptors
    from src.server.timeline_browse_providers import get_browse_provider

    descriptors = list(list_catalog_descriptors()) + list(list_forum_descriptors())
    if not descriptors:
        print("No local connectors configured in config/connectors.local.json.")
        return 0

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
        for desc in descriptors:
            prov = get_browse_provider(desc.id)
            if prov is None:
                continue
            res = await prov.browse(client, desc.default_category, limit=5)
            print(f"[{desc.id}] category={desc.default_category} items={len(res.items)} has_more={res.has_more} err={res.error}")
            for it in res.items[:2]:
                print(f"  - {it.get('title')} ({it.get('albumUrl')})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Actually query upstream hosts configured locally.")
    args = parser.parse_args()
    if not args.live:
        print("Skipped live upstream smoke probe (pass --live to query locally configured connectors).")
        return 0
    return asyncio.run(run_live_smoke())


if __name__ == "__main__":
    raise SystemExit(main())
