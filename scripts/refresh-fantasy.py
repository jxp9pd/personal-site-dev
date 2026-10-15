#!/usr/bin/env python3
"""Refresh a saved Fantasy week, or verify it by CSV backup, deletion and rebuild."""
import argparse
import csv
from datetime import datetime, timezone
from decimal import Decimal
from functools import partial
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services' / 'vestaboard'))
from board import cloud_tls_context, environment_value
from fantasy import SleeperSource, SourceError, league_settings, saved_dashboard
from fantasy_store import FantasyStore, StorageUnavailable
from fantasy_weeks import ConcurrentRefresh, FantasyWeekStore

FIELDS = ('season', 'week', 'slot', 'league_id', 'league_url', 'username', 'label', 'league_name',
          'your_roster_id', 'your_team', 'your_points', 'opponent_roster_id', 'opponent_team',
          'opponent_points', 'starters', 'win_chance')


def credentials(env_file=None):
    """Use existing server settings, or fetch a CLI key in memory without logging it."""
    url = environment_value('SUPABASE_URL', env_file)
    key = environment_value('SUPABASE_SERVICE_ROLE_KEY', env_file)
    if url or key:
        if not url or not key:
            raise ValueError('Configure both Supabase environment settings together.')
        return url, key
    ref_file = ROOT / 'supabase' / '.temp' / 'project-ref'
    ref = ref_file.read_text().strip() if ref_file.exists() else ''
    cli = shutil.which('supabase')
    if not cli or not re.fullmatch(r'[a-z0-9]{20}', ref):
        raise ValueError('Link this checkout with supabase link, or supply --env-file with the existing server settings.')
    result = subprocess.run([cli, 'projects', 'api-keys', '--project-ref', ref, '--reveal', '--output-format', 'json'],
                            capture_output=True, text=True, timeout=30)
    try:
        if result.returncode:
            raise ValueError()
        key = next(item['api_key'] for item in json.loads(result.stdout)['keys']
                   if item['name'] == 'service_role' and item.get('type') == 'legacy')
        if not isinstance(key, str) or not key:
            raise ValueError()
    except (ValueError, KeyError, TypeError, StopIteration):
        raise ValueError('Could not obtain a Supabase service key. Check supabase login and the linked project.') from None
    return 'https://' + ref + '.supabase.co', key


def csv_rows(snapshot):
    """Exact scores and lineup order; omit only storage versions and fetch times."""
    saved_dashboard(snapshot)
    rows = []
    for slot, (league, matchup) in enumerate(zip(snapshot['leagues'], snapshot['matchups']), 1):
        if matchup is None:
            raise ValueError('Cannot export an incomplete week.')
        you, opponent = matchup['you'], matchup['opponent']
        values = (snapshot['season'], snapshot['week'], slot, league['leagueId'], league['url'],
                  league['username'], league['label'], matchup['leagueName'],
                  you['rosterId'], you['name'], format(Decimal(str(you['points'])).normalize(), 'f'),
                  opponent['rosterId'] if opponent else '', opponent['name'] if opponent else '',
                  format(Decimal(str(opponent['points'])).normalize(), 'f') if opponent else '',
                  json.dumps(matchup['starters'], ensure_ascii=False, separators=(',', ':')),
                  '' if matchup.get('winChance') is None else matchup['winChance'])
        rows.append(dict(zip(FIELDS, map(str, values))))
    return rows


def write_json(path, data):
    with path.open('x', encoding='utf-8') as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())


