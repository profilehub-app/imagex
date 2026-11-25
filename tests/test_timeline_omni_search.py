import json
from urllib.parse import unquote
import httpx
import pytest
from src.server.timeline_search_providers import (
    SearchProviderCapabilities,
    SearchPageResult,
    decode_search_cursor,
    encode_search_cursor,
    get_search_provider,
    list_search_providers,
    register_search_provider,
    unregister_search_provider,
)


@pytest.fixture(autouse=True)
def _isolate_connector_config(tmp_path, monkeypatch):
    from src.server import connector_registry

    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(tmp_path / "connectors.local.json"))
    monkeypatch.setenv("IMAGEX_BUNDLED_CONNECTORS_FILE", str(tmp_path / "connectors.defaults.json"))
    connector_registry.clear_connector_cache()
    yield
    connector_registry.clear_connector_cache()


class _DummyProvider:
    capabilities = SearchProviderCapabilities(
        source_id="custom_mock",
        display_name="CustomMock",
        categories=("videos", "posts"),
        supports_live_connector=False,
    )

    async def search(self, client: httpx.AsyncClient, query: str, category: str, cursor: str | None = None) -> SearchPageResult:
        return SearchPageResult(source_id="custom_mock", category=category, profiles=[], items=[], next_cursor=None, has_more=False)


def test_search_provider_registry_register_and_unregister():
    register_search_provider(_DummyProvider())
    try:
        ids = [p.capabilities.source_id for p in list_search_providers()]
        assert "custom_mock" in ids
        assert get_search_provider("custom_mock").capabilities.categories == ("videos", "posts")
    finally:
        unregister_search_provider("custom_mock")
    assert get_search_provider("custom_mock") is None


def test_search_cursor_roundtrip_and_tamper_fallback():
    token = encode_search_cursor({"page": 3, "url": "https://example.com/search/luna/3/"})
    assert decode_search_cursor(token) == {"page": 3, "url": "https://example.com/search/luna/3/"}
    assert decode_search_cursor("not-valid-base64!!!") == {}
    assert decode_search_cursor(None) == {}


@pytest.mark.asyncio
async def test_youtube_provider_extracts_channels_playlists_shorts_and_page2_continuation():
    from src.server.timeline_search_providers import get_search_provider

    yt_videos_html = '<script>"INNERTUBE_API_KEY":"k123","INNERTUBE_CLIENT_VERSION":"2.2026"</script>' + (
        "<script>var ytInitialData = "
        + json.dumps({
            "contents": {
                "twoColumnSearchResultsRenderer": {
                    "primaryContents": {
                        "sectionListRenderer": {
                            "contents": [
                                {"itemSectionRenderer": {"contents": [
                                    {"videoRenderer": {
                                        "videoId": "vid11111111",
                                        "title": {"runs": [{"text": "Luna Live"}]},
                                        "ownerText": {"runs": [{"text": "LunaVEVO", "navigationEndpoint": {"commandMetadata": {"webCommandMetadata": {"url": "/@LunaVEVO"}}}}]},
                                        "lengthText": {"simpleText": "5:10"},
                                        "shortViewCountText": {"simpleText": "1M views"},
                                        "publishedTimeText": {"simpleText": "3 years ago"},
                                        "thumbnail": {"thumbnails": [{"url": "https://i.ytimg.com/vi/vid11111111/hqdefault.jpg"}]},
                                    }},
                                    {"shortsLockupViewModel": {
                                        "onTap": {"innertubeCommand": {"reelWatchEndpoint": {"videoId": "shrt2222222"}}},
                                        "overlayMetadata": {"primaryText": {"content": "Luna Short Clip"}, "secondaryText": {"content": "4.9M views"}},
                                        "thumbnailViewModel": {"thumbnailViewModel": {"image": {"sources": [{"url": "https://i.ytimg.com/vi/shrt2222222/oar2.jpg"}]}}},
                                    }},
                                ]}},
                                {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "CONT_TOK_1"}}}},
                            ]
                        }
                    }
                }
            }
        })
        + ";</script>"
    )
    yt_channels_html = "<script>var ytInitialData = " + json.dumps({
        "contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [
                {"channelRenderer": {
                    "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
                    "title": {"simpleText": "Luna Channel"},
                    "canonicalBaseUrl": "/@lunachannel",
                    "subscriberCountText": {"simpleText": "500K subscribers"},
                    "videoCountText": {"simpleText": "120 videos"},
                    "thumbnail": {"thumbnails": [{"url": "//yt3.googleusercontent.com/abc=s176"}]},
                    "ownerBadges": [{"metadataBadgeRenderer": {"style": "BADGE_STYLE_TYPE_VERIFIED"}}],
                }}
            ]}}
        ]}}}}
    }) + ";</script>"
    yt_playlists_html = "<script>var ytInitialData = " + json.dumps({
        "contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [
                {"lockupViewModel": {
                    "contentId": "PLabc123456",
                    "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST",
                    "metadata": {"lockupMetadataViewModel": {
                        "title": {"content": "Luna Mix Playlist"},
                        "metadata": {"contentMetadataViewModel": {"metadataRows": [{"metadataParts": [{"text": {"content": "MusicFan", "commandRuns": [{"onTap": {"innertubeCommand": {"commandMetadata": {"webCommandMetadata": {"url": "/@musicfan"}}}}}]}}]}]}},
                    }},
                    "contentImage": {"collectionThumbnailViewModel": {"primaryThumbnail": {"thumbnailViewModel": {"image": {"sources": [{"url": "https://i.ytimg.com/vi/pl1/hqdefault.jpg"}]}, "overlays": [{"thumbnailOverlayBadgeViewModel": {"thumbnailBadges": [{"thumbnailBadgeViewModel": {"text": "24 videos"}}]}}]}}}},
                }},
                {"playlistRenderer": {
                    "playlistId": "PLlegacy999",
                    "title": {"simpleText": "Luna Legacy Playlist"},
                    "shortBylineText": {"runs": [{"text": "LegacyCurator", "navigationEndpoint": {"commandMetadata": {"webCommandMetadata": {"url": "/@legacycurator"}}}}]},
                    "videoCount": "12",
                    "thumbnails": [{"thumbnails": [{"url": "https://i.ytimg.com/vi/pl2/hqdefault.jpg", "width": 480, "height": 360}]}],
                }},
            ]}}
        ]}}}}
    }) + ";</script>"
    yt_cont_json = {
        "onResponseReceivedCommands": [{"appendContinuationItemsAction": {"continuationItems": [
            {"itemSectionRenderer": {"contents": [{"videoRenderer": {"videoId": "vid22222222", "title": {"runs": [{"text": "Luna Page 2"}]}}}]}},
            {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "CONT_TOK_2"}}}},
        ]}}]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "/youtubei/v1/search" in u:
            return httpx.Response(200, json=yt_cont_json)
        if "sp=EgIQAg" in u:
            return httpx.Response(200, text=yt_channels_html)
        if "sp=EgIQAw" in u:
            return httpx.Response(200, text=yt_playlists_html)
        return httpx.Response(200, text=yt_videos_html)

    provider = get_search_provider("youtube")
    assert provider is not None
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        p_vid = await provider.search(client, "luna", "videos")
        p_shr = await provider.search(client, "luna", "shorts")
        p_ch = await provider.search(client, "luna", "profiles")
        p_pl = await provider.search(client, "luna", "playlists")
        p_vid2 = await provider.search(client, "luna", "videos", cursor=p_vid.next_cursor)

    assert len(p_vid.items) == 1 and p_vid.items[0]["creatorName"] == "LunaVEVO"
    assert isinstance(p_vid.items[0]["thumbnail"], str) and p_vid.items[0]["thumbnail"].startswith("https://")
    assert isinstance(p_vid.items[0]["creatorAvatar"], str) and p_vid.items[0]["creatorAvatar"].startswith("https://")
    assert p_vid.has_more and p_vid.next_cursor is not None
    assert len(p_shr.items) == 1 and p_shr.items[0]["creatorName"] == "YouTube Shorts" and p_shr.items[0]["isShort"] is True
    assert len(p_ch.profiles) == 1 and p_ch.profiles[0]["verified"] is True
    assert len(p_pl.items) == 2 and p_pl.items[0]["type"] == "playlist" and p_pl.items[0]["videoCount"] == 24 and p_pl.items[0]["creatorName"] == "MusicFan"
    assert isinstance(p_pl.items[1]["thumbnail"], str) and p_pl.items[1]["thumbnail"].startswith("https://")
    assert isinstance(p_pl.items[1]["creatorAvatar"], str) and p_pl.items[1]["creatorAvatar"].startswith("https://")
    assert len(p_vid2.items) == 1 and p_vid2.items[0]["youtubeId"] == "vid22222222" and p_vid2.has_more


