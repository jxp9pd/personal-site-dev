#!/bin/bash
# Forced SSH command for the deploy user (installed at /usr/local/bin/deploy-site.sh).
# Publishes main, then reinstalls the Vestaboard gateway when its code changed
# since the last successful install.
set -euo pipefail
cd "${DEPLOY_REPO:-/var/www/personal-site-dev}"
installed_rev_file=${GATEWAY_REV_FILE:-/var/lib/vestaboard-note/installed-rev}
git fetch --prune origin
git reset --hard origin/main
echo "deployed $(git rev-parse --short HEAD) at $(date -u +%FT%TZ)"

installed=$(cat "$installed_rev_file" 2>/dev/null || true)
if [[ -n $installed ]] && git cat-file -e "$installed^{commit}" 2>/dev/null \
        && ! git diff --name-only "$installed" HEAD -- services/vestaboard \
            | grep -qvE '(^|/)(test_[^/]*\.py|README\.md)$'; then
    echo "gateway unchanged since ${installed:0:7}"
    exit 0
fi
sudo -n /usr/local/sbin/install-vestaboard-gateway
