#!/usr/bin/env python3
"""Local static + /api/playlist server (stdlib only). Mirrors Vercel api/playlist.js scrape."""

from __future__ import annotations

import argparse
import json
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
MAX_VIDEOS = 50
YT_INITIAL_RE = re.compile(r"ytInitialData\s*=\s*(\{.+?\});\s*</script>", re.DOTALL)


def walk_collect(obj, videos, seen, meta):
    if obj is None:
        return
    if isinstance(obj, list):
        for item in obj:
            walk_collect(item, videos, seen, meta)
        return
    if not isinstance(obj, dict):
        return
    pmr = obj.get("playlistMetadataRenderer")
    if pmr and meta.get("title") is None:
        title = pmr.get("title")
        if isinstance(title, str) and title:
            meta["title"] = title
    lvm = obj.get("lockupViewModel")
    if lvm:
        video_id = lvm.get("contentId")
        if (
            isinstance(video_id, str)
            and re.fullmatch(r"[a-zA-Z0-9_-]{11}", video_id)
            and video_id not in seen
        ):
            seen.add(video_id)
            title = video_id
            meta_block = (lvm.get("metadata") or {}).get("lockupMetadataViewModel") or {}
            t = meta_block.get("title")
            if isinstance(t, str):
                title = t
            elif isinstance(t, dict):
                if isinstance(t.get("content"), str):
                    title = t["content"]
                elif isinstance(t.get("simpleText"), str):
                    title = t["simpleText"]
            videos.append({"videoId": video_id, "title": title})
    for value in obj.values():
        walk_collect(value, videos, seen, meta)


def scrape_playlist(list_id: str) -> dict:
    url = f"https://www.youtube.com/playlist?list={list_id}"
    req = Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urlopen(req, timeout=25) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    m = YT_INITIAL_RE.search(html)
    if not m:
        raise ValueError("Could not parse playlist data")
    data = json.loads(m.group(1))
    videos = []
    seen = set()
    meta = {"title": None}
    walk_collect(data, videos, seen, meta)
    return {
        "playlistId": list_id,
        "title": meta["title"] or "Playlist",
        "videos": videos[:MAX_VIDEOS],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/playlist":
            self._handle_playlist(parsed)
            return
        if parsed.path.startswith("/api/"):
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":false,"error":"Not found"}')
            return
        super().do_GET()

    def _handle_playlist(self, parsed):
        qs = parse_qs(parsed.query)
        list_id = (qs.get("list") or [""])[0].strip()
        if not list_id or not re.fullmatch(r"[a-zA-Z0-9_-]{10,80}", list_id):
            self._json(400, {"ok": False, "error": "Missing or invalid list parameter"})
            return
        try:
            result = scrape_playlist(list_id)
        except HTTPError as e:
            self._json(502, {"ok": False, "error": f"YouTube returned {e.code}"})
            return
        except (URLError, TimeoutError, ValueError, json.JSONDecodeError) as e:
            self._json(502, {"ok": False, "error": str(e) or "Failed to fetch playlist"})
            return
        if not result["videos"]:
            self._json(404, {"ok": False, "error": "Playlist is empty or unavailable"})
            return
        self._json(
            200,
            {
                "ok": True,
                "playlistId": result["playlistId"],
                "title": result["title"],
                "videos": result["videos"],
            },
        )

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description="YouTube Shquared local server")
    parser.add_argument("-p", "--port", type=int, default=4173)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Serving {ROOT} at http://127.0.0.1:{args.port}/", flush=True)
    print("Playlist API: GET /api/playlist?list=PLAYLIST_ID", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)


if __name__ == "__main__":
    main()
