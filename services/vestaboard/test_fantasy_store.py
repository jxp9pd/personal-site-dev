from copy import deepcopy
import io
import json
import os
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from apps import BoardController
from fantasy import DEFAULT_LEAGUES, Fantasy, SourceError, league_settings
from fantasy_store import FantasyStore, StorageUnavailable
from test_helpers import AppTestCase, Response, background_task, matchup


class Database:
    """Small PostgREST fake shared across independent gateway instances."""
    def __init__(self):
        self.row = None
        self.requests = []

    def __call__(self, request, **kwargs):
        self.requests.append(request)
        if request.method == 'GET':
            rows = [self.row] if self.row else []
        elif request.method == 'POST':
            if self.row and 'ignore-duplicates' in request.get_header('Prefer'):
                rows = []
            else:
                self.row = json.loads(request.data)
                rows = [self.row]
        else:
            version = parse_qs(urlsplit(request.full_url).query)['config_version'][0][3:]
            rows = []
            if self.row and self.row['config_version'] == version:
                self.row.update(json.loads(request.data))
                rows = [self.row]
        return Response(json.dumps(rows).encode())


class StoreTransportTest(unittest.TestCase):
    def test_credentials_timeouts_initialization_and_version_guard(self):
        database = Database()
        upstream = Mock(side_effect=database)
        store = FantasyStore('https://example.supabase.co', 'sb_secret_test', upstream)
        original = store.save_settings(league_settings(DEFAULT_LEAGUES), initialize=True)
        self.assertEqual(store.load(), original)
        changed = [dict(league, username='another') for league in DEFAULT_LEAGUES]
        self.assertEqual(store.save_settings(changed, initialize=True), original)
        replacement = store.save_settings(changed)
        self.assertNotEqual(original['config_version'], replacement['config_version'])
        self.assertFalse(store.save_matchups(original['config_version'], {'week': 5}))
        self.assertIsNone(database.row['week'])
        self.assertTrue(store.save_matchups(replacement['config_version'], {'week': 6}))
        self.assertEqual(store.load()['week'], 6)
        for call in upstream.call_args_list:
            self.assertEqual(call.kwargs['timeout'], 3)
            self.assertEqual(call.args[0].get_header('Apikey'), 'sb_secret_test')
            self.assertIsNone(call.args[0].get_header('Authorization'))

    def test_bad_responses_and_network_errors_are_sanitized(self):
        failures = [OSError('secret'), HTTPError('https://example.supabase.co', 401, 'secret', {}, io.BytesIO(b'secret'))]
        for failure in failures:
            opener = Mock(side_effect=failure)
            store = FantasyStore('https://example.supabase.co', 'eyJsecret', opener)
            with self.assertRaises(StorageUnavailable) as error:
                store.load()
            self.assertNotIn('secret', str(error.exception))
            opener.assert_called_once()
            self.assertEqual(opener.call_args.args[0].get_header('Authorization'), 'Bearer eyJsecret')
        for raw in (b'not JSON', b'{}', b'[null]', b'[{}, {}]', b' ' * 256_001):
            with self.subTest(raw=raw[:12]):
                store = FantasyStore('https://example.supabase.co', 'secret', Mock(return_value=Response(raw)))
                with self.assertRaises(StorageUnavailable):
                    store.load()

    def test_environment_is_optional_but_never_partially_configured(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(FantasyStore.from_environment())
            with patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co'}):
                with self.assertRaises(ValueError):
                    FantasyStore.from_environment()
                with patch.dict(os.environ, {'SUPABASE_SERVICE_ROLE_KEY': 'secret'}):
                    self.assertIsInstance(FantasyStore.from_environment(), FantasyStore)


class PersistenceTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.database = Database()
        self.store = FantasyStore('https://example.supabase.co', 'secret', self.database)
        self.app = self.new_app()

    def new_app(self):
        return Fantasy(BoardController(self.gateway), self.source, lambda: self.now, lambda: self.wall, store=self.store)

    def test_settings_and_scores_survive_restart_without_restarting_board(self):
        self.app.tick()
        changed = [dict(league, username='another') for league in DEFAULT_LEAGUES]
        self.assertEqual(self.app.command({'action': 'start', 'leagues': changed})[0], 200)
        self.source.matchup.return_value = matchup(177.25)
        self.app.tick()
        saved = deepcopy(self.database.row)
        self.gateway.send.reset_mock()
        self.source.state.side_effect = SourceError('Feed offline.')
        restarted = self.new_app()
        restarted.tick()
        state = restarted.status()
        self.assertEqual(state['leagues'][0]['username'], 'another')
        self.assertEqual(state['leagues'][0]['matchup']['you']['points'], 177.25)
        self.assertEqual(state['source']['lastCheckedAt'], saved['last_checked_at'])
        self.assertEqual(state['storage'], {'enabled': True, 'ready': True, 'error': None})
        self.assertEqual(state['state'], 'idle')
        self.assertIsNone(state['alert'])
        self.assertIsNone(restarted.controller.owner)
        self.assertEqual(self.database.row, saved)
        self.gateway.send.assert_not_called()

    def test_startup_outage_or_invalid_saved_data_never_overwrites_settings(self):
        self.store.save_settings(league_settings(DEFAULT_LEAGUES))
        original = deepcopy(self.database.row)
        self.source.state.reset_mock()
        self.store.opener = Mock(side_effect=OSError('offline'))
        self.app.tick()
        self.assertFalse(self.app.status()['storage']['ready'])
        self.assertEqual(self.app.command({'action': 'preview', 'leagues': DEFAULT_LEAGUES})[0], 503)
        self.source.state.assert_not_called()
        self.store.opener = self.database
        self.database.row['matchups'] = [{'you': {'points': 'broken'}}, None]
        self.now = 15
        self.app.tick()
        self.assertFalse(self.app.status()['storage']['ready'])
        self.assertEqual(self.database.row['matchups'][0]['you']['points'], 'broken')
        self.database.row = original
        self.now = 30
        self.app.tick()
        self.assertTrue(self.app.status()['storage']['ready'])

    def test_ambiguous_settings_save_is_read_back_without_claiming_board(self):
        self.app.tick()
        before = deepcopy(self.app.status()['leagues'])
        changed = [dict(league, username='another') for league in DEFAULT_LEAGUES]
        def timeout_after_commit(request, **kwargs):
            self.database(request, **kwargs)
            raise OSError('connection lost after commit')
        self.store.opener = timeout_after_commit
        self.assertEqual(self.app.command({'action': 'start', 'leagues': changed})[0], 503)
        self.assertEqual(self.app.status()['leagues'], before)
        self.assertIsNone(self.app.controller.owner)
        self.gateway.send.assert_not_called()
        self.store.opener = self.database
        self.now = 15
        self.app.tick()
        self.assertEqual(self.app.status()['leagues'][0]['username'], 'another')
        self.assertEqual(self.app.status()['state'], 'idle')
        self.gateway.send.assert_not_called()

    def test_score_save_retries_and_stop_remains_available_during_outage(self):
        self.app.tick()
        self.app.command({'action': 'start', 'leagues': DEFAULT_LEAGUES})
        self.store.opener = Mock(side_effect=OSError('offline'))
        self.app.tick()
        self.assertIn('could not be saved', self.app.status()['storage']['error'])
        self.assertEqual(self.app.status()['leagues'][0]['matchup']['you']['points'], 123.45)
        attempts = self.gateway.send.call_count
        self.app.tick()
        self.assertEqual(self.store.opener.call_count, 1)
        self.assertEqual(self.app.command({'action': 'stop'})[0], 200)
        self.store.opener = self.database
        self.now = 15
        self.app.tick()
        self.assertEqual(self.database.row['matchups'][0]['you']['points'], 123.45)
        self.assertIsNone(self.app.status()['storage']['error'])
        self.assertEqual(self.gateway.send.call_count, attempts)

    def test_in_flight_old_snapshot_cannot_replace_new_leagues(self):
        self.app.tick()
        entered, release = threading.Event(), threading.Event()
        def delay_patch(request, **kwargs):
            if request.method == 'PATCH':
                entered.set()
                if not release.wait(2):
                    raise AssertionError('Snapshot was not released')
            return self.database(request, **kwargs)
        self.store.opener = delay_patch
        self.now = 60
        self.app.status()
        self.app._refresh()
        with background_task(self.app._save_snapshot):
            self.assertTrue(entered.wait(1))
            try:
                changed = [dict(league, username='another') for league in DEFAULT_LEAGUES]
                self.assertEqual(self.app.command({'action': 'preview', 'leagues': changed})[0], 200)
            finally:
                release.set()
        self.assertEqual(self.database.row['leagues'][0]['username'], 'another')
        self.assertEqual(self.database.row['matchups'], [None, None])
        self.assertIsNone(self.app.status()['storage']['error'])


if __name__ == '__main__':
    unittest.main()
