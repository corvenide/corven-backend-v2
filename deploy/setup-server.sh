#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu Lightsail instance. Run from the backend
# checkout as the ubuntu user:
#   bash deploy/setup-server.sh
# Safe to re-run: every step skips work that is already done.
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_ROOT=/opt/corven/web

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

# Rotate logs of every container, including the workspace containers the
# runtime service creates, so they can't fill the disk.
if [ ! -f /etc/docker/daemon.json ]; then
    echo "==> Enabling Docker log rotation"
    echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' |
        sudo tee /etc/docker/daemon.json >/dev/null
    sudo systemctl restart docker
fi

# Swap keeps image builds (LLVM, Rust) from getting OOM-killed on smaller plans.
if ! swapon --show | grep -q .; then
    echo "==> Adding a 4 GB swap file"
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Creating $WEB_ROOT for the frontend build"
sudo mkdir -p "$WEB_ROOT"
sudo chown "$USER":"$USER" "$WEB_ROOT"

if [ ! -f deploy/.env ]; then
    echo "==> Creating deploy/.env with generated secrets"
    db_password=$(openssl rand -hex 24)
    jwt_secret=$(openssl rand -hex 48)
    # Each running workspace needs about 3 GB; keep 2 GB for the platform.
    mem_gb=$(free -g | awk '/^Mem:/ {print $2}')
    max_workspaces=$(( (mem_gb - 2) / 3 ))
    [ "$max_workspaces" -ge 1 ] || max_workspaces=1
    sed -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${db_password}#" \
        -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://corven:${db_password}@postgres:5432/corven#" \
        -e "s#^JWT_SECRET=.*#JWT_SECRET=${jwt_secret}#" \
        -e "s#^HOST_MAX_WORKSPACES=.*#HOST_MAX_WORKSPACES=${max_workspaces}#" \
        deploy/.env.example >deploy/.env
    chmod 600 deploy/.env
else
    echo "==> deploy/.env already exists; leaving it unchanged"
fi

cat <<'EOF'

Setup done. Next:
  1. Log out and back in so the docker group applies (or run: newgrp docker).
  2. Review deploy/.env (domains, CORS_ORIGINS, ANTHROPIC_API_KEY).
  3. Deploy the backend:  bash deploy/deploy.sh
EOF
