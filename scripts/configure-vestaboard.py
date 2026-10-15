#!/usr/bin/env python3
"""Prompt privately, then install the token over SSH. Never print or commit it."""
import getpass
import argparse
import json
from pathlib import Path
import shlex
import subprocess
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', action='store_true', help='Configure Supabase message history and Fantasy storage instead of the board token.')
    args = parser.parse_args()
    if args.history:
        url = input('Supabase project URL: ').strip().rstrip('/')
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment):
            raise SystemExit('Expected an HTTPS Supabase project URL.')
        key = getpass.getpass('Supabase secret / service_role key (hidden): ').strip()
        values = {'SUPABASE_URL': url, 'SUPABASE_SERVICE_ROLE_KEY': key}
    else:
        print('Create a Write token for your Note at https://web.vestaboard.com (API tab).')
        token = getpass.getpass('Vestaboard API token (hidden): ').strip()
        values = {'VESTABOARD_API_TOKEN': token}
    if any(not value or not value.isascii() or any(c.isspace() or c in '\"\'\\' for c in value)
           for value in values.values()):
        raise SystemExit('Expected nonempty values without whitespace or quotes.')
    # No secret in command arguments, shell history, repo, or stdout. stdin travels over SSH.
    remote = r'''import json, os, tempfile
from pathlib import Path
import sys
settings = json.load(sys.stdin)
destination = '/etc/vestaboard-history.env' if settings['history'] else '/etc/vestaboard-note.env'
fd, name = tempfile.mkstemp(prefix='.vestaboard-', dir='/etc')
with os.fdopen(fd, 'w') as f:
    f.write(''.join(key + '=' + value + '\n' for key, value in settings['values'].items()))
os.chmod(name, 0o600)
os.replace(name, destination)
'''
    ssh = ['ssh', '-i', str(Path.home() / '.ssh/id_ed25519_personal'),
           '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'root@5.78.199.99']
    subprocess.run(ssh + ['python3 -c ' + shlex.quote(remote)],
                   input=json.dumps({'history': args.history, 'values': values}), text=True, check=True)
    subprocess.run(ssh + ['systemctl restart vestaboard-note && systemctl is-active vestaboard-note'], check=True)
    if args.history:
        print('History configured. Apply migration 0009 and install the updated gateway before sending a note.')
    else:
        print('Token installed. Open https://jpentakalos.com/tools/vestaboard.html and send a test note.')
        print('This configures the token; only a successful send verifies Vestaboard accepted it.')


if __name__ == '__main__':
    main()
