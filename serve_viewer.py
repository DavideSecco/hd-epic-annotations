#!/usr/bin/env python3
"""
Serve the HD-EPIC annotation viewer on a local HTTP server.

Usage:
    python3 serve_viewer.py [--port PORT] [--no-browser]

Serves the repo root so that viewer/index.html can reach data files via
relative paths (../narrations-and-action-segments/... etc.).
Opens http://localhost:PORT/viewer/ automatically in the browser.
"""

import argparse
import http.server
import socket
import threading
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent


def find_free_port() -> int:
    with socket.socket() as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description='HD-EPIC Viewer server')
    parser.add_argument('--port', type=int, default=0,
                        help='Port to listen on (default: random free port)')
    parser.add_argument('--no-browser', action='store_true',
                        help='Start server but do not open browser')
    args = parser.parse_args()

    port = args.port or find_free_port()
    url = f'http://localhost:{port}/viewer/'

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(REPO_ROOT), **kw)

        def log_message(self, fmt, *a):
            pass  # silence request logs

    server = http.server.HTTPServer(('localhost', port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f'[server] serving {REPO_ROOT}')
    print(f'[open]   {url}')

    if not args.no_browser:
        webbrowser.open(url)

    print('Press Ctrl+C to stop.')
    try:
        thread.join()
    except KeyboardInterrupt:
        print('\n[stop] Server stopped.')
        server.shutdown()


if __name__ == '__main__':
    main()
