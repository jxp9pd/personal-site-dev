#!/usr/bin/env bash
# Run on the Hetzner host as root. Requires /etc/door-access.env (see README.md)
# and the Vestaboard gateway's Cloudflare real-IP snippet.
set -euo pipefail
cd -- "$(dirname -- "$0")"
[[ -f /etc/door-access.env ]] || { echo 'Create /etc/door-access.env first.' >&2; exit 1; }
install -d -m 755 /opt/door-access
shopt -s nullglob
for installed in /opt/door-access/*.py; do
    [[ -f ${installed##*/} ]] || rm -f -- "$installed"
done
for module in *.py; do
    [[ $module == test_* ]] || install -m 644 "$module" /opt/door-access/
done
install -m 644 door-access.service /etc/systemd/system/door-access.service
install -m 644 nginx.conf /etc/nginx/snippets/door-access.conf
printf '%s\n' 'limit_req_zone $binary_remote_addr zone=door_requests:1m rate=2r/s;' > /etc/nginx/conf.d/door-rate-limit.conf
python3 - <<'PY'
from pathlib import Path
path = Path('/etc/nginx/sites-enabled/site.conf')
text = path.read_text()
include = '    include /etc/nginx/snippets/door-access.conf;'
if include not in text:
    marker = '    location / {'
    if text.count(marker) != 1:
        raise SystemExit('Expected one root location; inspect nginx config before adding the include.')
    backup = Path('/etc/nginx/site.conf.before-door')
    if not backup.exists():
        backup.write_text(text)
    path.write_text(text.replace(marker, include + '\n\n' + marker))
PY
nginx -t
systemctl daemon-reload
systemctl enable door-access
systemctl restart door-access
systemctl reload nginx
systemctl is-active door-access
