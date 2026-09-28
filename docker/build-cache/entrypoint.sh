#!/bin/sh
set -eu

token="${CACHE_WRITE_TOKEN:-}"
case "$token" in
    ''|*[!A-Za-z0-9]*)
        echo "CACHE_WRITE_TOKEN must be set to letters and digits only" >&2
        exit 1
        ;;
esac

mkdir -p /cache/sccache /cache/.upload-tmp
chown -R nginx:nginx /cache/sccache /cache/.upload-tmp

sed "s/__CACHE_WRITE_TOKEN__/${token}/" /etc/corven/nginx.conf.template > /etc/nginx/nginx.conf

# Entries nobody has rewritten for a while are dropped; the warmer refills
# the cache (its completion marker ages out with the rest).
max_age_days="${CACHE_MAX_AGE_DAYS:-30}"
(
    while true; do
        sleep 21600
        find /cache/sccache -type f -mtime "+${max_age_days}" -delete 2>/dev/null || true
        find /cache/sccache -mindepth 1 -type d -empty -delete 2>/dev/null || true
    done
) &

exec nginx -g 'daemon off;'
