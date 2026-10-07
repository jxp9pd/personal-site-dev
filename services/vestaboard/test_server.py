import io
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer
from server import BoardGateway, handler_for, valid_characters


def message():
    return [[1] + [0] * 14, [0] * 15, [0] * 15]


class Response(io.BytesIO):
    status = 200


class GatewayTest(unittest.TestCase):
    def test_shape_and_code_validation(self):
        self.assertTrue(valid_characters(message()))
        for value in (None, {}, [[1]], [[0] * 15] * 3, [[70] * 15] * 3,
                      [[True] * 15] * 3, [[43] * 15] * 3, [[1.0] * 15] * 3):
            self.assertFalse(valid_characters(value), repr(value))

    def test_unconfigured_never_calls_api(self):
        gateway = BoardGateway(opener=lambda *a, **kw: self.fail('Unexpected API call'))
        self.assertFalse(gateway.status()['configured'])
        self.assertEqual(gateway.send(message())[0], 503)

    def test_cloud_contract_and_cooldown(self):
        calls = []
        now = [100]
        def upstream(request, **kwargs):
            calls.append(request)
            self.assertEqual(request.full_url, 'https://cloud.vestaboard.com/')
            self.assertEqual(request.get_header('X-vestaboard-token'), 'test-token')
            self.assertEqual(json.loads(request.data), {'characters': message()})
            self.assertEqual(kwargs['timeout'], 10)
            return Response(b'{"status":"ok","id":"test"}')
        gateway = BoardGateway('test-token', upstream, lambda: now[0])
        self.assertEqual(gateway.send(message()), (200, {'accepted': True, 'retryAfter': 15}))
        self.assertEqual(gateway.send(message())[0], 429)
        now[0] = 115
        self.assertEqual(gateway.send(message())[0], 200)
        self.assertEqual(len(calls), 2)

    def test_concurrent_sends_only_forward_one(self):
        started, release = threading.Event(), threading.Event()
        def upstream(*a, **kw):
            started.set()
            release.wait(2)
            return Response(b'{"status":"ok"}')
        gateway = BoardGateway('test-token', upstream)
        worker = threading.Thread(target=lambda: gateway.send(message()))
        worker.start()
        self.assertTrue(started.wait(2))
        try:
            self.assertEqual(gateway.send(message())[0], 429)
        finally:
            release.set()
            worker.join()

    def test_failures_do_not_claim_success_or_leak_upstream_body(self):
        for raw in (b'{"status":"error","secret":"private"}', b'not json', b'[]'):
            gateway = BoardGateway('test-token', lambda *a, **kw: Response(raw))
            status, body = gateway.send(message())
            self.assertEqual(status, 502)
            self.assertNotIn('private', json.dumps(body))
            self.assertNotIn('accepted', body)
        def failure(*a, **kw):
            raise HTTPError('https://cloud.vestaboard.com/', 401, 'secret', {}, io.BytesIO(b'secret'))
        status, body = BoardGateway('test-token', failure).send(message())
        self.assertEqual(status, 502)
        self.assertNotIn('secret', json.dumps(body))

    def test_timeout_and_upstream_rate_limit(self):
        def timeout(*a, **kw):
            raise TimeoutError()
        self.assertEqual(BoardGateway('test-token', timeout).send(message())[0], 504)
        def busy(*a, **kw):
            raise HTTPError('https://cloud.vestaboard.com/', 429, 'busy', {'Retry-After': '90'}, None)
        gateway = BoardGateway('test-token', busy)
        self.assertEqual(gateway.send(message())[1]['retryAfter'], 90)
        self.assertGreaterEqual(gateway.status()['retryAfter'], 89)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.forwarded = []
        def upstream(request, **kwargs):
            self.forwarded.append(json.loads(request.data))
            return Response(b'{"status":"ok"}')
        gateway = BoardGateway('test-token', upstream)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(gateway, {'https://jpentakalos.com'}))
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
        self.assertEqual(self.request(body, origin='https://evil.example')[0], 403)
        self.assertEqual(self.request(body, content_type='text/plain')[0], 415)
        self.assertEqual(self.request(b'x' * 4097)[0], 413)
        self.assertEqual(self.request(b'{')[0], 400)
        self.assertEqual(self.request(b'\xff')[0], 400)
        self.assertEqual(self.request(b'[]')[0], 400)
        self.assertEqual(self.request(b'{"characters": [[true]]}')[0], 400)
        self.assertEqual(self.forwarded, [])

    def test_status_is_uncached_contains_no_secret_and_does_not_contact_cloud(self):
        status, headers, raw = self.request(path='/api/vestaboard/status')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertTrue(json.loads(raw)['configured'])
        self.assertNotIn(b'test-token', raw)
        self.assertEqual(self.forwarded, [])

    def test_success_then_http_cooldown_and_no_forced_override(self):
        body = json.dumps({'characters': message(), 'forced': True}).encode()
        self.assertEqual(self.request(body)[0], 200)
        status, headers, raw = self.request(body)
        self.assertEqual(status, 429)
        self.assertGreater(int(headers['Retry-After']), 0)
        self.assertEqual(self.forwarded, [{'characters': message()}])

    def test_production_does_not_serve_local_files(self):
        self.assertEqual(self.request(path='/server.py')[0], 404)
        self.assertEqual(self.request(path='/server.py', method='HEAD')[0], 405)


if __name__ == '__main__':
    unittest.main()
