from copy import deepcopy
import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from fantasy import DEFAULT_LEAGUES, SourceError, league_settings
from fantasy_weeks import ConcurrentRefresh, FantasyWeekStore
from test_helpers import Response, matchup

path = Path(__file__).resolve().parents[2] / 'scripts' / 'refresh-fantasy.py'
spec = importlib.util.spec_from_file_location('refresh_fantasy', path)
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class WeeklyDatabase:
    def __init__(self):
        self.rows = {}
        self.before_delete = lambda: None

    def __call__(self, request, **kwargs):
        assert urlsplit(request.full_url).path == '/rest/v1/vestaboard_fantasy_weeks'
        query = parse_qs(urlsplit(request.full_url).query)
        body = json.loads(request.data) if request.data else None
        key = ((body['season'], body['week']) if request.method == 'POST'
               else (query['season'][0][3:], int(query['week'][0][3:])))
        current = self.rows.get(key)
        result = []
        if request.method == 'GET':
            result = [current] if current else []
        elif request.method == 'POST':
            if current is None:
                self.rows[key] = body
                result = [body]
        elif current and current['config_version'] == query['config_version'][0][3:]:
            if request.method == 'DELETE':
                self.before_delete()
                result = [self.rows.pop(key)]
            else:
                current.update(body)
                result = [current]
        return Response(json.dumps(result).encode())


class WeeklyRefreshTest(unittest.TestCase):
    def setUp(self):
        self.database = WeeklyDatabase()
        self.store = FantasyWeekStore('https://example.supabase.co', 'secret', self.database)
        self.source = Mock()
        self.source.matchup.side_effect = lambda config, state: dict(matchup(), week=state['week'], season=state['season'])
        self.leagues = league_settings(DEFAULT_LEAGUES)
        self.before = refresh.refresh_week(self.source, self.store, '2026', 5, self.leagues)

    def test_specific_week_is_repeatable_without_duplicates_or_changes_to_other_weeks(self):
        other = refresh.refresh_week(self.source, self.store, '2026', 6, self.leagues)
        after = refresh.refresh_week(self.source, self.store, '2026', 5, self.leagues, self.before)
        self.assertEqual(refresh.csv_rows(after), refresh.csv_rows(self.before))
        self.assertNotEqual(after['config_version'], self.before['config_version'])
        self.assertEqual(len(self.database.rows), 2)
        self.assertEqual(self.store.load('2026', 6), other)
        self.assertEqual(self.source.matchup.call_args.args[1], {'season': '2026', 'week': 5, 'season_type': 'regular'})

    def test_partial_fetch_failure_preserves_the_entire_saved_week(self):
        self.source.matchup.side_effect = [matchup(155), SourceError('Second league unavailable')]
        with self.assertRaises(SourceError):
            refresh.refresh_week(self.source, self.store, '2026', 5, self.leagues, self.before)
        self.assertEqual(self.store.load('2026', 5), self.before)

    def test_backups_exist_before_deletion_and_rebuilt_csv_matches_every_field(self):
        other = refresh.refresh_week(self.source, self.store, '2026', 6, self.leagues)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            def check_backup():
                self.assertEqual(json.loads((output / 'backup.json').read_text()), self.before)
                with (output / 'before.csv').open(newline='') as handle:
                    self.assertEqual(list(csv.DictReader(handle)), refresh.csv_rows(self.before))
            self.database.before_delete = check_backup
            report = refresh.verify_rebuild(self.source, self.store, self.before, output)
            self.assertTrue(report['match'])
            self.assertTrue(report['deleted_then_rebuilt'])
            self.assertEqual(report['differences'], [])
            self.assertEqual(report['rows_after'], 2)
            self.assertEqual((output / 'before.csv').read_bytes(), (output / 'after.csv').read_bytes())
            self.assertEqual(json.loads((output / 'comparison.json').read_text()), report)
        self.assertEqual(self.store.load('2026', 6), other)

    def test_rebuild_failure_restores_backup_and_records_recovery(self):
        self.source.matchup.side_effect = SourceError('Feed offline')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaises(SourceError):
                refresh.verify_rebuild(self.source, self.store, self.before, output)
            restored = self.store.load('2026', 5)
            self.assertEqual(refresh.csv_rows(restored), refresh.csv_rows(self.before))
            self.assertEqual(restored['config_version'], self.before['config_version'])
            self.assertEqual(json.loads((output / 'failure.json').read_text())['recovery'], 'Restored the original backup.')

    def test_comparison_reports_stat_corrections_without_rounding_them_away(self):
        self.source.matchup.side_effect = None
        self.source.matchup.return_value = matchup(123.46)
        with tempfile.TemporaryDirectory() as directory:
            report = refresh.verify_rebuild(self.source, self.store, self.before, Path(directory))
            self.assertFalse(report['match'])
            self.assertEqual(report['differences'], [
                {'slot': slot, 'field': 'your_points', 'before': '123.45', 'after': '123.46'} for slot in (1, 2)])
        self.assertEqual(self.store.load('2026', 5)['matchups'][0]['you']['points'], 123.46)

    def test_stale_delete_or_update_cannot_replace_a_concurrent_refresh(self):
        newer = refresh.refresh_week(self.source, self.store, '2026', 5, self.leagues, self.before)
        with self.assertRaises(ConcurrentRefresh):
            self.store.delete(self.before)
        with self.assertRaises(ConcurrentRefresh):
            refresh.refresh_week(self.source, self.store, '2026', 5, self.leagues, self.before)
        self.assertEqual(self.store.load('2026', 5), newer)

    def test_csv_preserves_unicode_names_lineup_order_exact_scores_and_bye_weeks(self):
        snapshot = deepcopy(self.before)
        snapshot['matchups'][0]['you']['name'] = 'Name, "quoted"\n♥'
        snapshot['matchups'][0]['you']['points'] = -1.025
        snapshot['matchups'][0]['opponent'] = None
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'snapshot.csv'
            refresh.export_csv(output, snapshot)
            with output.open(newline='') as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]['your_team'], 'Name, "quoted"\n♥')
            self.assertEqual(rows[0]['your_points'], '-1.025')
            self.assertEqual(rows[0]['opponent_points'], '')
            self.assertEqual(json.loads(rows[0]['starters']), ['receiver', 'runner'])

    def test_cli_uses_archived_settings_and_returns_nonzero_for_comparison_differences(self):
        self.source.matchup.side_effect = None
        self.source.matchup.return_value = matchup(123.46)
        with tempfile.TemporaryDirectory() as directory, patch.object(refresh, 'credentials', return_value=('https://example.supabase.co', 'secret')), \
                patch.object(refresh, 'FantasyWeekStore', return_value=self.store), \
                patch.object(refresh, 'SleeperSource', return_value=self.source), \
                patch.object(refresh, 'FantasyStore') as live, patch('builtins.print'):
            status = refresh.main(['--season', '2026', '--week', '5', '--verify-rebuild', '--output-dir', directory])
            self.assertEqual(status, 2)
            live.assert_not_called()
            self.source.state.assert_not_called()


if __name__ == '__main__':
    unittest.main()
