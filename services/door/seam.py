"""Seam (seam.co) lock driver: one device in one Seam workspace."""
from datetime import datetime, timedelta, timezone
import json
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from locks import LockError

API = 'https://connect.getseam.com'


def rejection(error):
    """Seam's own error message (never includes credentials), or a generic one."""
    try:
        message = json.loads(error.read(16 * 1024))['error']['message']
    except (OSError, ValueError, KeyError, TypeError):
        message = None
    return f'The lock service rejected the request: {message}' if isinstance(message, str) else \
        'The lock service rejected the request.'


def code_record(code):
    """Seam access code -> lock-driver code. `setting` means Seam has not confirmed it is on the keypad yet."""
    return {'id': code['access_code_id'], 'name': code.get('name') or 'Guest', 'code': code.get('code'),
            'starts_at': code.get('starts_at'), 'ends_at': code.get('ends_at'),
            'setting': code.get('status') == 'setting', 'failed': bool(code.get('errors'))}


class SeamLock:
    name = 'seam'

    # Stays under the 20 s nginx proxy_read_timeout, including one last 5 s request.
    def __init__(self, api_key, device_id, opener=urlopen, sleep=time.sleep, clock=time.monotonic, timeout=12):
        if not api_key or not device_id:
            raise ValueError('Configure SEAM_API_KEY and SEAM_DEVICE_ID for the Seam lock driver.')
        self.api_key, self.device_id = api_key, device_id
        self.opener, self.sleep, self.clock, self.timeout = opener, sleep, clock, timeout

    def _call(self, path, body):
        request = Request(API + path, method='POST', data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + self.api_key, 'Content-Type': 'application/json'})
        try:
            with self.opener(request, timeout=5) as response:
                return json.loads(response.read(256 * 1024))
        except HTTPError as error:
            failure = LockError(rejection(error))
            failure.status = error.code
            raise failure from None
        except (OSError, ValueError):
            raise LockError('Could not reach the lock service.') from None

    def state(self):
        device = self._call('/devices/get', {'device_id': self.device_id}).get('device') or {}
        locked = (device.get('properties') or {}).get('locked')
        return 'unknown' if locked is None else 'locked' if locked else 'unlocked'

    def _act(self, path):
        deadline = self.clock() + self.timeout
        attempt = self._call(path, {'device_id': self.device_id}).get('action_attempt') or {}
        while attempt.get('status') == 'pending' and self.clock() + 1 < deadline:
            self.sleep(1)
            attempt = self._call('/action_attempts/get', {
                'action_attempt_id': attempt.get('action_attempt_id')}).get('action_attempt') or {}
        if attempt.get('status') == 'success':
            return
        if attempt.get('status') == 'pending':
            raise LockError('The lock has not confirmed yet. Check its state before trying again.')
        raise LockError((attempt.get('error') or {}).get('message') or 'The lock rejected the command.')

    def list_codes(self):
        codes = self._call('/access_codes/list', {'device_id': self.device_id}).get('access_codes') or []
        return [code_record(code) for code in codes
                if code.get('access_code_id') and code.get('starts_at') and code.get('ends_at')]

    def list_events(self):
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        events = self._call('/events/list', {'device_id': self.device_id, 'since': since, 'limit': 50,
                                             'event_types': ['lock.locked', 'lock.unlocked']}).get('events') or []
        return [{'at': event.get('occurred_at'), 'action': event['event_type'].split('.')[1][:-2],
                 'code_id': event.get('access_code_id')}
                for event in events if event.get('event_type') in ('lock.locked', 'lock.unlocked')]

    def create_code(self, name, starts_at, ends_at, code):
        created = self._call('/access_codes/create', {
            'device_id': self.device_id,
            'name': name,
            'code': code,
            'starts_at': starts_at,
            'ends_at': ends_at,
        }).get('access_code') or {}
        if not created.get('access_code_id'):
            raise LockError('The lock service did not create the code.')
        return code_record({'name': name, 'code': code, 'starts_at': starts_at, 'ends_at': ends_at,
                            'status': 'setting', **created})

    def delete_code(self, code_id):
        try:
            self._call('/access_codes/delete', {'access_code_id': code_id})
        except LockError as failure:
            if getattr(failure, 'status', None) != 404:
                raise

    def lock(self):
        self._act('/locks/lock_door')

    def unlock(self):
        self._act('/locks/unlock_door')
