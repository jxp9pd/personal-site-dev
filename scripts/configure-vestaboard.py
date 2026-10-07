#!/usr/bin/env python3
"""Prompt privately, then install the token over SSH. Never print or commit it."""
import getpass
import json
from pathlib import Path
import shlex
import subprocess


def main():
    print('Create a Write token for your Note at https://web.vestaboard.com (API tab).')
    token = getpass.getpass('Vestaboard API token (hidden): ').strip()
    if not token or not token.isascii() or any(c.isspace() or c in '\"\'\\' for c in token):
        raise SystemExit('Expected a nonempty API token without whitespace or quotes.')
    # No secret in command arguments, shell history, repo, or stdout. stdin travels over SSH.
    remote = '''import json, os, tempfile
from pathlib import Path
import sys
token = json.load(sys.stdin)['token']
fd, name = tempfile.mkstemp(prefix='.vestaboard-', dir='/etc')
with os.fdopen(fd, 'w') as f:
    f.write('VESTABOARD_API_TOKEN=' + token + '\\n')
os.chmod(name, 0o600)
os.replace(name, '/etc/vestaboard-note.env')
'''
    ssh = ['ssh', '-i', str(Path.home() / '.ssh/id_ed25519_personal'),
           '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'root@5.78.199.99']
    subprocess.run(ssh + ['python3 -c ' + shlex.quote(remote)],
                   input=json.dumps({'token': token}), text=True, check=True)
    subprocess.run(ssh + ['systemctl restart vestaboard-note && systemctl is-active vestaboard-note'], check=True)
    print('Token installed. Open https://jpentakalos.com/tools/vestaboard.html and send a test note.')
    print('This configures the token; only a successful send verifies Vestaboard accepted it.')


if __name__ == '__main__':
    main()
