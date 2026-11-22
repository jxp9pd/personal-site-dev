"""Seam (seam.co) lock driver: one device in one Seam workspace."""
import json
import time
from urllib.request import Request, urlopen

from locks import LockError

API = 'https://connect.getseam.com'


class SeamLock:
    name = 'seam'

    def __init__(self, api_key, device_id, opener=urlopen, sleep=time.sleep, timeout=15):
        if not api_key or not device_id:
            raise ValueError('Configure SEAM_API_KEY and SEAM_DEVICE_ID for the Seam lock driver.')
        self.api_key, self.device_id = api_key, device_id
        self.opener, self.sleep, self.timeout = opener, sleep, timeout

    def _call(self, path, body):
        request = Request(API + path, method='POST', data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + self.api_key, 'Content-Type': 'application/json'})
        try:
            with self.opener(request, timeout=5) as response:
                return json.loads(response.read(256 * 1024))
        except (OSError, ValueError):
            raise LockError('Could not reach the lock service.') from None

    def state(self):
        device = self._call('/devices/get', {'device_id': self.device_id}).get('device') or {}
        locked = (device.get('properties') or {}).get('locked')
        return 'unknown' if locked is None else 'locked' if locked else 'unlocked'

    def _act(self, path):
        attempt = self._call(path, {'device_id': self.device_id}).get('action_attempt') or {}
        waited = 0
        while attempt.get('status') == 'pending' and waited < self.timeout:
            self.sleep(1)
            waited += 1
            attempt = self._call('/action_attempts/get', {
                'action_attempt_id': attempt.get('action_attempt_id')}).get('action_attempt') or {}
        if attempt.get('status') == 'success':
            return
        if attempt.get('status') == 'pending':
            raise LockError('The lock has not confirmed yet. Check its state before trying again.')
        raise LockError((attempt.get('error') or {}).get('message') or 'The lock rejected the command.')

    def lock(self):
        self._act('/locks/lock_door')

    def unlock(self):
        self._act('/locks/unlock_door')
