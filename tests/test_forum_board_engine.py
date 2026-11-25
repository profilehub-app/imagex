import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest


def _write_test_forum_connectors(tmp_path: Path, monkeypatch) -> None:
    from src.server.connector_registry import clear_connector_cache

    cfg = {
        "catalogs": [],
        "forums": [
            {
                "id": "board_one",
                "displayName": "Media Board",
                "baseUrl": "https://board.example",
                "domains": ["board.example"],
                "catalogModes": ["albums", "videos", "gifs", "posts", "recent"],
                "defaultCategory": "albums",
                "forum": {
                    "indexPath": "/forum.php",
                    "searchPath": "/search.php?search_type=1",
                    "searchProcessPath": "/search.php?contenttype=1&do=process",
                    "dailyPath": "/search.php?do=getdaily",
                    "excludedBoardIds": ["999"],
                    "excludedTitleRegex": "promo|casino",
                    "boardRoles": {
                        "album_sets": ["10", "11"],
                        "artist_collections": ["20", "21"],
                        "video_releases": ["30", "31"],
                        "gif_boards": ["40"],
                        "link_drops": ["50"],
                    },
                    "searchFlagsByCategory": {
                        "albums": {"imgsearch": "1", "titleonly": "0", "showposts": "0"},
                        "videos": {"vidsearch": "1", "titleonly": "0", "showposts": "0"},
                        "gifs": {"imgsearch": "1", "querySuffix": " OR gif OR webm"},
                        "posts": {"showposts": "1"},
                        "profiles": {"forumchoice": ["20", "21"], "childforums": "1"},
                    },
                    "mirrorHosts": ["rapidgator.net", "k2s.cc", "pixeldrain.com"],
                },
            }
        ],
        "imageHosts": [
            {
                "id": "viewer_one",
                "domains": ["viewer.example"],
                "viewerPathPrefixes": ["/show/", "/i/"],
                "directHostRegex": "^img\\d*\\.viewer\\.example$",
                "directPathPrefixes": ["/images/"],
            }
        ],
    }
    p = tmp_path / "connectors.forum.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()


