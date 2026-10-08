"""Shared Vestaboard Note encoding and delivery; independent of pages and timers."""
import json
import math
import os
import shlex
import socket
import ssl
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROWS, COLUMNS = 3, 15
BLANK, GREEN, VIOLET, WHITE = 0, 66, 68, 69
CODES = {char: index + 1 for index, char in enumerate('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}
CODES.update({char: index + 27 for index, char in enumerate('1234567890')})
CODES.update({' ': 0, '!': 37, '@': 38, '#': 39, '$': 40, '(': 41, ')': 42,
              '-': 44, '+': 46, '&': 47, '=': 48, ';': 49, ':': 50, "'": 52,
              '"': 53, '%': 54, ',': 55, '.': 56, '/': 59, '?': 60, '♥': 62})
VALID_CODES = set(CODES.values()) | set(range(63, 72))
API_URL = 'https://cloud.vestaboard.com/'
COOLDOWN = 15


def text_row(text, width=COLUMNS):
    """Center and encode an already-normalized row without silently truncating it."""
    if len(text) > width:
        raise ValueError('Text does not fit the Note.')
    return [CODES[char] for char in text.center(width)]


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
    return (isinstance(value, list) and len(value) == ROWS
            and all(isinstance(row, list) and len(row) == COLUMNS
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
            return {'configured': bool(self.token), 'rows': ROWS, 'columns': COLUMNS,
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
