import json
from pathlib import Path

import pytest


def test_connector_registry_loads_catalog_forum_and_image_hosts_from_custom_file(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import (
        clear_connector_cache,
        find_connector_for_url,
        get_connector_descriptor,
        list_catalog_descriptors,
        list_forum_descriptors,
        list_image_host_rules,
    )

    cfg = {
        "catalogs": [
            {
                "id": "cat_alpha",
                "displayName": "Catalog Alpha",
                "baseUrl": "https://alpha.example",
                "domains": ["alpha.example", "cdn.alpha.example"],
                "iconKind": "gallery_catalog",
                "rootMode": "api_list",
                "catalogModes": ["popular", "recent", "albums", "gifs"],
                "defaultCategory": "popular",
                "searchCategories": ["all", "profiles", "albums", "gifs"],
                "capabilities": {
                    "archetype": "gallery_catalog",
                    "supportsComments": False,
                    "supportsSourceLikes": False,
                    "supportsVideosTab": False,
                    "supportsPlaylists": False,
                    "supportsArtistProfiles": True,
                    "supportsDirectories": True,
                    "directoryKinds": ["categories", "artists", "channels", "tags"],
                },
                "browse": {
                    "apiListPath": "/popular/api/galleries/list/",
                    "searchApiPath": "/search/srch.php",
                    "rankingSubpaths": ["rating", "views", "likes"],
                    "albumPathSegment": "/galleries/",
                    "artistPathSegment": "/artists/",
                    "channelPathSegment": "/channels/",
                    "tagPathSegment": "/tags/",
                    "directories": {
                        "categories": "/",
                        "artists": "/artists/",
                        "channels": "/channels/",
                        "tags": "/tags/",
                    },
                    "thumbUpgrade": ["/460/", "/1280/"],
                },
            },
            {
                "id": "cat_beta",
                "displayName": "Catalog Beta",
                "baseUrl": "https://beta.example",
                "baseUrlEnv": "BETA_CATALOG_BASE_URL",
                "domains": ["beta.example"],
                "domainPatterns": ["catmirror"],
                "rootMode": "category_first",
                "catalogModes": ["recent", "albums", "photos"],
                "defaultCategory": "recent",
                "searchCategories": ["all", "profiles", "albums"],
            },
        ],
        "forums": [
            {
                "id": "board_one",
                "displayName": "Media Board",
                "baseUrl": "https://board.example",
                "domains": ["board.example"],
                "iconKind": "forum_board",
                "catalogModes": ["albums", "videos", "gifs", "posts", "recent"],
                "defaultCategory": "albums",
                "searchCategories": ["all", "profiles", "albums", "videos", "gifs", "posts"],
                "capabilities": {
                    "archetype": "forum_board",
                    "supportsComments": False,
                    "supportsSourceLikes": False,
                    "supportsVideosTab": True,
                    "supportsPlaylists": False,
                    "supportsArtistProfiles": True,
                    "supportsDirectories": True,
                    "supportsThreadReader": True,
                    "directoryKinds": ["sections"],
                },
                "forum": {
                    "indexPath": "/forum.php",
                    "searchPath": "/search.php",
                    "searchProcessPath": "/search.php?contenttype=1&do=process",
                    "excludedBoardIds": ["999"],
                    "excludedTitleRegex": "promo|casino",
                    "boardRoles": {
                        "album_sets": ["10", "11"],
                        "artist_collections": ["20", "21"],
                        "video_releases": ["30", "31"],
                        "gif_boards": ["40"],
                        "link_drops": ["50"],
                    },
                },
            }
        ],
        "imageHosts": [
            {
                "id": "viewer_one",
                "domains": ["viewer.example"],
                "viewerPathPrefixes": ["/show/", "/v/"],
                "directHostRegex": "^img\\d*\\.viewer\\.example$",
                "directPathPrefixes": ["/images/"],
                "thumbToFullReplace": ["t(\\d*)\\.viewer\\.example/thumbs/", "img\\1.viewer.example/images/"],
                "gatewaySubmitNames": ["imgContinue", "continue"],
            }
        ],
    }

    cfg_path = tmp_path / "connectors.test.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    monkeypatch.setenv("BETA_CATALOG_BASE_URL", "https://custom-beta.example")
    clear_connector_cache()

    catalogs = list_catalog_descriptors()
    forums = list_forum_descriptors()
    hosts = list_image_host_rules()

    assert [c.id for c in catalogs] == ["cat_alpha", "cat_beta"]
    assert [f.id for f in forums] == ["board_one"]
    assert [h.id for h in hosts] == ["viewer_one"]

    beta = get_connector_descriptor("cat_beta")
    assert beta is not None
    assert beta.effective_base_url() == "https://custom-beta.example"

    found_beta = find_connector_for_url("https://catmirror.org/artists/jane-doe/")
    assert found_beta is not None and found_beta.id == "cat_beta"

    found_board = find_connector_for_url("https://board.example/threads/123-Set")
    assert found_board is not None and found_board.id == "board_one"
    assert found_board.capabilities.supports_thread_reader is True


def test_exact_domain_takes_precedence_over_earlier_substring_pattern_and_sets_layout_modes(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import clear_connector_cache, find_connector_for_url, get_connector_descriptor

    cfg = {
        "catalogs": [
            {
                "id": "cat_primary",
                "displayName": "Primary Wall",
                "baseUrl": "https://photos.example",
                "domains": ["photos.example"],
                "domainPatterns": ["photos."],
                "rootMode": "api_list",
            },
            {
                "id": "cat_hd",
                "displayName": "HD Showcase",
                "baseUrl": "https://hdphotos.example",
                "domains": ["hdphotos.example"],
                "domainPatterns": ["hdphotos."],
                "rootMode": "category_first",
            },
        ],
        "forums": [
            {
                "id": "board_main",
                "displayName": "Board Main",
                "baseUrl": "https://forum.example",
                "domains": ["forum.example"],
            }
        ],
        "imageHosts": [],
    }
    p = tmp_path / "connectors.precedence.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()

    # Exact domain `hdphotos.example` must match `cat_hd`, NEVER `cat_primary` via substring `photos.`
    matched = find_connector_for_url("https://hdphotos.example/latina/")
    assert matched is not None and matched.id == "cat_hd"
    assert matched.capabilities.layout_mode == "category_showcase"

    primary = get_connector_descriptor("cat_primary")
    board = get_connector_descriptor("board_main")
    assert primary is not None and primary.capabilities.layout_mode == "editorial_wall"
    assert board is not None and board.capabilities.layout_mode == "forum_index"
