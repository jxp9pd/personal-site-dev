from datetime import datetime, timedelta, timezone
import io
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from door import Door, token_hash
from locks import LockError, MockLock, lock_from_environment
from server import handler_for
from store import MemoryStore, StoreUnavailable

ORIGIN = 'https://jpentakalos.com'


class BrokenLock(MockLock):
    def unlock(self):
        raise LockError('Lock is offline.')


class DownStore(MemoryStore):
    def __getattribute__(self, name):
        if name in ('create_pass', 'list_passes', 'find_pass', 'revoke_pass', 'record_event', 'list_events',
                    'create_code', 'list_codes', 'get_code', 'update_code'):
            def fail(*args):
                raise StoreUnavailable()
            return fail
        return super().__getattribute__(name)


class DoorTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 22, 18, 0, tzinfo=timezone.utc)
        self.lock, self.store = MockLock(), MemoryStore()
        self.door = Door(self.lock, self.store, lambda: self.now)

    def create(self, start=timedelta(0), length=timedelta(days=1), label='Sam'):
        status, body = self.door.owner_command({
            'action': 'create_pass', 'label': label,
            'startsAt': (self.now + start).isoformat(), 'endsAt': (self.now + start + length).isoformat()}, '192.0.2.1')
        self.assertEqual(status, 200, body)
        return body

    def guest(self, token, action='status'):
        return self.door.guest_command({'token': token, 'action': action}, '192.0.2.9')

    def test_owner_locks_and_unlocks_and_is_logged(self):
        self.assertEqual(self.door.owner_command({'action': 'unlock'}, None), (200, {'lockState': 'unlocked'}))
        self.assertEqual(self.door.owner_command({'action': 'lock'}, None), (200, {'lockState': 'locked'}))
        events = self.door.owner_status()['events']
        self.assertEqual([(e['actor'], e['action'], e['outcome']) for e in events],
                         [('owner', 'lock', 'ok'), ('owner', 'unlock', 'ok')])

    def test_pass_stores_only_a_hash_of_the_token(self):
        created = self.create()
        self.assertEqual(created['pass']['status'], 'active')
        stored = self.store.passes[0]
        self.assertEqual(stored['token_hash'], token_hash(created['token']))
        self.assertNotIn(created['token'], json.dumps(stored))
        self.assertNotIn('token_hash', json.dumps(self.door.owner_status()))

    def test_guest_can_unlock_only_inside_the_window(self):
        token = self.create(start=timedelta(hours=1))['token']
        status, body = self.guest(token, 'unlock')
        self.assertEqual((status, body['pass']['status']), (403, 'scheduled'))
        self.assertNotIn('lockState', self.guest(token)[1])
        self.assertEqual(self.lock.state(), 'locked')
        self.now += timedelta(hours=2)
        status, body = self.guest(token, 'unlock')
        self.assertEqual((status, body['lockState']), (200, 'unlocked'))
        self.assertEqual(self.guest(token, 'lock')[1]['lockState'], 'locked')
        self.now += timedelta(days=1)
        self.assertEqual(self.guest(token, 'unlock')[0], 403)
        self.assertEqual(self.lock.state(), 'locked')
        outcomes = [(e['actor'], e['label'], e['action'], e['outcome']) for e in self.door.owner_status()['events']]
        self.assertEqual(outcomes, [('guest', 'Sam', 'unlock', 'denied'), ('guest', 'Sam', 'lock', 'ok'),
                                    ('guest', 'Sam', 'unlock', 'ok'), ('guest', 'Sam', 'unlock', 'denied')])

    def test_revoked_and_unknown_tokens_cannot_unlock(self):
        created = self.create()
        self.assertEqual(self.door.owner_command({'action': 'revoke_pass', 'id': created['pass']['id']}, None)[0], 200)
        status, body = self.guest(created['token'], 'unlock')
        self.assertEqual((status, body['error']), (403, 'This pass was revoked.'))
        for token in ('x' * 43, 'short', None, 'bad token with spaces' * 3):
            self.assertEqual(self.guest(token, 'unlock')[0], 404)
        self.assertEqual(self.lock.state(), 'locked')

    def test_pass_validation(self):
        bad = [
            {'label': '', 'startsAt': self.now.isoformat(), 'endsAt': (self.now + timedelta(hours=1)).isoformat()},
            {'label': 'x' * 61, 'startsAt': self.now.isoformat(), 'endsAt': (self.now + timedelta(hours=1)).isoformat()},
            {'label': 'A', 'startsAt': '2026-11-22T10:00', 'endsAt': '2026-11-22T12:00'},
            {'label': 'A', 'startsAt': self.now.isoformat(), 'endsAt': self.now.isoformat()},
            {'label': 'A', 'startsAt': (self.now - timedelta(days=2)).isoformat(), 'endsAt': (self.now - timedelta(days=1)).isoformat()},
            {'label': 'A', 'startsAt': self.now.isoformat(), 'endsAt': (self.now + timedelta(days=31)).isoformat()},
            {'label': 'A', 'startsAt': (self.now + timedelta(days=400)).isoformat(), 'endsAt': (self.now + timedelta(days=401)).isoformat()},
            {'label': 'A', 'startsAt': 5, 'endsAt': None},
        ]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(self.door.owner_command({'action': 'create_pass', **body}, None)[0], 400)
        self.assertEqual(self.store.passes, [])
        self.assertEqual(self.door.owner_command({'action': 'revoke_pass', 'id': 'nope'}, None)[0], 400)
        self.assertEqual(self.door.owner_command({'action': 'open_sesame'}, None)[0], 400)

    def test_lock_failure_is_reported_and_logged(self):
        door = Door(BrokenLock(), self.store, lambda: self.now)
        self.assertEqual(door.owner_command({'action': 'unlock'}, None),
                         (502, {'error': 'Lock is offline.', 'lockState': 'locked'}))
        self.assertEqual(self.store.events[0]['outcome'], 'failed')

    def test_store_outage_still_lets_the_owner_operate_but_guests_fail_closed(self):
        door = Door(self.lock, DownStore(), lambda: self.now)
        with self.assertLogs(level='ERROR'):
            self.assertEqual(door.owner_command({'action': 'unlock'}, None)[0], 200)
        status = door.owner_status()
        self.assertEqual((status['lockState'], status['passes']), ('unlocked', None))
        self.assertEqual(door.guest_command({'token': 'a' * 43, 'action': 'lock'}, None)[0], 503)

    def test_driver_selection(self):
        settings = {'DOOR_LOCK_DRIVER': 'seam', 'SEAM_API_KEY': 'seam_test', 'SEAM_DEVICE_ID': 'device-1'}
        self.assertEqual(lock_from_environment(lambda name: '').name, 'mock')
        self.assertEqual(lock_from_environment(settings.get).name, 'seam')
        for bad in ({'DOOR_LOCK_DRIVER': 'ring'}, {'DOOR_LOCK_DRIVER': 'seam'}):
            with self.assertRaises(ValueError):
                lock_from_environment(lambda name: bad.get(name, ''))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.lock = MockLock()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(
            Door(self.lock, MemoryStore()), {ORIGIN}, lambda token: token == 'owner-token'))
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
        self.assertEqual((status, body['driver'], body['lockState']), (200, 'mock', 'locked'))

    def test_guest_flow_over_http(self):
        start = datetime.now(timezone.utc)
        _, created = self.call('/api/door/owner', {'action': 'create_pass', 'label': 'Sam', 'startsAt': start.isoformat(),
                                                   'endsAt': (start + timedelta(hours=2)).isoformat()}, token='owner-token')
        status, body = self.call('/api/door/guest', {'token': created['token'], 'action': 'unlock'})
        self.assertEqual((status, body['lockState'], body['pass']['label']), (200, 'unlocked', 'Sam'))

    def test_request_guards(self):
        body = {'action': 'unlock'}
        for path in ('/api/door/owner', '/api/door/guest'):
            with self.subTest(path=path):
                self.assertEqual(self.call(path, body, 'owner-token', origin='https://evil.example')[0], 403)
                self.assertEqual(self.call(path, body, 'owner-token', content_type='text/plain')[0], 415)
                self.assertEqual(self.call(path, b'x' * 2049, 'owner-token')[0], 413)
                self.assertEqual(self.call(path, b'{', 'owner-token')[0], 400)
        self.assertEqual(self.call('/api/door/elsewhere', body)[0], 404)
        self.assertEqual(self.lock.state(), 'locked')


