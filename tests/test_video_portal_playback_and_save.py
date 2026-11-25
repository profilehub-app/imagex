"""Tests for generic VideoPortal streamFallback in server and safe progressive MP4 / muxed HLS saving."""
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_video_portal_engine import _write_synthetic_portal_config


def test_select_playable_format_and_hls_master_muxed_codecs():
    from src.server.profile_hub_execution import ExecutionError
    from src.server.timeline_video_save import hls_master_has_audio_video, select_playable_format

    # Extractor progressive dict without explicit ext/acodec/vcodec
    prog_info = {
        "formats": [
            {"url": "https://cdn.portal.example/hls/master.m3u8", "format_id": "hls-1080p", "protocol": "m3u8_native"},
            {"url": "https://cdn.portal.example/mp4/clip_low.mp4", "format_id": "mp4-low"},
            {"url": "https://cdn.portal.example/mp4/clip_high.mp4", "format_id": "mp4-high"},
        ]
    }
    picked = select_playable_format(prog_info)
    assert picked is not None
    assert picked["stream_url"] == "https://cdn.portal.example/mp4/clip_high.mp4"

    # Reject video-only or audio-only even with mp4 format_id
    video_only = {
        "formats": [
            {"url": "https://cdn.portal.example/mp4/vonly.mp4", "format_id": "mp4-high", "ext": "mp4", "vcodec": "avc1", "acodec": "none"},
            {"url": "https://cdn.portal.example/mp4/aonly.mp4", "format_id": "mp4-low", "ext": "mp4", "vcodec": "none", "acodec": "mp4a.40.2"},
        ]
    }
    with pytest.raises(ExecutionError):
        select_playable_format(video_only)

    # Muxed HLS playlist declaring both video + audio codecs inline on STREAM-INF
    muxed_hls = (
        "#EXTM3U\n"
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"\n'
        "hls-720p.m3u8\n"
    )
    assert hls_master_has_audio_video(muxed_hls, "https://cdn.portal.example/hls/master.m3u8") is True

    # Video-only HLS without audio codec or AUDIO group must remain rejected
    video_only_hls = (
        "#EXTM3U\n"
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f"\n'
        "hls-720p.m3u8\n"
    )
    assert hls_master_has_audio_video(video_only_hls, "https://cdn.portal.example/hls/master.m3u8") is False


def test_server_qualities_endpoint_uses_generic_stream_fallback(tmp_path, monkeypatch):
    cfg_path = _write_synthetic_portal_config(tmp_path)
    monkeypatch.setenv("IMAGEX_CONNECTORS_FILE", str(cfg_path))
    from src.server import server
    from src.server.connector_registry import load_connector_bundle

    load_connector_bundle(force_reload=True)

    watch_html = """
    <html><body>
      <script>
        portalPlayer.setTitle('Fallback Recovered Clip');
        portalPlayer.setPoster('https://cdn.portal.example/posters/fb1.jpg');
        portalPlayer.setHLS('https://cdn.portal.example/hls/fb1/master.m3u8');
        portalPlayer.setHD('https://cdn.portal.example/mp4/fb1_hd.mp4');
        portalPlayer.setSD('https://cdn.portal.example/mp4/fb1_sd.mp4');
      </script>
    </body></html>
    """

    class _FailingYDL:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download=False):
            raise RuntimeError("simulated yt-dlp extraction failure")

    import yt_dlp
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FailingYDL)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/video.fb101/fallback_test":
            return httpx.Response(200, text=watch_html, headers={"content-type": "text/html"})
        return httpx.Response(404, text="not found")

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_async_client(transport=transport, **{k: v for k, v in kw.items() if k != "transport"}))

    client = TestClient(server.app)
    resp = client.get("/api/video-stream-qualities", params={"url": "https://portal.example/video.fb101/fallback_test"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_hls"] is True
    assert "master.m3u8" in (body["master_hls_url"] or "")
    assert [q["height"] for q in body["qualities"]] == [720, 360]
