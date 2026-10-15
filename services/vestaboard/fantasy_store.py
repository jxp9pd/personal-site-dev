"""Private Supabase storage for the shared Fantasy dashboard."""
from datetime import datetime, timezone
import json
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from board import environment_value


class StorageUnavailable(Exception):
    """Deliberately excludes upstream responses and credentials."""


class FantasyStore:
    def __init__(self, url, key, opener=urlopen):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('SUPABASE_URL must be an HTTPS project URL.')
        self.endpoint = url.rstrip('/') + '/rest/v1/vestaboard_fantasy'
        self.key, self.opener = key, opener

    @classmethod
    def from_environment(cls, env_file=None, opener=urlopen):
        url = environment_value('SUPABASE_URL', env_file)
        key = environment_value('SUPABASE_SERVICE_ROLE_KEY', env_file)
        if not url and not key:
            return None
        if not url or not key:
            raise ValueError('Configure both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for Fantasy storage.')
        return cls(url, key, opener)

    def _request(self, method, suffix, body=None, preference='return=representation'):
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json',
                   'apikey': self.key, 'Prefer': preference}
        if self.key.startswith('eyJ'):
            headers['Authorization'] = 'Bearer ' + self.key
        if body is not None:
            body = dict(body, updated_at=datetime.now(timezone.utc).isoformat())
        try:
            request = Request(self.endpoint + suffix, method=method, headers=headers,
                              data=json.dumps(body, allow_nan=False).encode() if body is not None else None)
            with self.opener(request, timeout=3) as response:
                raw = response.read(256_001)
                if not 200 <= response.status < 300 or len(raw) > 256_000:
                    raise StorageUnavailable()
                rows = json.loads(raw)
                if not isinstance(rows, list) or len(rows) > 1 or any(not isinstance(row, dict) for row in rows):
                    raise StorageUnavailable()
                return rows
        except (OSError, ValueError):
            raise StorageUnavailable() from None

    def load(self):
        rows = self._request('GET', '?id=eq.default&select=*')
        return rows[0] if rows else None

    def save_settings(self, leagues, *, initialize=False, snapshot=None):
        record = {'id': 'default', 'config_version': str(uuid4()), 'leagues': leagues,
                  'matchups': [None, None], 'week': None, 'season': None, 'last_checked_at': None}
        if snapshot:
            record.update(snapshot)
        # Initial setup/backfill must never replace an existing dashboard.
        resolution = 'ignore-duplicates' if initialize else 'merge-duplicates'
        rows = self._request('POST', '?on_conflict=id', record,
                             'resolution=' + resolution + ',return=representation')
        saved = (rows[0] if rows else self.load()) if initialize else (rows[0] if rows else None)
        if saved is None:
            raise StorageUnavailable()
        return saved

    def save_matchups(self, config_version, snapshot):
        # An in-flight refresh for old leagues cannot overwrite newer settings.
        rows = self._request('PATCH', '?id=eq.default&config_version=eq.' + config_version, snapshot)
        return bool(rows)
