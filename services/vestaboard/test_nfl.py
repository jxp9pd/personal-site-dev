import json
import threading
import unittest
from unittest.mock import Mock

from board import text_row
from nfl import NFL, NFLSource, normalize_game
from test_helpers import Response


def event(state='live', away_score='21', home_score='17', possession='25'):
    status = {'scheduled': ('STATUS_SCHEDULED', 'pre', False),
              'live': ('STATUS_IN_PROGRESS', 'in', False),
              'final': ('STATUS_FINAL', 'post', True),
              'halftime': ('STATUS_HALFTIME', 'in', False),
              'delayed': ('STATUS_DELAYED', 'pre', False)}[state]
    return {'id': '401000001', 'date': '2026-10-13T00:15Z',
            'status': {'type': dict(zip(('name', 'state', 'completed'), status))},
            'competitions': [{'competitors': [
                {'homeAway': 'home', 'score': home_score, 'team': {
                    'id': '26', 'abbreviation': 'SEA', 'displayName': 'Seattle Seahawks'}},
                {'homeAway': 'away', 'score': away_score, 'team': {
                    'id': '25', 'abbreviation': 'SF', 'displayName': 'San Francisco 49ers'}}],
                'situation': {'possession': possession}}]}


def game(**kwargs):
    return normalize_game(event(**kwargs))


class SourceTest(unittest.TestCase):
    def test_normalizes_away_home_colors_scores_and_possession_into_exact_grid(self):
        data = game()
        frame = data['characters']
        self.assertEqual(frame[0], [63, 0, 19, 6, 0, 65, 0, 0, 67, 0, 19, 5, 1, 0, 66])
        self.assertEqual(frame[1], text_row('21', 7) + [0] + text_row('17', 7))
        self.assertEqual(frame[2], [0, 0, 0, 64] + [0] * 11)
        self.assertEqual(game(possession='26')['characters'][2][11], 64)
        self.assertEqual(game(possession='unknown')['characters'][2], [0] * 15)
        self.assertEqual(game(possession=None)['characters'][2], [0] * 15)

    def test_scheduled_game_uses_pacific_kickoff_and_eastern_date_filter_for_mnf(self):
        data = game(state='scheduled')
        self.assertEqual(data['dateKey'], '20261012')
        self.assertEqual(data['characters'][1], text_row('--', 7) + [0] + text_row('--', 7))
        self.assertEqual(data['characters'][2], text_row('MON 5:15PM'))
        self.assertIsNone(data['possession'])

    def test_special_statuses_never_show_a_stale_possession_indicator(self):
        for state in ('final', 'halftime', 'delayed'):
            with self.subTest(state=state):
                data = game(state=state)
                self.assertEqual(data['characters'][2], text_row(state.upper()))
                self.assertIsNone(data['possession'])
                self.assertEqual(data['terminal'], state == 'final')

    def test_canceled_game_without_scores_displays_status_and_ends_tracking(self):
        data = event(state='scheduled')
        data['status']['type']['name'] = 'STATUS_CANCELLED'
        for team in data['competitions'][0]['competitors']:
            del team['score']
        result = normalize_game(data)
        self.assertTrue(result['terminal'])
        self.assertIsNone(result['away']['score'])
        self.assertEqual(result['characters'][2], text_row('CANCELED'))

    def test_source_uses_fixed_public_endpoint_without_board_credentials(self):
        opener = Mock(return_value=Response(json.dumps({'events': [event()]}).encode()))
        source = NFLSource(opener)
        self.assertEqual(source.games('20261012')[0]['id'], '401000001')
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261012')
        self.assertNotIn('X-vestaboard-token', request.headers)
        with self.assertRaises(ValueError):
            source.games('https://example.com')
        opener.assert_called_once()

    def test_malformed_feed_is_rejected_instead_of_displaying_invented_scores(self):
        for data in ({}, {'events': None}, {'events': [event(away_score='bad')]},
                     {'events': [event(home_score='-1')]}, {'events': [event(home_score=1.5)]}):
            with self.subTest(data=data):
                source = NFLSource(Mock(return_value=Response(json.dumps(data).encode())))
                with self.assertRaises((ValueError, KeyError, TypeError)):
                    source.games()