if __name__ == '__main__':
    unittest.main()


class KeypadCodeTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 22, 18, 0, tzinfo=timezone.utc)
        self.lock, self.store = MockLock(), MemoryStore()
        self.door = Door(self.lock, self.store, lambda: self.now)

    def create(self, **overrides):
        body = {'action': 'create_code', 'label': 'Dog sitter', 'startsAt': self.now.isoformat(),
                'endsAt': (self.now + timedelta(days=2)).isoformat(), **overrides}
        return self.door.owner_command(body, None)

    def test_creates_a_six_digit_code_on_the_lock_without_storing_the_pin(self):
        status, body = self.create()
        self.assertEqual(status, 200, body)
        self.assertRegex(body['pin'], r'^[0-9]{6}$')
        [(lock_code_id, on_lock)] = self.lock.codes.items()
        self.assertEqual((on_lock['code'], on_lock['name'], on_lock['starts_at']),
                         (body['pin'], 'Dog sitter', '2026-11-22T18:00:00+00:00'))
        self.assertEqual(self.store.codes[0]['lock_code_id'], lock_code_id)
        self.assertNotIn(body['pin'], json.dumps(self.store.codes))
        [listed] = self.door.owner_status()['codes']
        self.assertEqual((listed['label'], listed['status']), ('Dog sitter', 'active'))
        self.assertNotIn('lock_code_id', listed)

    def test_revoking_removes_the_code_from_the_lock(self):
        code_id = self.create()[1]['code']['id']
        self.assertEqual(self.door.owner_command({'action': 'revoke_code', 'id': code_id}, None), (200, {'revoked': code_id}))
        self.assertEqual(self.lock.codes, {})
        [listed] = self.door.owner_status()['codes']
        self.assertEqual((listed['status'], listed['removedFromLock']), ('revoked', True))

    def test_validates_the_window_and_reports_lock_failures(self):
        self.assertEqual(self.create(endsAt=(self.now + timedelta(days=31)).isoformat())[0], 400)
        self.assertEqual(self.create(label=' ')[0], 400)

        class NoKeypad(MockLock):
            def create_code(self, *args):
                raise LockError('The lock service rejected the request: Device has no keypad.')
        self.door.lock = NoKeypad()
        self.assertEqual(self.create(), (502, {'error': 'The lock service rejected the request: Device has no keypad.'}))
        self.assertEqual(self.store.codes, [])

    def test_store_outage_removes_the_new_code_from_the_lock(self):
        self.door.store = DownStore()
        self.assertEqual(self.create()[0], 503)
        self.assertEqual(self.lock.codes, {})

    def test_revoke_warns_when_the_lock_keeps_the_code_and_a_retry_removes_it(self):
        code_id = self.create()[1]['code']['id']
        delete = self.lock.delete_code
        self.lock.delete_code = lambda code_id: (_ for _ in ()).throw(LockError())
        status, body = self.door.owner_command({'action': 'revoke_code', 'id': code_id}, None)
        self.assertEqual((status, body['revoked']), (200, code_id))
        self.assertIn('Retry removal', body['warning'])
        self.assertEqual(len(self.lock.codes), 1)
        self.assertFalse(self.door.owner_status()['codes'][0]['removedFromLock'])
        self.lock.delete_code = delete
        self.assertEqual(self.door.owner_command({'action': 'revoke_code', 'id': code_id}, None), (200, {'revoked': code_id}))
        self.assertEqual(self.lock.codes, {})

    def test_revoke_retries_after_the_store_times_out_mid_revocation(self):
        code_id = self.create()[1]['code']['id']
        update = self.store.update_code
        def commit_then_time_out(code_id, fields):
            update(code_id, fields)
            raise StoreUnavailable()
        self.store.update_code = commit_then_time_out
        self.assertEqual(self.door.owner_command({'action': 'revoke_code', 'id': code_id}, None)[0], 503)
        self.store.update_code = update
        self.assertEqual(self.door.owner_command({'action': 'revoke_code', 'id': code_id}, None), (200, {'revoked': code_id}))
        self.assertEqual(self.lock.codes, {})


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

    def test_state_reads_the_device_locked_property(self):
        self.assertEqual(self.lock([{'device': {'properties': {'locked': True}}}]).state(), 'locked')
        self.assertEqual(self.lock([{'device': {'properties': {'locked': False}}}]).state(), 'unlocked')
        self.assertEqual(self.lock([{'device': {'properties': {'online': False}}}]).state(), 'unknown')