@pytest.mark.asyncio
async def test_portal_grid_portal_tube_portal_state_imgur_providers_and_imgur_album_resolution():
    from src.server.timeline_search_providers import get_search_provider, fetch_imgur_album_photos

    ep_videos = '''<html><body>
      <div class="mb" id="vf1"><div class="mbcontent"><a href="/video-1/luna-test/"><img data-src="https://img.portal-grid.example/1.jpg"></a></div>
        <div class="mbunder"><p class="mbtit"><a href="/video-1/luna-test/">Luna Test</a></p>
        <span class="mb-uploader"><a href="/profile/asupanlokalan/" title="Uploader">asupanlokalan</a></span></div>
      </div>
      <div class="numlist2"><a href="/tag/luna-13pvuUac/2/">2</a></div>
    </body></html>'''
    ep_playlists = '''<html><body><div class="mb mbplaylist" id="pl1">
      <div class="mbphoto2_playlistico">4</div>
      <a href="/profile/soniasoniamom69/playlist/AOpLGF1FnuM/luna-mix/"><img src="https://img.portal-grid.example/p.jpg" alt="Luna Mix"></a>
    </div></body></html>'''
    ep_pornstars = '''<html><body><div class="mbprofile"><a href="/pornstar/luna-wicky/"><img src="https://img.portal-grid.example/a.jpg"><div class="mbtit">Luna Wicky</div></a><span>Videos: 88</span><span>Photos: 12</span></div></body></html>'''

    ph_videos = '''<html><body><ul id="videoSearchResult"><li class="pcVideoListItem" data-video-vkey="ph999">
      <a class="linkVideoThumb" href="/view_video.php?viewkey=ph999" title="PH Luna"><img src="https://cdn.portal-tube.example/t.jpg"></a>
      <div class="usernameWrap"><a href="/model/luna-star">Luna Star</a></div>
    </li></ul><div class="pagination3"><li class="page_next"><a href="/video/search?search=luna&page=2">Next</a></li></div></body></html>'''
    ph_albums_one_page = '''<html><body><ul class="photoAlbumList">
      <li class="photoAlbumListBlock"><a href="/album/123" title="Luna Album"><img src="https://cdn.portal-tube.example/alb.jpg"></a></li>
    </ul></body></html>'''

    xh_videos = '<script>window.initials = ' + json.dumps({
        "searchResult": {"videoThumbProps": [{"id": 77, "title": "XH Luna", "pageURL": "https://portal-state.example/videos/xh-luna-77", "thumbURL": "https://cdn.portal-state.example/77.jpg", "duration": 180, "landing": {"type": "channel", "name": "DevilTeam", "logo": "https://cdn.portal-state.example/logo.jpg", "link": "https://portal-state.example/channels/devilteam"}}]},
        "pagination": {"active": 1, "next": 2, "maxPages": 40, "pageLinkTemplate": "https://portal-state.example/search/luna?page=#"},
    }) + ';</script>'

    imgur_search = '''<html><body><div class="cards">
      <div class="post" id="b9wKp"><a class="image-list-link" href="/gallery/b9wKp"><img src="//i.imgur.com/0Uiluv3b.jpg" alt="Luna Album"></a><div class="post-info">album · 100 views</div></div>
      <div class="post" id="NSv42RA"><a class="image-list-link" href="/gallery/NSv42RA"><img src="//i.imgur.com/NSv42RAb.jpg" alt="Animated Luna"></a><div class="post-info">animated · 50 views</div></div>
    </div></body></html>'''
    imgur_album_api = {"id": "b9wKp", "title": "Luna Album", "image_count": 1, "account": {"username": "jenklk2"}, "media": [{"id": "0Uiluv3", "mime_type": "image/jpeg", "url": "https://i.imgur.com/0Uiluv3.jpeg", "width": 620, "height": 819, "metadata": {"title": "Cover", "is_animated": False}}]}

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "portal-grid.example/search/luna/" in u:
            return httpx.Response(200, text=ep_videos, request=httpx.Request("GET", "https://portal-grid.example/tag/luna-13pvuUac/"))
        if "portal-grid.example/search-playlists/" in u:
            return httpx.Response(200, text=ep_playlists)
        if "portal-grid.example/search-pornstars/" in u:
            return httpx.Response(200, text=ep_pornstars)
        if "portal-tube.example/video/search" in u:
            return httpx.Response(200, text=ph_videos)
        if "portal-tube.example/albums" in u:
            return httpx.Response(200, text=ph_albums_one_page)
        if "portal-state.example/search/luna" in u:
            return httpx.Response(200, text=xh_videos)
        if "imgur.com/search" in u:
            return httpx.Response(200, text=imgur_search)
        if "api.imgur.com/post/v1/albums/b9wKp" in u:
            return httpx.Response(200, json=imgur_album_api)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        ep_v = await get_search_provider("portal_grid").search(client, "luna", "videos")
        ep_p = await get_search_provider("portal_grid").search(client, "luna", "playlists")
        ep_c = await get_search_provider("portal_grid").search(client, "luna", "profiles")
        ph_v = await get_search_provider("portal_tube").search(client, "luna", "videos")
        ph_a = await get_search_provider("portal_tube").search(client, "luna", "albums")
        xh_v = await get_search_provider("portal_state").search(client, "luna", "videos")
        im_a = await get_search_provider("imgur").search(client, "luna", "albums")
        im_g = await get_search_provider("imgur").search(client, "luna", "gifs")
        resolved = await fetch_imgur_album_photos(client, "https://imgur.com/gallery/b9wKp")

    assert ep_v.items[0]["creatorName"] == "asupanlokalan" and ep_v.has_more and "/tag/luna-13pvuUac/2/" in (decode_search_cursor(ep_v.next_cursor).get("url") or "")
    assert ep_p.items[0]["creatorName"] == "soniasoniamom69" and "portal-grid.example/profile/soniasoniamom69" in ep_p.items[0]["sourcePage"]
    assert ep_c.profiles[0]["name"] == "Luna Wicky"
    assert ph_v.items[0]["creatorName"] == "Luna Star" and ph_v.has_more is True
    assert ph_a.has_more is False  # Prevents blind 404 page-2 fetch when pagination3 has no next link
    assert xh_v.items[0]["creatorName"] == "DevilTeam" and xh_v.profiles[0]["name"] == "DevilTeam" and xh_v.has_more
    assert im_a.items[0]["thumbnail"] == "https://i.imgur.com/0Uiluv3.jpg" and not im_a.items[0].get("sourcePage")
    assert im_g.items[0]["type"] == "gif" and "i.imgur.com/NSv42RA.mp4" in unquote(im_g.items[0]["videoUrl"])
    assert resolved["success"] is True and resolved["photos"][0]["originalUrl"] == "https://i.imgur.com/0Uiluv3.jpeg"


