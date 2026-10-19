from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


path = Path(__file__).resolve().parents[2] / 'scripts' / 'weekly-fantasy-refresh.py'
spec = importlib.util.spec_from_file_location('weekly_fantasy_refresh', path)
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)


class WeeklyFantasyCronTest(unittest.TestCase):
    def test_cron_runs_once_at_six_pacific_in_summer_and_winter(self):
        for month, day, expected_hour in ((10, 21, 13), (11, 4, 14)):
            with self.subTest(month=month):
                selected = [hour for hour in (13, 14) if weekly.scheduled_time(
                    datetime(2026, month, day, hour, tzinfo=timezone.utc))]
                self.assertEqual(selected, [expected_hour])
        self.assertFalse(weekly.scheduled_time(datetime(2026, 10, 22, 13, tzinfo=timezone.utc)))

    def test_completed_week_handles_rollover_and_the_last_regular_season_week(self):
        self.assertEqual(weekly.completed_week({'season': '2026', 'week': 7, 'season_type': 'regular'}), ('2026', 6))
        self.assertEqual(weekly.completed_week({'season': '2026', 'week': 1, 'season_type': 'post'}), ('2026', 18))
        for state in ({'season': '2027', 'week': 0, 'season_type': 'pre'},
                      {'season': '2027', 'week': 1, 'season_type': 'regular'},
                      {'season': '2026', 'week': 2, 'season_type': 'post'}):
            with self.subTest(state=state):
                self.assertIsNone(weekly.completed_week(state))

    def test_invalid_active_season_state_does_not_select_a_week(self):
        for state in (None, {'season': 'bad', 'week': 7, 'season_type': 'regular'},
                      {'season': '2026', 'week': 19, 'season_type': 'regular'},
                      {'season': '2026', 'week': True, 'season_type': 'regular'}):
            with self.subTest(state=state), self.assertRaises(ValueError):
                weekly.completed_week(state)

    def test_dry_run_and_inactive_season_never_launch_a_refresh(self):
        for state, extra in (({'season': '2026', 'week': 7, 'season_type': 'regular'}, ['--dry-run']),
                             ({'season': '2027', 'week': 1, 'season_type': 'regular'}, [])):
            with self.subTest(state=state), patch.object(weekly, 'read_state', return_value=state), \
                    patch.object(weekly.subprocess, 'run') as run, patch('builtins.print'):
                self.assertEqual(weekly.main(['--refresh-script', '/missing/refresh.py',
                                              '--env-file', '/missing/settings.env'] + extra), 0)
                run.assert_not_called()

    def test_refresh_uses_the_existing_script_with_an_explicit_completed_week(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script, env = root / 'refresh.py', root / 'private.env'
            script.touch()
            env.touch()
            with patch.object(weekly, 'read_state', return_value={'season': '2026', 'week': 7, 'season_type': 'regular'}), \
                    patch.object(weekly.subprocess, 'run', return_value=Mock(returncode=1)) as run, patch('builtins.print'):
                self.assertEqual(weekly.main(['--refresh-script', str(script), '--env-file', str(env),
                                              '--output-root', str(root / 'runs')]), 1)
                command = run.call_args.args[0]
                self.assertEqual(command[:8], [weekly.sys.executable, str(script), '--env-file', str(env),
                                                '--season', '2026', '--week', '6'])
                self.assertEqual(command[8], '--output-dir')
                self.assertEqual(Path(command[9]).parent, root / 'runs' / '2026-week-06')
                self.assertNotIn('--verify-rebuild', command)


if __name__ == '__main__':
    unittest.main()
