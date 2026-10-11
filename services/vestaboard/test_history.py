import io
import importlib.util
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from history import HistoryUnavailable, MessageHistory, sender_ip
from test_helpers import Response, message


class HistoryTest(unittest.TestCase):
    def test_configuration_script_keeps_credentials_private_and_in_separate_files(self):
        path = Path(__file__).resolve().parents[2] / 'scripts/configure-vestaboard.py'
        spec = importlib.util.spec_from_file_location('configure_vestaboard', path)
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)
        run = subprocess.run
        with tempfile.TemporaryDirectory() as folder:
            for history_mode in (False, True):
                secret = 'sb_secret_history' if history_mode else 'board-token'
                argv = [str(path)] + (['--history'] if history_mode else [])
                with patch.object(sys, 'argv', argv), patch('builtins.input', return_value='https://example.supabase.co'), \
                        patch.object(script.getpass, 'getpass', return_value=secret), \
                        patch.object(script.subprocess, 'run') as ssh, patch('builtins.print') as output:
                    script.main()
                command = ssh.call_args_list[0].args[0]
                payload = ssh.call_args_list[0].kwargs['input']
                self.assertNotIn(secret, repr(command))
                self.assertNotIn(secret, repr(output.call_args_list))
                remote = shlex.split(command[-1])[2].replace('/etc', folder)
                run([sys.executable, '-c', remote], input=payload, text=True, check=True, capture_output=True)
            self.assertEqual((Path(folder) / 'vestaboard-note.env').read_text(), 'VESTABOARD_API_TOKEN=board-token\n')
            history_file = Path(folder) / 'vestaboard-history.env'
            self.assertEqual(history_file.read_text(), 'SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_history\n')
            self.assertEqual(history_file.stat().st_mode & 0o777, 0o600)

    def test_records_original_message_grid_utc_time_ip_and_outcome(self):
        requests = []
        def upstream(request, **kwargs):
            requests.append(request)
            self.assertEqual(kwargs['timeout'], 3)
            self.assertEqual(request.get_header('Apikey'), 'sb_secret_test')
            self.assertIsNone(request.get_header('Authorization'))
            return Response(b'')
        history = MessageHistory('https://example.supabase.co', 'sb_secret_test', upstream)
        record_id = history.begin(' Hello ♥\nfriend ', message(), '2001:db8::1')
        record = json.loads(requests[0].data)
        self.assertEqual(record['id'], record_id)
        self.assertEqual(record['original_message'], ' Hello ♥\nfriend ')
        self.assertEqual(record['characters'], message())
        self.assertEqual(record['sender_ip'], '2001:db8::1')
        self.assertTrue(record['submitted_at'].endswith('+00:00'))
        self.assertEqual(record['outcome'], 'unknown')
        self.assertEqual(requests[0].method, 'POST')
        for status, outcome in [(200, 'accepted'), (429, 'rejected'), (503, 'rejected'),
                                (502, 'unknown'), (504, 'unknown')]:
            with self.subTest(status=status):
                history.finish(record_id, status)
                self.assertEqual(requests[-1].method, 'PATCH')
                self.assertEqual(requests[-1].full_url, history.endpoint + '?id=eq.' + record_id)
                self.assertEqual(json.loads(requests[-1].data), {'outcome': outcome, 'http_status': status})

    def test_database_failures_keep_secrets_out_of_errors_and_do_not_retry(self):
        for failure in (OSError('secret'), HTTPError('https://example.supabase.co', 401, 'secret', {}, io.BytesIO(b'secret'))):
            with self.subTest(failure=type(failure).__name__):
                opener = Mock(side_effect=failure)
                history = MessageHistory('https://example.supabase.co', 'eyJtest-key', opener)
                with self.assertRaises(HistoryUnavailable) as error:
                    history.begin('A', message(), None)
                self.assertNotIn('secret', str(error.exception))
                opener.assert_called_once()
                self.assertEqual(opener.call_args.args[0].get_header('Authorization'), 'Bearer eyJtest-key')
                with self.assertLogs(level='ERROR') as logs:
                    history.finish('known-record', 200)
                self.assertIn('known-record', logs.output[0])
                self.assertNotIn('secret', logs.output[0])
                self.assertEqual(opener.call_count, 2)

    def test_forwarded_ip_only_trusted_from_local_proxy(self):
        for peer, forwarded, expected in [
            ('127.0.0.1', '203.0.113.7', '203.0.113.7'),
            ('::1', '2001:db8::1', '2001:db8::1'),
            ('127.0.0.1', None, None),
            ('127.0.0.1', '203.0.113.7, 198.51.100.1', None),
            ('198.51.100.1', '203.0.113.7', '198.51.100.1'),
        ]:
            with self.subTest(peer=peer, forwarded=forwarded):
                self.assertEqual(sender_ip(peer, forwarded), expected)

    def test_configuration_is_optional_but_partial_configuration_fails(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(MessageHistory.from_environment())
            path = Path(folder) / '.env'
            path.write_text('SUPABASE_URL=https://example.supabase.co\n')
            with self.assertRaises(ValueError):
                MessageHistory.from_environment(path)
            path.write_text('SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY="sb_secret_test"\n')
            self.assertEqual(MessageHistory.from_environment(path).key, 'sb_secret_test')
            with patch.dict(os.environ, {'SUPABASE_URL': '', 'SUPABASE_SERVICE_ROLE_KEY': ''}):
                self.assertIsNone(MessageHistory.from_environment(path))


if __name__ == '__main__':
    unittest.main()
