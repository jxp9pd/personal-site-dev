#!/usr/bin/env python3
"""Schedule the existing Fantasy refresh for the most recently completed week."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


def scheduled_time(now):
    pacific = now.astimezone(ZoneInfo('America/Los_Angeles'))
    return pacific.weekday() == 2 and pacific.hour == 6


def completed_week(state):
    if not isinstance(state, dict):
        raise ValueError('Sleeper returned an invalid NFL state.')
    season, week = state.get('season'), state.get('week')
    if state.get('season_type') not in ('regular', 'post'):
        return None
    if not isinstance(season, str) or not re.fullmatch(r'[0-9]{4}', season) or type(week) is not int:
        raise ValueError('Sleeper returned an invalid season or week.')
    # Sleeper resets to postseason week 1 after regular-season week 18.
    if state['season_type'] == 'post':
        return (season, 18) if week == 1 else None
    if not 1 <= week <= 18:
        raise ValueError('Sleeper returned an invalid regular-season week.')
    return (season, week - 1) if week > 1 else None


def read_state():
    request = Request('https://api.sleeper.app/v1/state/nfl',
                      headers={'Accept': 'application/json', 'User-Agent': 'PentaProjects-Fantasy/1.0'})
    with urlopen(request, timeout=15) as response:
        data = response.read(65537)
        if response.status != 200 or len(data) > 65536:
            raise ValueError('Sleeper returned an unexpected NFL state response.')
        return json.loads(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh-script', type=Path, required=True)
    parser.add_argument('--env-file', type=Path, required=True)
    parser.add_argument('--output-root', type=Path, default=Path('/var/lib/fantasy-refresh/runs'))
    parser.add_argument('--scheduled', action='store_true', help='Run only Wednesday at 6 a.m. Pacific.')
    parser.add_argument('--dry-run', action='store_true', help='Show the selected week without writing data.')
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    if args.scheduled and not scheduled_time(now):
        return 0
    print(f'{now.isoformat()} Weekly Fantasy refresh', flush=True)
    selected = completed_week(read_state())
    if selected is None:
        print('Skipped: no newly completed regular-season week.', flush=True)
        return 0
    season, week = selected
    print(f'Selected {season} week {week}.', flush=True)
    if args.dry_run:
        return 0
    if not args.refresh_script.is_file() or not args.env_file.is_file():
        raise ValueError('The deployed refresh script and private environment file must exist.')
    output = args.output_root / f'{season}-week-{week:02}' / now.strftime('%Y%m%dT%H%M%S%fZ')
    result = subprocess.run([sys.executable, str(args.refresh_script), '--env-file', str(args.env_file),
                             '--season', season, '--week', str(week), '--output-dir', str(output)],
                            timeout=600)
    print(f'{datetime.now(timezone.utc).isoformat()} Refresh exit status: {result.returncode}', flush=True)
    return result.returncode if result.returncode >= 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        # Do not include response bodies or environment-file contents in logs.
        print('Weekly refresh failed: check Sleeper connectivity, installed files, and refresh logs.', file=sys.stderr)
        sys.exit(1)
