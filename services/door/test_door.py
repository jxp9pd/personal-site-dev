from datetime import datetime, timedelta, timezone
import io
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from door import Door
from locks import LockError, MockLock, lock_from_environment
from server import handler_for

ORIGIN = 'https://jpentakalos.com'


class BrokenLock(MockLock):
    def unlock(self):
        raise LockError('Lock is offline.')

    def delete_code(self, code_id):
        raise LockError('Lock is offline.')


class DoorTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 22, 18, 0, tzinfo=timezone.utc)
        self.lock = MockLock(clock=lambda: self.now)
        self.door = Door(self.lock, lambda: self.now)

    def create(self, start=timedelta(0), length=timedelta(days=1), label='Sam'):
        return self.door.owner_command({
            'action': 'create_code', 'label': label,
            'startsAt': (self.now + start).isoformat(), 'endsAt': (self.now + start + length).isoformat()})

    def test_owner_locks_and_unlocks_and_the_lock_logs_it(self):
        self.assertEqual(self.door.owner_command({'action': 'unlock'}), (200, {'lockState': 'unlocked'}))
        self.assertEqual(self.door.owner_command({'action': 'lock'}), (200, {'lockState': 'locked'}))
        self.assertEqual([event['action'] for event in self.door.owner_status()['events']], ['lock', 'unlock'])

    def test_creates_six_digit_codes_on_the_lock(self):
        status, body = self.create(label=' Sam ')
        self.assertEqual(status, 200, body)
        self.assertRegex(body['code']['pin'], r'^\d{6}$')
        self.assertEqual((body['code']['label'], body['code']['status']), ('Sam', 'active'))
        self.assertEqual(self.create(start=timedelta(hours=2), label='Cleaner')[1]['code']['status'], 'scheduled')
        self.assertEqual(self.lock.codes[body['code']['id']]['code'], body['code']['pin'])
        listed = self.door.owner_status()['codes']
        self.assertEqual([(code['label'], code['pin']) for code in listed],
                         [('Sam', body['code']['pin']), ('Cleaner', listed[1]['pin'])])

    def test_expired_codes_drop_off_the_list(self):
        self.create(length=timedelta(hours=1))
        self.now += timedelta(hours=2)
        self.assertEqual(self.door.owner_status()['codes'], [])

    def test_revoking_removes_the_code_from_the_lock(self):
        code_id = self.create()[1]['code']['id']
        self.assertEqual(self.door.owner_command({'action': 'revoke_code', 'id': code_id}), (200, {'revoked': code_id}))
        self.assertEqual(self.lock.codes, {})
        for bad in (None, 7, '', '../x', 'a' * 101):
            self.assertEqual(self.door.owner_command({'action': 'revoke_code', 'id': bad})[0], 400)

    def test_validates_the_window(self):
        cases = [({'label': ''}, 'Name'), ({'endsAt': 'tomorrow'}, 'ISO'), ({'endsAt': '2026-11-23T18:00:00'}, 'ISO'),
                 ({'startsAt': '2026-11-22T19:00:00+00:00', 'endsAt': '2026-11-22T18:30:00+00:00'}, 'after'),
                 ({'startsAt': '2026-11-20T00:00:00+00:00', 'endsAt': '2026-11-21T00:00:00+00:00'}, 'expired'),
                 ({'endsAt': '2026-12-30T00:00:00+00:00'}, '30 days'),
                 ({'startsAt': '2028-01-01T00:00:00+00:00', 'endsAt': '2028-01-02T00:00:00+00:00'}, 'year')]
        base = {'action': 'create_code', 'label': 'Sam', 'startsAt': self.now.isoformat(),
                'endsAt': (self.now + timedelta(days=1)).isoformat()}
        for change, message in cases:
            with self.subTest(change=change):
                status, body = self.door.owner_command({**base, **change})
                self.assertEqual(status, 400)
                self.assertIn(message, body['error'])
        self.assertEqual(self.lock.codes, {})
        self.assertEqual(self.door.owner_command({'action': 'open_sesame'})[0], 400)

    def test_lock_failures_are_reported(self):
        door = Door(BrokenLock(), lambda: self.now)
        status, body = door.owner_command({'action': 'unlock'})
        self.assertEqual((status, body['error'], body['lockState']), (502, 'Lock is offline.', 'locked'))
        self.assertEqual(door.owner_command({'action': 'revoke_code', 'id': 'c1'})[0], 502)

    def test_lock_service_outage_still_shows_the_lock(self):
        class DownLock(MockLock):
            def list_codes(self):
                raise LockError('down')
        body = Door(DownLock(), lambda: self.now).owner_status()
        self.assertEqual((body['lockState'], body['codes']), ('locked', None))
        self.assertIn('error', body)

    def test_driver_selection(self):
        self.assertEqual(lock_from_environment(lambda name: '').name, 'mock')
        seam = lock_from_environment({'DOOR_LOCK_DRIVER': 'seam', 'SEAM_API_KEY': 'k', 'SEAM_DEVICE_ID': 'd'}.get)
        self.assertEqual(seam.name, 'seam')
        with self.assertRaises(ValueError):
            lock_from_environment({'DOOR_LOCK_DRIVER': 'seam'}.get)
        with self.assertRaises(ValueError):
            lock_from_environment({'DOOR_LOCK_DRIVER': 'ring'}.get)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.lock = MockLock()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(
            Door(self.lock), {ORIGIN}, lambda token: token == 'owner-token'))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, path, body=None, token=None, origin=ORIGIN, content_type='application/json'):
        headers = {'Origin': origin, 'Content-Type': content_type}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        try:
            response = urlopen(Request(self.base + path, data=data, headers=headers))
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_owner_routes_require_the_owner_token(self):
        for token in (None, 'someone-else'):
            self.assertEqual(self.call('/api/door/owner', token=token)[0], 401)
            self.assertEqual(self.call('/api/door/owner', {'action': 'unlock'}, token=token)[0], 401)
        self.assertEqual(self.lock.state(), 'locked')
        status, body = self.call('/api/door/owner', token='owner-token')
        self.assertEqual((status, body['lockState'], body['codes']), (200, 'locked', []))
        self.assertEqual(self.call('/api/door/owner', {'action': 'unlock'}, token='owner-token'),
                         (200, {'lockState': 'unlocked'}))

    def test_request_guards(self):
        path, body = '/api/door/owner', {'action': 'unlock'}
        self.assertEqual(self.call(path, body, 'owner-token', origin='https://evil.example')[0], 403)
        self.assertEqual(self.call(path, body, 'owner-token', content_type='text/plain')[0], 415)
        self.assertEqual(self.call(path, b'x' * 2049, 'owner-token')[0], 413)
        self.assertEqual(self.call(path, b'{', 'owner-token')[0], 400)
        self.assertEqual(self.call('/api/door/guest', body)[0], 404)
        self.assertEqual(self.lock.state(), 'locked')


