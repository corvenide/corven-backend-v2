#!/usr/bin/env bash
# Build and (re)start the backend on the server. Run from the backend checkout:
#   bash deploy/deploy.sh             # pull latest code, rebuild, restart
#   bash deploy/deploy.sh --no-pull   # deploy what is checked out
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f deploy/.env ]; then
    echo "deploy/.env is missing. Run deploy/setup-server.sh first." >&2
    exit 1
fi

if [ "${1:-}" != "--no-pull" ]; then
    echo "==> Pulling latest code"
    git pull --ff-only
fi

# The runtime service starts workspaces and the shared build cache from these.
echo "==> Building workspace images"
docker build -t fiberdev/ckb-node:dev docker/ckb-node
docker build -t fiberdev/ckb-runtime:dev docker/ckb-runtime
docker build -t corven/build-cache:dev docker/build-cache

compose=(docker compose -f deploy/docker-compose.yml)

echo "==> Building backend image"
"${compose[@]}" build migrate

echo "==> Starting services (migrations run first)"
"${compose[@]}" up -d --remove-orphans

docker image prune -f >/dev/null

"${compose[@]}" ps
echo
echo "Check: curl https://$(grep '^API_DOMAIN=' deploy/.env | cut -d= -f2)/api/health"
