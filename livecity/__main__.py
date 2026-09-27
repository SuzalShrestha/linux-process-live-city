"""Command line entry point: ``python -m livecity``."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import webbrowser

from . import __version__
from .collector import Collector
from .server import is_loopback, serve


def open_browser(url: str) -> bool:
    """Open ``url`` in the user's browser, even when we were started via sudo.

    Under sudo the process runs as root, which on macOS (and on most Linux
    desktops) can't open windows in the logged-in user's session, so
    ``webbrowser.open`` silently does nothing. Hand the job back to the
    user who invoked sudo instead.
    """
    sudo_user = os.environ.get("SUDO_USER")
    if hasattr(os, "geteuid") and os.geteuid() == 0 and sudo_user and sudo_user != "root":
        opener = "open" if sys.platform == "darwin" else shutil.which("xdg-open")
        if opener:
            try:
                subprocess.Popen(
                    ["sudo", "-u", sudo_user, opener, url],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                return True
            except OSError:
                pass
    try:
        return webbrowser.open(url)
    except Exception:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="livecity",
        description="Process City - watch your processes as a living 3D city.",
    )
    ap.add_argument("--host", default="127.0.0.1",
                    help="address to bind (default: 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8765, help="port (default: 8765)")
    ap.add_argument("--interval", type=float, default=1.5,
                    help="seconds between samples (default: 1.5)")
    ap.add_argument("--allow-signals", action="store_true",
                    help="enable TERM/KILL/STOP/CONT buttons in the inspector")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = ap.parse_args(argv)

    collector = Collector(interval=args.interval)
    collector.start()
    try:
        httpd, token = serve(args.host, args.port, collector, allow_signals=args.allow_signals)
    except OSError as exc:
        print(f"livecity: cannot listen on {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 1

    shown_host = "localhost" if is_loopback(args.host) else args.host
    url = f"http://{shown_host}:{args.port}/"
    if token:
        url += f"?token={token}"
        print("WARNING: listening on a non-loopback address. Process details include "
              "environment variables, which often contain secrets.", file=sys.stderr)
    print(f"Process City {__version__} is running.")
    print(f"  -> Open {url} in your browser to see the city.")
    print(f"  sampling every {collector.interval}s"
          f"{', signals ENABLED' if args.allow_signals else ''} - this terminal stays quiet; "
          "Ctrl+C to quit")

    if not args.no_browser:
        threading.Timer(0.6, lambda: open_browser(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        collector.stop()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
