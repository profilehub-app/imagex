import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from playwright.async_api import async_playwright

from src.server.social_timeline import SocialTimeline, social_timeline_router


def tweet(number):
    return f"""
    <article data-testid="tweet" style="height: 460px">
      <div data-testid="User-Name">Fixture Author<br>@example</div>
      <a href="/example/status/{number}"><time datetime="2026-01-01T00:00:00Z">Jan 1</time></a>
      <div data-testid="tweetText">Publication {number}</div>
      <button data-testid="like">7</button>
    </article>
    """


@pytest.mark.asyncio
async def test_x_timeline_pages_rendered_posts_and_followed_accounts():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={"width": 900, "height": 700})
        service = SocialTimeline()
        service.context = context

        async def source(route):
            path = route.request.url.removeprefix("https://x.com")
            top = '<nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav>'
            if path == "/owner/following":
                content = '<div data-testid="UserCell"><a href="/example">Fixture Author</a><div data-testid="UserDescription">Bio</div></div>'
            elif path == "/example":
                content = tweet(21) + tweet(22)
            else:
                content = f"""
                <div role="tablist">
                  <button role="tab" aria-selected="true">For you</button>
                  <button role="tab" aria-selected="false" onclick="
                    this.previousElementSibling.setAttribute('aria-selected', false);
                    this.setAttribute('aria-selected', true);
                    document.querySelector('#feed').replaceChildren(document.querySelector('#following').content.cloneNode(true));
                  ">Following</button>
                </div>
                <div id="feed">{tweet(1)}{tweet(2)}{tweet(3)}</div>
                <template id="following">{tweet(11)}{tweet(12)}</template>
                <template id="more">{tweet(3)}{tweet(4)}{tweet(5)}</template>
                <script>
                  addEventListener('scroll', () => {{
                    document.querySelector('#feed').append(document.querySelector('#more').content.cloneNode(true));
                  }}, {{once: true}});
                </script>
                """
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'{top}<main data-testid="primaryColumn">{content}</main>')

        await context.route("https://x.com/**", source)
        app = FastAPI()
        app.include_router(social_timeline_router(service))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            async def read(scope, cursor, offset=0, **options):
                return await client.post(
                    f"/api/social-timeline/x/batch/{offset}",
                    json={"scope": scope, "cursor": f"5b252af6-ea4d-45e8-ad29-{cursor:012}", "advance": bool(offset), **options},
                )

            first = await read("recommended", 1)
            assert first.status_code == 200, first.text
            assert [item["id"] for item in first.json()["items"]] == ["1", "2", "3"]
            assert first.json()["items"][0]["metrics"]["likes"] == 7
            more = await read("recommended", 1, 1)
            assert [item["id"] for item in more.json()["items"]] == ["4", "5"]
            assert (await read("recommended", 1, 1)).json() == more.json()
            assert (await read("following", 1, 1)).status_code == 409
            following = await read("following", 2)
            assert [item["id"] for item in following.json()["items"]] == ["11", "12"]
            accounts = await read("accounts", 3)
            assert accounts.json()["items"][0]["handle"] == "example"
            profile = await read("profile", 4, handle="example")
            assert [item["id"] for item in profile.json()["items"]] == ["21", "22"]
            assert (await read("profile", 5, handle="a/b")).status_code == 422
            forbidden = await client.post(
                "/api/social-timeline/x/batch/0",
                headers={"Origin": "https://example.test"},
                json={"scope": "recommended", "cursor": "5b252af6-ea4d-45e8-ad29-000000000001"},
            )
            assert forbidden.status_code == 403
        await service.close()
        await browser.close()


