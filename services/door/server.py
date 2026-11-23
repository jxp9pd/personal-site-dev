#!/usr/bin/env python3
"""HTTP routes for the apartment door: owner-only lock control and keypad codes."""
import argparse
import json
import logging
import os
from pathlib import Path
import shlex
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from door import Door
from locks import lock_from_environment
from supabase import SupabaseAuth

MAX_BODY = 2048


def environment_value(name, env_file=None):
    if name in os.environ:
        return os.environ[name].strip()
    if env_file is None or not env_file.is_file():
        return ''
    for line in env_file.read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and key.strip() == name:
            values = shlex.split(value, comments=True)
            return values[0] if values else ''
    return ''



def handler_for(door, origins, authorize, preview_dir=None):
    class Handler(SimpleHTTPRequestHandler):
        server_version = 'DoorAccess'
        sys_version = ''

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=preview_dir, **kwargs)

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def reply(self, status, body):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def is_owner(self):
            scheme, _, token = self.headers.get('Authorization', '').partition(' ')
            return scheme.lower() == 'bearer' and bool(token) and authorize(token.strip())

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/api/door/owner':
                if not self.is_owner():
                    return self.reply(401, {'error': 'Log in as the owner to manage the door.'})
                return self.reply(200, door.owner_status())
            if preview_dir and not path.startswith('/api/'):
                return super().do_GET()
            self.reply(404, {'error': 'Not found.'})

        def do_HEAD(self):
            self.send_response(405)
            self.send_header('Allow', 'GET, POST')
            self.end_headers()

        def do_POST(self):
            path = urlsplit(self.path).path
            if path != '/api/door/owner':
                return self.reply(404, {'error': 'Not found.'})
            if self.headers.get('Origin') not in origins:
                return self.reply(403, {'error': 'Use the website.'})
            if self.headers.get('Transfer-Encoding'):
                return self.reply(400, {'error': 'Unsupported request encoding.'})
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                return self.reply(415, {'error': 'Use application/json.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return self.reply(400, {'error': 'Invalid request length.'})
            if length <= 0 or length > MAX_BODY:
                return self.reply(413, {'error': 'Request is too large or empty.'})
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError, socket.timeout):
                return self.reply(400, {'error': 'Invalid JSON.'})
            if not self.is_owner():
                return self.reply(401, {'error': 'Log in as the owner to manage the door.'})
            return self.reply(*door.owner_command(body))

    return Handler


def owner_authorizer(auth, owner_id):
    return lambda token: auth.user_id(token) == owner_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8788)
    parser.add_argument('--preview', help='Serve a local static site from this directory too.')
    parser.add_argument('--dev-owner', action='store_true',
                        help='Preview only: treat every bearer token as the owner.')
    args = parser.parse_args()
    if args.dev_owner and not args.preview:
        parser.error('--dev-owner requires --preview.')
    logging.basicConfig(level=logging.INFO)
    origins = {'https://jpentakalos.com', 'https://www.jpentakalos.com'}
    if args.preview:
        origins |= {f'http://127.0.0.1:{args.port}', f'http://localhost:{args.port}'}
    env_file = Path(__file__).resolve().parents[2] / '.env' if args.preview else None
    lock = lock_from_environment(lambda name: environment_value(name, env_file))
    if args.dev_owner:
        authorize = lambda token: True
    else:
        url, key = environment_value('SUPABASE_URL', env_file), environment_value('SUPABASE_ANON_KEY', env_file)
        owner_id = environment_value('DOOR_OWNER_USER_ID', env_file)
        if not (url and key and owner_id):
            raise SystemExit('Configure SUPABASE_URL, SUPABASE_ANON_KEY and DOOR_OWNER_USER_ID.')
        authorize = owner_authorizer(SupabaseAuth(url, key), owner_id)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler_for(
        Door(lock), origins, authorize, args.preview))
    print(f'Door service listening on 127.0.0.1:{args.port}; lock driver: {lock.name}', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