@pytest.mark.asyncio
async def test_forum_hierarchy_filtering_and_thread_post_parsing(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.forum_board_engine import (
        classify_thread_kind,
        fetch_board_hierarchy,
        parse_forum_thread_page,
    )

    _write_test_forum_connectors(tmp_path, monkeypatch)
    desc = get_connector_descriptor("board_one")
    assert desc is not None

    async def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == "https://board.example/forum.php":
            return httpx.Response(
                200,
                text="""
                <html><body><ol id="forums">
                  <li class="forumbit_nopost">
                    <h2 class="forumtitle"><a>Photo Collections</a></h2>
                    <a href="forums/10-Studio-Photo-Sets?s=abc">Studio Photo Sets</a>
                    <a href="forums/20-Artist-Collections?s=abc">Artist Collections</a>
                    <a href="forums/999-Promo-Spam?s=abc">Promo Casino Offer</a>
                  </li>
                  <li class="forumbit_nopost">
                    <h2 class="forumtitle"><a>Video Releases</a></h2>
                    <a href="forums/30-Scene-Videos?s=abc">Scene Videos</a>
                  </li>
                </ol></body></html>
                """,
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sections = await fetch_board_hierarchy(client, desc)

    all_ids = [b["id"] for sec in sections for b in sec["boards"]]
    assert "10-Studio-Photo-Sets" in all_ids
    assert "20-Artist-Collections" in all_ids
    assert "30-Scene-Videos" in all_ids
    assert "999-Promo-Spam" not in all_ids

    # Inline album + mirrors (wrapped viewer images + rapidgator mirror)
    album_html = """
    <html><head><base href="https://board.example/" /><title>Claire - Sunny Studio - x45</title></head><body>
      <div class="pagenav"><span>Page 1 of 4</span><a href="threads/501-Sunny-Studio/page2">2</a></div>
      <div id="post_1" class="postbitlegacy">
        <a class="username" href="members/11-Editor">Editor</a>
        <div id="post_message_1">
          <blockquote class="postcontent">
            Sunny Studio set<br/>
            <a href="https://viewer.example/show/1/01.jpg"><img src="https://t1.viewer.example/thumbs/1/01.jpg" /></a>
            <a href="https://viewer.example/show/1/02.jpg"><img src="https://t1.viewer.example/thumbs/1/02.jpg" /></a>
            <a href="https://viewer.example/show/1/03.jpg"><img src="https://t1.viewer.example/thumbs/1/03.jpg" /></a>
            <a href="https://viewer.example/show/1/04.jpg"><img src="https://t1.viewer.example/thumbs/1/04.jpg" /></a>
            Download Link: <a href="https://rapidgator.net/file/abc/Sunny.zip.html">Rapidgator</a>
          </blockquote>
        </div>
      </div>
    </body></html>
    """
    parsed_album = parse_forum_thread_page(album_html, "https://board.example/threads/501-Sunny-Studio", desc)
    assert parsed_album["threadKind"] == "inline_album"
    assert len(parsed_album["photos"]) == 4
    assert parsed_album["photos"][0]["isResolvedOriginal"] is False
    assert parsed_album["posts"][0]["releaseLinks"][0]["host"] == "rapidgator.net"
    assert parsed_album["totalPages"] == 4
    assert parsed_album["nextPageUrl"] == "https://board.example/threads/501-Sunny-Studio/page2"

    # Video release with standalone unwrapped [IMG] poster + screenlist + k2s mirror
    video_html = """
    <html><head><base href="https://board.example/" /><title>Scene Release REMASTERED - 1080p</title></head><body>
      <div id="post_2" class="postbitlegacy">
        <div class="breadcrumb"><a href="forums/30-Scene-Videos">Scene Videos</a></div>
        <a class="username" href="members/12-Ripper">Ripper</a>
        <div id="post_message_2">
          <blockquote class="postcontent">
            Release.1080p.MP4 (420MB)<br/>
            <img src="https://img3.viewer.example/images/50/poster_2x2.jpg" />
            <a href="https://viewer.example/show/50/screenlist.jpg"><img src="https://t3.viewer.example/thumbs/50/screenlist.jpg" /></a>
            <a href="https://k2s.cc/file/xyz">Keep2Share</a>
          </blockquote>
        </div>
      </div>
    </body></html>
    """
    parsed_video = parse_forum_thread_page(video_html, "https://board.example/threads/602-Scene-1080p", desc)
    assert parsed_video["threadKind"] == "video_release"
    assert len(parsed_video["photos"]) == 2
    assert parsed_video["photos"][0]["originalUrl"] == "https://img3.viewer.example/images/50/poster_2x2.jpg"
    assert parsed_video["posts"][0]["releaseLinks"][0]["url"] == "https://k2s.cc/file/xyz"
    assert "1080p" in parsed_video["releaseSpecs"]
    assert classify_thread_kind("Collection Pack x2", board_role="link_drops", inline_image_count=1, release_link_count=2) == "download_pack"


@pytest.mark.asyncio
async def test_forum_browse_separation_and_native_search_flags(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.forum_board_engine import browse_forum_board, search_forum_board

    _write_test_forum_connectors(tmp_path, monkeypatch)
    desc = get_connector_descriptor("board_one")
    assert desc is not None

    captured_posts: list[dict[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if request.method == "GET" and u == "https://board.example/forum.php":
            return httpx.Response(
                200,
                text="""
                <html><body><ol id="forums">
                  <li class="forumbit_nopost">
                    <h2 class="forumtitle"><a>Photo Collections</a></h2>
                    <a href="forums/10-Studio-Photo-Sets">Studio Photo Sets</a>
                  </li>
                  <li class="forumbit_nopost">
                    <h2 class="forumtitle"><a>Video Releases</a></h2>
                    <a href="forums/30-Scene-Videos">Scene Videos</a>
                  </li>
                </ol></body></html>
                """,
            )
        if request.method == "GET" and "/forums/10-Studio-Photo-Sets" in u:
            return httpx.Response(
                200,
                text="""
                <html><body><ol id="threads">
                  <li class="threadbit">
                    <a class="title" href="threads/701-Claire-Set-x40?goto=newpost">Claire Set - x40</a>
                    <a class="username" href="members/11-Editor">Editor</a>
                    <span>Replies: 5</span>
                  </li>
                  <li class="threadbit">
                    <a class="title" href="threads/702-Release-1080p-MP4?p=9#post9">Scene Clip 1080p MP4</a>
                  </li>
                </ol></body></html>
                """,
            )
        if request.method == "GET" and "/forums/30-Scene-Videos" in u:
            return httpx.Response(
                200,
                text="""
                <html><body><ol id="threads">
                  <li class="threadbit">
                    <a class="title" href="threads/801-Studio-Movie-1080p">Studio Movie - 1080p</a>
                  </li>
                </ol></body></html>
                """,
            )
        if request.method == "POST" and "search.php" in u:
            raw_body = await request.aread()
            body_qs = {k: v[0] if len(v) == 1 else v for k, v in parse_qs(raw_body.decode()).items()}
            captured_posts.append(body_qs)
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <li class="threadbit"><a class="title" href="threads/901-Found-Result">Found Result</a></li>
                  <div class="pagenav"><a href="search.php?searchid=8899&page=2">2</a></div>
                </body></html>
                """,
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        alb_res = await browse_forum_board(client, desc, "albums")
        assert len(alb_res.items) == 1
        assert alb_res.items[0]["albumUrl"] == "https://board.example/threads/701-Claire-Set-x40"
        assert alb_res.items[0]["threadKind"] == "inline_album"

        vid_res = await browse_forum_board(client, desc, "videos")
        assert len(vid_res.items) == 1
        assert vid_res.items[0]["threadKind"] == "video_release"

        s_alb = await search_forum_board(client, desc, "claire", "albums")
        assert s_alb.items[0]["albumUrl"] == "https://board.example/threads/901-Found-Result"
        s_vid = await search_forum_board(client, desc, "claire", "videos")
        s_post = await search_forum_board(client, desc, "claire", "posts")
        s_prof = await search_forum_board(client, desc, "claire", "profiles")

    assert captured_posts[0].get("imgsearch") == "1"
    assert captured_posts[1].get("vidsearch") == "1"
    assert captured_posts[2].get("showposts") == "1"
    assert "forumchoice[]" in str(captured_posts[3]) or "20" in str(captured_posts[3])


@pytest.mark.asyncio
async def test_forum_parent_container_auto_follows_child_subforum_and_skips_rule_stickies(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import get_connector_descriptor
    from src.server.forum_board_engine import browse_forum_board

    _write_test_forum_connectors(tmp_path, monkeypatch)
    desc = get_connector_descriptor("board_one")
    assert desc is not None

    async def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if u.endswith("/forums/10"):
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <ol class="childforum">
                    <li><h2 class="forumtitle"><a href="forums/11-Sub-Photo-Sets">Sub Photo Sets</a></h2></li>
                  </ol>
                </body></html>
                """,
            )
        if "/forums/11-Sub-Photo-Sets" in u:
            return httpx.Response(
                200,
                text="""
                <html><body><ol id="threads">
                  <li class="threadbit">
                    <a class="title" href="threads/100-Guidelines-and-Rules">Guidelines &amp; Rules: Photo Sets</a>
                  </li>
                  <li class="threadbit">
                    <a href="threads/777-Studio-Autumn-Collection"></a>
                    <span>Replies: 12</span>
                  </li>
                </ol></body></html>
                """,
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        res = await browse_forum_board(client, desc, "albums")

    assert len(res.items) == 1
    assert res.items[0]["title"] == "Studio Autumn Collection"
    assert res.items[0]["replyCount"] == 12


@pytest.mark.asyncio
async def test_forum_coalesced_search_slices_categories_with_single_upstream_post(tmp_path: Path, monkeypatch):
    from src.server.connector_registry import clear_connector_cache, get_connector_descriptor
    from src.server.forum_board_engine import clear_forum_search_cache, search_forum_board

    cfg = {
        "catalogs": [],
        "forums": [
            {
                "id": "board_coal",
                "displayName": "Coalesced Board",
                "baseUrl": "https://coal.example",
                "domains": ["coal.example"],
                "catalogModes": ["albums", "videos", "gifs", "posts", "recent"],
                "defaultCategory": "albums",
                "forum": {
                    "indexPath": "/forum.php",
                    "searchPath": "/search.php?search_type=1",
                    "searchProcessPath": "/search.php?do=process",
                    "coalesceTitleSearch": True,
                    "defaultSearchFlags": {"threadtitleonly": "1", "excludegay": "1"},
                    "boardRoles": {
                        "album_sets": ["10"],
                        "artist_collections": ["20"],
                        "video_releases": ["30"],
                        "gif_boards": ["40"],
                        "link_drops": ["50"],
                    },
                    "mirrorHosts": ["rapidgator.net"],
                },
            }
        ],
        "imageHosts": [],
    }
    p = tmp_path / "connectors.coal.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(p))
    clear_connector_cache()
    clear_forum_search_cache()

    desc = get_connector_descriptor("board_coal")
    assert desc is not None

    post_calls = 0
    captured_payload: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal post_calls
        if request.method == "POST" and "search.php" in str(request.url):
            post_calls += 1
            raw = await request.aread()
            for k, v in parse_qs(raw.decode()).items():
                captured_payload[k] = v[0]
            return httpx.Response(
                200,
                text="""
                <html><body>
                  <li class="threadbit">
                    <a class="title" href="threads/101-Claire-Vance-Studio-Set-269x">Claire Vance - Studio Set (269x)</a>
                    <a class="username" href="members/1-Poster">Poster</a>
                    <p class="threadpostedin"><a href="forums/10-Studio-Photo-Sets">Studio Photo Sets</a></p>
                  </li>
                  <li class="threadbit">
                    <a class="title" href="threads/202-Claire-Vance-1080p-MP4">Claire Vance - Feature Scene 1080p</a>
                    <p class="threadpostedin"><a href="forums/30-Scene-Videos">Scene Videos</a></p>
                  </li>
                  <li class="threadbit">
                    <a class="title" href="threads/303-Claire-Vance">Claire Vance</a>
                    <p class="threadpostedin"><a href="forums/20-Performers">Performers</a></p>
                  </li>
                  <li class="threadbit">
                    <a class="title" href="threads/404-Claire-Vance-Zip-Pack">Claire Vance Archive Pack</a>
                    <p class="threadpostedin"><a href="forums/50-Link-Drops">Link Drops</a></p>
                  </li>
                  <div class="pagination"><a rel="next" href="search.php?searchid=777&amp;page=2">Next</a></div>
                </body></html>
                """,
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        alb = await search_forum_board(client, desc, "claire vance", "albums")
        vid = await search_forum_board(client, desc, "claire vance", "videos")
        prof = await search_forum_board(client, desc, "claire vance", "profiles")
        post = await search_forum_board(client, desc, "claire vance", "posts")

        assert post_calls == 1, "Coalesced search must hit upstream only once across parallel/repeat categories"
        assert captured_payload.get("query") == '"claire vance"'
        assert captured_payload.get("threadtitleonly") == "1"
        assert len(alb.items) == 1
        assert alb.items[0]["boardName"] == "Studio Photo Sets"
        assert alb.items[0]["boardUrl"] == "https://coal.example/forums/10-Studio-Photo-Sets"
        assert alb.has_more is True
        assert len(vid.items) == 1
        assert vid.items[0]["threadKind"] == "video_release"
        assert len(prof.profiles) == 1
        assert prof.profiles[0]["name"] == "Claire Vance"
        assert len(post.items) == 1
        assert post.items[0]["boardName"] == "Link Drops"

        # Filtered search options (boardId + full posts scope + images filter + recent sort)
        captured_payload.clear()
        alb_filtered = await search_forum_board(
            client,
            desc,
            "claire vance",
            "albums",
            options={
                "boardId": "10-Studio-Photo-Sets",
                "searchScope": "posts",
                "mediaFilter": "images",
                "sortBy": "recent",
            },
        )
        assert post_calls == 2, "New option combination must trigger a distinct upstream search"
        assert captured_payload.get("contenttypeid") == "1"
        assert captured_payload.get("search_type") == "1"
        assert captured_payload.get("forumchoice[]") == "10"
        assert captured_payload.get("childforums") == "1"
        assert captured_payload.get("titleonly") == "0"
        assert captured_payload.get("imgsearch") == "1"
        assert captured_payload.get("sortby") == "lastpost"
        assert len(alb_filtered.items) >= 1