@pytest.mark.asyncio
async def test_x_post_thread_reads_focal_tweet_views_emojis_and_replies():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={"width": 900, "height": 700})
        service = SocialTimeline()
        service.context = context

        async def source(route):
            path = route.request.url.removeprefix("https://x.com")
            top = '<nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav>'
            if path == "/example/status/1234567890":
                content = """
                <article data-testid="tweet" style="height: 280px">
                  <div data-testid="User-Name">M Author<br>@example</div>
                  <div data-testid="tweetText">Road trip essentials <img alt="👅" src="https://abs-0.twimg.com/emoji/v2/svg/1f445.svg" /></div>
                  <a href="/example/status/1234567890"><time datetime="2026-08-19T20:45:00Z">5:45 PM · Aug 19, 2026</time></a>
                  <a href="/example/status/1234567890/analytics">11.6K Views</a>
                  <button data-testid="reply">2</button>
                  <button data-testid="retweet">1</button>
                  <button data-testid="like">26</button>
                  <button data-testid="bookmark">2</button>
                </article>
                <article data-testid="tweet" style="height: 160px">
                  <div data-testid="User-Name">Morant<br>@whoObserver</div>
                  <a href="/whoObserver/status/9990001111"><time datetime="2026-08-19T21:15:00Z">1h</time></a>
                  <div data-testid="tweetText">id like that, il be getting my own soon</div>
                  <a href="/whoObserver/status/9990001111/analytics">13</a>
                </article>
                <article data-testid="tweet" style="height: 160px">
                  <div data-testid="User-Name">Mike Weenis<br>@MikeWeenisofqi</div>
                  <a href="/MikeWeenisofqi/status/9990002222"><time datetime="2026-10-11T10:00:00Z">Oct 11</time></a>
                  <div data-testid="tweetText">When you lwk think about starting to smoke bc ts mad cute</div>
                  <a href="/MikeWeenisofqi/status/9990002222/analytics">37</a>
                </article>
                """
            else:
                content = ""
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'{top}<main data-testid="primaryColumn">{content}</main>')

        await context.route("https://x.com/**", source)
        app = FastAPI()
        app.include_router(social_timeline_router(service))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            resp = await client.post(
                "/api/social-timeline/x/batch/0",
                json={
                    "scope": "post",
                    "handle": "example",
                    "postId": "1234567890",
                    "cursor": "5b252af6-ea4d-45e8-ad29-000000000099",
                    "advance": False,
                },
            )
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]
            assert [it["id"] for it in items] == ["1234567890", "9990001111", "9990002222"]
            assert items[0]["text"] == "Road trip essentials 👅"
            assert items[0]["metrics"]["views"] == 11600
            assert items[0]["metrics"]["bookmarks"] == 2
            assert items[1]["handle"] == "whoObserver"
            assert items[1]["metrics"]["views"] == 13
            assert items[2]["handle"] == "MikeWeenisofqi"
            assert items[2]["metrics"]["views"] == 37
        await service.close()
        await browser.close()


@pytest.mark.asyncio
async def test_x_explore_trends_following_state_and_aria_repost_counts():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={"width": 900, "height": 700})
        service = SocialTimeline()
        service.context = context

        async def source(route):
            path = route.request.url.removeprefix("https://x.com")
            top = '<nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav>'
            if path == "/explore":
                content = """
                <div data-testid="trend"><div>Trending in Brazil</div><div>#LiveTopic</div><div>18.4K posts</div></div>
                <div data-testid="trend"><div>Sports · Trending</div><div>Finals</div><div>92K posts</div></div>
                <article data-testid="tweet" style="height: 260px">
                  <div data-testid="User-Name">Explore Author<br>@exploreuser</div>
                  <a href="/exploreuser/status/555111222"><time datetime="2026-11-20T12:00:00Z">Nov 20</time></a>
                  <div data-testid="tweetText">Live explore post</div>
                  <button data-testid="retweet" aria-label="42 reposts. Repost"></button>
                  <button data-testid="like" aria-label="150 likes. Like"></button>
                </article>
                """
            elif path == "/followeduser":
                content = """
                <div data-testid="UserName"><div>Followed Person</div><div>@followeduser</div></div>
                <button data-testid="98765-unfollow">Following</button>
                """ + tweet(77)
            else:
                content = ""
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'{top}<main data-testid="primaryColumn">{content}</main>')

        await context.route("https://x.com/**", source)
        app = FastAPI()
        app.include_router(social_timeline_router(service))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            explore = await client.post(
                "/api/social-timeline/x/batch/0",
                json={"scope": "explore", "cursor": "5b252af6-ea4d-45e8-ad29-000000000101", "advance": False},
            )
            assert explore.status_code == 200, explore.text
            payload = explore.json()
            assert [t["topic"] for t in payload["trends"]] == ["#LiveTopic", "Finals"]
            assert payload["items"][0]["id"] == "555111222"
            assert payload["items"][0]["metrics"]["reposts"] == 42
            assert payload["items"][0]["metrics"]["likes"] == 150

            prof = await client.post(
                "/api/social-timeline/x/batch/0",
                json={"scope": "profile", "handle": "@followeduser", "cursor": "5b252af6-ea4d-45e8-ad29-000000000102", "advance": False},
            )
            assert prof.status_code == 200, prof.text
            assert prof.json()["profile"]["isFollowing"] is True
        await service.close()
        await browser.close()


