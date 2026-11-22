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
        if name in ('create_pass', 'list_passes', 'find_pass', 'revoke_pass', 'record_event', 'list_events'):
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
        return SeamLock('seam_key', 'device-1', opener=opener, sleep=lambda seconds: None, timeout=3)

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
            self.lock([pending] * 4).lock()
        with self.assertRaisesRegex(LockError, 'reach'):
            self.lock([OSError()]).unlock()

    def test_state_reads_the_device_locked_property(self):
        self.assertEqual(self.lock([{'device': {'properties': {'locked': True}}}]).state(), 'locked')
        self.assertEqual(self.lock([{'device': {'properties': {'locked': False}}}]).state(), 'unlocked')
        self.assertEqual(self.lock([{'device': {'properties': {'online': False}}}]).state(), 'unknown')
