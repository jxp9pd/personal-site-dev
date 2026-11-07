import json
import unittest
from unittest.mock import Mock

from board import text_row
from sports import ESPNSource, normalize_game
from test_helpers import AppTestCase, Response, event, game, nba_event, nba_game


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
        source = ESPNSource('nfl', opener)
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
                source = ESPNSource('nfl', Mock(return_value=Response(json.dumps(data).encode())))
                with self.assertRaises((ValueError, KeyError, TypeError)):
                    source.games()


class NBASourceTest(unittest.TestCase):
    def source(self, events):
        opener = Mock(return_value=Response(json.dumps({'events': events}).encode()))
        return ESPNSource('nba', opener)

    def test_filters_to_either_streaming_service_without_filtering_nfl(self):
        for names, expected in ((['Prime Video'], ['Prime Video']),
                                (['Peacock'], ['Peacock']),
                                (['PEACOCK', 'Prime Video', 'Peacock'], ['Peacock', 'Prime Video']),
                                (['ESPN', 'ABC', 'NBA TV', 'NBC Sports CA', 'NBA League Pass'], []),
                                ([], [])):
            with self.subTest(names=names):
                data = nba_event()
                data['competitions'][0]['broadcasts'][0]['names'] = names
                games = self.source([data]).games()
                self.assertEqual([game['broadcasts'] for game in games], [expected] if expected else [])
        self.assertEqual(len(ESPNSource('nfl', Mock(return_value=Response(
            json.dumps({'events': [event()]}).encode()))).games()), 1)

    def test_accepts_us_national_geo_broadcasts_and_ignores_other_regions(self):
        for region, market, expected in (('us', 'National', 1), ('ca', 'National', 0), ('us', 'Home', 0)):
            with self.subTest(region=region, market=market):
                data = nba_event()
                competition = data['competitions'][0]
                del competition['broadcasts']
                competition['geoBroadcasts'] = [{
                    'region': region, 'market': {'type': market},
                    'media': {'shortName': 'Peacock'}}]
                self.assertEqual(len(self.source([data]).games()), expected)

    def test_missing_broadcasts_are_excluded_and_malformed_eligible_scores_are_rejected(self):
        for names in (None, [], ['ESPN']):
            with self.subTest(names=names):
                data = nba_event(away_score='bad')
                competition = data['competitions'][0]
                if names is None:
                    del competition['broadcasts']
                else:
                    competition['broadcasts'][0]['names'] = names
                self.assertEqual(self.source([data, nba_event()]).games(), [nba_game()])
        with self.assertRaises(ValueError):
            self.source([nba_event(away_score='bad')]).games()

    def test_uses_nba_endpoint_and_keeps_three_digit_scores_and_four_letter_teams_in_grid(self):
        source = self.source([nba_event()])
        game = source.games('20261012')[0]
        self.assertEqual(source.opener.call_args.args[0].full_url,
                         'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261012')
        self.assertEqual(game['away']['abbreviation'], 'UTAH')
        self.assertEqual(game['away']['colors'], [68, 67])
        self.assertEqual(game['home']['colors'], [68, 65])
        self.assertTrue(all(len(row) == 15 for row in game['characters']))
        self.assertEqual(game['characters'][1], text_row('112', 7) + [0] + text_row('108', 7))
        self.assertIsNone(game['possession'])
        self.assertEqual(game['characters'][2], [0] * 15)


class NBATest(AppTestCase):
    def test_follows_game_across_day_rollover_then_stops_after_final(self):
        self.app = self.nba
        self.assertEqual(self.start_app(self.nba)[0], 200)
        self.nba.tick()
        self.assertEqual(self.frames, [nba_game()['characters']])
        self.nba_fetch.side_effect = [[], [nba_game(away_score='120')], [],
                                      [nba_game(state='final', away_score='125')]]
        self.tick_at(180)
        self.assertEqual(self.nba_fetch.call_args.args, ('20261012',))
        self.assertEqual(self.nba.status()['game']['away']['score'], 120)
        self.assertEqual(self.nba.status()['games'], [])
        self.tick_at(360)
        self.assertEqual(self.nba.status()['state'], 'completed')
        self.assertEqual(self.frames[-1][2], text_row('FINAL'))
        self.nba_fetch.reset_mock()
        self.tick_at(1000)
        self.nba_fetch.assert_not_called()


class NFLTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.app = self.nfl

    def track(self):
        return self.app.command({'action': 'track', 'gameId': '401000001'})

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

    def test_controls_reject_invalid_ids_and_ended_games(self):
        for body in ({'action': 'track', 'gameId': 401000001},
                     {'action': 'track', 'gameId': 'https://example.com'}):
            self.assertEqual(self.app.command(body)[0], 400)
        self.assertEqual(self.app.command({'action': 'track', 'gameId': '999'})[0], 409)
        self.app.games = [game(state='final')]
        self.assertEqual(self.track()[0], 409)


if __name__ == '__main__':
    unittest.main()
