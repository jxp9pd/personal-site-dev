"""Private Supabase storage for the shared Fantasy dashboard."""
from datetime import datetime, timezone
import json
from uuid import uuid4

from supabase_rest import SupabaseUnavailable


class StorageUnavailable(SupabaseUnavailable):
    """Deliberately excludes upstream responses and credentials."""


class FantasyStore:
    table = 'vestaboard_fantasy'

    def __init__(self, client):
        self.client = client
        self.endpoint = client.table_url(self.table)

    def _request(self, method, suffix, body=None, preference='return=representation'):
        if body is not None:
            body = dict(body, updated_at=datetime.now(timezone.utc).isoformat())
        try:
            raw = self.client.request(method, self.endpoint + suffix, body,
                                      {'Accept': 'application/json', 'Prefer': preference}, limit=256_001)
            if len(raw) > 256_000:
                raise StorageUnavailable()
            rows = json.loads(raw)
        except (SupabaseUnavailable, ValueError):
            raise StorageUnavailable() from None
        if not isinstance(rows, list) or len(rows) > 1 or any(not isinstance(row, dict) for row in rows):
            raise StorageUnavailable()
        return rows

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
