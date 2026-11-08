"""Serve the board, relay /roku/... to the Roku's ECP port (8060), and save
tv.txt from remote.html (POST /tv).

ECP sends no CORS headers, so the page can POST keys to the Roku but can't
read the answer. Going through this server, it can check that the TV is
still playing after a move.

  ROKU_HOST=192.168.4.123 python3 serve.py [port]
"""
import os, sys, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROKU = os.environ.get("ROKU_HOST", "192.168.4.123")
GETS = ("/roku/query/media-player", "/roku/query/active-app")
POSTS = ("/roku/keypress/",)


class Handler(SimpleHTTPRequestHandler):
    def relay(self, method):
        req = urllib.request.Request(f"http://{ROKU}:8060{self.path[len('/roku'):]}", method=method)
        try:
            with urllib.request.urlopen(req, timeout=3) as r:
                code, body = r.status, r.read()
        except OSError as e:
            code, body = 502, str(e).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith(GETS):
            return self.relay("GET")
        super().do_GET()

    def do_POST(self):
        if self.path.startswith(POSTS):
            return self.relay("POST")
        if self.path == "/tv":
            n = int(self.headers.get("Content-Length", 0))
            if not 0 < n <= 1000:
                return self.send_error(400)
            tmp = os.path.join(here, "tv.txt.new")
            with open(tmp, "wb") as f:
                f.write(self.rfile.read(n))
            os.replace(tmp, os.path.join(here, "tv.txt"))
            self.send_response(204)
            return self.end_headers()
        self.send_error(404)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/roku/query"):
            super().log_message(fmt, *args)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8083
here = os.path.dirname(os.path.abspath(__file__))
ThreadingHTTPServer(("", port), partial(Handler, directory=here)).serve_forever()
