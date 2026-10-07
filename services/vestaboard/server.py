#!/usr/bin/env python3
"""Small, dependency-free Vestaboard Note gateway. Run behind nginx in production."""
import argparse
from functools import partial
import json
import math
import os
from pathlib import Path
import shlex
import socket
import ssl
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

API_URL = 'https://cloud.vestaboard.com/'
VALID_CODES = set(range(43)) | {44, 46, 47, 48, 49, 50, 52, 53, 54, 55, 56, 59, 60, 62} | set(range(63, 72))
COOLDOWN = 15
MAX_BODY = 4096


def api_token(env_file=None):
    # Explicit environment settings (including an empty value) take precedence.
    if 'VESTABOARD_API_TOKEN' in os.environ:
        return os.environ['VESTABOARD_API_TOKEN'].strip()
    if env_file is None or not env_file.is_file():
        return ''
    for line in env_file.read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and key.strip() == 'VESTABOARD_API_TOKEN':
            values = shlex.split(value, comments=True)
            if len(values) > 1:
                raise ValueError('VESTABOARD_API_TOKEN must be a single value in .env.')
            return values[0] if values else ''
    return ''


def cloud_tls_context():
    context = ssl.create_default_context()
    # python.org macOS installations can lack their optional CA bundle.
    # Use the OS's existing roots without disabling certificate verification.
    if (sys.platform == 'darwin' and context.cert_store_stats()['x509_ca'] == 0
            and not os.environ.get('SSL_CERT_FILE') and not os.environ.get('SSL_CERT_DIR')):
        context.load_verify_locations('/etc/ssl/cert.pem')
    return context


def valid_characters(value):
    return (isinstance(value, list) and len(value) == 3
            and all(isinstance(row, list) and len(row) == 15
                    and all(type(code) is int and code in VALID_CODES for code in row) for row in value)
            and any(code not in (0, 70) for row in value for code in row))


class BoardGateway:
    def __init__(self, token='', opener=urlopen, clock=time.monotonic):
        self.token = token.strip()
        self.opener = opener
        self.clock = clock
        self.next_send = 0
        self.sending = False
        self.lock = threading.Lock()

    def status(self):
        with self.lock:
            return {'configured': bool(self.token), 'rows': 3, 'columns': 15,
                    'retryAfter': max(1 if self.sending else 0, math.ceil(self.next_send - self.clock()))}

    def send(self, characters):
        if not valid_characters(characters):
            return 400, {'error': 'Send a nonblank 3 × 15 array of valid Vestaboard character codes.'}
        if not self.token:
            return 503, {'error': 'The board is not connected yet. Please try again later.'}
        with self.lock:
            remaining = max(0, math.ceil(self.next_send - self.clock()))
            if self.sending or remaining:
                return 429, {'error': 'Give the board a moment before sending another note.',
                             'retryAfter': max(1, remaining)}
            # Reserve before network I/O so simultaneous visitors cannot race.
            self.sending = True
            self.next_send = self.clock() + COOLDOWN
        try:
            request = Request(API_URL, method='POST',
                              data=json.dumps({'characters': characters}).encode(),
                              headers={'Content-Type': 'application/json', 'X-Vestaboard-Token': self.token})
            with self.opener(request, timeout=10) as response:
                result = json.loads(response.read(65536))
                # The live Cloud API returns "success"; the official examples use "ok".
                if not 200 <= response.status < 300 or not isinstance(result, dict) or result.get('status') not in ('ok', 'success'):
                    return 502, {'error': 'Vestaboard did not confirm the message. Check the board before retrying.'}
            return 200, {'accepted': True, 'retryAfter': COOLDOWN}
        except HTTPError as error:
            if error.code == 429:
                try:
                    retry = max(COOLDOWN, min(3600, int(error.headers.get('Retry-After', COOLDOWN))))
                except (ValueError, TypeError):
                    retry = COOLDOWN
                with self.lock:
                    self.next_send = max(self.next_send, self.clock() + retry)
                return 429, {'error': 'Vestaboard is busy. Please wait before trying again.', 'retryAfter': retry}
            if error.code in (401, 403):
                return 502, {'error': 'The board’s API token needs attention. Please let John know.'}
            return 502, {'error': 'Vestaboard could not accept this note. Please try again later.'}
        except (TimeoutError, socket.timeout, URLError, OSError):
            return 504, {'error': 'Vestaboard did not respond in time. Your note may have been sent; check the board before retrying.'}
        except (ValueError, UnicodeError):
            return 502, {'error': 'Vestaboard returned an unexpected response. Check the board before retrying.'}
        finally:
            with self.lock:
                self.sending = False
                self.next_send = max(self.next_send, self.clock() + COOLDOWN)


def handler_for(gateway, origins, preview_dir=None):
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
            if urlsplit(self.path).path != '/api/vestaboard/messages':
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
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler_for(gateway, origins, args.preview))
    print(f'Note gateway listening on 127.0.0.1:{args.port}; token configured: {bool(gateway.token)}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
