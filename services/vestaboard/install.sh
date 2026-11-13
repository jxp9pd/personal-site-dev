#!/usr/bin/env bash
# Run on the Hetzner host as root after deploying the repository.
set -euo pipefail
cd -- "$(dirname -- "$0")"
install -d -m 755 /opt/vestaboard-note
shopt -s nullglob
# Drop modules deleted from the repository so stale code cannot be imported.
for installed in /opt/vestaboard-note/*.py; do
    [[ -f ${installed##*/} ]] || rm -f -- "$installed"
done
for module in *.py; do
    [[ $module == test_* ]] || install -m 644 "$module" /opt/vestaboard-note/
done
install -m 644 vestaboard-note.service /etc/systemd/system/vestaboard-note.service
install -m 644 nginx.conf /etc/nginx/snippets/vestaboard-note.conf
install -m 644 cloudflare-real-ip.conf /etc/nginx/snippets/vestaboard-cloudflare-real-ip.conf
printf '%s\n' 'limit_req_zone $server_name zone=vestaboard_requests:1m rate=5r/s;' > /etc/nginx/conf.d/vestaboard-rate-limit.conf
python3 - <<'PY'
from pathlib import Path
path = Path('/etc/nginx/sites-enabled/site.conf')
text = path.read_text()
include = '    include /etc/nginx/snippets/vestaboard-note.conf;'
if include not in text:
    marker = '    location / {'
    if text.count(marker) != 1:
        raise SystemExit('Expected one root location; inspect nginx config before adding the include.')
    backup = Path('/etc/nginx/site.conf.before-vestaboard')
    if not backup.exists():
        backup.write_text(text)
    path.write_text(text.replace(marker, include + '\n\n' + marker))
PY
nginx -t
systemctl daemon-reload
systemctl enable vestaboard-note
systemctl restart vestaboard-note
systemctl reload nginx
systemctl is-active vestaboard-note
