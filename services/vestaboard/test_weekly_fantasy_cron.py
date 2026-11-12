import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_helpers import Response


path = Path(__file__).resolve().parents[2] / 'scripts' / 'weekly-fantasy-refresh.py'
spec = importlib.util.spec_from_file_location('weekly_fantasy_refresh', path)
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)


class WeeklyFantasyCronTest(unittest.TestCase):
    def test_state_is_read_through_the_shared_sleeper_client_with_a_size_limit(self):
        requests = []
        def opener(body):
            def respond(request, timeout):
                requests.append((request, timeout))
                return Response(body)
            return respond
        state = {'season': '2026', 'week': 1, 'season_type': 'post'}
        self.assertEqual(weekly.read_state(weekly.SleeperSource(opener(json.dumps(state).encode()))), state)
        self.assertEqual(requests[0][0].full_url, 'https://api.sleeper.app/v1/state/nfl')
        self.assertEqual(requests[0][0].get_header('User-agent'), 'PentaProjects-Fantasy/1.0')
        with self.assertRaises(ValueError):
            weekly.read_state(weekly.SleeperSource(opener(b' ' * 65537)))

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
