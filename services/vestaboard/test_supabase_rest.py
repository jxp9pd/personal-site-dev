import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from fantasy import DEFAULT_LEAGUES, league_settings
from fantasy_store import FantasyStore
from fantasy_weeks import FantasyWeekStore
from history import MessageHistory
from supabase_rest import SupabaseClient, SupabaseUnavailable
from test_helpers import Response, message


def store(cls, key, opener):
    return cls(SupabaseClient('https://example.supabase.co', key, opener))


class SupabaseHeadersTest(unittest.TestCase):
    """Modern sb_secret keys send only apikey; legacy JWTs also send Authorization."""
    calls = {
        MessageHistory: lambda history: history.begin('A', message(), None),
        FantasyStore: lambda fantasy: fantasy.save_settings(league_settings(DEFAULT_LEAGUES)),
        FantasyWeekStore: lambda weeks: weeks.load('2026', 5),
    }

    def test_every_store_sends_headers_for_both_key_styles(self):
        for cls, call in self.calls.items():
            for key, authorization in (('sb_secret_test', None), ('eyJtest', 'Bearer eyJtest')):
                with self.subTest(store=cls.__name__, key=key):
                    opener = Mock(side_effect=lambda request, **kwargs: Response(
                        json.dumps([json.loads(request.data)] if request.data else []).encode()))
                    call(store(cls, key, opener))
                    request = opener.call_args.args[0]
                    self.assertEqual(request.get_header('Apikey'), key)
                    self.assertEqual(request.get_header('Authorization'), authorization)
                    self.assertEqual(request.get_header('Content-type'), 'application/json')
                    self.assertEqual(opener.call_args.kwargs, {'timeout': 3})
                    opener.assert_called_once()


class SupabaseClientTest(unittest.TestCase):
    def test_headers_for_both_key_styles(self):
        self.assertEqual(SupabaseClient('https://example.supabase.co', 'sb_secret_test').headers(),
                         {'apikey': 'sb_secret_test'})
        self.assertEqual(SupabaseClient('https://example.supabase.co', 'eyJtest').headers(),
                         {'apikey': 'eyJtest', 'Authorization': 'Bearer eyJtest'})

    def test_only_https_project_urls_are_accepted(self):
        self.assertEqual(SupabaseClient('https://example.supabase.co/', 'key').table_url('t'),
                         'https://example.supabase.co/rest/v1/t')
        for url in ('http://example.supabase.co', 'https://user:pw@example.supabase.co', 'https://example.supabase.co/x',
                    'https://example.supabase.co?a=1', 'https://example.supabase.co#a', 'https://'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                SupabaseClient(url, 'key')

    def test_failures_are_sanitized_and_never_retried(self):
        redirect = Response(b'secret')
        redirect.status = 302
        for name, opener in (('network', Mock(side_effect=OSError('secret'))),
                             ('http', Mock(side_effect=HTTPError('https://example.supabase.co', 401, 'secret', {}, io.BytesIO(b'secret')))),
                             ('non-2xx', Mock(return_value=redirect))):
            with self.subTest(failure=name):
                client = SupabaseClient('https://example.supabase.co', 'eyJsecret', opener)
                with self.assertRaises(SupabaseUnavailable) as error:
                    client.request('GET', client.table_url('t'), limit=10)
                self.assertNotIn('secret', str(error.exception))
                opener.assert_called_once()


class RefreshCredentialsTest(unittest.TestCase):
    """refresh-fantasy.py builds the same client from server settings or the linked Mac CLI."""
    def setUp(self):
        path = Path(__file__).resolve().parents[2] / 'scripts' / 'refresh-fantasy.py'
        spec = importlib.util.spec_from_file_location('refresh_fantasy', path)
        self.refresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.refresh)

    def test_env_file_settings_build_the_shared_client(self):
        opener = Mock()
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / 'history.env'
            env.write_text('SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_test\n')
            client = self.refresh.credentials(env, opener)
            self.assertIsInstance(client, SupabaseClient)
            self.assertEqual((client.url, client.key, client.opener), ('https://example.supabase.co', 'sb_secret_test', opener))
            env.write_text('SUPABASE_URL=https://example.supabase.co\n')
            with self.assertRaises(ValueError):
                self.refresh.credentials(env, opener)

    def test_linked_cli_key_builds_the_shared_client_without_exposing_it(self):
        ref = 'a' * 20
        keys = {'keys': [{'name': 'anon', 'type': 'legacy', 'api_key': 'eyJanon'},
                         {'name': 'service_role', 'type': 'legacy', 'api_key': 'eyJservice'}]}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'supabase' / '.temp').mkdir(parents=True)
            (root / 'supabase' / '.temp' / 'project-ref').write_text(ref + '\n')
            done = subprocess.CompletedProcess([], 0, stdout=json.dumps(keys), stderr='')
            with patch.object(self.refresh, 'ROOT', root), patch.dict('os.environ', {}, clear=True), \
                    patch.object(self.refresh.shutil, 'which', return_value='/usr/local/bin/supabase'), \
                    patch.object(self.refresh.subprocess, 'run', return_value=done) as run:
                client = self.refresh.credentials(None, Mock())
            self.assertEqual((client.url, client.key), ('https://' + ref + '.supabase.co', 'eyJservice'))
            self.assertNotIn('eyJ', repr(run.call_args))


if __name__ == '__main__':
    unittest.main()
