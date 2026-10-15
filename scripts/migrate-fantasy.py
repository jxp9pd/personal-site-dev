#!/usr/bin/env python3
"""Seed Supabase from the running gateway before its first persistent restart.

Run on the gateway host after migration 0010, before installing the new service.
Existing saved data is never overwritten. No commands are sent to the board.
"""
import argparse
from functools import partial
import json
from pathlib import Path
import sys
from urllib.request import urlopen
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services' / 'vestaboard'))
from board import cloud_tls_context
from fantasy import league_settings, saved_dashboard
from fantasy_store import FantasyStore, StorageUnavailable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='Existing private Supabase environment file.')
    parser.add_argument('--gateway', default='http://127.0.0.1:8787', help='Running gateway base URL.')
    args = parser.parse_args()
    store = FantasyStore.from_environment(args.env_file, opener=partial(urlopen, context=cloud_tls_context()))
    if store is None:
        raise SystemExit('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.')
    try:
        existing = store.load()
        if existing is not None:
            saved_dashboard(existing)
            print('Fantasy data already exists; nothing was overwritten.')
            return
        with urlopen(args.gateway.rstrip('/') + '/api/vestaboard/fantasy', timeout=10) as response:
            state = json.load(response)
        leagues = league_settings(state['leagues'])
        snapshot = {'matchups': [league['matchup'] for league in state['leagues']],
                    'week': state['week'], 'season': state['season'],
                    'last_checked_at': state['source']['lastCheckedAt']}
        saved_dashboard(dict(snapshot, leagues=leagues, config_version=str(uuid4())))
        saved = store.save_settings(leagues, initialize=True, snapshot=snapshot)
        saved_dashboard(saved)
        print('Saved two league settings and their latest matchups to Supabase.')
    except (StorageUnavailable, OSError, ValueError, KeyError, TypeError):
        raise SystemExit('Migration could not be verified. The running gateway was not changed.') from None


if __name__ == '__main__':
    main()