@pytest.mark.asyncio
async def test_x_fallback_provider_pagination_and_video_routing():
    from src.server.timeline_search_providers import decode_search_cursor, get_search_provider

    yahoo_profiles_p1 = '<html><body><a href="https://x.com/lunamusic">Luna Music (@lunamusic)</a></body></html>'
    yahoo_tweets_p1 = '<html><body><a href="https://x.com/lunamusic/status/111111111111111">V</a><a href="https://x.com/otheruser/status/222222222222222">T</a></body></html>'
    yahoo_tweets_p2 = '<html><body><a href="https://x.com/lunapage2/status/333333333333333">P2</a><a href="https://x.com/otheruser/status/222222222222222">Dup</a></body></html>'

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "search.yahoo.com/search" in u:
            if "inurl%3Astatus" in u or "-inurl%3Astatus" in u or "-inurl:status" in u:
                return httpx.Response(200, text=yahoo_profiles_p1)
            if "b=11" in u:
                return httpx.Response(200, text=yahoo_tweets_p2)
            return httpx.Response(200, text=yahoo_tweets_p1)
        if "api.fxtwitter.com/lunamusic/status/" not in u and "api.fxtwitter.com/lunamusic" in u:
            return httpx.Response(200, json={"user": {"screen_name": "lunamusic", "name": "Luna Official", "avatar_url": "https://pbs.twimg.com/a_normal.jpg", "followers": 42000, "verified": True}})
        if "api.vxtwitter.com/lunamusic/status/111111111111111" in u:
            return httpx.Response(200, json={"tweetID": "111111111111111", "user_screen_name": "lunamusic", "user_name": "Luna Official", "text": "Luna music video clip", "media_extended": [{"type": "video", "url": "https://video.twimg.com/v1.mp4", "thumbnail_url": "https://pbs.twimg.com/p1.jpg"}]})
        if "api.vxtwitter.com/otheruser/status/222222222222222" in u:
            return httpx.Response(200, json={"tweetID": "222222222222222", "user_screen_name": "otheruser", "user_name": "Other User", "text": "Listening to luna tonight", "media_extended": []})
        if "api.vxtwitter.com/lunapage2/status/333333333333333" in u:
            return httpx.Response(200, json={"tweetID": "333333333333333", "user_screen_name": "lunapage2", "user_name": "Luna Page 2", "text": "Luna tour dates", "media_extended": [{"type": "image", "url": "https://pbs.twimg.com/img3.jpg"}]})
        return httpx.Response(404)

    provider = get_search_provider("x")
    assert provider is not None
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        x_prof = await provider.search(client, "luna", "profiles")
        x_vid = await provider.search(client, "luna", "videos")
        x_post1 = await provider.search(client, "luna", "posts")
        x_post2 = await provider.search(client, "luna", "posts", cursor=x_post1.next_cursor)

    assert len(x_prof.profiles) == 1 and x_prof.profiles[0]["name"] == "Luna Official" and x_prof.profiles[0]["verified"] is True
    assert [it["id"] for it in x_vid.items] == ["omni-x-111111111111111"]
    assert len(x_post1.items) == 2 and x_post1.has_more
    assert decode_search_cursor(x_post1.next_cursor).get("offset") == 11
    assert [it["id"] for it in x_post2.items] == ["omni-x-333333333333333"]


