"""One shared NFL scoreboard, refreshed without requiring an open browser."""
from datetime import datetime, timezone
import json
import re
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from board import BLANK, WHITE, text_row

SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
POLL_SECONDS = 180
ORANGE = 64
PACIFIC = ZoneInfo('America/Los_Angeles')
EASTERN = ZoneInfo('America/New_York')
# Approximate each team's primary/secondary colors using the Note's eight colors.
# Curated pairs preserve teams like Pittsburgh whose API primary color is black.
TEAM_COLORS = {
    'ARI': (63, 69), 'ATL': (63, 70), 'BAL': (68, 65), 'BUF': (67, 63),
    'CAR': (67, 70), 'CHI': (67, 64), 'CIN': (64, 70), 'CLE': (64, 69),
    'DAL': (67, 69), 'DEN': (64, 67), 'DET': (67, 69), 'GB': (66, 65),
    'HOU': (67, 63), 'IND': (67, 69), 'JAX': (66, 65), 'KC': (63, 65),
    'LAC': (67, 65), 'LAR': (67, 65), 'LV': (70, 69), 'MIA': (66, 64),
    'MIN': (68, 65), 'NE': (67, 63), 'NO': (70, 65), 'NYG': (67, 63),
    'NYJ': (66, 69), 'PHI': (66, 69), 'PIT': (70, 65), 'SEA': (67, 66),
    'SF': (63, 65), 'TB': (63, 70), 'TEN': (67, 69), 'WSH': (63, 65),
}
IDLE_FRAME = [text_row('NFL SCORES'), text_row('PICK A GAME'), [BLANK] * 15]


def board_frame(game):
    away, home = game['away'], game['home']
    def heading(team):
        primary, secondary = team['colors']
        return [primary] + text_row(team['abbreviation'], 5) + [secondary]
    scores = [text_row(str(team['score']) if team['score'] is not None else '--', 7)
              for team in (away, home)]
    bottom = [BLANK] * 15
    if game['state'] == 'scheduled':
        kickoff = datetime.fromisoformat(game['startsAt']).astimezone(PACIFIC)
        label = kickoff.strftime('%a ').upper() + str(kickoff.hour % 12 or 12)
        label += kickoff.strftime(':%M%p')
        bottom = text_row(label)
    elif game['state'] in ('final', 'halftime', 'canceled', 'postponed', 'delayed', 'suspended'):
        bottom = text_row(game['state'].upper())
    elif game['state'] == 'live' and game['possession']:
        bottom[3 if game['possession'] == away['id'] else 11] = ORANGE
    return [heading(away) + [BLANK] + heading(home), scores[0] + [BLANK] + scores[1], bottom]


