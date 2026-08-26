#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-telecom-site.service}"
APACHE_SITE="${APACHE_SITE:-telecom-site.conf}"
BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:4173}"

failures=0
check() {
  local label="$1"; shift
  printf '[check] %s\n' "$label"
  if "$@"; then printf '  PASS\n'; else printf '  FAIL\n'; failures=$((failures + 1)); fi
}

check 'Node.js >= 24' bash -c 'major=$(node -p "Number(process.versions.node.split(\".\")[0])"); test "$major" -ge 24'
check 'systemd service is active' systemctl is-active --quiet "$SERVICE_NAME"
check 'systemd service is enabled' systemctl is-enabled --quiet "$SERVICE_NAME"
check 'Apache configuration syntax' sudo -n apachectl configtest
check 'Apache site configuration exists' test -f "/etc/apache2/sites-enabled/$APACHE_SITE"
check 'Application listens only on loopback:4173' bash -c "ss -ltnp | grep -E '127\\.0\\.0\\.1:4173[[:space:]]' >/dev/null"
check 'Local health endpoint' curl --fail --silent --show-error --max-time 5 "$BASE_URL/api/v1/health" -o /dev/null
check 'Local Catalog endpoint' curl --fail --silent --show-error --max-time 5 "$BASE_URL/api/v1/catalog/products" -o /dev/null

printf '\nRecent service log (read-only):\n'
journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true

if (( failures > 0 )); then
  printf '\n%d host verification check(s) failed.\n' "$failures" >&2
  exit 1
fi
printf '\nAll host verification checks passed.\n'