from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_search_sources_and_unbounded_paginated_omni_search_with_custom_provider():
    from src.server.timeline_omni_service import router
    from src.server.timeline_search_providers import (
        SearchPageResult,
        SearchProviderCapabilities,
        register_search_provider,
        unregister_search_provider,
    )

    class _PaginatedProvider:
        capabilities = SearchProviderCapabilities("mockfeed", "MockFeed", ("videos", "profiles"), False)

        async def search(self, client, query, category, cursor=None):
            page = 1 if not cursor else 2
            if category == "profiles":
                return SearchPageResult(
                    "mockfeed",
                    "profiles",
                    [{"id": f"mf:p{page}", "name": f"{query} Author {page}", "handle": f"@auth{page}", "avatar": "", "profileUrl": f"https://mock.test/u/{page}", "site": "mockfeed"}],
                    [],
                    None,
                    False,
                )
            items = [
                {
                    "id": f"mf-{page}-{i}",
                    "creatorId": "mf:c",
                    "creatorName": "Author",
                    "creatorHandle": "@auth",
                    "creatorAvatar": "",
                    "type": "video",
                    "source": "mockfeed",
                    "originalUrl": f"https://mock.test/v/{page}/{i}",
                    "title": f"{query} Video {page}-{i}",
                    "comments": [],
                }
                for i in range(40)
            ]
            return SearchPageResult("mockfeed", "videos", [], items, "page-2-tok" if page == 1 else None, page == 1)

    app = FastAPI()
    app.include_router(router)
    register_search_provider(_PaginatedProvider())
    try:
        client = TestClient(app)
        s_resp = client.get("/api/profile-hub/timeline/search-sources")
        assert s_resp.status_code == 200
        assert any(s["id"] == "mockfeed" for s in s_resp.json()["sources"])

        r1 = client.post("/api/profile-hub/timeline/omni-search", json={"query": "luna", "source": "mockfeed"})
        d1 = r1.json()
        assert len(d1["sections"]["videos"]) == 40
        assert len(d1["sections"]["profiles"]) == 1
        assert d1["cursors"]["mockfeed:videos"]["hasMore"] is True

        r2 = client.post(
            "/api/profile-hub/timeline/omni-search",
            json={"query": "luna", "source": "mockfeed", "cursors": {"mockfeed:videos": d1["cursors"]["mockfeed:videos"]["cursor"]}},
        )
        d2 = r2.json()
        assert len(d2["sections"]["videos"]) == 40
        assert d2["sections"]["videos"][0]["id"] != d1["sections"]["videos"][0]["id"]
        assert d2["hasMore"] is False
    finally:
        unregister_search_provider("mockfeed")