def normalize_game(event):
    competition = event['competitions'][0]
    status = event.get('status') or competition['status']
    kind = status['type']
    name = kind['name']
    if name == 'STATUS_CANCELLED':
        state = 'canceled'
    elif name in ('STATUS_CANCELED', 'STATUS_POSTPONED', 'STATUS_DELAYED', 'STATUS_SUSPENDED', 'STATUS_HALFTIME'):
        state = name.removeprefix('STATUS_').lower()
    elif kind.get('completed') is True:
        state = 'final'
    elif kind['state'] == 'pre':
        state = 'scheduled'
    elif kind['state'] == 'in':
        state = 'live'
    else:
        raise ValueError('Unknown game status.')
    event_id = str(event['id'])
    if not re.fullmatch(r'[0-9]{1,20}', event_id):
        raise ValueError('Invalid game ID.')
    starts = datetime.fromisoformat(event['date'].replace('Z', '+00:00'))
    if starts.tzinfo is None:
        raise ValueError('Kickoff must include a time zone.')
    teams = {}
    for item in competition['competitors']:
        team = item['team']
        abbreviation = team['abbreviation']
        if not re.fullmatch(r'[A-Z]{2,3}', abbreviation):
            raise ValueError('Invalid team abbreviation.')
        raw_score = item.get('score')
        if state in ('scheduled', 'canceled', 'postponed') and kind['state'] == 'pre':
            score = None
        else:
            if type(raw_score) not in (str, int) or not re.fullmatch(r'[0-9]{1,3}', str(raw_score)):
                raise ValueError('Invalid score.')
            score = int(raw_score)
        if score is not None and not 0 <= score <= 999:
            raise ValueError('Invalid score.')
        side = item['homeAway']
        if side not in ('away', 'home') or side in teams:
            raise ValueError('Invalid matchup.')
        teams[side] = {'id': str(team['id']), 'abbreviation': abbreviation,
                       'name': team['displayName'], 'score': score,
                       'colors': list(TEAM_COLORS.get(abbreviation, (WHITE, WHITE)))}
    if set(teams) != {'away', 'home'}:
        raise ValueError('Incomplete matchup.')
    possession = str((competition.get('situation') or {}).get('possession', ''))
    game = {'id': event_id, 'startsAt': starts.isoformat(),
            # ESPN's date filter uses the game day in Eastern time, including MNF.
            'dateKey': starts.astimezone(EASTERN).strftime('%Y%m%d'),
            'state': state, 'terminal': state in ('final', 'canceled', 'postponed'),
            'possession': possession if state == 'live' and possession in
            (teams['away']['id'], teams['home']['id']) else None, **teams}
    game['characters'] = board_frame(game)
    return game


class NFLSource:
    def __init__(self, opener=urlopen):
        self.opener = opener

    def games(self, date=None):
        url = SCOREBOARD_URL
        if date is not None:
            if not re.fullmatch(r'[0-9]{8}', date):
                raise ValueError('Invalid game day.')
            url += '?' + urlencode({'dates': date})
        request = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'PentaProjects-NFL/1.0'})
        with self.opener(request, timeout=8) as response:
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000 or response.status != 200:
                raise ValueError('Invalid scoreboard response.')
            data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get('events'), list):
            raise ValueError('Invalid scoreboard data.')
        return [normalize_game(event) for event in data['events']]


