"""Owner commands for the apartment door. The lock (Seam, or the mock) is the record of codes and activity."""
from datetime import datetime, timedelta, timezone
import re
import secrets

from locks import LockError

MAX_CODE = timedelta(days=30)
MAX_LEAD = timedelta(days=365)
CODE_DIGITS = 6
CODE_ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


def iso(moment):
    return moment.astimezone(timezone.utc).isoformat()


def parse_time(value):
    moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if moment.tzinfo is None:
        raise ValueError('Times must include a timezone.')
    return moment.astimezone(timezone.utc)


def public_code(code, now):
    return {'id': code['id'], 'label': code['name'], 'pin': code.get('code'), 'startsAt': code['starts_at'],
            'endsAt': code['ends_at'], 'status': 'scheduled' if now < parse_time(code['starts_at']) else 'active'}


class Door:
    def __init__(self, lock, clock=lambda: datetime.now(timezone.utc)):
        self.lock, self.clock = lock, clock

    def _lock_state(self):
        try:
            return self.lock.state()
        except LockError:
            return 'unknown'

    def owner_status(self):
        now = self.clock()
        body = {'lockState': self._lock_state()}
        try:
            codes = [code for code in self.lock.list_codes() if parse_time(code['ends_at']) > now]
            names = {code['id']: code['name'] for code in codes}
            body['codes'] = sorted((public_code(code, now) for code in codes), key=lambda code: code['startsAt'])
            body['events'] = [{'at': event['at'], 'action': event['action'], 'label': names.get(event['code_id'])}
                              for event in self.lock.list_events()]
        except (LockError, KeyError, TypeError, ValueError):
            body.update(codes=None, events=None, error='Could not load codes from the lock service.')
        return body

    def owner_command(self, body):
        action = body.get('action') if isinstance(body, dict) else None
        if action in ('lock', 'unlock'):
            try:
                getattr(self.lock, action)()
            except LockError as error:
                return 502, {'error': str(error) or 'The lock did not respond.', 'lockState': self._lock_state()}
            return 200, {'lockState': self._lock_state()}
        if action == 'create_code':
            return self._create_code(body)
        if action == 'revoke_code':
            return self._revoke_code(body)
        return 400, {'error': 'Unknown action.'}

    def _create_code(self, body):
        label = body.get('label')
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 60:
            return 400, {'error': 'Name the code with 1–60 characters.'}
        try:
            starts, ends = parse_time(body.get('startsAt')), parse_time(body.get('endsAt'))
        except (AttributeError, TypeError, ValueError):
            return 400, {'error': 'Start and end must be ISO times with a timezone.'}
        now = self.clock()
        if ends <= starts:
            return 400, {'error': 'The code must end after it starts.'}
        if ends <= now:
            return 400, {'error': 'The code would already be expired.'}
        if ends - starts > MAX_CODE:
            return 400, {'error': 'A code can last at most 30 days.'}
        if starts > now + MAX_LEAD:
            return 400, {'error': 'A code must start within a year.'}
        pin = ''.join(secrets.choice('0123456789') for _ in range(CODE_DIGITS))
        code = {'name': label.strip(), 'code': pin, 'starts_at': iso(starts), 'ends_at': iso(ends)}
        try:
            code['id'] = self.lock.create_code(code['name'], code['starts_at'], code['ends_at'], pin)
        except LockError as failure:
            return 502, {'error': str(failure) or 'The lock did not accept the code.'}
        return 200, {'code': public_code(code, now)}

    def _revoke_code(self, body):
        code_id = body.get('id')
        if not isinstance(code_id, str) or not CODE_ID.match(code_id):
            return 400, {'error': 'Unknown code.'}
        try:
            self.lock.delete_code(code_id)
        except LockError as failure:
            return 502, {'error': str(failure) or 'The lock did not remove the code. Try again.'}
        return 200, {'revoked': code_id}
