"""Owner and guest commands for the apartment door."""
from datetime import datetime, timedelta, timezone
import hashlib
import logging
import re
import secrets
from uuid import UUID, uuid4

from locks import LockError
from store import StoreUnavailable, iso, parse_time

MAX_PASS = timedelta(days=30)
MAX_LEAD = timedelta(days=365)
TOKEN_PATTERN = re.compile(r'^[A-Za-z0-9_-]{32,128}$')
STORE_ERROR = 'Guest passes are unavailable right now. Try again in a moment.'


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def pass_status(record, now):
    if record.get('revoked_at'):
        return 'revoked'
    if now < parse_time(record['starts_at']):
        return 'scheduled'
    if now >= parse_time(record['ends_at']):
        return 'expired'
    return 'active'


def public_pass(record, now):
    return {'id': record['id'], 'label': record['label'], 'startsAt': record['starts_at'],
            'endsAt': record['ends_at'], 'createdAt': record.get('created_at'),
            'revokedAt': record.get('revoked_at'), 'status': pass_status(record, now)}


def public_event(event):
    return {'at': event['at'], 'actor': event['actor'], 'label': event.get('label'),
            'action': event['action'], 'outcome': event['outcome']}


class Door:
    def __init__(self, lock, store, clock=lambda: datetime.now(timezone.utc)):
        self.lock, self.store, self.clock = lock, store, clock

    def _lock_state(self):
        try:
            return self.lock.state()
        except LockError:
            return 'unknown'

    def _record(self, actor, action, outcome, ip, record=None):
        try:
            self.store.record_event({
                'id': str(uuid4()), 'at': iso(self.clock()), 'actor': actor,
                'pass_id': record['id'] if record else None,
                'label': record['label'] if record else None,
                'action': action, 'outcome': outcome, 'ip': ip,
            })
        except StoreUnavailable:
            logging.error('Could not record door %s by %s (%s).', action, actor, outcome)

    def _actuate(self, action, actor, ip, record=None):
        try:
            getattr(self.lock, action)()
        except LockError as error:
            self._record(actor, action, 'failed', ip, record)
            return 502, {'error': str(error) or 'The lock did not respond.', 'lockState': self._lock_state()}
        self._record(actor, action, 'ok', ip, record)
        return 200, {'lockState': self._lock_state()}

    def owner_status(self):
        now = self.clock()
        body = {'driver': self.lock.name, 'lockState': self._lock_state()}
        try:
            body['passes'] = [public_pass(row, now) for row in self.store.list_passes()]
            body['events'] = [public_event(row) for row in self.store.list_events()]
        except StoreUnavailable:
            body.update(passes=None, events=None, storeError=STORE_ERROR)
        return body

    def owner_command(self, body, ip):
        action = body.get('action') if isinstance(body, dict) else None
        if action in ('lock', 'unlock'):
            return self._actuate(action, 'owner', ip)
        if action == 'create_pass':
            return self._create_pass(body)
        if action == 'revoke_pass':
            return self._revoke_pass(body)
        return 400, {'error': 'Unknown action.'}

    def _create_pass(self, body):
        label = body.get('label')
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 60:
            return 400, {'error': 'Name the pass with 1–60 characters.'}
        try:
            starts, ends = parse_time(body.get('startsAt')), parse_time(body.get('endsAt'))
        except (AttributeError, TypeError, ValueError):
            return 400, {'error': 'Start and end must be ISO times with a timezone.'}
        now = self.clock()
        if ends <= starts:
            return 400, {'error': 'The pass must end after it starts.'}
        if ends <= now:
            return 400, {'error': 'The pass would already be expired.'}
        if ends - starts > MAX_PASS:
            return 400, {'error': 'Passes can last at most 30 days.'}
        if starts > now + MAX_LEAD:
            return 400, {'error': 'Passes must start within a year.'}
        token = secrets.token_urlsafe(32)
        record = {'id': str(uuid4()), 'label': label.strip(), 'token_hash': token_hash(token),
                  'starts_at': iso(starts), 'ends_at': iso(ends), 'created_at': iso(now), 'revoked_at': None}
        try:
            self.store.create_pass(record)
        except StoreUnavailable:
            return 503, {'error': STORE_ERROR}
        return 200, {'pass': public_pass(record, now), 'token': token}

    def _revoke_pass(self, body):
        try:
            pass_id = str(UUID(body.get('id')))
        except (AttributeError, TypeError, ValueError):
            return 400, {'error': 'Unknown pass.'}
        try:
            self.store.revoke_pass(pass_id, self.clock())
        except StoreUnavailable:
            return 503, {'error': STORE_ERROR}
        return 200, {'revoked': pass_id}

    def guest_command(self, body, ip):
        token = body.get('token') if isinstance(body, dict) else None
        action = body.get('action', 'status') if isinstance(body, dict) else None
        if action not in ('status', 'lock', 'unlock'):
            return 400, {'error': 'Unknown action.'}
        if not isinstance(token, str) or not TOKEN_PATTERN.match(token):
            return 404, {'error': 'This pass link is not valid.'}
        try:
            record = self.store.find_pass(token_hash(token))
        except StoreUnavailable:
            return 503, {'error': STORE_ERROR}
        if record is None:
            return 404, {'error': 'This pass link is not valid.'}
        now = self.clock()
        info = {'pass': {key: value for key, value in public_pass(record, now).items()
                         if key in ('label', 'startsAt', 'endsAt', 'status')},
                'driver': self.lock.name}
        if action == 'status':
            return 200, {**info, 'lockState': self._lock_state()}
        if info['pass']['status'] != 'active':
            self._record('guest', action, 'denied', ip, record)
            return 403, {**info, 'error': {
                'scheduled': 'This pass is not active yet.',
                'expired': 'This pass has expired.',
                'revoked': 'This pass was revoked.'}[info['pass']['status']]}
        status, result = self._actuate(action, 'guest', ip, record)
        return status, {**info, **result}