def test_omni_search_isolates_failing_provider_timeout():
    from src.server.timeline_omni_service import router
    from src.server.timeline_search_providers import (
        SearchPageResult,
        SearchProviderCapabilities,
        list_search_providers,
        register_search_provider,
        unregister_search_provider,
    )

    class _FailingProvider:
        capabilities = SearchProviderCapabilities("slow_mock", "SlowMock", ("videos",), False)

        async def search(self, client, query, category, cursor=None):
            raise httpx.ReadTimeout("upstream timed out")

    class _HealthyProvider:
        capabilities = SearchProviderCapabilities("ok_mock", "OkMock", ("videos",), False)

        async def search(self, client, query, category, cursor=None):
            return SearchPageResult(
                "ok_mock",
                "videos",
                [],
                [{"id": "ok-1", "creatorId": "ok:c", "creatorName": "OkChannel", "creatorHandle": "@ok", "creatorAvatar": "", "type": "video", "source": "ok_mock", "originalUrl": "https://ok.test/v/1", "title": f"{query} ok", "comments": []}],
                None,
                False,
            )

    saved = list(list_search_providers())
    for p in saved:
        unregister_search_provider(p.capabilities.source_id)
    app = FastAPI()
    app.include_router(router)
    register_search_provider(_FailingProvider())
    register_search_provider(_HealthyProvider())
    try:
        client = TestClient(app)
        resp = client.post("/api/profile-hub/timeline/omni-search", json={"query": "luna", "source": "all"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["sourceStatus"]["slow_mock"]["ok"] is False
        assert body["sourceStatus"]["ok_mock"]["ok"] is True
        assert body["sourceStatus"]["ok_mock"]["count"] == 1
        assert len(body["sections"]["videos"]) == 1
    finally:
        unregister_search_provider("slow_mock")
        unregister_search_provider("ok_mock")
        for p in saved:
            register_search_provider(p)


@pytest.mark.asyncio
async def test_x_fallback_decodes_yahoo_ru_links_and_vxtwitter_user_fallback():
    from src.server.timeline_search_providers import get_search_provider, make_item_entry

    yt_entry = make_item_entry(
        source_id="youtube",
        item_id="omni-yt-x1",
        item_type="video",
        title="Luna Video",
        original_url="https://www.youtube.com/watch?v=x1",
        creator_name="Luna",
        source_page="https://www.youtube.com/@minecraftbyluna",
    )
    assert yt_entry["creatorHandle"] == "@minecraftbyluna"

    yahoo_ru_prof = '<a href="https://r.search.yahoo.com/_ylt=A/RU=https%3a%2f%2fx.com%2flunavxfb/RK=2/RS=abc">Luna VX</a>'
    yahoo_ru_tweets = '<a href="https://r.search.yahoo.com/_ylt=B/RU=https%3a%2f%2fx.com%2flunavxfb%2fstatus%2f999999999999999/RK=2/RS=def">Post</a>'

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "search.yahoo.com/search" in u:
            if "inurl%3Astatus" in u or "-inurl%3Astatus" in u:
                return httpx.Response(200, text=yahoo_ru_prof)
            return httpx.Response(200, text=yahoo_ru_tweets)
        if "api.fxtwitter.com" in u:
            return httpx.Response(404, json={"code": 404, "message": "User not found"})
        if "api.vxtwitter.com/lunavxfb/status/999999999999999" in u:
            return httpx.Response(
                200,
                json={"tweetID": "999999999999999", "user_screen_name": "lunavxfb", "user_name": "Luna VX", "text": "Luna post via RU", "media_extended": []},
            )
        if "api.vxtwitter.com/lunavxfb" in u:
            return httpx.Response(
                200,
                json={
                    "screen_name": "lunavxfb",
                    "name": "Luna VX",
                    "description": "VX profile",
                    "followers_count": 9001,
                    "following_count": 12,
                    "tweet_count": 300,
                    "profile_image_url": "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
                },
            )
        return httpx.Response(404)

    provider = get_search_provider("x")
    assert provider is not None
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        prof = await provider.search(client, "luna", "profiles")
        post = await provider.search(client, "luna", "posts")

    assert any(p["handle"] == "@lunavxfb" and p["followers"] == 9001 for p in prof.profiles)
    assert [it["id"] for it in post.items] == ["omni-x-999999999999999"]


def test_omni_search_does_not_cache_empty_results():
    from src.server.timeline_omni_service import _OMNI_SEARCH_CACHE, router
    from src.server.timeline_search_providers import (
        SearchPageResult,
        SearchProviderCapabilities,
        register_search_provider,
        unregister_search_provider,
    )

    calls = {"n": 0}

    class _FlakyEmptyProvider:
        capabilities = SearchProviderCapabilities("flaky_mock", "FlakyMock", ("posts",), False)

        async def search(self, client, query, category, cursor=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return SearchPageResult("flaky_mock", "posts", [], [], None, False)
            return SearchPageResult(
                "flaky_mock",
                "posts",
                [],
                [{"id": "flaky-1", "creatorId": "fk:c", "creatorName": "Author", "creatorHandle": "@a", "creatorAvatar": "", "type": "text", "source": "flaky_mock", "originalUrl": "https://fk.test/1", "title": query, "comments": []}],
                None,
                False,
            )

    _OMNI_SEARCH_CACHE.clear()
    app = FastAPI()
    app.include_router(router)
    register_search_provider(_FlakyEmptyProvider())
    try:
        client = TestClient(app)
        r1 = client.post("/api/profile-hub/timeline/omni-search", json={"query": "luna_flaky", "source": "flaky_mock"}).json()
        r2 = client.post("/api/profile-hub/timeline/omni-search", json={"query": "luna_flaky", "source": "flaky_mock"}).json()
        assert len(r1["sections"]["posts"]) == 0
        assert len(r2["sections"]["posts"]) == 1
    finally:
        unregister_search_provider("flaky_mock")
        _OMNI_SEARCH_CACHE.clear()


@pytest.mark.asyncio
async def test_zero_yield_filtered_pages_stop_pagination_and_imgur_host_guard():
    from src.server import timeline_omni_service as tos
    from src.server import timeline_search_providers as tsp

    # Shared X hydrators per Ledger Ruling #1
    assert tos._fetch_x_user_info is tsp._fetch_x_user_info
    assert tos._fetch_x_tweet_info is tsp._fetch_x_tweet_info

    # Zero-yield YouTube shorts, X videos, and wrapped-duplicate Imgur page 2 stop has_more
    yt_regular_only = '<script>"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_VERSION":"2"</script><script>var ytInitialData=' + json.dumps({
        "contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [{"videoRenderer": {"videoId": "reg12345678", "title": {"runs": [{"text": "Long video"}]}}}]}},
            {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "CONT_ONLY_REG"}}}},
        ]}}}}
    }) + ";</script>"
    yahoo_text_tweets = '<a href="https://x.com/luna/status/888888888888888">T</a>'
    imgur_p1 = '<div class="cards"><div class="post" id="im1"><a href="/a/im1"><img src="https://i.imgur.com/im1b.jpg"></a><div class="post-info">album</div></div></div>'

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "youtube.com" in u:
            return httpx.Response(200, text=yt_regular_only)
        if "search.yahoo.com" in u:
            return httpx.Response(200, text=yahoo_text_tweets)
        if "api.vxtwitter.com/luna/status/888888888888888" in u:
            return httpx.Response(200, json={"tweetID": "888888888888888", "user_screen_name": "luna", "user_name": "Luna", "text": "no video", "media_extended": []})
        if "imgur.com/search" in u:
            return httpx.Response(200, text=imgur_p1)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        yt_shr = await tsp.get_search_provider("youtube").search(client, "luna", "shorts")
        assert yt_shr.items == [] and yt_shr.has_more is False and yt_shr.next_cursor is None

        x_vid = await tsp.get_search_provider("x").search(client, "luna", "videos")
        assert x_vid.items == [] and x_vid.has_more is False and x_vid.next_cursor is None

        im1 = await tsp.get_search_provider("imgur").search(client, "luna", "albums")
        assert len(im1.items) == 1 and im1.has_more is True
        im2 = await tsp.get_search_provider("imgur").search(client, "luna", "albums", cursor=im1.next_cursor)
        assert im2.items == [] and im2.has_more is False and im2.next_cursor is None

        # Evil host with imgur.com path substring must be rejected before issuing HTTP request
        evil_album = await tsp.fetch_imgur_album_photos(client, "https://evil.example/imgur.com/a/abc123")
        assert evil_album is None

        # Imgur relative hrefs outside http(s) or imgur hosts must not produce javascript: URLs
        bad_scheme = tsp._http_url("https://imgur.com", "javascript:alert(1)")
        assert bad_scheme == ""


