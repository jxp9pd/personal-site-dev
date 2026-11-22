"""Minimal Supabase REST + Auth client for the door service."""
import json
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class SupabaseUnavailable(Exception):
    """Deliberately excludes upstream responses and credentials."""


class Supabase:
    def __init__(self, url, key, opener=urlopen):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('SUPABASE_URL must be an HTTPS project URL.')
        self.url, self.key, self.opener = url.rstrip('/'), key, opener

    def _headers(self):
        headers = {'apikey': self.key}
        if self.key.startswith('eyJ'):
            headers['Authorization'] = 'Bearer ' + self.key
        return headers

    def request(self, method, path, body=None, headers=None):
        """One attempt, never retried. Returns the decoded JSON body, or None if empty."""
        try:
            request = Request(self.url + path, method=method,
                              headers={'Content-Type': 'application/json', **self._headers(), **(headers or {})},
                              data=None if body is None else json.dumps(body, allow_nan=False).encode())
            with self.opener(request, timeout=4) as response:
                if not 200 <= response.status < 300:
                    raise SupabaseUnavailable()
                payload = response.read(256 * 1024)
                return json.loads(payload) if payload else None
        except (OSError, ValueError):
            raise SupabaseUnavailable() from None

    def user_id(self, access_token):
        """The Supabase Auth user id for a session token, or None if it is not valid."""
        try:
            user = self.request('GET', '/auth/v1/user', headers={'Authorization': 'Bearer ' + access_token})
        except SupabaseUnavailable:
            return None
        return user.get('id') if isinstance(user, dict) else None
