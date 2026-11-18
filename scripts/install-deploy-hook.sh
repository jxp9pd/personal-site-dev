#!/usr/bin/env bash
# Run as root on the Hetzner host from a checkout; safe to repeat.
set -euo pipefail
cd -- "$(dirname -- "$0")/../services/deploy"
test "$(id -u)" = 0
id deploy >/dev/null
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
install -m 440 sudoers "$sudoers"
visudo -cf "$sudoers"
install -m 755 install-vestaboard-gateway /usr/local/sbin/install-vestaboard-gateway
install -m 440 "$sudoers" /etc/sudoers.d/vestaboard-gateway-deploy
install -m 755 deploy-site.sh /usr/local/bin/deploy-site.sh
install -m 644 nginx-page-cache.conf /etc/nginx/conf.d/page-cache.conf
nginx -t
systemctl reload nginx
visudo -c >/dev/null
sudo -l -U deploy | tail -n 1
