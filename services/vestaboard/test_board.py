import io
import os
from pathlib import Path
import tempfile
import threading
import json
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from board import BoardGateway, api_token, cloud_tls_context, valid_characters
from test_helpers import Response, message


class EnvironmentTest(unittest.TestCase):
    def test_preview_reads_only_the_token_without_expanding_values(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            env_file = Path(folder) / '.env'
            env_file.write_text('# Local settings\nOTHER=value\nVESTABOARD_API_TOKEN="test-$literal" # comment\n')
            self.assertEqual(api_token(env_file), 'test-$literal')

    def test_environment_overrides_file_and_empty_environment_disables_sends(self):
        with tempfile.TemporaryDirectory() as folder:
            env_file = Path(folder) / '.env'
            env_file.write_text('VESTABOARD_API_TOKEN=file-token\n')
            for value in ('environment-token', ''):
                with patch.dict(os.environ, {'VESTABOARD_API_TOKEN': value}):
                    self.assertEqual(api_token(env_file), value)

    def test_missing_file_and_production_without_environment_stay_unconfigured(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            self.assertEqual(api_token(Path(folder) / '.env'), '')
            self.assertEqual(api_token(), '')

    def test_macos_missing_ca_bundle_uses_system_roots(self):
        context = Mock()
        context.cert_store_stats.return_value = {'x509_ca': 0}
        with patch('board.ssl.create_default_context', return_value=context), \
                patch('board.sys.platform', 'darwin'), patch.dict(os.environ, {}, clear=True):
            self.assertIs(cloud_tls_context(), context)
        context.load_verify_locations.assert_called_once_with('/etc/ssl/cert.pem')

    def test_explicit_certificate_settings_are_preserved(self):
        context = Mock()
        context.cert_store_stats.return_value = {'x509_ca': 0}
        with patch('board.ssl.create_default_context', return_value=context), \
                patch('board.sys.platform', 'darwin'), \
                patch.dict(os.environ, {'SSL_CERT_FILE': '/custom/roots.pem'}):
            cloud_tls_context()
        context.load_verify_locations.assert_not_called()


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
            return Response(json.dumps({"status": "ok" if len(calls) == 1 else "success"}).encode())
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
