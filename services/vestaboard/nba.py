"""NBA games broadcast nationally on Prime Video or Peacock."""
from sports import ESPNSource, Sports


class NBASource(ESPNSource):
    league = 'nba'


class NBA(Sports):
    league = 'nba'
