"""NFL configuration for the shared sports scoreboard."""
from sports import ESPNSource, Sports, normalize_game


class NFLSource(ESPNSource):
    league = 'nfl'


class NFL(Sports):
    league = 'nfl'