@pytest.mark.asyncio
async def test_real_source_fidelity_portal_tube_rank_yt_subs_imgur_api_and_x_partial():
    import asyncio
    from src.server.timeline_search_providers import get_search_provider

    # 1) Exact real PortalTube pornstar + channel HTML where Rank anchor precedes .title/.usernameLink
    ph_ps_real = '''<ul id="pornstarsSearchResult">
      <li class="sniperModeEngaged"><ins class="adsbytrafficjunky"></ins></li>
      <li><div class="wrap">
        <a href="/pornstar/lana-s"><span class="pornstar_label"><span class="title-album">Rank:<span class="rank_number">0</span></span></span><img src="https://ei.cdn.portal-tube.example/lana.jpg" alt="Lana S"></a>
        <div class="thumbnail-info-wrapper"><a href="/pornstar/lana-s" class="title">Lana S</a><span class="videosNumber">14 Videos</span><span class="pstarViews">3.1M views</span></div>
      </div></li>
    </ul>'''
    ph_ch_real = '''<section id="searchChannelsSection"><ul><li class="wrap"><div class="channelsWrapper clearfix">
      <div class="imgWrapper"><a href="/channels/pornochic"><div class="rank"><span>Rank<br> 236</span></div></a></div>
      <div class="description"><div class="avatar"><a href="/channels/pornochic" class="usernameLink"><img src="https://ei.cdn.portal-tube.example/ch.jpg" alt="PORNOCHIC avatar"></a></div>
      <div class="descriptionContainer"><ul><li><a href="/channels/pornochic" class="usernameLink">PORNOCHIC</a></li><li><span>76,628</span> Subscribers</li><li><span>412</span> Videos</li></ul></div></div>
    </div></li></ul></section>'''
    ph_gif_search = '<ul class="gifs"><li class="gifVideoBlock"><a href="/gif/777" title="Lana Real GIF"><img data-thumb_url="https://ei.cdn.portal-tube.example/g.jpg"></a></li></ul>'

    # 2) YouTube channelRenderer with handle in subscriberCountText & count in videoCountText
    yt_ch_real = "<script>var ytInitialData = " + json.dumps({
        "contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [{"channelRenderer": {
                "channelId": "UCqk3CdGN_j8IR9z4uBbVPSg",
                "title": {"simpleText": "Lana Del Rey"},
                "navigationEndpoint": {"commandMetadata": {"webCommandMetadata": {"url": "/@LanaDelRey"}}},
                "subscriberCountText": {"simpleText": "@LanaDelRey"},
                "videoCountText": {"simpleText": "19.1M subscribers"},
                "thumbnail": {"thumbnails": [{"url": "https://yt3.ggpht.com/ldr.jpg"}]},
            }}]}}
        ]}}}}
    }) + ";</script>"

    # 3) Imgur API v3 payload with real creator account_url, ups, views, animated mp4, and anonymous post
    imgur_api_v3 = {"success": True, "data": [
        {"id": "0pShG", "title": "5 shows everyone should watch", "account_url": "Smashqu", "is_album": True, "images_count": 6, "ups": 7551, "views": 413087, "datetime": 1420156340, "link": "https://imgur.com/a/0pShG", "images": [{"id": "bZxLRIx", "type": "image/jpeg", "link": "https://i.imgur.com/bZxLRIx.jpg"}]},
        {"id": "0N0I9ne", "title": "LANA?!", "account_url": None, "is_album": False, "animated": True, "type": "video/mp4", "mp4": "https://i.imgur.com/0N0I9ne.mp4", "link": "https://imgur.com/0N0I9ne", "ups": 1200, "views": 50000, "datetime": 1700000000},
    ]}

    # 4) PortalGrid dirty title with zero-width space and promotional suffix
    ep_dirty = '''<html><body><div class="mb" id="vf9"><div class="mbcontent"><a href="/video-9/lana-dress/"><img src="https://img.portal-grid.example/9.jpg"></a></div>
      <div class="mbunder"><p class="mbtit"><a href="/video-9/lana-dress/">Lana \u200bin \u200bsexy dress Explore Full Videos </a></p></div></div></body></html>'''

    seen_ph_gif_urls = []

    async def async_handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "portal-tube.example/pornstars/search" in u:
            return httpx.Response(200, text=ph_ps_real)
        if "portal-tube.example/channels/search" in u:
            return httpx.Response(200, text=ph_ch_real)
        if "portal-tube.example/gifs" in u:
            seen_ph_gif_urls.append(u)
            return httpx.Response(200, text=ph_gif_search if "/gifs/search" in u else "<html></html>")
        if "youtube.com/results" in u:
            return httpx.Response(200, text=yt_ch_real)
        if "api.imgur.com/3/gallery/search/" in u:
            return httpx.Response(200, json=imgur_api_v3)
        if "portal-grid.example/search/lana/" in u:
            return httpx.Response(200, text=ep_dirty)
        if "search.yahoo.com/search" in u:
            return httpx.Response(200, text='<a href="https://x.com/lana_fast">L</a><a href="https://x.com/lana_hang">H</a>')
        if "api.fxtwitter.com/lana_fast" in u:
            return httpx.Response(200, json={"user": {"screen_name": "lana_fast", "name": "Lana Fast", "followers": 999}})
        if "lana_hang" in u:
            await asyncio.sleep(10)
            return httpx.Response(404)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(async_handler)) as client:
        ph_prof = await get_search_provider("portal_tube").search(client, "lana", "profiles")
        ph_gif = await get_search_provider("portal_tube").search(client, "lana", "gifs")
        yt_prof = await get_search_provider("youtube").search(client, "lana", "profiles")
        im_alb = await get_search_provider("imgur").search(client, "lana", "albums")
        im_gif = await get_search_provider("imgur").search(client, "lana", "gifs")
        ep_vid = await get_search_provider("portal_grid").search(client, "lana", "videos")
        x_prof = await get_search_provider("x").search(client, "lana_query_test", "profiles")

    assert [p["name"] for p in ph_prof.profiles] == ["Lana S", "PORNOCHIC"]
    assert ph_prof.profiles[0]["videosCount"] == 14
    assert ph_prof.profiles[1]["subscribersText"] == "76,628 subscribers" or "76,628" in (ph_prof.profiles[1].get("subscribersText") or "")
    assert any("/gifs/search?" in u for u in seen_ph_gif_urls) and len(ph_gif.items) == 1
    assert yt_prof.profiles[0]["handle"] == "@LanaDelRey" and yt_prof.profiles[0]["subscribersText"] == "19.1M subscribers"
    assert im_alb.items[0]["creatorName"] == "Smashqu" and not im_alb.items[0].get("sourcePage") and im_alb.items[0]["photoCount"] == 6
    assert im_gif.items[0]["type"] == "gif" and im_gif.items[0]["creatorName"] == "Imgur"
    assert "\u200b" not in ep_vid.items[0]["title"] and "Explore Full Videos" not in ep_vid.items[0]["title"]
    assert any(p["handle"] == "@lana_fast" for p in x_prof.profiles)


