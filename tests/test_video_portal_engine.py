"""Unit tests for generic VideoPortalDescriptor and pure video_portal_engine helpers."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _write_synthetic_portal_config(tmp_path: Path) -> Path:
    cfg = {
        "catalogs": [],
        "forums": [],
        "imageHosts": [],
        "videoPortals": [
            {
                "id": "vid_portal",
                "displayName": "Video Portal",
                "domains": ["portal.example", "m.portal.example", "mobile.portal.example", "*.portal.example"],
                "canonicalOrigin": "https://portal.example",
                "accentColor": "#e11d48",
                "enabled": True,
                "capabilities": {
                    "archetype": "video_portal",
                    "layoutMode": "video_wall",
                    "supportsComments": True,
                    "supportsSourceLikes": True,
                    "supportsNativePlayback": True,
                    "supportsVideosTab": True,
                    "supportsPlaylists": True,
                    "supportsArtistProfiles": True,
                    "supportsDirectories": True,
                    "supportsThreadReader": False,
                    "directoryKinds": ["categories", "channels", "artists", "tags"],
                },
                "urlHints": {
                    "videoPathRegex": r"^/(?:video\.[a-z0-9]+|embedframe/[a-z0-9]+)",
                    "playlistPathRegex": r"^/favorite/[a-z0-9]+",
                    "entityPrefixes": ["/profiles/", "/channels/", "/models/", "/c/", "/tags/"],
                },
                "routing": {
                    "mobileSubdomains": ["m", "mobile"],
                    "stripPrefixes": ["/amp/"],
                    "redirectRules": [
                        {
                            "pattern": r"^/click/[^/]+/[^/]+/([a-z0-9]+)/(.*)$",
                            "template": r"/video.\1/\2",
                        }
                    ],
                    "videoIdRegex": r'(?:/video\.([a-z0-9]+)|/embedframe/([a-z0-9]+)|"id_video"\s*:\s*(\d+))',
                    "videoPathPrefixes": ["/video.", "/embedframe/"],
                    "playlistPrefixes": ["/favorite/"],
                    "categoryPrefixes": ["/c/"],
                    "tagPrefixes": ["/tags/"],
                    "channelPrefixes": ["/channels/"],
                    "creatorPrefixes": ["/profiles/", "/models/"],
                    "directoryPrefixes": ["/categories", "/channels", "/models", "/tags"],
                    "reservedRootPrefixes": [
                        "/new",
                        "/best",
                        "/hot",
                        "/verified",
                        "/video.",
                        "/embedframe",
                        "/tags",
                        "/c",
                        "/channels",
                        "/profiles",
                        "/models",
                        "/favorite",
                        "/search",
                        "/categories",
                        "/lang",
                        "/account",
                    ],
                    "rootSlugEntityKind": "channel",
                    "rootSlugRegex": r"^/([A-Za-z0-9_.-]{2,})(?:/.*)?$",
                    "stripTrailingTabs": ["videos", "photos", "playlists", "favorites", "best", "new", "shorts"],
                },
                "videoCards": {
                    "cardSelector": "div.portal-grid div.portal-card:not(.portal-dir-card)",
                    "videoIdAttr": "data-id",
                    "videoEidAttr": "data-eid",
                    "titleLinkSelector": "p.title a",
                    "thumbSelector": "img",
                    "thumbSrcAttrs": ["data-src", "src"],
                    "previewVideoAttrs": ["data-pvv", "data-mediabook"],
                    "durationSelector": "span.duration",
                    "qualitySelector": "span.quality-badge",
                    "authorLinkSelector": "p.metadata a",
                    "authorNameSelector": "span.name",
                    "viewsSelector": "p.metadata",
                    "viewsRegex": r"([0-9]+(?:\.[0-9]+)?\s*[KkMm]?\s*Views?)",
                    "paginationSelector": ".pagination a",
                    "pageHrefRegex": r"(?:/([0-9]+)|[?&]p=([0-9]+))(?:$|[?#])",
                    "pageBaseZero": True,
                },
                "profile": {
                    "confRegex": r"portal\.conf\s*=\s*(\{.*?\});",
                    "nameSelectors": [".portal-title .name", ".portal-title", "h2.page-title"],
                    "avatarSelectors": [".portal-avatar img", "meta[property='og:image']"],
                    "bannerSelectors": [".portal-banner img"],
                    "bioSelectors": [".portal-bio", ".portal-about p"],
                    "statsContainerSelector": ".portal-about",
                    "subscribersRegex": r"Subscribers:\s*([0-9,.\sKkMm]+)",
                    "totalViewsRegex": r"Total video views:\s*([0-9,.\sKkMm]+)",
                    "relatedLinksSelector": ".portal-about a[href]",
                    "videosJsonPathTemplate": "{entity_base}/videos/{sort}/{page_zero}",
                    "shortsJsonPathTemplate": "{entity_base}/shorts/{sort}/{page_zero}",
                    "videosJsonKey": "videos",
                    "totalVideosKey": "nb_videos",
                    "perPageKey": "nb_per_page",
                    "pageBaseZero": True,
                    "jsonFields": {
                        "id": "id",
                        "eid": "eid",
                        "url": "u",
                        "title": "tf",
                        "fallbackTitle": "t",
                        "thumb": "i",
                        "fallbackThumb": "il",
                        "previewVideo": "ipu",
                        "duration": "d",
                        "views": "n",
                        "hdFlag": "h",
                        "resolutionTag": "hm",
                        "authorName": "pn",
                        "authorUrl": "pu",
                        "isChannel": "ch",
                    },
                    "albumsPath": "/photos",
                    "albumCardSelector": "div.portal-card.portal-album",
                    "albumLinkSelector": "a[href]",
                    "albumTitleSelector": "p.title a",
                    "albumThumbSelector": "img",
                    "albumCountSelector": ".album-count",
                    "albumPhotoSelector": ".album-photos .photo-item img",
                    "playlistsPath": "/favorites",
                    "playlistCardSelector": "div.playlist-block",
                    "playlistLinkSelector": "a.playlist-link",
                    "playlistTitleSelector": "p.playlist-title a",
                    "playlistThumbSelector": "img",
                    "playlistCountSelector": "span.playlist-count",
                    "playlistReportedCountSelector": "h1 .count",
                    "playlistPageBaseZero": True,
                },
                "watch": {
                    "jsonLdSelector": 'script[type="application/ld+json"]',
                    "titleSelector": "h2.page-title",
                    "uploaderLinkSelector": ".portal-metadata li.portal-uploader a",
                    "uploaderNameSelector": ".name",
                    "uploaderSubsSelector": ".portal-subs .count",
                    "performerLinkSelector": ".portal-metadata li.portal-performer a",
                    "performerNameSelector": ".name",
                    "tagSelector": ".portal-metadata a.is-keyword, .portal-metadata a[href^='/tags/']",
                    "categorySelector": ".portal-metadata a[href^='/c/']",
                    "likesSelector": "span.portal-likes",
                    "dislikesSelector": "span.portal-dislikes",
                    "commentsCountSelector": "button.comments .badge",
                    "numericIdRegex": r'"id_video"\s*:\s*(\d+)',
                    "relatedVarRegex": r"var\s+portal_related\s*=\s*(\[.*?\]);",
                },
                "comments": {
                    "listPathTemplate": "/api/portal-comments/top/{numeric_id}/{page_zero}/0",
                    "pageBaseZero": True,
                    "postsContainerKey": "posts",
                    "totalKey": "nb_posts_total",
                    "idsKey": "ids",
                    "childrenKey": "children",
                    "itemsMapKey": "posts",
                    "remainingKey": "nb_after",
                },
                "browse": {
                    "feeds": {
                        "latest": "/new/{page_zero}",
                        "popular": "/best/{page_zero}",
                        "verified": "/verified/{page_zero}",
                    },
                    "dynamicSubfilters": {
                        "selector": "#dyn-cat-strip a[href^='/c/']",
                        "maxItems": 10,
                    },
                    "pageBaseZero": True,
                    "directories": {},
                },
                "search": {
                    "videosPathTemplate": "/?k={query}&p={page_zero}",
                    "suggestPathTemplate": "/search-suggest/{query}",
                    "pageBaseZero": True,
                },
                "streamFallback": {
                    "hlsRegex": r"portalPlayer\.setHLS\(['\"]([^'\"]+)['\"]\)",
                    "hdMp4Regex": r"portalPlayer\.setHD\(['\"]([^'\"]+)['\"]\)",
                    "sdMp4Regex": r"portalPlayer\.setSD\(['\"]([^'\"]+)['\"]\)",
                    "thumbRegex": r"portalPlayer\.setPoster\(['\"]([^'\"]+)['\"]\)",
                    "titleRegex": r"portalPlayer\.setTitle\(['\"]([^'\"]+)['\"]\)",
                },
            }
        ],
    }
    cfg_path = tmp_path / "connectors.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    return cfg_path


def test_descriptor_load_and_provider_resolution(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))

    from src.server.connector_registry import (
        VideoPortalDescriptor,
        find_connector_for_url,
        get_connector_descriptor,
        list_video_portal_descriptors,
        load_connector_bundle,
    )
    from src.server.profile_hub_providers import normalize_source_author_url, resolve_provider

    bundle = load_connector_bundle(force_reload=True)
    assert len(bundle.video_portals) == 1
    desc = get_connector_descriptor("vid_portal")
    assert isinstance(desc, VideoPortalDescriptor)
    assert isinstance(find_connector_for_url("https://m.portal.example/profiles/jane-doe"), VideoPortalDescriptor)
    assert list_video_portal_descriptors()[0].id == "vid_portal"
    fe = desc.to_frontend_dict()
    assert fe["iconKind"] == "video_portal"
    assert fe["capabilities"]["archetype"] == "video_portal"
    assert fe["accentColor"] == "#e11d48"
    assert fe["urlHints"]["videoPathRegex"]

    spec = resolve_provider("https://portal.example/profiles/jane-doe")
    assert spec.provider_id == "vid_portal"
    assert spec.allows_profile_path("/profiles/jane-doe") is True
    assert spec.allows_profile_path("/channels/studio-alpha") is True
    assert spec.allows_profile_path("/studio-root") is True
    assert spec.allows_profile_path("/c/cinema") is True
    assert spec.allows_profile_path("/tags/4k-hd") is True
    assert spec.allows_profile_path("/video.abc123/clip") is False
    assert spec.allows_profile_path("/search?k=demo") is False

    normalized = normalize_source_author_url(
        {"author_url": "/studio_official"},
        "https://portal.example/video.abc123/clip",
    )
    assert normalized == "https://portal.example/studio_official"


def test_url_normalization_entity_kind_and_duration(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import get_connector_descriptor, load_connector_bundle
    from src.server.video_portal_engine import (
        canonicalize_portal_url,
        detect_portal_entity_kind,
        extract_portal_video_id,
        normalize_portal_duration,
        normalize_portal_entity_base_url,
    )

    load_connector_bundle(force_reload=True)
    desc = get_connector_descriptor("vid_portal")

    assert canonicalize_portal_url("https://m.portal.example/amp/video.ab12cd/demo-clip", desc) == (
        "https://portal.example/video.ab12cd/demo-clip"
    )
    assert canonicalize_portal_url("/click/channel/studio/ab12cd/demo-clip", desc) == (
        "https://portal.example/video.ab12cd/demo-clip"
    )
    assert extract_portal_video_id("https://portal.example/video.ab12cd/demo-clip", desc) == "ab12cd"
    assert extract_portal_video_id("https://portal.example/embedframe/xy99zz", desc) == "xy99zz"

    assert detect_portal_entity_kind("https://portal.example/profiles/alice", desc) == "creator"
    assert detect_portal_entity_kind("https://portal.example/channels/studio-one", desc) == "channel"
    assert detect_portal_entity_kind("https://portal.example/studio_official", desc) == "channel"
    assert detect_portal_entity_kind("https://portal.example/c/cinema-hd", desc) == "category"
    assert detect_portal_entity_kind("https://portal.example/tags/hdr-clips", desc) == "tag"
    assert detect_portal_entity_kind("https://portal.example/favorite/f123/curated", desc) == "playlist"
    assert detect_portal_entity_kind("https://portal.example/video.ab12cd/demo-clip", desc) == "video"

    assert normalize_portal_entity_base_url("https://m.portal.example/profiles/alice/videos/best/2", desc) == (
        "https://portal.example/profiles/alice"
    )
    assert normalize_portal_entity_base_url("https://portal.example/studio_official/videos/new", desc) == (
        "https://portal.example/studio_official"
    )
    assert normalize_portal_entity_base_url("https://portal.example/c/cinema-hd/1", desc) == (
        "https://portal.example/c/cinema-hd"
    )

    assert normalize_portal_duration("14 min") == "14:00"
    assert normalize_portal_duration("1 h 05 min") == "1:05:00"
    assert normalize_portal_duration("45 sec") == "0:45"
    assert normalize_portal_duration("05:12") == "5:12"


def test_parse_video_cards_json_profile_albums_playlists_and_stream(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server.connector_registry import get_connector_descriptor, load_connector_bundle
    from src.server.video_portal_engine import (
        extract_portal_max_page,
        extract_portal_stream_fallback,
        parse_portal_album_photos,
        parse_portal_albums,
        parse_portal_playlist_videos,
        parse_portal_playlists,
        parse_portal_profile_root,
        parse_portal_video_cards,
        parse_portal_video_json_items,
    )

    load_connector_bundle(force_reload=True)
    desc = get_connector_descriptor("vid_portal")

    grid_html = """
    <html><body>
      <div class="portal-grid">
        <div class="portal-card" data-id="9001" data-eid="eid9001">
          <div class="thumb-inside">
            <div class="thumb">
              <a href="/video.eid9001/sunset_clip">
                <img src="https://cdn.portal.example/lightbox-blank.gif"
                     data-src="https://cdn.portal.example/thumbs/9001.jpg"
                     data-pvv="https://cdn.portal.example/previews/9001.mp4" />
              </a>
              <span class="quality-badge">1440p</span>
            </div>
          </div>
          <p class="title"><a href="/video.eid9001/sunset_clip" title="Sunset Clip Full">Sunset Clip...</a></p>
          <p class="metadata">
            <span class="duration">12 min</span>
            <a href="/studio_root"><span class="name">Studio Root</span></a>
            <span class="views">548.3k Views</span>
          </p>
        </div>
        <div class="portal-card portal-dir-card">ignored directory tile</div>
      </div>
      <div class="pagination">
        <ul><li><a href="/new/1">2</a></li><li><a href="/new/4">5</a></li></ul>
      </div>
    </body></html>
    """
    cards = parse_portal_video_cards(grid_html, "https://portal.example/new/0", desc)
    assert len(cards) == 1
    assert cards[0]["id"] == "eid9001"
    assert cards[0]["title"] == "Sunset Clip Full"
    assert cards[0]["thumbnailUrl"] == "https://cdn.portal.example/thumbs/9001.jpg"
    assert cards[0]["previewVideoUrl"] == "https://cdn.portal.example/previews/9001.mp4"
    assert cards[0]["duration"] == "12:00"
    assert cards[0]["resolution"] == "1440p"
    assert cards[0]["authorName"] == "Studio Root"
    assert cards[0]["authorUrl"] == "https://portal.example/studio_root"
    assert cards[0]["views"] == "548.3k Views"
    assert extract_portal_max_page(grid_html, desc) == 5

    json_payload = {
        "nb_videos": 42,
        "nb_per_page": 36,
        "videos": [
            {
                "id": 9002,
                "eid": "eid9002",
                "u": "/click/profile/alice/eid9002/ocean_breeze",
                "tf": "Ocean Breeze Full HD",
                "t": "Ocean...",
                "i": "https://cdn.portal.example/thumbs/9002.jpg",
                "ipu": "https://cdn.portal.example/previews/9002.mp4",
                "d": "8 min",
                "n": "120k",
                "h": 1,
                "hm": "1080p",
                "pn": "Alice Demo",
                "pu": "/profiles/alice-demo",
                "ch": 0,
            }
        ],
    }
    json_items = parse_portal_video_json_items(json_payload, "https://portal.example/profiles/alice-demo", desc)
    assert len(json_items) == 1
    assert json_items[0]["originalUrl"] == "https://portal.example/video.eid9002/ocean_breeze"
    assert json_items[0]["title"] == "Ocean Breeze Full HD"
    assert json_items[0]["previewVideoUrl"] == "https://cdn.portal.example/previews/9002.mp4"
    assert json_items[0]["duration"] == "8:00"

    profile_html = """
    <html>
      <head><meta property="og:image" content="https://cdn.portal.example/avatars/alice.jpg" /></head>
      <body>
        <script>
          portal.conf = {"id_user": 77, "profile_name": "alice-demo"};
        </script>
        <div class="portal-title"><span class="name">Alice Demo</span></div>
        <div class="portal-avatar"><img src="https://cdn.portal.example/avatars/alice.jpg" /></div>
        <div class="portal-about">
          <p class="portal-bio">Travel filmmaker</p>
          <p>Subscribers: 314,811</p>
          <p>Total video views: 18,400,200</p>
          <p>Worked with: <a href="/channels/studio-alpha">Studio Alpha</a></p>
          <a href="/channels/sub-ch"><script>document.write('<img src="t.jpg"/>');</script></a>
        </div>
      </body>
    </html>
    """
    profile_meta = parse_portal_profile_root(profile_html, "https://portal.example/profiles/alice-demo", desc)
    assert profile_meta["name"] == "Alice Demo"
    assert profile_meta["avatarUrl"] == "https://cdn.portal.example/avatars/alice.jpg"
    assert profile_meta["bio"] == "Travel filmmaker"
    assert profile_meta["subscribersCount"] == 314811
    assert [r["name"] for r in profile_meta["relatedEntities"]] == ["Studio Alpha"]
    assert profile_meta["relatedEntities"][0]["url"] == "https://portal.example/channels/studio-alpha"

    albums_html = """
    <html><body>
      <div class="portal-card portal-album">
        <a href="/profiles/alice-demo/photos/alb1"><img data-src="https://cdn.portal.example/alb1.jpg" src="blank.gif" /></a>
        <p class="title"><a href="/profiles/alice-demo/photos/alb1">Behind The Scenes</a></p>
        <span class="album-count">14</span>
      </div>
    </body></html>
    """
    albums = parse_portal_albums(albums_html, "https://portal.example/profiles/alice-demo/photos", desc)
    assert len(albums) == 1
    assert albums[0]["title"] == "Behind The Scenes"
    assert albums[0]["thumbnailUrl"] == "https://cdn.portal.example/alb1.jpg"
    assert albums[0]["photoCount"] == 14

    album_page_html = """
    <div class="album-photos">
      <div class="photo-item"><img data-src="https://cdn.portal.example/p1.jpg" src="blank.gif" /></div>
      <div class="photo-item"><img src="https://cdn.portal.example/p2.jpg" /></div>
    </div>
    """
    album_res = parse_portal_album_photos(album_page_html, "https://portal.example/profiles/alice-demo/photos/alb1", desc)
    assert album_res["photos"] == ["https://cdn.portal.example/p1.jpg", "https://cdn.portal.example/p2.jpg"]

    playlists_html = """
    <html><body>
      <div class="playlist-block">
        <a class="playlist-link" href="/favorite/fav99/night-reels">
          <img data-src="https://cdn.portal.example/fav99.jpg" src="blank.gif" />
        </a>
        <p class="playlist-title"><a href="/favorite/fav99/night-reels">Night Reels</a></p>
        <span class="playlist-count">25 videos</span>
      </div>
    </body></html>
    """
    playlists = parse_portal_playlists(playlists_html, "https://portal.example/profiles/alice-demo/favorites", desc)
    assert len(playlists) == 1
    assert playlists[0]["id"] == "fav99"
    assert playlists[0]["videoCount"] == 25

    playlist_detail_html = f"<h1>Night Reels <span class='count'>1</span></h1>{grid_html}"
    pl_detail = parse_portal_playlist_videos(playlist_detail_html, "https://portal.example/favorite/fav99/night-reels", desc)
    assert pl_detail["count"] == 1
    assert pl_detail["videos"][0]["title"] == "Sunset Clip Full"

    player_html = """
    <script>
      portalPlayer.setTitle('Stream Test Clip');
      portalPlayer.setPoster('https://cdn.portal.example/poster169.jpg');
      portalPlayer.setHLS('https://cdn.portal.example/hls/9001/master.m3u8');
      portalPlayer.setHD('https://cdn.portal.example/mp4/9001_high.mp4');
      portalPlayer.setSD('https://cdn.portal.example/mp4/9001_low.mp4');
    </script>
    """
    stream = extract_portal_stream_fallback(player_html, "https://portal.example/video.eid9001/sunset_clip", desc)
    assert stream["master_hls_url"] == "https://cdn.portal.example/hls/9001/master.m3u8"
    assert [q["quality"] for q in stream["qualities"]] == ["Auto", "HD", "SD"]
    assert stream["thumb_url"] == "https://cdn.portal.example/poster169.jpg"


def test_parse_compact_count_european_thousands_and_interests():
    from bs4 import BeautifulSoup
    from src.server.video_portal_engine import VideoPortalDescriptor, parse_compact_count, parse_portal_profile_root

    assert parse_compact_count("3.504.018") == 3504018
    assert parse_compact_count("25.406.458.344") == 25406458344
    assert parse_compact_count("101,407,817") == 101407817
    assert parse_compact_count("791.5K") == 791500

    html = """
    <html><head>
      <script>
        var portalState = {"data":{"user":{"display":"Studio Nova"}}};
      </script>
    </head><body>
      <div class="portal-hero-banner"><a class="portal-site-link" href="https://studionova.example/">Site</a><img src="https://cdn.portal.example/banner.jpg"/></div>
      <div class="portal-subs">3.504.018</div>
      <div class="portal-views">25.406.458.344</div>
      <div class="portal-bio">Real studio bio here</div>
      <div class="portal-tags-cell"><span>Action, Drama, Studio HD</span></div>
      <div class="portal-channels-wrap">
        <div class="portal-channel-card"><a href="/channels/sub_alpha"><img src="https://cdn.portal.example/a.jpg"/><span class="name">Sub Alpha</span></a></div>
        <div class="portal-channel-card"><a href="/channels/sub_beta"><script>document.write(portalThumb.replaceThumb('<img src="bad"/>'));</script></a></div>
        <div class="portal-channel-card"><a href="/channels/sub_gamma">document.write(portalThumb.replaceThumb('junk'));</a></div>
      </div>
    </body></html>
    """
    desc = VideoPortalDescriptor(
        id="vid_portal",
        display_name="VidPortal",
        canonical_origin="https://portal.example",
        domains=("portal.example",),
        url_hints={},
        capabilities={},
        routing={},
        video_cards={},
        profile={
            "confRegex": r"var\s+portalState\s*=\s*(\{.+?\});",
            "bannerSelectors": [".portal-hero-banner img"],
            "websiteSelectors": [".portal-site-link"],
            "bioSelectors": [".portal-bio"],
            "fieldSelectors": {
                "subscribers": ".portal-subs",
                "views": ".portal-views",
            },
            "collections": {
                "interestsSelector": ".portal-tags-cell span",
                "affiliatedCardSelector": ".portal-channels-wrap .portal-channel-card",
                "affiliatedTitleSelector": "span.name",
            },
            "confPaths": {
                "userObject": "data.user",
                "displayName": "display",
            },
        },
        watch={},
        comments={},
        browse={},
        search={},
        stream_fallback={},
    )
    meta = parse_portal_profile_root(html, "https://portal.example/studionova", desc)
    assert meta["name"] == "Studio Nova"
    assert meta["bannerUrl"] == "https://cdn.portal.example/banner.jpg"
    assert meta["portalInfo"]["website"] == "https://studionova.example/"
    assert meta["subscribersCount"] == 3504018
    assert meta["totalViewsCount"] == 25406458344
    assert [i["name"] for i in meta["interests"]] == ["Action", "Drama", "Studio HD"]
    assert [c["name"] for c in meta["affiliatedChannels"]] == ["Sub Alpha"]

