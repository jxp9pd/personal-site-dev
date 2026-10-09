"""Two Sleeper matchups and a FIFO of starter-only Big Play alerts."""
from collections import deque
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import json
import math
import re
import threading
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from board import BLANK, CODES, GREEN, text_row

POLL_SECONDS = 15
ALERT_SECONDS = 30
DEFAULT_LEAGUES = [
    {'url': 'https://sleeper.com/leagues/1399168246661296128', 'username': 'pentakalos', 'label': 'TD'},
    {'url': 'https://sleeper.com/leagues/1389707496347697152', 'username': 'pentakalos', 'label': 'SH'},
]
IDLE_FRAME = [text_row('FANTASY'), text_row('PICK YOUR TEAMS'), [BLANK] * 15]


class SourceError(ValueError):
    pass


def league_settings(value):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('Enter two Sleeper leagues.')
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError('Enter a league URL, username, and short label.')
        url, username, label = (item.get(key) for key in ('url', 'username', 'label'))
        if not all(isinstance(x, str) for x in (url, username, label)):
            raise ValueError('Enter a league URL, username, and short label.')
        if len(url) > 300:
            raise ValueError('Enter a Sleeper league URL.')
        parsed = urlsplit(url.strip())
        match = re.fullmatch(r'/leagues/([0-9]{1,20})(?:/matchup)?/?', parsed.path)
        if (parsed.scheme != 'https' or parsed.netloc.lower() not in ('sleeper.com', 'sleeper.app')
                or not match):
            raise ValueError('Use a https://sleeper.com/leagues/… URL.')
        username, label = username.strip(), label.strip().upper()
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,40}', username):
            raise ValueError('Enter a Sleeper username, without @.')
        if not re.fullmatch(r'[A-Z0-9]{1,3}', label):
            raise ValueError('Use 1–3 letters or numbers for each league label.')
        result.append({'url': 'https://sleeper.com/leagues/' + match[1],
                       'leagueId': match[1], 'username': username, 'label': label})
    if result[0]['label'] == result[1]['label']:
        raise ValueError('Give the leagues different short labels.')
    return result


def board_text(value):
    text = unicodedata.normalize('NFKD', str(value)).encode('ascii', 'ignore').decode().upper()
    return ''.join(char for char in text if char in CODES).strip()