def export_csv(path, snapshot):
    rows = csv_rows(snapshot)
    with path.open('x', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
        handle.flush()
        os.fsync(handle.fileno())
    # Confirm the complete backup can be read before allowing a deletion.
    with path.open(encoding='utf-8', newline='') as handle:
        if list(csv.DictReader(handle)) != rows:
            raise ValueError('CSV backup failed its round-trip check.')


def compare_csv(before, after):
    with before.open(encoding='utf-8', newline='') as handle:
        old = list(csv.DictReader(handle))
    with after.open(encoding='utf-8', newline='') as handle:
        new = list(csv.DictReader(handle))
    differences = []
    if len(old) != len(new):
        differences.append({'field': 'row_count', 'before': len(old), 'after': len(new)})
    for index, (left, right) in enumerate(zip(old, new), 1):
        for field in FIELDS:
            if left.get(field) != right.get(field):
                differences.append({'slot': index, 'field': field, 'before': left.get(field), 'after': right.get(field)})
    return {'match': not differences, 'rows_before': len(old), 'rows_after': len(new),
            'fields_per_row': len(FIELDS), 'ignored_storage_fields': ['config_version', 'last_checked_at', 'updated_at'],
            'differences': differences}


def refresh_week(source, store, season, week, leagues, previous=None):
    state = {'season': season, 'week': week, 'season_type': 'regular'}
    configs = league_settings(leagues)
    # Fetch both leagues before a write. A partial upstream failure never replaces a saved week.
    snapshot = {'season': season, 'week': week, 'config_version': str(uuid4()), 'leagues': configs,
                'matchups': [source.matchup(config, state) for config in configs],
                'last_checked_at': datetime.now(timezone.utc).isoformat()}
    saved_dashboard(snapshot)
    saved = store.save(snapshot, previous['config_version'] if previous else None)
    readback = store.load(season, week)
    if readback is None or readback['config_version'] != saved['config_version'] or csv_rows(readback) != csv_rows(snapshot):
        raise ValueError('The saved week could not be verified by reading it back.')
    return readback


def verify_rebuild(source, store, before, output):
    export_csv(output / 'before.csv', before)
    write_json(output / 'backup.json', before)
    with (output / 'backup.json').open(encoding='utf-8') as handle:
        backup = json.load(handle)
    if backup != before:
        raise ValueError('JSON backup failed its round-trip check.')
    try:
        store.delete(before)
        if store.load(before['season'], before['week']) is not None:
            raise ConcurrentRefresh('The week was recreated concurrently; rebuild stopped.')
        after = refresh_week(source, store, before['season'], before['week'], backup['leagues'])
        export_csv(output / 'after.csv', after)
        report = compare_csv(output / 'before.csv', output / 'after.csv')
        report['deleted_then_rebuilt'] = True
        write_json(output / 'comparison.json', report)
        return report
    except (Exception, KeyboardInterrupt):
        # Even an ambiguous DELETE failure may have removed the row. Restore only
        # if absent, using insert-ignore so a concurrent refresh is never replaced.
        recovery = 'A saved row is present; it was left unchanged.'
        try:
            if store.load(before['season'], before['week']) is None:
                store.save(backup)
                recovery = 'Restored the original backup.'
        except Exception:
            recovery = 'Automatic recovery failed; use --restore-backup with backup.json.'
        write_json(output / 'failure.json', {'recovery': recovery, 'backup': str(output / 'backup.json')})
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--season', help='Four-digit season; defaults to Sleeper’s current regular season.')
    parser.add_argument('--week', type=int, choices=range(1, 19), metavar='1-18', help='Defaults to the current week.')
    parser.add_argument('--verify-rebuild', action='store_true', help='Back up, delete only this archived week, rebuild and compare.')
    parser.add_argument('--restore-backup', type=Path, help='Restore a JSON backup only if that archived week is absent.')
    parser.add_argument('--output-dir', type=Path, help='New/empty directory for CSVs and the comparison report.')
    parser.add_argument('--env-file', type=Path, help='Existing private server environment file; otherwise use the linked Supabase CLI.')
    args = parser.parse_args(argv)
    if args.verify_rebuild and (not args.season or not args.week):
        parser.error('--verify-rebuild requires an explicit --season and --week.')
    if args.restore_backup and (args.verify_rebuild or args.season or args.week):
        parser.error('--restore-backup cannot be combined with week selection or --verify-rebuild.')
    if args.season and not re.fullmatch(r'[0-9]{4}', args.season):
        parser.error('--season must contain four digits.')
    opener = partial(urlopen, context=cloud_tls_context())
    url, key = credentials(args.env_file)
    store = FantasyWeekStore(url, key, opener)
    if args.restore_backup:
        with args.restore_backup.open(encoding='utf-8') as handle:
            backup = json.load(handle)
        saved_dashboard(backup)
        existing = store.load(backup['season'], backup['week'])
        if existing is not None:
            print('The week already exists; no data was replaced.')
        else:
            store.save(backup)
            restored = store.load(backup['season'], backup['week'])
            if restored is None or csv_rows(restored) != csv_rows(backup):
                raise ValueError('Backup restoration could not be verified.')
            print('Restored the archived week from backup.')
        return 0
    source = SleeperSource(opener=opener)
    current = source.state() if not args.season or not args.week else {}
    season, week = args.season or current['season'], args.week or current['week']
    store.scope(season, week)
    if args.season and not args.week and args.season != current['season']:
        parser.error('Provide --week when selecting a historical season.')
    before = store.load(season, week)
    if args.verify_rebuild and before is None:
        raise ValueError('No archived data exists for this week. Run a regular refresh first, then verify the rebuild.')
    settings = before or FantasyStore(url, key, opener).load()
    if settings is None:
        raise ValueError('Save the dashboard’s league settings before refreshing a week.')
    output = args.output_dir or ROOT / 'data' / 'fantasy-runs' / (season + '-week-' + str(week).zfill(2)) / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Choose an empty output directory; existing backups will not be overwritten.')
    print('Run files: ' + str(output.resolve()), flush=True)
    if args.verify_rebuild:
        report = verify_rebuild(source, store, before, output)
        print(('MATCH' if report['match'] else 'DIFFERENCES FOUND') + f': {season} week {week}; {report["rows_after"]} leagues, {len(report["differences"])} differences.')
        print('Backup and comparison: ' + str(output.resolve()))
        return 0 if report['match'] else 2
    saved = refresh_week(source, store, season, week, settings['leagues'], before)
    export_csv(output / 'after.csv', saved)
    print(f'Saved {season} week {week}: {len(saved["matchups"])} leagues. CSV: {output.resolve() / "after.csv"}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (StorageUnavailable, ConcurrentRefresh, SourceError, ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        # Never include subprocess output, response bodies or credentials in errors.
        detail = str(error) if isinstance(error, (SourceError, ConcurrentRefresh, ValueError)) else 'Check Supabase/Sleeper connectivity and the output directory.'
        print('Refresh failed: ' + detail, file=sys.stderr)
        sys.exit(1)
