"""
Generic anti-bot JavaScript challenge solver and yt-dlp bridge.
Replaces the obsolete PhantomJS dependency in yt-dlp with a fast bounded QuickJS
or headless Chromium/Playwright runner, solving JS cookie challenges generically
for any supported origin.
"""

import os
import re
import shutil
import subprocess
import tempfile
import logging
import http.cookiejar
from typing import Optional, Tuple, Dict
from urllib.parse import urlsplit

logger = logging.getLogger("js_challenge_solver")


def get_system_browser_path() -> Optional[str]:
    """Finds installed Google Chrome or Microsoft Edge executable on the system."""
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "google-chrome",
        "google-chrome-stable",
        "chromium-browser",
        "chromium",
        "microsoft-edge",
    ]
    for c in candidates:
        if os.path.isabs(c):
            if os.path.isfile(c):
                return c
        else:
            w = shutil.which(c)
            if w:
                return w
    return None


def solve_challenge_cookie_with_runtime(html: str) -> Dict[str, str]:
    """Evaluate bounded JS cookie challenge via QuickJS and return resulting cookies."""
    if not html:
        return {}
    m = re.search(r"<script[^>]*>(.*?)</script>", html, re.DOTALL)
    if not m:
        return {}
    script = m.group(1)
    if "go()" not in script and "document.cookie" not in script:
        return {}

    from .profile_cookie_runtime import calculate_cookie_script
    return calculate_cookie_script(script)


_CHALLENGE_PATTERNS = (
    r'<body\b[^>]+\bonload=["\']go\(\)',
    r'document\.cookie\s*=\s*["\']RNKEY=',
    r"document\.location\.reload\(true\)",
    r"leastFactor",
)


def _is_challenge_html(html: str) -> bool:
    if not html:
        return False
    if "flashvars_" in html or "mediaDefinitions" in html:
        return False
    return any(re.search(p, html) for p in _CHALLENGE_PATTERNS)


def _cookie_domains_for_url(url: Optional[str]) -> Tuple[str, ...]:
    host = (urlsplit(url or "").hostname or "").strip().lower().removeprefix("www.")
    if not host:
        return ()
    return (f".{host}", f"www.{host}", host)


def _apply_cookies_to_extractor(target, cookies: Dict[str, str], url: Optional[str] = None) -> None:
    if not target or not cookies:
        return
    domains = _cookie_domains_for_url(url)
    if hasattr(target, "_set_cookie") and domains:
        for host in domains:
            for k, v in cookies.items():
                target._set_cookie(host, k, v)
    jar = getattr(target, "cookiejar", None)
    if jar is None:
        jar = getattr(getattr(target, "_downloader", None), "cookiejar", None)
    if jar is not None and hasattr(jar, "set_cookie") and domains:
        dot_domain = domains[0]
        for k, v in cookies.items():
            cookie = http.cookiejar.Cookie(
                version=0,
                name=k,
                value=v,
                port=None,
                port_specified=False,
                domain=dot_domain,
                domain_specified=True,
                domain_initial_dot=True,
                path="/",
                path_specified=True,
                secure=True,
                expires=None,
                discard=True,
                comment=None,
                comment_url=None,
                rest={},
            )
            jar.set_cookie(cookie)


