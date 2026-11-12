import json
import unittest
from unittest.mock import Mock

from fantasy import DEFAULT_LEAGUES, league_settings
from fantasy_store import FantasyStore
from fantasy_weeks import FantasyWeekStore
from history import MessageHistory
from test_helpers import Response, message


def store(cls, key, opener):
    return cls('https://example.supabase.co', key, opener)


class SupabaseHeadersTest(unittest.TestCase):
    """Modern sb_secret keys send only apikey; legacy JWTs also send Authorization."""
    calls = {
        MessageHistory: lambda history: history.begin('A', message(), None),
        FantasyStore: lambda fantasy: fantasy.save_settings(league_settings(DEFAULT_LEAGUES)),
        FantasyWeekStore: lambda weeks: weeks.load('2026', 5),
    }

    def test_every_store_sends_headers_for_both_key_styles(self):
        for cls, call in self.calls.items():
            for key, authorization in (('sb_secret_test', None), ('eyJtest', 'Bearer eyJtest')):
                with self.subTest(store=cls.__name__, key=key):
                    opener = Mock(side_effect=lambda request, **kwargs: Response(
                        json.dumps([json.loads(request.data)] if request.data else []).encode()))
                    call(store(cls, key, opener))
                    request = opener.call_args.args[0]
                    self.assertEqual(request.get_header('Apikey'), key)
                    self.assertEqual(request.get_header('Authorization'), authorization)
                    self.assertEqual(request.get_header('Content-type'), 'application/json')
                    self.assertEqual(opener.call_args.kwargs, {'timeout': 3})
                    opener.assert_called_once()


if __name__ == '__main__':
    unittest.main()
