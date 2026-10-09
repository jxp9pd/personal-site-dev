#!/usr/bin/env python3
"""HTTP routes and wiring for the shared Vestaboard service."""
import argparse
from functools import partial
import json
from pathlib import Path
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import urlopen

from board import BoardGateway, api_token, cloud_tls_context
from fantasy import Fantasy, SleeperSource
from nfl import NFL, NFLSource
from pomodoro import Pomodoro

MAX_BODY = 4096


def handler_for(gateway, origins, preview_dir=None, pomodoro=None, nfl=None, fantasy=None):
    class Handler(SimpleHTTPRequestHandler):
        # HTTP/1.0 closes each connection, including rejected/unconsumed bodies.
        server_version = 'NoteGateway'
        sys_version = ''

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=preview_dir, **kwargs)

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def reply(self, status, body):
            body = dict(body)
            if status >= 400:
                retry = gateway.status()['retryAfter']
                if retry:
                    body['retryAfter'] = max(retry, body.get('retryAfter', 0))
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(payload)))
            if body.get('retryAfter'):
                self.send_header('Retry-After', str(body['retryAfter']))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if urlsplit(self.path).path == '/api/vestaboard/status':
                self.reply(200, gateway.status())
            elif urlsplit(self.path).path == '/api/vestaboard/pomodoro' and pomodoro:
                self.reply(200, pomodoro.status())
            elif urlsplit(self.path).path == '/api/vestaboard/nfl' and nfl:
                self.reply(200, nfl.status())
            elif urlsplit(self.path).path == '/api/vestaboard/fantasy' and fantasy:
                self.reply(200, fantasy.status())
            elif preview_dir and not self.path.startswith('/api/'):
                super().do_GET()
            else:
                self.reply(404, {'error': 'Not found.'})

        def do_HEAD(self):
            # Do not let the inherited static handler serve the working directory.
            self.send_response(405)
            self.send_header('Allow', 'GET, POST')
            self.end_headers()

        def do_POST(self):
            path = urlsplit(self.path).path
            if path != '/api/vestaboard/messages' and not (
                    path == '/api/vestaboard/pomodoro' and pomodoro or path == '/api/vestaboard/nfl' and nfl
                    or path == '/api/vestaboard/fantasy' and fantasy):
                return self.reply(404, {'error': 'Not found.'})
            if self.headers.get('Origin') not in origins:
                return self.reply(403, {'error': 'Send notes from the website.'})
            if self.headers.get('Transfer-Encoding'):
                return self.reply(400, {'error': 'Unsupported request encoding.'})
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                return self.reply(415, {'error': 'Use application/json.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return self.reply(400, {'error': 'Invalid request length.'})
            if length <= 0 or length > MAX_BODY:
                return self.reply(413, {'error': 'Message is too large or empty.'})
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError, socket.timeout):
                return self.reply(400, {'error': 'Invalid JSON.'})
            if path == '/api/vestaboard/pomodoro':
                status, result = pomodoro.command(body)
                return self.reply(status, result)
            if path == '/api/vestaboard/nfl':
                status, result = nfl.command(body)
                return self.reply(status, result)
            if path == '/api/vestaboard/fantasy':
                status, result = fantasy.command(body)
                return self.reply(status, result)
            # Discard all other fields; clients cannot force delivery during quiet hours.
            characters = body.get('characters') if isinstance(body, dict) else None
            status, result = gateway.send(characters)
            return self.reply(status, result)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--preview', help='Serve a local static site from this directory too.')
    args = parser.parse_args()
    origins = {'https://jpentakalos.com', 'https://www.jpentakalos.com'}
    if args.preview:
        origins |= {f'http://127.0.0.1:{args.port}', f'http://localhost:{args.port}'}
    # Only local previews read the repo's .env; production uses systemd's EnvironmentFile.
    env_file = Path(__file__).resolve().parents[2] / '.env' if args.preview else None
    gateway = BoardGateway(api_token(env_file), opener=partial(urlopen, context=cloud_tls_context()))
    pomodoro = Pomodoro(gateway)
    nfl = NFL(gateway, NFLSource(opener=partial(urlopen, context=cloud_tls_context())).games)
    fantasy = Fantasy(gateway, SleeperSource(opener=partial(urlopen, context=cloud_tls_context())))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler_for(
        gateway, origins, args.preview, pomodoro=pomodoro, nfl=nfl, fantasy=fantasy))
    pomodoro.start_worker()
    nfl.start_worker()
    fantasy.start_worker()
    print(f'Note gateway listening on 127.0.0.1:{args.port}; token configured: {bool(gateway.token)}', flush=True)
    try:
        server.serve_forever()
    finally:
        pomodoro.close()
        nfl.close()
        fantasy.close()
        server.server_close()


if __name__ == '__main__':
    main()