class SeamLockTest(unittest.TestCase):
    def lock(self, responses):
        from seam import SeamLock
        self.requests = []

        class Reply(io.BytesIO):
            def __enter__(self):
                return self

        def opener(request, timeout):
            self.requests.append((request.full_url, json.loads(request.data), request.headers['Authorization']))
            reply = responses.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return Reply(json.dumps(reply).encode())
        now = [0.0]

        def slow_opener(request, timeout):
            now[0] += 1
            return opener(request, timeout)
        return SeamLock('seam_key', 'device-1', opener=slow_opener, sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
                        clock=lambda: now[0], timeout=5)

    def test_unlock_polls_the_action_attempt_until_success(self):
        lock = self.lock([{'action_attempt': {'action_attempt_id': 'a1', 'status': 'pending'}},
                          {'action_attempt': {'action_attempt_id': 'a1', 'status': 'success'}}])
        lock.unlock()
        self.assertEqual(self.requests, [
            ('https://connect.getseam.com/locks/unlock_door', {'device_id': 'device-1'}, 'Bearer seam_key'),
            ('https://connect.getseam.com/action_attempts/get', {'action_attempt_id': 'a1'}, 'Bearer seam_key')])

    def test_errors_and_timeouts_raise_lock_errors(self):
        failed = {'action_attempt': {'status': 'error', 'error': {'message': 'Lock is offline.'}}}
        with self.assertRaisesRegex(LockError, 'offline'):
            self.lock([failed]).lock()
        pending = {'action_attempt': {'action_attempt_id': 'a1', 'status': 'pending'}}
        with self.assertRaisesRegex(LockError, 'not confirmed'):
            self.lock([pending] * 3).lock()
        self.assertEqual(len(self.requests), 3)
        with self.assertRaisesRegex(LockError, 'reach'):
            self.lock([OSError()]).unlock()

    def test_access_codes_use_the_seam_endpoints(self):
        lock = self.lock([{'access_code': {'access_code_id': 'c1', 'code': '123456'}}, {}])
        self.assertEqual(lock.create_code('Sam', '2026-11-22T18:00:00+00:00', '2026-11-23T18:00:00+00:00', '123456'), 'c1')
        lock.delete_code('c1')
        self.assertEqual([(url.rsplit('/', 2)[-2:], body) for url, body, _ in self.requests], [
            (['access_codes', 'create'], {'device_id': 'device-1', 'name': 'Sam', 'code': '123456',
                                          'starts_at': '2026-11-22T18:00:00+00:00', 'ends_at': '2026-11-23T18:00:00+00:00'}),
            (['access_codes', 'delete'], {'access_code_id': 'c1'})])

    def test_deleting_a_code_seam_no_longer_has_succeeds(self):
        missing = HTTPError('https://connect.getseam.com', 404, 'Not Found', {},
                            io.BytesIO(b'{"error": {"message": "Access code not found"}}'))
        self.lock([missing]).delete_code('c1')

    def test_seam_rejections_surface_seams_message(self):
        rejected = HTTPError('https://connect.getseam.com', 400, 'Bad Request', {},
                             io.BytesIO(b'{"error": {"message": "Device has no keypad."}}'))
        with self.assertRaisesRegex(LockError, 'rejected the request: Device has no keypad'):
            self.lock([rejected]).create_code('Sam', 'a', 'b', '123456')

    def test_lists_codes_and_lock_events(self):
        lock = self.lock([
            {'access_codes': [{'access_code_id': 'c1', 'name': 'Sam', 'code': '123456',
                               'starts_at': '2026-11-22T18:00:00Z', 'ends_at': '2026-11-23T18:00:00Z'},
                              {'access_code_id': 'c2', 'name': 'Ongoing', 'code': '999999'}]},
            {'events': [{'event_type': 'lock.unlocked', 'occurred_at': '2026-11-22T19:00:00Z', 'access_code_id': 'c1'},
                        {'event_type': 'lock.locked', 'occurred_at': '2026-11-22T18:30:00Z'}]}])
        self.assertEqual(lock.list_codes(), [{'id': 'c1', 'name': 'Sam', 'code': '123456',
                                              'starts_at': '2026-11-22T18:00:00Z', 'ends_at': '2026-11-23T18:00:00Z'}])
        self.assertEqual(lock.list_events(), [{'at': '2026-11-22T19:00:00Z', 'action': 'unlock', 'code_id': 'c1'},
                                              {'at': '2026-11-22T18:30:00Z', 'action': 'lock', 'code_id': None}])
        self.assertEqual([(url.rsplit('/', 2)[-2:], body) for url, body, _ in self.requests], [
            (['access_codes', 'list'], {'device_id': 'device-1'}),
            (['events', 'list'], {'device_id': 'device-1', 'limit': 50, 'event_types': ['lock.locked', 'lock.unlocked']})])

    def test_state_reads_the_device_locked_property(self):
        self.assertEqual(self.lock([{'device': {'properties': {'locked': True}}}]).state(), 'locked')
        self.assertEqual(self.lock([{'device': {'properties': {'locked': False}}}]).state(), 'unlocked')
        self.assertEqual(self.lock([{'device': {'properties': {'online': False}}}]).state(), 'unknown')


if __name__ == '__main__':
    unittest.main()
