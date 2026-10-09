import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from board import BoardGateway
from nfl import NFL
from pomodoro import Pomodoro
from server import handler_for
from test_helpers import Response, message
from test_nfl import game


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.forwarded = []
        def upstream(request, **kwargs):
            self.forwarded.append(json.loads(request.data))
            return Response(b'{"status":"ok"}')
        gateway = BoardGateway('test-token', upstream, lambda: self.now)
        self.timer = Pomodoro(gateway, lambda: self.now)
        self.nfl = NFL(gateway, lambda *args: [game()], lambda: self.now)
        self.nfl.status()
        self.nfl.tick()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(
            gateway, {'https://jpentakalos.com'}, pomodoro=self.timer, nfl=self.nfl))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, data=None, origin='https://jpentakalos.com', path='/api/vestaboard/messages', content_type='application/json', method=None):
        headers = {'Origin': origin, 'Content-Type': content_type}
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = urlopen(request)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_origin_content_type_body_and_validation_block_before_api(self):
        body = json.dumps({'characters': message()}).encode()
        for path in ('/api/vestaboard/messages', '/api/vestaboard/pomodoro', '/api/vestaboard/nfl'):
            with self.subTest(path=path):
                self.assertEqual(self.request(body, path=path, origin='https://evil.example')[0], 403)
                self.assertEqual(self.request(body, path=path, content_type='text/plain')[0], 415)
                self.assertEqual(self.request(b'x' * 4097, path=path)[0], 413)
                self.assertEqual(self.request(b'{', path=path)[0], 400)
                self.assertEqual(self.request(b'\xff', path=path)[0], 400)
                self.assertEqual(self.request(b'[]', path=path)[0], 400)
        self.assertEqual(self.request(b'{"characters": [[true]]}')[0], 400)
        self.assertEqual(self.forwarded, [])

    def test_status_is_uncached_contains_no_secret_and_does_not_contact_cloud(self):
        for path in ('/api/vestaboard/status', '/api/vestaboard/pomodoro', '/api/vestaboard/nfl'):
            with self.subTest(path=path):
                status, headers, raw = self.request(path=path)
                self.assertEqual(status, 200)
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertTrue(json.loads(raw)['configured'])
                self.assertNotIn(b'test-token', raw)
        self.assertEqual(self.forwarded, [])

    def test_notes_and_timer_share_delivery_and_cooldown_without_forced_override(self):
        body = json.dumps({'characters': message(), 'forced': True}).encode()
        self.assertEqual(self.request(body)[0], 200)
        status, headers, raw = self.request(body)
        self.assertEqual(status, 429)
        self.assertGreater(int(headers['Retry-After']), 0)
        self.assertEqual(self.forwarded, [{'characters': message()}])
        self.timer.command({'action': 'start', 'focusMinutes': 6, 'breakMinutes': 1})
        self.timer.tick()  # The note's cooldown applies to timer sends too.
        self.assertEqual(len(self.forwarded), 1)
        self.now = 15
        self.timer.tick()
        self.assertEqual(len(self.forwarded), 2)
        self.assertEqual(self.request(body)[0], 429)  # And vice versa.
        self.now = 299
        self.assertEqual(self.request(body)[0], 200)  # A note can replace an active timer.
        self.now = 300
        self.timer.tick()
        self.assertEqual(self.forwarded[-1], {'characters': message()})
        self.now = 314
        self.timer.tick()
        self.assertEqual(self.forwarded[-1]['characters'], self.timer.status()['characters'])
        self.now = 360
        self.assertEqual(self.timer.status()['phase'], 'break')  # Delivery delays don't extend focus.

    def test_pomodoro_commands_update_shared_state_without_synchronous_board_writes(self):
        path = '/api/vestaboard/pomodoro'
        for action, state in (('start', 'running'), ('pause', 'paused'), ('resume', 'running'), ('stop', 'stopped')):
            body = {'action': action, 'focusMinutes': 25, 'breakMinutes': 5}
            status, _, raw = self.request(json.dumps(body).encode(), path=path)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)['state'], state)
            self.assertEqual(json.loads(self.request(path=path)[2])['state'], state)
        self.assertEqual(self.forwarded, [])

    def test_production_does_not_serve_local_files(self):
        self.assertEqual(self.request(path='/server.py')[0], 404)
        self.assertEqual(self.request(path='/server.py', method='HEAD')[0], 405)

    def test_nfl_routes_track_and_stop_using_the_same_board_cooldown(self):
        path = '/api/vestaboard/nfl'
        status, _, raw = self.request(b'{"action":"track","gameId":"401000001"}', path=path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)['state'], 'tracking')
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.request(json.dumps({'characters': message()}).encode())[0], 200)
        self.nfl.tick()
        self.assertEqual(len(self.forwarded), 1)
        self.now = 15
        self.nfl.tick()
        self.assertEqual(self.forwarded[-1]['characters'], game()['characters'])
        self.assertEqual(self.request(b'{"action":"stop"}', path=path)[0], 200)
        self.assertEqual(json.loads(self.request(path=path)[2])['state'], 'stopped')


if __name__ == '__main__':
    unittest.main()
