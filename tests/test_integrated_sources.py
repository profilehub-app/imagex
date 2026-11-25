from __future__ import annotations

import json
from pathlib import Path
import pytest


def test_cold_start_returns_empty_when_no_files(tmp_path: Path, monkeypatch):
    from src.server import integrated_sources_service, profile_favorites_service

    monkeypatch.setenv("IMAGEX_INTEGRATED_SOURCES_FILE", str(tmp_path / "integrated_sources.json"))
    monkeypatch.setattr(profile_favorites_service, "FAVORITES_FILE", tmp_path / "favorite_profiles.json")

    assert integrated_sources_service.load_integrated_sources() == []
    assert integrated_sources_service.get_integrated_source_ids() == set()
    catalog = integrated_sources_service.list_supported_integration_catalog()
    assert any(item["id"] == "youtube" for item in catalog)
    assert any(item["id"] == "x" for item in catalog)


def test_migrates_only_existing_saved_creator_sites(tmp_path: Path, monkeypatch):
    from src.server import integrated_sources_service, profile_favorites_service

    fav_file = tmp_path / "favorite_profiles.json"
    fav_file.write_text(
        json.dumps([{"url": "https://www.youtube.com/@demo", "name": "Demo", "site": "youtube"}]),
        encoding="utf-8",
    )
    monkeypatch.setenv("IMAGEX_INTEGRATED_SOURCES_FILE", str(tmp_path / "integrated_sources.json"))
    monkeypatch.setattr(profile_favorites_service, "FAVORITES_FILE", fav_file)

    sources = integrated_sources_service.load_integrated_sources()
    ids = integrated_sources_service.get_integrated_source_ids()
    assert ids == {"youtube"}
    assert len(sources) == 1
    assert sources[0]["id"] == "youtube"