def rounded_score(value):
    return str(Decimal(str(value)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def score_frame(configs, matchups, week):
    rows = []
    for config, matchup in zip(configs, matchups):
        if matchup is None:
            line = config['label'] + ' LOADING'
        elif matchup['opponent'] is None:
            line = f"{config['label']} {rounded_score(matchup['you']['points'])} - BYE"
        else:
            line = (f"{config['label']} {rounded_score(matchup['you']['points'])} - "
                    f"{rounded_score(matchup['opponent']['points'])}")
        rows.append(text_row(line))
    chances = [m.get('winChance') if m else None for m in matchups]
    # Public matchups do not contain Sleeper win percentages. Never infer them
    # from points, projections, or a home-grown probability model.
    label = ''
    if any(chance is not None for chance in chances):
        label = 'WIN ' + ' / '.join('--' if x is None else str(round(x)) + '%' for x in chances)
    rows.append(text_row(label))
    return rows


class SleeperSource:
    def __init__(self, opener=urlopen, clock=time.monotonic):
        self.opener, self.clock = opener, clock
        self.cache = {}

    def _read(self, path, *, ttl=0, limit=4_000_000):
        cached = self.cache.get(path)
        if cached and cached[0] > self.clock():
            return cached[1]
        request = Request('https://api.sleeper.app/' + path,
                          headers={'Accept': 'application/json', 'User-Agent': 'PentaProjects-Fantasy/1.0'})
        try:
            with self.opener(request, timeout=8) as response:
                raw = response.read(limit + 1)
                if response.status != 200 or len(raw) > limit:
                    raise SourceError('Sleeper returned an unexpected response.')
                data = json.loads(raw)
        except HTTPError as error:
            if error.code == 404:
                raise SourceError('That Sleeper league or username was not found.') from None
            raise SourceError('Sleeper is unavailable. Retrying shortly.') from None
        except (OSError, ValueError) as error:
            if isinstance(error, SourceError):
                raise
            raise SourceError('Sleeper is unavailable. Retrying shortly.') from None
        if ttl:
            self.cache[path] = (self.clock() + ttl, data)
        return data

    def state(self):
        data = self._read('v1/state/nfl', ttl=60)
        if (not isinstance(data, dict) or not re.fullmatch(r'[0-9]{4}', str(data.get('season', '')))
                or type(data.get('week')) is not int or not 1 <= data['week'] <= 18):
            raise SourceError('Sleeper has no active fantasy week right now.')
        if data.get('season_type') != 'regular':
            raise SourceError('Fantasy tracking is available during the regular season.')
        return data

    @staticmethod
    def _team(raw, roster, users):
        points = raw.get('custom_points')
        if points is None:
            points = raw.get('points')
        if type(points) not in (int, float) or not math.isfinite(points) or not -998 <= points <= 9998:
            raise SourceError('Sleeper returned an invalid score.')
        user = users.get(roster.get('owner_id'), {})
        name = (user.get('metadata') or {}).get('team_name') or user.get('display_name') or 'Team'
        return {'rosterId': raw['roster_id'], 'name': name, 'points': points}

    def matchup(self, config, state):
        base = 'v1/league/' + config['leagueId']
        league = self._read(base, ttl=60)
        user = self._read('v1/user/' + config['username'], ttl=3600)
        users = self._read(base + '/users', ttl=60)
        rosters = self._read(base + '/rosters', ttl=60)
        if not isinstance(league, dict) or not isinstance(user, dict):
            raise SourceError('That Sleeper league or username was not found.')
        if league.get('sport') != 'nfl' or league.get('season') != state['season']:
            raise SourceError('Choose an NFL league for the current season.')
        if not isinstance(users, list) or not isinstance(rosters, list):
            raise SourceError('Sleeper returned an unexpected league response.')
        roster = next((r for r in rosters if r.get('owner_id') == user.get('user_id')
                       or user.get('user_id') in (r.get('co_owners') or [])), None)
        if roster is None:
            raise SourceError(f"{config['username']} has no team in that league.")
        games = self._read(base + '/matchups/' + str(state['week']))
        if not isinstance(games, list):
            raise SourceError('Sleeper returned an unexpected matchup response.')
        yours = next((r for r in games if r.get('roster_id') == roster['roster_id']), None)
        if yours is None:
            raise SourceError('This week’s matchup is not available yet.')
        rivals = [r for r in games if yours.get('matchup_id') is not None
                  and r.get('matchup_id') == yours['matchup_id'] and r['roster_id'] != yours['roster_id']]
        if len(rivals) > 1:
            raise SourceError('This matchup has more than one opponent.')
        user_map = {u['user_id']: u for u in users}
        roster_map = {r['roster_id']: r for r in rosters}
        starters = yours.get('starters')
        if not isinstance(starters, list) or not all(isinstance(p, str) for p in starters):
            raise SourceError('Sleeper returned an unexpected starting lineup.')
        return {'leagueName': league.get('name', config['label']),
                'week': state['week'], 'season': state['season'],
                'you': self._team(yours, roster, user_map),
                'opponent': self._team(rivals[0], roster_map[rivals[0]['roster_id']], user_map) if rivals else None,
                'starters': [p for p in starters if p != '0'], 'winChance': None}

    def plays(self, state):
        query = urlencode({'season_type': state['season_type'], 'season': state['season'],
                           'week': state['week'], 'limit': 1000})
        data = self._read('plays/nfl/recent?' + query, limit=8_000_000)
        if not isinstance(data, list):
            raise SourceError('Sleeper’s play feed is unavailable. Retrying shortly.')
        return data

    def player(self, player_id):
        # Sleeper asks consumers to download its player catalog at most daily.
        players = self._read('v1/players/nfl', ttl=86400, limit=40_000_000)
        if not isinstance(players, dict):
            raise SourceError('Sleeper’s player names are unavailable.')
        player = players.get(player_id) or {}
        return {'name': player.get('full_name') or player.get('last_name') or player_id,
                'lastName': player.get('last_name') or player_id}


def play_alert(play, starters, player_lookup):
    meta = play.get('metadata') or {}
    touchdown = meta.get('is_scoring_play') is True and 'touchdown' in str(meta.get('description', '')).lower()
    big = (meta.get('type') == 'Rush' and meta.get('yards_gained', 0) >= 15
           or meta.get('type') == 'PassCompleted' and meta.get('yards_gained', 0) >= 20)
    if not (touchdown or big):
        return None
    candidates = []
    for item in play.get('play_stats') or []:
        player_id, stats = item.get('player_id'), item.get('stats') or {}
        if player_id not in starters:
            continue
        td = any(stats.get(key, 0) > 0 for key in
                 ('rec_td', 'rush_td', 'pass_td', 'def_td', 'def_st_td', 'st_td', 'fum_rec_td'))
        gained = (meta.get('type') == 'Rush' and stats.get('rush_yd', 0) >= 15
                  or meta.get('type') == 'PassCompleted' and
                  (stats.get('rec_yd', 0) >= 20 or stats.get('pass_yd', 0) >= 20))
        if not ((touchdown and td) or (not touchdown and gained)):
            continue  # A tackler or intercepted QB appearing in the same play is not its scorer.
        kind = 'CATCH' if stats.get('rec', 0) > 0 else 'RUN' if stats.get('rush_att', 0) > 0 else 'PASS'
        priority = {'CATCH': 0, 'RUN': 1, 'PASS': 2}[kind]
        candidates.append((priority, player_id, kind))
    if not candidates:
        return None
    candidates.sort()
    names = [player_lookup(candidate[1]) for candidate in candidates]
    name = board_text(names[0]['name'])
    if len(names) > 1:
        combined = ' / '.join(board_text(p['lastName']) for p in names)
        if len(combined) <= 15:
            name = combined
    if len(name) > 15:
        parts = name.split()
        name = (parts[0][0] + '. ' + ' '.join(parts[1:]))[:15]
    yards = meta.get('yards_gained', 0)
    if type(yards) not in (int, float) or not math.isfinite(yards) or not 0 <= yards <= 110:
        return None
    detail = f"{round(yards)}YD {'TD' if touchdown else candidates[0][2]}"
    return {'id': play['play_id'], 'gameId': play['game_id'],
            'players': [p['name'] for p in names], 'detail': detail,
            'description': meta.get('fantasy_description') or meta.get('description'),
            'characters': [[GREEN] + text_row('BIG PLAY!', 13) + [GREEN], text_row(name), text_row(detail)]}


class Fantasy:
    def __init__(self, gateway, source, clock=time.monotonic, wall_clock=time.time):
        self.gateway, self.source = gateway, source
        self.clock, self.wall_clock = clock, wall_clock
        self.lock = threading.Lock()
        self.wake, self.shutdown = threading.Event(), threading.Event()
        self.worker = None
        self.configs = league_settings(DEFAULT_LEAGUES)
        self.matchups = [None, None]
        self.errors = [None, None]
        self.state, self.revision = 'idle', 0
        self.week, self.season = None, None
        self.next_refresh, self.refresh_requested = 0, False
        self.last_checked, self.play_error = None, None
        self.started_at = None
        self.seen, self.queue = set(), deque()
        self.alert, self.alert_until = None, None
        self.characters = IDLE_FRAME
        self.display_key, self.last_attempt = None, None
        self.delivery = {'status': 'idle'}

    def _prepare_display(self):
        if self.alert and self.alert_until is not None and self.clock() >= self.alert_until:
            self.alert, self.alert_until = None, None
        if self.state == 'tracking' and not self.alert and self.queue:
            self.alert = self.queue.popleft()
        if self.alert:
            characters = self.alert['characters']
            key = (self.revision, 'alert', self.alert['gameId'], self.alert['id'])
        else:
            characters = score_frame(self.configs, self.matchups, self.week)
            key = (self.revision, 'scores', tuple(code for row in characters for code in row))
        self.characters, self.display_key = characters, key
        if self.state == 'tracking' and key != self.last_attempt:
            self.delivery = {'status': 'pending'}

    def _snapshot(self):
        return {'configured': bool(self.gateway.token), 'state': self.state,
                'leagues': [dict(config, matchup=matchup, error=error)
                            for config, matchup, error in zip(self.configs, self.matchups, self.errors)],
                'week': self.week, 'season': self.season, 'characters': self.characters,
                'alert': self.alert, 'queuedAlerts': len(self.queue),
                'alertSecondsRemaining': (max(0, math.ceil(self.alert_until - self.clock()))
                                          if self.alert_until is not None else None),
                'source': {'lastCheckedAt': self.last_checked, 'playError': self.play_error,
                           'refreshing': self.refresh_requested, 'pollSeconds': POLL_SECONDS,
                           'winChanceAvailable': False}, 'delivery': dict(self.delivery)}

    def status(self):
        with self.lock:
            if self.clock() >= self.next_refresh:
                self.refresh_requested = True
                self.wake.set()
            return self._snapshot()

    def command(self, body):
        if not isinstance(body, dict) or body.get('action') not in ('start', 'stop', 'preview'):
            return 400, {'error': 'Choose start, stop, or preview.'}
        action = body['action']
        if action != 'stop':
            try:
                configs = league_settings(body.get('leagues'))
            except ValueError as error:
                return 400, {'error': str(error)}
            if action == 'start' and not self.gateway.token:
                return 503, {'error': 'The board is not connected yet. Preview your matchups instead.'}
        with self.lock:
            if action == 'stop':
                if self.state != 'tracking':
                    return 409, {'error': 'Tracking has already stopped.'}
                self.state = 'stopped'
                self.revision += 1
                self.alert, self.alert_until = None, None
                self.queue.clear()
                self.delivery = {'status': 'idle'}
            else:
                if self.state == 'tracking':
                    return 409, {'error': 'Stop tracking before changing the leagues.'}
                self.configs, self.matchups, self.errors = configs, [None, None], [None, None]
                self.revision += 1
                self.state = 'tracking' if action == 'start' else 'idle'
                self.started_at = self.wall_clock() if action == 'start' else None
                self.week, self.season, self.last_checked = None, None, None
                self.seen.clear()
                self.queue.clear()
                self.alert, self.alert_until, self.play_error = None, None, None
                self.last_attempt = None
                self.delivery = {'status': 'idle'}
                self.next_refresh, self.refresh_requested = 0, True
                self._prepare_display()
            result = self._snapshot()
        self.wake.set()
        return 200, result

    def _refresh(self):
        with self.lock:
            if self.clock() < self.next_refresh or not (self.refresh_requested or self.state == 'tracking'):
                return
            self.refresh_requested = False
            revision, tracking, configs = self.revision, self.state == 'tracking', self.configs
            started_at, old_week, old_season = self.started_at, self.week, self.season
            seen = set(self.seen)
            self.next_refresh = self.clock() + POLL_SECONDS
        try:
            state = self.source.state()
        except Exception as error:
            with self.lock:
                if revision == self.revision:
                    self.errors = [str(error) if isinstance(error, SourceError) else 'Sleeper is unavailable. Retrying shortly.'] * 2
                    self.next_refresh = self.clock() + 30
            return
        if (state['week'], state['season']) != (old_week, old_season):
            seen = set()
        results, errors = [], []
        for config in configs:
            try:
                results.append(self.source.matchup(config, state))
                errors.append(None)
            except Exception as error:
                results.append(None)
                errors.append(str(error) if isinstance(error, SourceError) else 'Sleeper scores are unavailable. Retrying shortly.')
        alerts, play_error = [], None
        if tracking:
            try:
                plays = self.source.plays(state)
                starters = {p for matchup in results if matchup for p in matchup['starters']}
                for play in sorted(plays, key=lambda p: p.get('time', 0)):
                    key = (play.get('game_id'), play.get('play_id'))
                    timestamp = play.get('time')
                    if (not all(isinstance(x, str) for x in key) or type(timestamp) not in (int, float)
                            or not math.isfinite(timestamp) or key in seen):
                        continue
                    if timestamp / 1000 >= started_at:
                        # Only consume new plays after both lineups are known;
                        # a temporary league outage must not silently drop alerts.
                        if any(errors):
                            continue
                        alert = play_alert(play, starters, self.source.player)
                        if alert:
                            alerts.append(alert)
                    seen.add(key)
            except Exception:
                play_error = 'Sleeper’s play feed is unavailable. Retrying shortly.'
        with self.lock:
            if revision != self.revision:
                return
            rollover = (state['week'], state['season']) != (self.week, self.season)
            if rollover:
                self.queue.clear()
                self.alert, self.alert_until = None, None
                self.matchups = [None, None]
            self.week, self.season = state['week'], state['season']
            self.matchups = [new if new is not None else old for new, old in zip(results, self.matchups)]
            self.errors, self.play_error, self.seen = errors, play_error, seen
            self.queue.extend(alerts)
            if not any(errors):
                self.last_checked = datetime.fromtimestamp(self.wall_clock(), timezone.utc).isoformat()
            self.next_refresh = self.clock() + (POLL_SECONDS if tracking else 60)
            self._prepare_display()

    def _deliver(self):
        with self.lock:
            if self.state != 'tracking':
                return
            self._prepare_display()
            if self.display_key == self.last_attempt or all(m is None for m in self.matchups):
                return
        if self.gateway.status()['retryAfter']:
            return
        with self.lock:
            if self.state != 'tracking':
                return
            revision, key, characters = self.revision, self.display_key, self.characters
        status, result = self.gateway.send(characters)
        with self.lock:
            if revision != self.revision or status == 429:
                return
            self.last_attempt = key
            self.delivery = ({'status': 'accepted'} if status == 200 else
                             {'status': 'error', 'error': result.get('error', 'Board update failed.')})
            # Hold each alert from its delivery attempt, rather than from feed
            # arrival. An ambiguous timeout may have delivered: do not repeat it.
            if self.alert and self.display_key == key:
                self.alert_until = self.clock() + ALERT_SECONDS

    def tick(self):
        self._deliver()
        self._refresh()
        self._deliver()

    def start_worker(self):
        def run():
            while not self.shutdown.is_set():
                self.wake.clear()
                self.tick()
                self.wake.wait(.5)
        self.worker = threading.Thread(target=run, name='fantasy', daemon=True)
        self.worker.start()

    def close(self):
        self.shutdown.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=2)
