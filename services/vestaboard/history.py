"""Private, server-side records of Leave a Note submissions."""
from datetime import datetime, timezone
import ipaddress
import json
import logging
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from board import environment_value


class HistoryUnavailable(Exception):
    pass


def sender_ip(peer, forwarded):
    """Only the local nginx proxy may supply X-Real-IP; it overwrites the header."""
    address = ipaddress.ip_address(peer)
    if not address.is_loopback:
        return str(address)
    try:
        return str(ipaddress.ip_address(forwarded))
    except ValueError:
        return None


class MessageHistory:
    def __init__(self, url, key, opener=urlopen):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('SUPABASE_URL must be an HTTPS project URL.')
        self.endpoint = url.rstrip('/') + '/rest/v1/vestaboard_messages'
        self.key, self.opener = key, opener

    @classmethod
    def from_environment(cls, env_file=None, opener=urlopen):
        url = environment_value('SUPABASE_URL', env_file)
        key = environment_value('SUPABASE_SERVICE_ROLE_KEY', env_file)
        if not url and not key:
            return None
        if not url or not key:
            raise ValueError('Configure both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for message history.')
        return cls(url, key, opener)

    def _write(self, method, body, suffix=''):
        headers = {'Content-Type': 'application/json', 'apikey': self.key, 'Prefer': 'return=minimal'}
        # Modern sb_secret keys authenticate via apikey. Legacy service_role
        # JWTs also support the Authorization header.
        if self.key.startswith('eyJ'):
            headers['Authorization'] = 'Bearer ' + self.key
        request = Request(self.endpoint + suffix, method=method,
                          data=json.dumps(body).encode(), headers=headers)
        try:
            with self.opener(request, timeout=3) as response:
                if not 200 <= response.status < 300:
                    raise HistoryUnavailable()
        except (OSError, ValueError):
            raise HistoryUnavailable() from None

    def begin(self, original_message, characters, address):
        record_id = str(uuid4())
        self._write('POST', {
            'id': record_id, 'submitted_at': datetime.now(timezone.utc).isoformat(),
            'original_message': original_message, 'characters': characters,
            'sender_ip': address, 'outcome': 'unknown',
        })
        return record_id

    def finish(self, record_id, status):
        outcome = 'accepted' if status == 200 else 'rejected' if status in (400, 429, 503) else 'unknown'
        try:
            self._write('PATCH', {'outcome': outcome, 'http_status': status}, '?id=eq.' + record_id)
        except HistoryUnavailable:
            # The message, time, and sender are already durable. Leave the
            # outcome unknown; never repeat a board write to repair history.
            logging.error('Could not update delivery outcome for message history record %s', record_id)