def test_resolve_and_integrate_network_and_profile_urls(tmp_path: Path, monkeypatch):
    from src.server import connector_registry, integrated_sources_service, profile_favorites_service

    conn_file = tmp_path / "connectors.local.json"
    conn_file.write_text(
        json.dumps(
            {
                "catalogs": [],
                "forums": [],
                "videoPortals": [
                    {
                        "id": "vid_portal",
                        "displayName": "Video Portal",
                        "domains": ["portal.example"],
                        "canonicalOrigin": "https://portal.example",
                        "enabled": True,
                        "urlHints": {
                            "entityPrefixes": ["/models/", "/channels/"],
                        },
                    }
                ],
                "imageHosts": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(conn_file))
    connector_registry.clear_connector_cache()
    monkeypatch.setenv("IMAGEX_INTEGRATED_SOURCES_FILE", str(tmp_path / "integrated_sources.json"))
    monkeypatch.setattr(profile_favorites_service, "FAVORITES_FILE", tmp_path / "favorite_profiles.json")

    res_net = integrated_sources_service.integrate_url("https://youtube.com")
    assert res_net["ok"] is True
    assert res_net["integration"]["sourceId"] == "youtube"
    assert res_net["integration"]["level"] == "network"

    res_prof = integrated_sources_service.integrate_url("youtube.com/@NASASpaceflight")
    assert res_prof["ok"] is True
    assert res_prof["integration"]["sourceId"] == "youtube"
    assert res_prof["integration"]["level"] == "profile"
    assert res_prof["integration"]["suggestedHandle"] == "@NASASpaceflight"
    assert res_prof["integration"]["targetUrl"] == "https://youtube.com/@NASASpaceflight"

    res_x_reserved = integrated_sources_service.integrate_url("https://x.com/home")
    assert res_x_reserved["ok"] is True
    assert res_x_reserved["integration"]["sourceId"] == "x"
    assert res_x_reserved["integration"]["level"] == "network"

    res_x_prof = integrated_sources_service.integrate_url("https://x.com/NASA")
    assert res_x_prof["ok"] is True
    assert res_x_prof["integration"]["sourceId"] == "x"
    assert res_x_prof["integration"]["level"] == "profile"
    assert res_x_prof["integration"]["suggestedHandle"] == "@NASA"

    res_conn = integrated_sources_service.integrate_url("https://portal.example/models/nova")
    assert res_conn["ok"] is True
    assert res_conn["integration"]["sourceId"] == "vid_portal"
    assert res_conn["integration"]["kind"] == "connector"
    assert res_conn["integration"]["level"] == "profile"

    res_bad = integrated_sources_service.integrate_url("javascript:alert(1)")
    assert res_bad["ok"] is False
    assert res_bad["matched"] is False

    res_unsup = integrated_sources_service.integrate_url("https://unsupported-site.invalid/user")
    assert res_unsup["ok"] is False
    assert res_unsup["supported"] is False
    assert integrated_sources_service.get_integrated_source_ids() == {"youtube", "x", "vid_portal"}


def test_remove_and_clear_persist_explicit_empty_state(tmp_path: Path, monkeypatch):
    from src.server import integrated_sources_service, profile_favorites_service

    fav_file = tmp_path / "favorite_profiles.json"
    fav_file.write_text(
        json.dumps([{"url": "https://youtube.com/@demo", "name": "Demo", "site": "youtube"}]),
        encoding="utf-8",
    )
    monkeypatch.setenv("IMAGEX_INTEGRATED_SOURCES_FILE", str(tmp_path / "integrated_sources.json"))
    monkeypatch.setattr(profile_favorites_service, "FAVORITES_FILE", fav_file)

    integrated_sources_service.integrate_url("https://youtube.com")
    integrated_sources_service.integrate_url("https://x.com")
    remaining = integrated_sources_service.remove_integrated_source("youtube")
    assert [row["id"] for row in remaining] == ["x"]

    cleared = integrated_sources_service.clear_integrated_sources()
    assert cleared == []
    assert integrated_sources_service.get_integrated_sources_path().exists()
    # Must NOT re-migrate favorites after user explicitly cleared integrated sources
    assert integrated_sources_service.load_integrated_sources() == []


def test_integrated_sources_api_and_opt_in_gating(tmp_path: Path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src.server import connector_registry, profile_favorites_service, timeline_omni_service

    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(tmp_path / "missing_connectors.json"))
    connector_registry.clear_connector_cache()
    monkeypatch.setenv("IMAGEX_INTEGRATED_SOURCES_FILE", str(tmp_path / "integrated_sources.json"))
    monkeypatch.setattr(profile_favorites_service, "FAVORITES_FILE", tmp_path / "missing_favorites.json")
    timeline_omni_service._BROWSE_CACHE.clear()
    timeline_omni_service._OMNI_SEARCH_CACHE.clear()

    app = FastAPI()
    app.include_router(timeline_omni_service.router)
    client = TestClient(app)

    res_init = client.get("/api/profile-hub/timeline/integrated-sources")
    assert res_init.status_code == 200
    body_init = res_init.json()
    assert body_init["ok"] is True
    assert body_init["sources"] == []
    assert any(item["id"] == "youtube" for item in body_init["supportedCatalog"])

    # Cold opt-in gated queries must return empty lists cleanly without preloading
    bs_gated = client.get("/api/profile-hub/timeline/browse-sources?integrated_only=1")
    ss_gated = client.get("/api/profile-hub/timeline/search-sources?integrated_only=1")
    assert bs_gated.status_code == 200 and bs_gated.json()["sources"] == []
    assert ss_gated.status_code == 200 and ss_gated.json()["sources"] == []

    # Without integrated_only, search-sources preserves full adapter catalog for backend contracts
    ss_all = client.get("/api/profile-hub/timeline/search-sources")
    assert ss_all.status_code == 200
    assert any(s["id"] == "youtube" for s in ss_all.json()["sources"])

    # Cold gated omni-search does zero network requests and returns empty results cleanly
    search_cold = client.post(
        "/api/profile-hub/timeline/omni-search",
        json={"query": "spacex", "source": "all", "category": "all", "integrated_only": True},
    )
    assert search_cold.status_code == 200
    assert search_cold.json()["posts"] == []
    assert search_cold.json()["creators"] == []

    # User integrates YouTube channel via Option A endpoint
    res_add = client.post(
        "/api/profile-hub/timeline/integrate-url",
        json={"url": "https://youtube.com/@NASASpaceflight"},
    )
    assert res_add.status_code == 200
    body_add = res_add.json()
    assert body_add["ok"] is True
    assert body_add["integration"]["sourceId"] == "youtube"
    assert body_add["integration"]["level"] == "profile"
    assert [s["id"] for s in body_add["sources"]] == ["youtube"]

    # Gated search-sources now includes YouTube (and NOT un-integrated platforms)
    ss_after = client.get("/api/profile-hub/timeline/search-sources?integrated_only=1")
    assert ss_after.status_code == 200
    assert [s["id"] for s in ss_after.json()["sources"]] == ["youtube"]

    # Unsupported URL does not mutate integrated state
    res_bad = client.post(
        "/api/profile-hub/timeline/integrate-url",
        json={"url": "https://unknown-domain.invalid/feed"},
    )
    assert res_bad.status_code == 200
    assert res_bad.json()["ok"] is False

    # Delete and reset endpoints restore empty state
    res_del = client.delete("/api/profile-hub/timeline/integrated-sources/youtube")
    assert res_del.status_code == 200
    assert res_del.json()["sources"] == []

    client.post("/api/profile-hub/timeline/integrate-url", json={"url": "https://x.com"})
    res_reset = client.post("/api/profile-hub/timeline/integrated-sources/reset")
    assert res_reset.status_code == 200
    assert res_reset.json()["sources"] == []

