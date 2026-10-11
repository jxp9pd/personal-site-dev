import copy
import json
import unittest

from board import text_row, valid_characters
from fantasy import (ALERT_SECONDS, DEFAULT_LEAGUES, SleeperSource, SourceError,
                     league_settings, play_alert, rounded_score, score_frame)
from test_helpers import AppTestCase, Response, STATE, matchup, play, player


class EncodingTest(unittest.TestCase):
    def test_league_urls_are_ids_not_arbitrary_fetch_destinations(self):
        configs = league_settings(DEFAULT_LEAGUES)
        self.assertEqual(configs[0]['leagueId'], '1399168246661296128')
        for url in ('https://evil.example/leagues/123', 'http://sleeper.com/leagues/123',
                    'https://sleeper.com@evil.example/leagues/123',
                    'https://sleeper.com:443/leagues/123', 'https://sleeper.com/leagues/123/../../secret'):
            bad = copy.deepcopy(DEFAULT_LEAGUES)
            bad[0]['url'] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                league_settings(bad)
        allowed = copy.deepcopy(DEFAULT_LEAGUES)
        allowed[0]['url'] = 'https://sleeper.app/leagues/123/matchup?week=5#scores'
        self.assertEqual(league_settings(allowed)[0]['url'], 'https://sleeper.com/leagues/123')

    def test_short_labels_and_usernames_are_validated(self):
        for key, value in [('username', '../../secret'), ('username', '@pentakalos'),
                           ('label', 'FOUR'), ('label', '♥'), ('label', 'SH')]:
            bad = copy.deepcopy(DEFAULT_LEAGUES)
            bad[0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                league_settings(bad)

    def test_rounding_byes_and_absent_probabilities(self):
        configs = league_settings(DEFAULT_LEAGUES)
        games = [matchup(), matchup(98.6)]
        frame = score_frame(configs, games, 5)
        self.assertEqual(frame[0], text_row('TD 123 - 119'))
        self.assertEqual(frame[1], text_row('SH 99 - 119'))
        self.assertEqual(frame[2], [0] * 15)
        self.assertEqual(rounded_score(-1.5), '-2')
        games[1]['opponent'] = None
        self.assertEqual(score_frame(configs, games, 5)[1], text_row('SH 99 - BYE'))
        self.assertTrue(valid_characters(frame))

    def test_sleeper_big_play_boundaries_and_touchdowns(self):
        for kind, threshold in [('Rush', 15), ('PassCompleted', 20)]:
            self.assertIsNone(play_alert(play(kind=kind, yards=threshold - 1), {'receiver'}, player))
            self.assertIsNotNone(play_alert(play(kind=kind, yards=threshold), {'receiver'}, player))
        alert = play_alert(play(yards=2, td=True), {'receiver'}, player)
        self.assertEqual(alert['detail'], '2YD TD')
        self.assertEqual(alert['characters'][1], text_row('CEEDEE LAMB'))
        self.assertTrue(valid_characters(alert['characters']))

    def test_bench_players_opponents_and_tacklers_do_not_alert(self):
        event = play()
        self.assertIsNone(play_alert(event, {'bench'}, player))
        event['play_stats'].append({'player_id': 'defender', 'stats': {'idp_tkl': 1}})
        self.assertIsNone(play_alert(event, {'defender'}, player))
        event['metadata']['type'] = 'FieldGoal'
        event['metadata']['yards_gained'] = 55
        self.assertIsNone(play_alert(event, {'receiver'}, player))

    def test_one_play_can_name_two_starters_without_duplicate_alerts(self):
        event = play(td=True)
        event['play_stats'].append({'player_id': 'qb', 'stats': {'pass_yd': 24, 'pass_td': 1}})
        alert = play_alert(event, {'receiver', 'qb'}, player)
        self.assertEqual(alert['players'], ['CeeDee Lamb', 'Dak Prescott'])
        self.assertEqual(alert['characters'][1], text_row('LAMB / PRESCOTT'))


class SourceTest(unittest.TestCase):
    def setUp(self):
        self.now, self.requests = 0, []
        self.data = {'v1/state/nfl': STATE, 'v1/user/pentakalos': {'user_id': 'me'},
                     'v1/league/123': {'sport': 'nfl', 'season': '2026', 'name': 'League'},
                     'v1/league/123/users': [{'user_id': 'me', 'display_name': 'pentakalos',
                                            'metadata': {'team_name': 'Bite me'}},
                                           {'user_id': 'other', 'display_name': 'Opponent'}],
                     'v1/league/123/rosters': [{'owner_id': 'me', 'roster_id': 1}, {'owner_id': 'other', 'roster_id': 2}],
                     'v1/league/123/matchups/5': [
                         {'roster_id': 1, 'matchup_id': 2, 'points': 123.45, 'custom_points': None,
                          'starters': ['receiver', '0'], 'players': ['receiver', 'bench']},
                         {'roster_id': 2, 'matchup_id': 2, 'points': 119.4}],
                     'v1/players/nfl': {'receiver': {'full_name': 'CeeDee Lamb', 'last_name': 'Lamb'}}}
        def opener(request, timeout):
            self.requests.append(request.full_url)
            path = request.full_url.removeprefix('https://api.sleeper.app/')
            return Response(json.dumps(self.data[path]).encode())
        self.source = SleeperSource(opener, lambda: self.now)
        self.config = {'leagueId': '123', 'username': 'pentakalos', 'label': 'TD'}

    def test_matchup_uses_owner_and_starters_and_preserves_sleeper_scores(self):
        result = self.source.matchup(self.config, self.source.state())
        self.assertEqual(result['you']['name'], 'Bite me')
        self.assertEqual(result['you']['points'], 123.45)
        self.assertEqual(result['opponent']['name'], 'Opponent')
        self.assertEqual(result['starters'], ['receiver'])
        self.assertIsNone(result['winChance'])
        self.data['v1/league/123/matchups/5'][0]['custom_points'] = 0
        self.assertEqual(self.source.matchup(self.config, STATE)['you']['points'], 0)

    def test_scores_refresh_but_catalog_downloads_once_daily(self):
        self.source.matchup(self.config, STATE)
        self.data['v1/league/123/matchups/5'][0]['points'] = 130.1
        self.assertEqual(self.source.matchup(self.config, STATE)['you']['points'], 130.1)
        self.assertEqual(sum(url.endswith('/users') for url in self.requests), 1)
        self.source.player('receiver')
        self.source.player('receiver')
        self.assertEqual(sum(url.endswith('/players/nfl') for url in self.requests), 1)

    def test_wrong_owner_season_and_nonfinite_scores_are_rejected(self):
        self.data['v1/user/pentakalos'] = {'user_id': 'outsider'}
        with self.assertRaisesRegex(SourceError, 'no team'):
            self.source.matchup(self.config, STATE)
        self.source.cache.clear()
        self.data['v1/user/pentakalos'] = {'user_id': 'me'}
        self.data['v1/league/123']['season'] = '2025'
        with self.assertRaisesRegex(SourceError, 'current season'):
            self.source.matchup(self.config, STATE)
        self.source.cache.clear()
        self.data['v1/league/123']['season'] = '2026'
        self.data['v1/league/123/matchups/5'][0]['points'] = float('nan')
        with self.assertRaisesRegex(SourceError, 'invalid score'):
            self.source.matchup(self.config, STATE)

    def test_co_owner_and_bye_are_supported(self):
        self.data['v1/league/123/rosters'][0]['owner_id'] = 'primary'
        self.data['v1/league/123/rosters'][0]['co_owners'] = ['me']
        self.data['v1/league/123/matchups/5'][0]['matchup_id'] = None
        result = self.source.matchup(self.config, STATE)
        self.assertIsNone(result['opponent'])

    def test_undocumented_play_feed_shape_and_query(self):
        self.data['plays/nfl/recent?season_type=regular&season=2026&week=5&limit=1000'] = [play()]
        self.assertEqual(self.source.plays(STATE)[0]['play_id'], 'one')


class SessionTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.app = self.session = self.fantasy

    def start(self):
        self.assertEqual(self.session.command({'action': 'start', 'leagues': DEFAULT_LEAGUES})[0], 200)
        self.session.tick()

    def test_opening_or_previewing_without_a_token_never_sends(self):
        self.gateway.token = ''
        self.session.status()
        self.session.tick()
        self.assertIsNotNone(self.session.status()['leagues'][0]['matchup'])
        self.session.command({'action': 'preview', 'leagues': DEFAULT_LEAGUES})
        self.session.tick()
        self.gateway.send.assert_not_called()
        self.source.plays.assert_not_called()

    def test_changed_scores_only_and_background_polling_without_browser(self):
        self.start()
        for now in (1, 15, 30):
            self.tick_at(now)
        self.gateway.send.assert_called_once()
        self.source.matchup.return_value = matchup(124.6)
        self.tick_at(45)
        self.assertEqual(self.gateway.send.call_count, 2)
        self.assertEqual(self.gateway.send.call_args.args[0][0], text_row('TD 125 - 119'))

    def test_alerts_queue_chronologically_and_hold_thirty_seconds_each(self):
        self.start()
        self.source.plays.return_value = [play('second', 1010), play('first', 1001)]
        self.tick_at(15)
        self.assertEqual(self.session.status()['alert']['id'], 'first')
        self.assertEqual(self.session.status()['queuedAlerts'], 1)
        self.tick_at(44)
        self.assertEqual(self.session.status()['alert']['id'], 'first')
        self.tick_at(45)
        self.assertEqual(self.session.status()['alert']['id'], 'second')
        self.tick_at(75)
        self.assertIsNone(self.session.status()['alert'])
        self.assertEqual(self.gateway.send.call_count, 4)  # scores, two identical-looking alerts, scores
        self.assertEqual(self.session.status()['characters'][0], text_row('TD 123 - 119'))

    def test_shared_cooldown_delays_alert_without_shortening_its_hold(self):
        self.start()
        self.gateway.status.return_value = {'retryAfter': 1}
        self.source.plays.return_value = [play()]
        self.tick_at(15)
        self.assertIsNone(self.session.status()['alertSecondsRemaining'])
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.return_value = (429, {'retryAfter': 15})
        self.tick_at(25)
        self.assertEqual(self.session.status()['delivery']['status'], 'pending')
        self.assertIsNone(self.session.status()['alertSecondsRemaining'])
        self.gateway.send.return_value = (504, {'error': 'May have sent.'})
        self.tick_at(26)
        attempts = self.gateway.send.call_count
        self.assertEqual(self.session.status()['alertSecondsRemaining'], ALERT_SECONDS)
        self.assertEqual(self.session.status()['delivery']['status'], 'error')
        self.tick_at(55)
        self.assertIsNotNone(self.session.status()['alert'])
        self.assertEqual(self.gateway.send.call_count, attempts)
        self.gateway.send.return_value = (200, {'accepted': True})
        self.tick_at(56)
        self.assertIsNone(self.session.status()['alert'])
        self.assertEqual(self.gateway.send.call_count, attempts + 1)

    def test_historical_events_duplicates_and_other_players_do_not_alert(self):
        self.source.plays.return_value = [play('old', 999), play('other', player_id='bench')]
        self.start()
        self.tick_at(15)
        self.assertIsNone(self.session.status()['alert'])
        self.gateway.send.assert_called_once()

    def test_outage_retains_scores_and_recovers_without_losing_new_plays(self):
        self.start()
        self.source.matchup.side_effect = SourceError('Temporary outage.')
        self.source.plays.return_value = [play()]
        self.tick_at(15)
        self.assertEqual(self.session.status()['leagues'][0]['matchup']['you']['points'], 123.45)
        self.assertIsNone(self.session.status()['alert'])
        self.source.matchup.side_effect = None
        self.tick_at(30)
        self.assertEqual(self.session.status()['alert']['id'], 'one')
        self.assertIsNone(self.session.status()['leagues'][0]['error'])

    def test_stop_clears_current_alert_and_pending_queue(self):
        self.start()
        self.source.plays.return_value = [play('one'), play('two', 1002)]
        self.tick_at(15)
        attempts = self.gateway.send.call_count
        self.session.command({'action': 'stop'})
        self.tick_at(100)
        self.assertEqual(self.gateway.send.call_count, attempts)
        self.assertIsNone(self.session.status()['alert'])
        self.assertEqual(self.session.status()['queuedAlerts'], 0)

    def test_rollover_discards_last_weeks_alerts_and_scores(self):
        self.start()
        self.source.plays.return_value = [play('one'), play('two', 1002)]
        self.tick_at(15)
        self.source.state.return_value = dict(STATE, week=6)
        self.source.matchup.return_value = dict(matchup(0), week=6)
        self.source.plays.return_value = []
        self.tick_at(30)
        self.assertIsNone(self.session.status()['alert'])
        self.assertEqual(self.session.status()['queuedAlerts'], 0)
        self.assertEqual(self.session.status()['week'], 6)


if __name__ == '__main__':
    unittest.main()