class NFLTest(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.gateway = Mock(token='test-token')
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.return_value = (200, {'accepted': True})
        self.fetch = Mock(return_value=[game()])
        self.app = NFL(self.gateway, self.fetch, lambda: self.now, lambda: 1_791_850_000 + self.now)
        self.app.status()
        self.app.tick()  # Load the picker, without starting board writes.

    @property
    def frames(self):
        return [call.args[0] for call in self.gateway.send.call_args_list]

    def track(self):
        return self.app.command({'action': 'track', 'gameId': '401000001'})

    def tick_at(self, now):
        self.now = now
        self.app.tick()

    def test_track_queues_without_writing_then_polls_every_three_minutes_for_changed_frames(self):
        self.assertEqual(self.app.status()['state'], 'idle')
        self.assertEqual(self.frames, [])
        status, snapshot = self.track()
        self.assertEqual(status, 200)
        self.assertEqual(snapshot['state'], 'tracking')
        self.assertEqual(snapshot['delivery']['status'], 'pending')
        self.assertEqual(self.frames, [])
        self.app.tick()
        self.assertEqual(self.frames, [game()['characters']])
        self.assertEqual(self.app.status()['delivery']['status'], 'accepted')

        self.tick_at(179)
        self.fetch.assert_called_once()
        self.tick_at(180)
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(len(self.frames), 1)
        self.fetch.return_value = [game(possession='26')]
        self.tick_at(360)
        self.assertEqual(self.frames[-1][2][11], 64)
        self.fetch.return_value = [game(away_score='28', possession='26')]
        self.tick_at(540)
        self.assertEqual(self.frames[-1][1], text_row('28', 7) + [0] + text_row('17', 7))
        self.assertEqual(len(self.frames), 3)

    def test_upcoming_game_transitions_to_live_then_sends_final_once_and_ends(self):
        self.fetch.return_value = [game(state='scheduled')]
        self.now = 180
        self.app.status()
        self.app.tick()
        self.track()
        self.app.tick()
        self.assertEqual(self.frames[-1][2], text_row('MON 5:15PM'))
        self.fetch.return_value = [game()]
        self.tick_at(360)
        self.assertEqual(self.frames[-1][2][3], 64)
        self.fetch.return_value = [game(state='final')]
        self.tick_at(540)
        self.assertEqual(self.app.state, 'completed')
        self.assertEqual(self.frames[-1][2], text_row('FINAL'))
        count = self.fetch.call_count
        self.tick_at(10000)
        self.assertEqual(self.fetch.call_count, count)
        self.assertEqual(len(self.frames), 3)

    def test_stop_cancels_a_queued_frame_and_all_future_tracking_polls(self):
        self.track()
        self.gateway.status.return_value = {'retryAfter': 15}
        self.app.tick()
        self.assertEqual(self.app.command({'action': 'stop'})[0], 200)
        self.gateway.status.return_value = {'retryAfter': 0}
        self.tick_at(10000)
        self.assertEqual(self.frames, [])
        self.fetch.assert_called_once()
        self.assertEqual(self.app.state, 'stopped')
        self.assertEqual(self.app.command({'action': 'stop'})[0], 409)

    def test_final_delivery_waits_for_shared_cooldown_even_after_tracking_ends(self):
        self.track()
        self.app.tick()
        self.gateway.status.return_value = {'retryAfter': 10}
        self.fetch.return_value = [game(state='final')]
        self.tick_at(180)
        self.assertEqual(self.app.state, 'completed')
        self.assertEqual(self.app.status()['delivery']['status'], 'pending')
        self.assertEqual(len(self.frames), 1)
        self.gateway.status.return_value = {'retryAfter': 0}
        self.tick_at(190)
        self.assertEqual(self.frames[-1][2], text_row('FINAL'))
        self.tick_at(1000)
        self.assertEqual(len(self.frames), 2)

    def test_feed_failure_keeps_last_score_and_recovers_without_duplicate_writes(self):
        self.track()
        self.app.tick()
        self.fetch.side_effect = OSError('private upstream diagnostics')
        self.tick_at(180)
        snapshot = self.app.status()
        self.assertIn('unavailable', snapshot['source']['error'])
        self.assertNotIn('private', json.dumps(snapshot))
        self.assertEqual(snapshot['game']['away']['score'], 21)
        self.assertEqual(len(self.frames), 1)
        self.tick_at(209)
        self.assertEqual(self.fetch.call_count, 2)
        self.fetch.side_effect = None
        self.fetch.return_value = [game(away_score='28')]
        self.tick_at(210)
        self.assertIsNone(self.app.status()['source']['error'])
        self.assertEqual(len(self.frames), 2)

    def test_ambiguous_cloud_failure_is_not_retried_for_unchanged_frame(self):
        self.track()
        self.gateway.send.return_value = (504, {'error': 'Delivery unconfirmed.'})
        self.app.tick()
        self.tick_at(180)
        self.tick_at(360)
        self.assertEqual(len(self.frames), 1)
        self.assertEqual(self.app.status()['delivery']['status'], 'error')
        self.fetch.return_value = [game(possession='26')]
        self.gateway.send.return_value = (200, {'accepted': True})
        self.tick_at(540)
        self.assertEqual(len(self.frames), 2)

    def test_rate_limited_sends_coalesce_to_the_latest_frame(self):
        self.track()
        self.gateway.send.return_value = (429, {'retryAfter': 600})
        self.app.tick()
        self.gateway.status.return_value = {'retryAfter': 600}
        self.fetch.return_value = [game(away_score='28')]
        self.tick_at(180)
        self.fetch.return_value = [game(away_score='35')]
        self.tick_at(360)
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.return_value = (200, {'accepted': True})
        self.tick_at(600)
        self.assertEqual(self.frames[-1], game(away_score='35')['characters'])
        self.assertEqual(len(self.frames), 2)

    def test_week_rollover_updates_picker_and_follows_selected_game_by_day_until_final(self):
        self.track()
        self.app.tick()
        next_week = game(state='scheduled')
        next_week['id'] = '401000002'
        next_week['startsAt'] = '2026-10-18T20:25:00+00:00'
        self.fetch.side_effect = [[next_week], [game()], [], [game(state='final')]]
        self.tick_at(180)
        snapshot = self.app.status()
        self.assertEqual([item['id'] for item in snapshot['games']], ['401000002'])
        self.assertEqual(snapshot['game']['id'], '401000001')
        self.assertEqual(snapshot['state'], 'tracking')
        self.tick_at(360)
        self.assertEqual(self.fetch.call_args.args, ('20261012',))
        snapshot = self.app.status()
        self.assertEqual(snapshot['state'], 'completed')
        self.assertEqual(snapshot['games'], [])
        self.assertEqual(snapshot['game']['id'], '401000001')
        self.assertEqual(self.frames[-1][2], text_row('FINAL'))

    def test_idle_schedule_refreshes_on_visits_after_the_cache_expires(self):
        next_week = game(state='scheduled')
        next_week['id'] = '401000002'
        self.fetch.return_value = [next_week]
        self.tick_at(180)
        self.fetch.assert_called_once()  # Idle without a visitor does not poll.
        self.app.status()
        self.app.tick()
        self.assertEqual(self.app.status()['games'][0]['id'], '401000002')
        self.assertEqual(self.frames, [])

    def test_stop_during_a_feed_request_cannot_resume_tracking_or_send_old_data(self):
        self.track()
        def fetch(*args):
            self.app.command({'action': 'stop'})
            return [game(away_score='28')]
        self.fetch.side_effect = fetch
        self.tick_at(180)
        self.assertEqual(self.app.state, 'stopped')
        self.assertEqual(self.frames, [])

    def test_track_during_a_picker_refresh_uses_fresh_scores_from_that_request(self):
        def fetch(*args):
            self.track()
            return [game(away_score='28')]
        self.fetch.side_effect = fetch
        self.now = 180
        self.app.status()
        self.app.tick()
        self.assertEqual(self.app.game['away']['score'], 28)
        self.assertEqual(self.frames, [game(away_score='28')['characters']])

    def test_controls_reject_invalid_ids_ended_games_and_unconfigured_board(self):
        for body in ([], None, {}, {'action': 'pause'}, {'action': 'track', 'gameId': 401000001},
                     {'action': 'track', 'gameId': 'https://example.com'}):
            self.assertEqual(self.app.command(body)[0], 400)
        self.assertEqual(self.app.command({'action': 'track', 'gameId': '999'})[0], 409)
        self.gateway.token = ''
        self.assertEqual(self.track()[0], 503)
        self.assertEqual(self.frames, [])
        self.gateway.token = 'test-token'
        self.app.games = [game(state='final')]
        self.assertEqual(self.track()[0], 409)

    def test_background_worker_tracks_without_browser_status_requests(self):
        sent = threading.Event()
        self.gateway.send.side_effect = lambda frame: (sent.set() or (200, {'accepted': True}))
        self.track()
        self.app.start_worker()
        try:
            self.assertTrue(sent.wait(2))
        finally:
            self.app.close()
        self.assertFalse(self.app.worker.is_alive())


if __name__ == '__main__':
    unittest.main()