@pytest.mark.asyncio
async def test_search_scope_urls_and_people_top_video_tabs():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={"width": 900, "height": 700})
        service = SocialTimeline()
        service.context = context
        requested_urls = []

        async def source(route):
            requested_urls.append(route.request.url)
            u = route.request.url
            top = '<nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav>'
            if "f=user" in u:
                content = '<div data-testid="UserCell"><a href="/lunamusic">Luna Official</a><div data-testid="UserDescription">Singer</div></div>'
            elif "f=video" in u:
                content = tweet(701)
            elif "f=live" in u:
                content = tweet(801)
            elif "f=image" in u:
                content = tweet(901)
            else:
                content = (
                    '<div data-testid="UserCell"><a href="/lunamusic">Luna Official</a></div>'
                    f'<div id="feed">{tweet(501)}{tweet(502)}</div>'
                    f'<template id="more">{tweet(502)}{tweet(503)}</template>'
                    "<script>addEventListener('scroll', () => { document.querySelector('#feed').append(document.querySelector('#more').content.cloneNode(true)); }, {once: true});</script>"
                )
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'{top}<main data-testid="primaryColumn">{content}</main>')

        await context.route("https://x.com/**", source)
        app = FastAPI()
        app.include_router(social_timeline_router(service))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            top_r = await client.post("/api/social-timeline/x/batch/0", json={"scope": "search", "searchQuery": "luna live", "searchTab": "top", "backgroundOnly": True, "cursor": "5b252af6-ea4d-45e8-ad29-000000000201", "advance": False})
            assert top_r.status_code == 200, top_r.text
            assert [it["id"] for it in top_r.json()["items"]] == ["501", "502"]
            assert top_r.json()["relevantPeople"][0]["handle"] == "lunamusic"

            top_more = await client.post("/api/social-timeline/x/batch/1", json={"scope": "search", "searchQuery": "luna live", "searchTab": "top", "backgroundOnly": True, "cursor": "5b252af6-ea4d-45e8-ad29-000000000201", "advance": True})
            assert [it["id"] for it in top_more.json()["items"]] == ["503"]

            people_r = await client.post("/api/social-timeline/x/batch/0", json={"scope": "search", "searchQuery": "luna live", "searchTab": "people", "backgroundOnly": True, "cursor": "5b252af6-ea4d-45e8-ad29-000000000202", "advance": False})
            assert people_r.json()["items"][0]["handle"] == "lunamusic"

            for idx, (tab, tid) in enumerate([("videos", "701"), ("latest", "801"), ("photos", "901")], start=3):
                r = await client.post("/api/social-timeline/x/batch/0", json={"scope": "search", "searchQuery": "luna live", "searchTab": tab, "backgroundOnly": True, "cursor": f"5b252af6-ea4d-45e8-ad29-00000000020{idx}", "advance": False})
                assert [it["id"] for it in r.json()["items"]] == [tid]

        assert any("https://x.com/search?q=luna+live&src=typed_query&f=user" in u for u in requested_urls)
        assert any("f=video" in u for u in requested_urls)
        assert any("f=live" in u for u in requested_urls)
        assert any("f=image" in u for u in requested_urls)
        await service.close()
        await browser.close()


@pytest.mark.asyncio
async def test_search_scope_background_only_login_required_does_not_activate_and_recycles_search_tabs():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context(viewport={"width": 900, "height": 700})
        service = SocialTimeline()
        service.context = context
        logged_in = True

        async def source(route):
            if not logged_in:
                await route.fulfill(content_type="text/html; charset=utf-8", body='<main><a href="/login">Sign in</a></main>')
                return
            await route.fulfill(content_type="text/html; charset=utf-8", body=f'<nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav><main data-testid="primaryColumn"><div role="tablist"><button role="tab" aria-selected="true">For you</button></div>{tweet(1)}</main>')

        await context.route("https://x.com/**", source)
        app = FastAPI()
        app.include_router(social_timeline_router(service))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1") as client:
            rec_cursor = "5b252af6-ea4d-45e8-ad29-000000000300"
            assert (await client.post("/api/social-timeline/x/batch/0", json={"scope": "recommended", "cursor": rec_cursor, "advance": False})).status_code == 200
            for i in range(1, 11):
                res = await client.post("/api/social-timeline/x/batch/0", json={"scope": "search", "searchQuery": f"luna {i}", "searchTab": "top", "backgroundOnly": True, "cursor": f"5b252af6-ea4d-45e8-ad29-0000000003{i:02d}", "advance": False})
                assert res.status_code == 200
            from uuid import UUID
            assert UUID(rec_cursor) in service.feeds

            logged_in = False
            fail_cursor = "5b252af6-ea4d-45e8-ad29-000000000399"
            orig_new_page = context.new_page
            brought_to_front = False

            async def wrapped_new_page():
                p = await orig_new_page()
                async def spy_front():
                    nonlocal brought_to_front
                    brought_to_front = True
                p.bring_to_front = spy_front
                return p

            context.new_page = wrapped_new_page
            login_res = await client.post("/api/social-timeline/x/batch/0", json={"scope": "search", "searchQuery": "luna", "searchTab": "top", "backgroundOnly": True, "cursor": fail_cursor, "advance": False})
            assert login_res.status_code == 200 and login_res.json()["status"] == "login_required"
            assert brought_to_front is False
            assert UUID(fail_cursor) not in service.feeds
        await service.close()
        await browser.close()
