"""The one Supabase REST client shared by message history and Fantasy storage."""
import json
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from board import environment_value


class SupabaseUnavailable(Exception):
    """Deliberately excludes upstream responses and credentials."""


class SupabaseClient:
    def __init__(self, url, key, opener=urlopen):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('SUPABASE_URL must be an HTTPS project URL.')
        self.url, self.key, self.opener = url.rstrip('/'), key, opener

    @classmethod
    def from_environment(cls, env_file=None, opener=urlopen):
        url = environment_value('SUPABASE_URL', env_file)
        key = environment_value('SUPABASE_SERVICE_ROLE_KEY', env_file)
        if not url and not key:
            return None
        if not url or not key:
            raise ValueError('Configure both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY '
                             'for message history and Fantasy storage.')
        return cls(url, key, opener)

    def table_url(self, table):
        return self.url + '/rest/v1/' + table

    def headers(self):
        headers = {'apikey': self.key}
        # Modern sb_secret keys authenticate via apikey. Legacy service_role
        # JWTs also support the Authorization header.
        if self.key.startswith('eyJ'):
            headers['Authorization'] = 'Bearer ' + self.key
        return headers

    def request(self, method, url, body=None, headers=None, limit=0):
        """One attempt, never retried. Returns up to `limit` bytes of a 2xx body."""
        try:
            request = Request(url, method=method,
                              headers={'Content-Type': 'application/json', **(headers or {}), **self.headers()},
                              data=None if body is None else json.dumps(body, allow_nan=False).encode())
            with self.opener(request, timeout=3) as response:
                if not 200 <= response.status < 300:
                    raise SupabaseUnavailable()
                return response.read(limit) if limit else b''
        except (OSError, ValueError):
            raise SupabaseUnavailable() from None
