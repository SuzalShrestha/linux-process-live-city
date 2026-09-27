"""Tiny stdlib HTTP server: static frontend + JSON API."""

from __future__ import annotations

import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psutil

from .collector import SIGNALS, Collector

WEB_ROOT = (Path(__file__).resolve().parent / "web").resolve()
LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1"}

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def is_loopback(host: str) -> bool:
    if host in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Config:
    def __init__(self, collector: Collector, allow_signals: bool, token: str | None,
                 check_host: bool):
        self.collector = collector
        self.allow_signals = allow_signals
        self.token = token
        self.check_host = check_host


def make_handler(cfg: Config):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ProcessCity/1.0"

        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        # ---------------------------------------------------------- helpers
        def _send(self, code, body: bytes, ctype: str, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code, obj):
            body = json.dumps(obj, separators=(",", ":"), default=str).encode()
            self._send(code, body, "application/json")

        def _host_ok(self) -> bool:
            # Guards against DNS rebinding: a remote page resolving its own
            # hostname to 127.0.0.1 would otherwise be able to read our API.
            if not cfg.check_host:
                return True
            host = self.headers.get("Host", "")
            hostname = urlparse(f"//{host}").hostname or ""
            return hostname in LOOPBACK_NAMES

        def _token_ok(self, query) -> bool:
            if cfg.token is None:
                return True
            got = self.headers.get("X-LiveCity-Token") or query.get("token", [""])[0]
            return hmac.compare_digest(got, cfg.token)

        # ----------------------------------------------------------- routes
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if not self._host_ok():
                return self._json(403, {"error": "bad host header"})
            url = urlparse(self.path)
            query = parse_qs(url.query)
            if url.path.startswith("/api/"):
                if not self._token_ok(query):
                    return self._json(401, {"error": "missing or bad token"})
                return self._api_get(url.path)
            return self._static(url.path)

        def do_POST(self):
            if not self._host_ok():
                return self._json(403, {"error": "bad host header"})
            url = urlparse(self.path)
            if not self._token_ok(parse_qs(url.query)):
                return self._json(401, {"error": "missing or bad token"})
            # A custom header forces a CORS preflight, which we never answer,
            # so other origins can't POST here.
            if self.headers.get("X-LiveCity") != "1":
                return self._json(403, {"error": "missing X-LiveCity header"})
            m = re.fullmatch(r"/api/process/(\d+)/signal", url.path)
            if not m:
                return self._json(404, {"error": "not found"})
            if not cfg.allow_signals:
                return self._json(403, {"error": "signals disabled; restart with --allow-signals"})
            try:
                length = min(int(self.headers.get("Content-Length") or 0), 4096)
                payload = json.loads(self.rfile.read(length) or b"{}")
                cfg.collector.send_signal(int(m.group(1)), str(payload.get("signal", "")))
            except psutil.NoSuchProcess:
                return self._json(404, {"error": "no such process"})
            except psutil.AccessDenied:
                return self._json(403, {"error": "access denied (try running with sudo)"})
            except (ValueError, PermissionError) as exc:
                return self._json(400, {"error": str(exc)})
            return self._json(200, {"ok": True})

        def _api_get(self, path):
            if path == "/api/snapshot":
                snap = cfg.collector.snapshot()
                if snap is None:
                    return self._json(503, {"error": "warming up"})
                return self._json(200, snap)
            if path == "/api/config":
                return self._json(200, {
                    "allow_signals": cfg.allow_signals,
                    "signals": sorted(SIGNALS),
                    "interval": cfg.collector.interval,
                    "self_pid": cfg.collector.self_pid,
                    "is_root": hasattr(os, "geteuid") and os.geteuid() == 0,
                })
            m = re.fullmatch(r"/api/process/(\d+)", path)
            if m:
                try:
                    return self._json(200, cfg.collector.details(int(m.group(1))))
                except psutil.NoSuchProcess:
                    return self._json(404, {"error": "process has exited"})
            return self._json(404, {"error": "not found"})

        def _static(self, path):
            rel = path.lstrip("/") or "index.html"
            target = (WEB_ROOT / rel).resolve()
            if target.is_dir():
                target = target / "index.html"
            if not target.is_relative_to(WEB_ROOT) or not target.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self._send(200, target.read_bytes(), ctype)

    return Handler


def serve(host: str, port: int, collector: Collector, allow_signals: bool = False,
          require_token: bool | None = None):
    loop = is_loopback(host)
    if require_token is None:
        require_token = not loop
    token = secrets.token_urlsafe(18) if require_token else None
    cfg = Config(collector, allow_signals, token, check_host=loop)
    httpd = ThreadingHTTPServer((host, port), make_handler(cfg))
    httpd.daemon_threads = True
    return httpd, token
