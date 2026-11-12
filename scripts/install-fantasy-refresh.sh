#!/usr/bin/env bash
# Run as root on the Hetzner host from a checkout; safe to repeat.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
test "$(id -u)" = 0
test -f /var/www/personal-site-dev/scripts/refresh-fantasy.py
test -f /var/www/personal-site-dev/scripts/weekly-fantasy-refresh.py
test -f /etc/vestaboard-history.env
install -d -m 700 /var/lib/fantasy-refresh
# Remove the old cron schedule first so the refresh can never run twice.
rm -f /etc/cron.d/fantasy-refresh /etc/logrotate.d/fantasy-refresh
rm -rf /usr/local/lib/fantasy-refresh
install -m 644 services/fantasy-refresh/fantasy-refresh.service /etc/systemd/system/fantasy-refresh.service
install -m 644 services/fantasy-refresh/fantasy-refresh.timer /etc/systemd/system/fantasy-refresh.timer
systemctl daemon-reload
systemctl enable --now fantasy-refresh.timer
systemctl list-timers fantasy-refresh.timer --no-pager
