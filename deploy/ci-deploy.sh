#!/usr/bin/env bash
# Entry point for deploys from GitHub Actions.
#
# The CI key's line in ~/.ssh/authorized_keys forces this script, so that key
# can run nothing else on the server:
#
#   command="/opt/corven/backend/deploy/ci-deploy.sh",restrict ssh-ed25519 AAAA... github-actions
#
# The workflow names what to deploy as the SSH command: "backend" or "frontend".
set -euo pipefail

target="${SSH_ORIGINAL_COMMAND:-${1:-}}"

# One deploy at a time; a second one waits for the first to finish.
exec 9>/tmp/corven-deploy.lock
flock 9

case "$target" in
    backend)
        cd /opt/corven/backend
        exec bash deploy/deploy.sh
        ;;
    frontend)
        cd /opt/corven/platform
        exec bash deploy/deploy.sh
        ;;
    *)
        echo "Usage: backend | frontend" >&2
        exit 2
        ;;
esac