def test_omni_search_interleaves_sources_round_robin_preserving_per_source_order():
    from src.server.timeline_omni_service import router
    from src.server.timeline_search_providers import (
        SearchPageResult,
        SearchProviderCapabilities,
        list_search_providers,
        register_search_provider,
        unregister_search_provider,
    )

    class _OrderedMockProvider:
        def __init__(self, source_id: str, video_ids: list[str], profile_ids: list[str]):
            self._sid = source_id
            self._video_ids = video_ids
            self._profile_ids = profile_ids
            cats = ("profiles", "videos") if profile_ids else ("videos",)
            self.capabilities = SearchProviderCapabilities(source_id, source_id.upper(), cats, False)

        async def search(self, client, query, category, cursor=None):
            if category == "profiles":
                profs = [
                    {
                        "id": f"{self._sid}:{pid}",
                        "name": f"{query} {pid}",
                        "handle": f"@{pid}",
                        "avatar": "",
                        "profileUrl": f"https://{self._sid}.test/u/{pid}",
                        "site": self._sid,
                    }
                    for pid in self._profile_ids
                ]
                return SearchPageResult(self._sid, "profiles", profs, [], None, False)
            vids = [
                {
                    "id": vid,
                    "creatorId": f"{self._sid}:c",
                    "creatorName": f"Creator {vid}",
                    "creatorHandle": f"@{vid}",
                    "creatorAvatar": "",
                    "type": "video",
                    "source": self._sid,
                    "originalUrl": f"https://{self._sid}.test/v/{vid}",
                    "title": f"{query} {vid}",
                    "comments": [],
                }
                for vid in self._video_ids
            ]
            return SearchPageResult(self._sid, "videos", [], vids, None, False)

    saved = list(list_search_providers())
    for p in saved:
        unregister_search_provider(p.capabilities.source_id)

    app = FastAPI()
    app.include_router(router)
    register_search_provider(_OrderedMockProvider("src_a", ["a1", "a2", "a3"], ["pa1", "pa2"]))
    register_search_provider(_OrderedMockProvider("src_b", ["b1", "b2", "b3"], ["pb1"]))
    register_search_provider(_OrderedMockProvider("src_c", ["c1", "c2"], []))
    try:
        client = TestClient(app)
        resp = client.post("/api/profile-hub/timeline/omni-search", json={"query": "luna_rr", "source": "all"})
        assert resp.status_code == 200
        body = resp.json()
        assert [it["id"] for it in body["sections"]["videos"]] == ["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3"]
        assert [it["id"] for it in body["posts"]] == ["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3"]
        assert [p["id"] for p in body["sections"]["profiles"]] == ["src_a:pa1", "src_b:pb1", "src_a:pa2"]
        assert [p["id"] for p in body["creators"]] == ["src_a:pa1", "src_b:pb1", "src_a:pa2"]
        assert body["sourceStatus"]["src_a"]["count"] == 5
        assert body["sourceStatus"]["src_b"]["count"] == 4
        assert body["sourceStatus"]["src_c"]["count"] == 2
    finally:
        for sid in ("src_a", "src_b", "src_c"):
            unregister_search_provider(sid)
        for p in saved:
            register_search_provider(p)


