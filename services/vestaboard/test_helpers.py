"""Fresh sports fixtures and a shared fake-clock app fixture; no live I/O."""
from contextlib import contextmanager
import io
import threading
import unittest
from unittest.mock import Mock

from apps import BoardController
from fantasy import DEFAULT_LEAGUES, Fantasy
from nfl import NFL, normalize_game
from pomodoro import Pomodoro


def message():
    return [[1] + [0] * 14, [0] * 15, [0] * 15]


class Response(io.BytesIO):
    status = 200


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


STATE = {'week': 5, 'season': '2026', 'season_type': 'regular'}


def matchup(points=123.45, starters=None):
    return {'week': 5, 'season': '2026', 'leagueName': 'League',
            'you': {'rosterId': 1, 'name': 'Your team', 'points': points},
            'opponent': {'rosterId': 2, 'name': 'Their team', 'points': 119.4},
            'starters': starters or ['receiver', 'runner'], 'winChance': None}


def play(play_id='one', timestamp=1001, yards=30, kind='PassCompleted', td=False, player_id='receiver'):
    stats = {'rec': 1, 'rec_yd': yards, 'rec_td': int(td)} if kind == 'PassCompleted' else {
        'rush_att': 1, 'rush_yd': yards, 'rush_td': int(td)}
    return {'play_id': play_id, 'game_id': 'game', 'time': timestamp * 1000,
            'metadata': {'type': kind, 'yards_gained': yards, 'is_scoring_play': td,
                         'description': 'TOUCHDOWN.' if td else 'A long play.', 'fantasy_description': 'Play detail'},
            'play_stats': [{'player_id': player_id, 'stats': stats}]}


def player(player_id):
    return {'name': {'receiver': 'CeeDee Lamb', 'runner': 'Bucky Irving', 'qb': 'Dak Prescott'}.get(player_id, player_id),
            'lastName': {'receiver': 'Lamb', 'runner': 'Irving', 'qb': 'Prescott'}.get(player_id, player_id)}


class AppTestCase(unittest.TestCase):
    def setUp(self):
        self.now, self.wall = 0, 1000
        self.gateway = self.make_gateway()
        self.controller = BoardController(self.gateway)
        self.choose = Mock(return_value='YOU GOT THIS')
        self.timer = Pomodoro(self.controller, lambda: self.now, self.choose)
        self.fetch = Mock(return_value=[game()])
        self.nfl = NFL(self.controller, self.fetch, lambda: self.now, lambda: 1_791_850_000 + self.now)
        self.source = Mock()
        self.source.state.return_value = STATE.copy()
        self.source.matchup.return_value = matchup()
        self.source.plays.return_value = []
        self.source.player.side_effect = player
        self.fantasy = Fantasy(self.controller, self.source, lambda: self.now, lambda: self.wall)
        self.nfl.status()
        self.nfl.tick()  # Populate the picker without scheduling board writes.
        self.apps = (self.timer, self.nfl, self.fantasy)
        self.start_commands = {
            self.timer: {'action': 'start', 'focusMinutes': 25, 'breakMinutes': 5},
            self.nfl: {'action': 'track', 'gameId': '401000001'},
            self.fantasy: {'action': 'start', 'leagues': DEFAULT_LEAGUES},
        }

    def make_gateway(self):
        gateway = Mock(token='test-token')
        gateway.status.return_value = {'retryAfter': 0}
        gateway.send.return_value = (200, {'accepted': True})
        return gateway

    @property
    def frames(self):
        return [call.args[0] for call in self.gateway.send.call_args_list]

    def start_app(self, app):
        return app.command(self.start_commands[app])

    def tick_at(self, now):
        self.now, self.wall = now, 1000 + now
        self.app.tick()


@contextmanager
def background_task(target):
    """Join race-test threads and surface their exceptions in the main test."""
    errors = []
    def run():
        try:
            target()
        except BaseException as error:
            errors.append(error)
    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    try:
        yield worker
    finally:
        worker.join(2)
        if worker.is_alive():
            raise AssertionError('Background test task did not finish.')
        if errors:
            raise errors[0]
