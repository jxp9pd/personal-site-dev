#!/usr/bin/env bash
# Run as root on the UTC-configured Hetzner host; safe to repeat.
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")/.."
test "$(id -u)" = 0
test "$(timedatectl show -p Timezone --value)" = Etc/UTC
test -f /var/www/personal-site-dev/scripts/refresh-fantasy.py
test -f /etc/vestaboard-history.env
command -v flock >/dev/null
systemctl is-active --quiet cron
install -d -m 755 /usr/local/lib/fantasy-refresh
install -d -m 700 /var/lib/fantasy-refresh
install -m 644 scripts/weekly-fantasy-refresh.py /usr/local/lib/fantasy-refresh/weekly-fantasy-refresh.py
install -m 644 services/fantasy-refresh/logrotate.conf /etc/logrotate.d/fantasy-refresh
touch /var/log/fantasy-refresh.log
chmod 640 /var/log/fantasy-refresh.log
chown root:adm /var/log/fantasy-refresh.log
# Install the schedule last, after all dependencies are in place.
install -m 644 services/fantasy-refresh/cron /etc/cron.d/fantasy-refresh
printf '%s\n' 'Installed Fantasy refresh: Wednesday at 06:00 America/Los_Angeles.'
