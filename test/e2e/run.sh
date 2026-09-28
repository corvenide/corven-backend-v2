#!/usr/bin/env bash
# Runs the end-to-end tests against a throwaway backend stack in Docker.
#
#   bash test/e2e/run.sh              # build, start, test, remove
#   KEEP=1 bash test/e2e/run.sh       # leave the stack running afterwards
#   NO_BUILD=1 bash test/e2e/run.sh   # reuse an existing corven-backend:e2e image
#
# To test a stack you started yourself, skip this script:
#   E2E_API_URL=http://localhost:8000/api pnpm test:e2e
set -euo pipefail

cd "$(dirname "$0")/../.."

export E2E_PORT="${E2E_PORT:-8000}"
export E2E_API_URL="http://127.0.0.1:${E2E_PORT}/api"
export E2E_DB_PORT="${E2E_DB_PORT:-5433}"
export E2E_DATABASE_URL="postgresql://corven:corven@127.0.0.1:${E2E_DB_PORT}/corven"

compose=(docker compose -f test/e2e/docker-compose.yml)

cleanup() {
    if [ "${KEEP:-}" = "1" ]; then
        echo "Stack left running (KEEP=1). Remove it with: ${compose[*]} down -v"
    else
        "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

build_flag=(--build)
[ "${NO_BUILD:-}" = "1" ] && build_flag=(--no-build)

echo "==> Starting the e2e stack"
"${compose[@]}" up -d "${build_flag[@]}"

echo "==> Waiting for the API"
for _ in $(seq 1 60); do
    if curl -fsS "${E2E_API_URL}/health/runtime" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

if ! curl -fsS "${E2E_API_URL}/health/runtime" >/dev/null; then
    echo "The API did not come up. Service logs:" >&2
    "${compose[@]}" logs --tail 50 >&2
    exit 1
fi

echo "==> Running tests"
node_modules/.bin/jest --config test/e2e/jest-e2e.json --runInBand "$@"