class HeadlessChromePhantomWrapper:
    """Drop-in replacement for yt-dlp PhantomJSwrapper using QuickJS / Chromium / Playwright."""

    def __init__(self, extractor=None, required_version=None, timeout=12000):
        self.extractor = extractor
        self.browser_exe = get_system_browser_path()
        self.timeout = timeout / 1000.0 if timeout else 12.0

    def get(
        self,
        url: str,
        html: Optional[str] = None,
        video_id: Optional[str] = None,
        note: Optional[str] = None,
        note2: str = "Executing JS on webpage",
        headers: Optional[dict] = None,
        jscode: str = "saveAndExit();",
    ) -> Tuple[str, str]:
        logger.info(f"[JS Challenge] Solving challenge for {url}...")

        if html:
            cookies = solve_challenge_cookie_with_runtime(html)
            if cookies:
                logger.info(f"[JS Challenge] Solved challenge cookie via runtime: {list(cookies.keys())}")
                _apply_cookies_to_extractor(self.extractor, cookies, url=url)

        if self.browser_exe:
            temp_profile = tempfile.mkdtemp(prefix="js_chrome_")
            try:
                cmd = [
                    self.browser_exe,
                    "--headless=new",
                    "--disable-gpu",
                    f"--user-data-dir={temp_profile}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--virtual-time-budget=8000",
                    "--dump-dom",
                    url,
                ]
                res = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=max(15, int(self.timeout)),
                )
                out_html = res.stdout or ""
                if out_html and ("flashvars_" in out_html or "mediaDefinitions" in out_html or "video_title" in out_html):
                    m_rn = re.search(r'cookie\s*=\s*["\']([^"\']+)["\']', out_html)
                    if m_rn:
                        parsed_cookies = {}
                        for part in m_rn.group(1).split(";"):
                            if "=" in part:
                                k, v = part.split("=", 1)
                                if k.strip().lower() not in ("path", "domain", "expires", "max-age", "samesite", "httponly", "secure"):
                                    parsed_cookies[k.strip()] = v.strip()
                        _apply_cookies_to_extractor(self.extractor, parsed_cookies, url=url)
                    return out_html, ""
                elif out_html and "leastFactor" not in out_html:
                    return out_html, ""
            except Exception as e:
                logger.warning(f"[JS Challenge] Browser subprocess failed: {e}. Trying Playwright fallback...")
            finally:
                shutil.rmtree(temp_profile, ignore_errors=True)

        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                launch_kwargs = {"headless": True}
                if self.browser_exe and os.path.isfile(self.browser_exe):
                    launch_kwargs["executable_path"] = self.browser_exe

                browser = p.chromium.launch(**launch_kwargs)
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                )
                page = context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(4000)
                content = page.content()
                browser_cookies = context.cookies()
                browser.close()
                domains = _cookie_domains_for_url(url)
                if hasattr(self.extractor, "_set_cookie") and domains:
                    for c in browser_cookies:
                        for host in domains:
                            self.extractor._set_cookie(host, c["name"], c["value"])
                if "flashvars_" in content or "mediaDefinitions" in content:
                    return content, ""
        except Exception as e_pw:
            logger.warning(f"[JS Challenge] Playwright fallback failed: {e_pw}")

        return html or "", ""


_PATCHED = False


def apply_ytdlp_challenge_patch():
    """Generically patch yt-dlp extractors so anti-bot JS cookie challenges are solved locally."""
    global _PATCHED
    if _PATCHED:
        return

    try:
        import yt_dlp.extractor.common as common_module
        import yt_dlp.extractor.openload as ol_module
        from yt_dlp.networking.common import Request

        ol_module.PhantomJSwrapper = HeadlessChromePhantomWrapper
        orig_download_handle = common_module.InfoExtractor._download_webpage_handle

        def patched_download_webpage_handle(self, *args, **kwargs):
            ret = orig_download_handle(self, *args, **kwargs)
            if not ret:
                return ret
            webpage, urlh = ret
            webpage_text = (
                webpage
                if isinstance(webpage, str)
                else (webpage.read().decode("utf-8", errors="replace") if hasattr(webpage, "read") else "")
            )

            if _is_challenge_html(webpage_text):
                url_or_request = args[0] if args else ""
                target_url = (
                    url_or_request.url
                    if isinstance(url_or_request, Request)
                    else str(url_or_request or "")
                )
                cookies = solve_challenge_cookie_with_runtime(webpage_text)
                if cookies:
                    _apply_cookies_to_extractor(self, cookies, url=target_url)
                    retry_ret = orig_download_handle(self, *args, **kwargs)
                    if retry_ret:
                        retry_page, retry_urlh = retry_ret
                        retry_text = (
                            retry_page
                            if isinstance(retry_page, str)
                            else (retry_page.read().decode("utf-8", errors="replace") if hasattr(retry_page, "read") else "")
                        )
                        if retry_text and not _is_challenge_html(retry_text):
                            return retry_ret
                        webpage_text = retry_text or webpage_text
                        ret = retry_ret

                phantom = HeadlessChromePhantomWrapper(self, required_version="2.0")
                solved_html, _ = phantom.get(target_url, html=webpage_text)
                if solved_html and ("flashvars_" in solved_html or "mediaDefinitions" in solved_html or "video_title" in solved_html):
                    return solved_html, urlh

                ret = orig_download_handle(self, *args, **kwargs)

            return ret

        common_module.InfoExtractor._download_webpage_handle = patched_download_webpage_handle
        _PATCHED = True
        logger.info("Successfully patched yt-dlp with generic HeadlessChromePhantomWrapper handler.")
    except Exception as exc:
        logger.warning(f"Could not monkeypatch yt-dlp challenge handler: {exc}")