@pytest.mark.asyncio
async def test_portal_state_hydrates_missing_landing_creators_performers_and_album_authors():
    xh_search_html = "<script>window.initials=" + json.dumps({
        "pagination": {"active": 1, "next": 2, "maxPages": 4},
        "searchResult": {
            "videoThumbProps": [
                {
                    "id": 101,
                    "title": "Aria Channel Clip",
                    "duration": 185,
                    "created": 1700000000,
                    "views": 199444,
                    "pageURL": "https://portal-state.example/videos/aria-ch-101",
                    "thumbURL": "https://cdn.portal-state.example/t101.jpg",
                    "landing": {
                        "name": "ChannelStudio",
                        "link": "https://portal-state.example/channels/channelstudio",
                        "logo": "https://cdn.portal-state.example/logo101.jpg",
                    },
                },
                {
                    "id": 102,
                    "title": "Aria Public User Clip",
                    "duration": 240,
                    "created": 1700000000,
                    "views": 741779,
                    "pageURL": "https://portal-state.example/videos/aria-usr-102",
                    "thumbURL": "https://cdn.portal-state.example/t102.jpg",
                },
                {
                    "id": 103,
                    "title": "Aria Performer Clip",
                    "duration": 620,
                    "created": 1534962904,
                    "views": 4603740,
                    "pageURL": "https://portal-state.example/videos/aria-perf-103",
                    "thumbURL": "https://cdn.portal-state.example/t103.jpg",
                },
            ]
        },
    }) + ";</script>"

    xh_vid_102_html = "<script>window.initials=" + json.dumps({
        "videoModel": {
            "author": {
                "name": "creator_alpha",
                "pageURL": "https://portal-state.example/users/profiles/creator_alpha",
                "retired": False,
            },
            "channelModel": None,
        },
        "videoEntity": {"maxResolution": "720p", "pornstarModels": []},
    }) + ";</script>"

    xh_vid_103_html = (
        "<script>window.initials="
        + json.dumps({
            "videoModel": {
                "author": {"name": "retired_u", "pageURL": None, "retired": True},
                "channelModel": None,
            },
            "videoEntity": {
                "maxResolution": "240p",
                "pornstarModels": [
                    {"name": "Other Costar", "inurl": "other-costar"},
                    {"name": "Aria Performer", "inurl": "aria-performer"},
                ],
            },
        })
        + ';</script><a href="https://portal-state.example/pornstars/aria-performer"><img src="https://ic-tt-nss.cdn.portal-state.example/aria.jpg"/></a>'
    )

    xh_photos_html = "<script>window.initials=" + json.dumps({
        "searchResultsPhotoComponent": {
            "pagination": {"active": 1, "next": 2, "maxPages": 3},
            "list": [
                {
                    "id": 501,
                    "titleLocalized": "Aria Photo Set",
                    "pageURL": "https://portal-state.example/photos/gallery/aria-set-501",
                    "imageURL": "https://cdn.portal-state.example/p501.jpg",
                    "imgCount": 24,
                    "views": 3195,
                    "author": {
                        "name": "PhotoAuthor",
                        "link": "https://portal-state.example/users/photoauthor",
                        "img": "https://cdn.portal-state.example/pa.jpg",
                    },
                },
                {
                    "id": 502,
                    "titleLocalized": "Anonymous Set",
                    "pageURL": "https://portal-state.example/photos/gallery/anon-502",
                    "thumbURL": "https://cdn.portal-state.example/p502.jpg",
                    "imgCount": 8,
                    "views": 900,
                    "author": None,
                },
            ],
        }
    }) + ";</script>"

    async def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "/photos/search/" in u:
            return httpx.Response(200, text=xh_photos_html)
        if "/search/" in u:
            return httpx.Response(200, text=xh_search_html)
        if "aria-usr-102" in u:
            return httpx.Response(200, text=xh_vid_102_html)
        if "aria-perf-103" in u:
            return httpx.Response(200, text=xh_vid_103_html)
        return httpx.Response(404)

    provider = get_search_provider("portal_state")
    assert provider is not None
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        v_res = await provider.search(client, "aria", "videos")
        a_res = await provider.search(client, "aria", "albums")

    assert v_res.items[0]["creatorName"] == "ChannelStudio"
    assert v_res.items[0]["views"] == "199K"
    assert v_res.items[1]["creatorName"] == "creator_alpha"
    assert v_res.items[1]["sourcePage"] == "https://portal-state.example/users/profiles/creator_alpha"
    assert v_res.items[1]["resolution"] == "720p"
    assert v_res.items[2]["creatorName"] == "Aria Performer"
    assert v_res.items[2]["sourcePage"] == "https://portal-state.example/pornstars/aria-performer"
    assert v_res.items[2]["creatorAvatar"] == "https://ic-tt-nss.cdn.portal-state.example/aria.jpg"
    assert v_res.items[2]["resolution"] == "240p"
    assert v_res.items[2]["views"] == "4.6M"
    assert any(p["name"] == "Aria Performer" for p in v_res.profiles)

    assert len(a_res.items) == 2
    assert a_res.items[0]["creatorName"] == "PhotoAuthor"
    assert a_res.items[0]["sourcePage"] == "https://portal-state.example/users/photoauthor"
    assert a_res.items[0]["creatorAvatar"] == "https://cdn.portal-state.example/pa.jpg"
    assert a_res.items[1]["creatorName"] == "PortalState"
    assert a_res.has_more is True