class NFL:
    def __init__(self, gateway, fetch_games, clock=time.monotonic, wall_clock=time.time):
        self.gateway, self.fetch_games = gateway, fetch_games
        self.clock, self.wall_clock = clock, wall_clock
        self.lock = threading.Lock()
        self.wake, self.shutdown = threading.Event(), threading.Event()
        self.worker = None
        self.games = []
        self.game = None
        self.state = 'idle'
        self.revision = 0
        self.characters = IDLE_FRAME
        self.pending = False
        self.last_attempt = None
        self.delivery = {'status': 'idle'}
        self.last_delivery = {'status': 'idle'}
        self.refresh_requested = False
        self.next_refresh = 0
        self.last_checked = None
        self.source_error = None

    def _snapshot(self):
        games = list(self.games)
        games.sort(key=lambda game: (0 if game['state'] in ('live', 'halftime') else
                                    2 if game['terminal'] else 1, game['startsAt']))
        return {'configured': bool(self.gateway.token), 'state': self.state,
                'games': games, 'game': self.game, 'characters': self.characters,
                'pollIntervalSeconds': POLL_SECONDS,
                'source': {'lastCheckedAt': self.last_checked, 'error': self.source_error},
                'delivery': dict(self.delivery)}

    def status(self):
        with self.lock:
            # Idle sessions refresh the picker only when a visitor needs it.
            if self.clock() >= self.next_refresh:
                self.refresh_requested = True
                self.wake.set()
            return self._snapshot()

    def _queue(self, game):
        self.game, self.characters = game, game['characters']
        key = (self.revision, tuple(code for row in self.characters for code in row))
        self.pending = key != self.last_attempt
        self.delivery = {'status': 'pending'} if self.pending else dict(self.last_delivery)
        if game['terminal']:
            self.state = 'completed'

    def command(self, body):
        if not isinstance(body, dict) or body.get('action') not in ('track', 'stop'):
            return 400, {'error': 'Choose track or stop.'}
        with self.lock:
            if body['action'] == 'stop':
                if self.state != 'tracking':
                    return 409, {'error': 'Tracking has already ended. Refresh its status.'}
                self.state, self.pending = 'stopped', False
                self.revision += 1
                self.delivery = {'status': 'idle'}
            else:
                event_id = body.get('gameId')
                if not isinstance(event_id, str) or not re.fullmatch(r'[0-9]{1,20}', event_id):
                    return 400, {'error': 'Choose a game from the list.'}
                if not self.gateway.token:
                    return 503, {'error': 'The board is not connected yet. Please try again later.'}
                game = next((game for game in self.games if game['id'] == event_id), None)
                if not game or game['terminal']:
                    return 409, {'error': 'That game is unavailable or has ended. Choose another game.'}
                if self.source_error:
                    return 503, {'error': 'NFL scores are unavailable. Wait for the next refresh.'}
                self.revision += 1
                self.state = 'tracking'
                self._queue(game)
            snapshot = self._snapshot()
        self.wake.set()
        return 200, snapshot

    def _refresh(self):
        with self.lock:
            if self.clock() < self.next_refresh or not (self.refresh_requested or self.state == 'tracking'):
                return
            self.refresh_requested = False
            revision, selected = self.revision, self.game if self.state == 'tracking' else None
            # Reserve the fetch before I/O; visitors cannot trigger duplicate polls.
            self.next_refresh = self.clock() + POLL_SECONDS
        try:
            games = self.fetch_games()
            current = next((game for game in games if selected and game['id'] == selected['id']), None)
            if selected and current is None:
                # Keep following a selected game when ESPN rolls to the next week.
                current = next((game for game in self.fetch_games(selected['dateKey'])
                                if game['id'] == selected['id']), None)
                if current is None:
                    raise ValueError('The selected game is missing from the feed.')
        except Exception:
            # Preserve the last known score, and never expose upstream diagnostics.
            with self.lock:
                self.source_error = 'NFL scores are unavailable. Retrying shortly.'
                self.next_refresh = self.clock() + 30
            return
        with self.lock:
            self.games = games
            self.last_checked = datetime.fromtimestamp(self.wall_clock(), timezone.utc).isoformat()
            self.source_error = None
            self.next_refresh = self.clock() + POLL_SECONDS
            if self.state == 'tracking':
                # A visitor may select a game while this request is in flight.
                # Apply fresh list data to their current choice, never an old one.
                updated = next((game for game in games if game['id'] == self.game['id']), None)
                if updated is None and revision == self.revision:
                    updated = current
                if updated:
                    self._queue(updated)

    def _deliver(self):
        with self.lock:
            if not self.pending or self.state not in ('tracking', 'completed'):
                return
        if self.gateway.status()['retryAfter']:
            return
        with self.lock:
            if not self.pending or self.state not in ('tracking', 'completed'):
                return
            revision = self.revision
            characters = self.characters
            key = (revision, tuple(code for row in characters for code in row))
        status, result = self.gateway.send(characters)
        with self.lock:
            if revision != self.revision or status == 429:
                return
            self.pending = False
            self.last_attempt = key
            self.delivery = ({'status': 'accepted'} if status == 200 else
                             {'status': 'error', 'error': result.get('error', 'Board update failed.')})
            self.last_delivery = dict(self.delivery)
            # An ambiguous send is not retried for the same frame. A score or
            # possession change, or an explicit Track command, can send a new one.

    def tick(self):
        self._refresh()
        self._deliver()

    def start_worker(self):
        def run():
            while not self.shutdown.is_set():
                self.wake.clear()
                self.tick()
                self.wake.wait(0.5)
        self.worker = threading.Thread(target=run, name='nfl', daemon=True)
        self.worker.start()

    def close(self):
        self.shutdown.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=28)
