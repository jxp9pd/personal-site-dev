"""On-demand weekly archives, separate from the live board's singleton."""
import re
from uuid import UUID

from fantasy import saved_dashboard
from fantasy_store import FantasyStore


class ConcurrentRefresh(Exception):
    pass


class FantasyWeekStore(FantasyStore):
    def __init__(self, url, key, opener=None):
        super().__init__(url, key, **({'opener': opener} if opener else {}))
        self.endpoint += '_weeks'

    @staticmethod
    def scope(season, week):
        if not isinstance(season, str) or not re.fullmatch(r'[0-9]{4}', season) or type(week) is not int or not 1 <= week <= 18:
            raise ValueError('Choose a four-digit season and a week from 1 to 18.')
        return '?season=eq.' + season + '&week=eq.' + str(week)

    def load(self, season, week):
        rows = self._request('GET', self.scope(season, week) + '&select=*')
        if not rows:
            return None
        saved_dashboard(rows[0])
        return rows[0]

    def save(self, snapshot, expected_version=None):
        saved_dashboard(snapshot)
        if not all(snapshot['matchups']):
            raise ValueError('Both matchups must be available before saving a week.')
        scope = self.scope(snapshot['season'], snapshot['week'])
        if expected_version:
            scope += '&config_version=eq.' + str(UUID(expected_version))
            rows = self._request('PATCH', scope, snapshot)
        else:
            rows = self._request('POST', '?on_conflict=season,week', snapshot,
                                 'resolution=ignore-duplicates,return=representation')
        if not rows:
            raise ConcurrentRefresh('This week changed during the refresh. Run the command again.')
        saved_dashboard(rows[0])
        return rows[0]

    def delete(self, snapshot):
        scope = self.scope(snapshot['season'], snapshot['week'])
        scope += '&config_version=eq.' + str(UUID(snapshot['config_version']))
        if not self._request('DELETE', scope):
            raise ConcurrentRefresh('This week changed after backup; no data was deleted.')
