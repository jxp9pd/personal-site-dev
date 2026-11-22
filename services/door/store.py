"""Guest passes and the access log, stored in Supabase or (for previews) memory."""
from datetime import datetime, timezone
import threading
from urllib.parse import quote

from supabase import SupabaseUnavailable

PASS_FIELDS = ('id', 'label', 'starts_at', 'ends_at', 'created_at', 'revoked_at')
CODE_FIELDS = ('id', 'label', 'lock_code_id', 'starts_at', 'ends_at', 'created_at', 'revoked_at', 'removed_at')
EVENT_FIELDS = ('id', 'at', 'actor', 'pass_id', 'label', 'action', 'outcome', 'ip')


class StoreUnavailable(SupabaseUnavailable):
    pass


def iso(moment):
    return moment.astimezone(timezone.utc).isoformat()


def parse_time(value):
    moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if moment.tzinfo is None:
        raise ValueError('Times must include a timezone.')
    return moment.astimezone(timezone.utc)


class MemoryStore:
    def __init__(self):
        self.passes, self.events, self.codes = [], [], []
        self._guard = threading.Lock()

    def create_pass(self, record):
        with self._guard:
            self.passes.append(dict(record))

    def list_passes(self):
        with self._guard:
            rows = sorted(self.passes, key=lambda row: row['starts_at'], reverse=True)[:100]
            return [{key: row[key] for key in PASS_FIELDS} for row in rows]

    def find_pass(self, token_hash):
        with self._guard:
            for row in self.passes:
                if row['token_hash'] == token_hash:
                    return {key: row[key] for key in PASS_FIELDS}
        return None

    def revoke_pass(self, pass_id, now):
        with self._guard:
            for row in self.passes:
                if row['id'] == pass_id and row['revoked_at'] is None:
                    row['revoked_at'] = iso(now)

    def create_code(self, record):
        with self._guard:
            self.codes.append(dict(record))

    def list_codes(self):
        with self._guard:
            return [dict(row) for row in sorted(self.codes, key=lambda row: row['starts_at'], reverse=True)[:100]]

    def get_code(self, code_id):
        with self._guard:
            return next((dict(row) for row in self.codes if row['id'] == code_id), None)

    def update_code(self, code_id, fields):
        with self._guard:
            for row in self.codes:
                if row['id'] == code_id:
                    row.update(fields)

    def record_event(self, event):
        with self._guard:
            self.events.append(dict(event))

    def list_events(self):
        with self._guard:
            return [dict(row) for row in reversed(self.events[-50:])]


class SupabaseStore:
    def __init__(self, client):
        self.client = client

    def _call(self, method, path, body=None, headers=None):
        try:
            return self.client.request(method, '/rest/v1/' + path, body, headers)
        except SupabaseUnavailable:
            raise StoreUnavailable() from None

    def create_pass(self, record):
        self._call('POST', 'door_passes', record, {'Prefer': 'return=minimal'})

    def list_passes(self):
        return self._call('GET', 'door_passes?select=' + ','.join(PASS_FIELDS) + '&order=starts_at.desc&limit=100') or []

    def find_pass(self, token_hash):
        rows = self._call('GET', 'door_passes?select=' + ','.join(PASS_FIELDS)
                          + '&token_hash=eq.' + quote(token_hash) + '&limit=1') or []
        return rows[0] if rows else None

    def revoke_pass(self, pass_id, now):
        self._call('PATCH', 'door_passes?id=eq.' + quote(pass_id) + '&revoked_at=is.null',
                   {'revoked_at': iso(now)}, {'Prefer': 'return=minimal'})

    def create_code(self, record):
        self._call('POST', 'door_access_codes', record, {'Prefer': 'return=minimal'})

    def list_codes(self):
        return self._call('GET', 'door_access_codes?select=' + ','.join(CODE_FIELDS)
                          + '&order=starts_at.desc&limit=100') or []

    def get_code(self, code_id):
        rows = self._call('GET', 'door_access_codes?select=' + ','.join(CODE_FIELDS)
                          + '&id=eq.' + quote(code_id) + '&limit=1') or []
        return rows[0] if rows else None

    def update_code(self, code_id, fields):
        self._call('PATCH', 'door_access_codes?id=eq.' + quote(code_id), fields, {'Prefer': 'return=minimal'})

    def record_event(self, event):
        self._call('POST', 'door_events', event, {'Prefer': 'return=minimal'})

    def list_events(self):
        return self._call('GET', 'door_events?select=' + ','.join(EVENT_FIELDS) + '&order=at.desc&limit=50') or []
