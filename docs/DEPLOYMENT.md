# Deploying to AWS Lightsail

This guide deploys the backend and the frontend ([corven-platform](https://github.com/lestonEth/corven-platform)) to one Ubuntu Lightsail instance:

| Domain | Serves |
|---|---|
| `https://corven.space` | Frontend (static build) |
| `https://staging-api.corvan.space/api` | REST API (api-gateway) |
| `https://staging-api.corvan.space/socket.io` | Terminal, build and test WebSockets (terminal-service) |

```text
                 ┌─────────────────────── Lightsail instance ────────────────────────┐
 corven.space ──▶│ Caddy :443 ── /srv/web (frontend build)                           │
 staging-api. ──▶│   ├─ /socket.io/* ─▶ terminal-service ─┐                          │
 corvan.space    │   └─ everything else ─▶ api-gateway ─▶ auth / workspace /         │
                 │                                        runtime / file services    │
                 │   PostgreSQL          Docker daemon ◀──┘  (one CKB node + one     │
                 │                                            build container per     │
                 │                                            running workspace)      │
                 └───────────────────────────────────────────────────────────────────┘
```

Caddy gets HTTPS certificates from Let's Encrypt automatically. Only ports 22, 80 and 443 are open to the internet; the services, PostgreSQL and the workspace containers are reachable only inside the server.

## 1. Prepare the instance

**Size.** Each running workspace uses about 3 GB of RAM (2 GB build container + 1 GB CKB node), plus about 2 GB for the platform itself. Check what you have:

```bash
free -h && nproc
```

| Lightsail plan | Workspaces running at once |
|---|---|
| 8 GB | about 2 |
| 16 GB | about 4 |
| 32 GB | about 9 |
| 64 GB | about 20 |

Stopped workspaces don't count. To move to a bigger plan later: create a snapshot, create a new instance from it with a larger plan, then move the static IP to it.

**Static IP.** Lightsail public IPs change when an instance is stopped and started. In the Lightsail console, open **Networking → Create static IP**, attach it to the instance, and use that IP in DNS below.

**Firewall.** On the instance's **Networking** tab, keep SSH (22) and add:

- HTTPS: TCP 443
- HTTP: TCP 80 (needed for certificate issuance and redirects)

Remove any other open ports.

## 2. Point DNS at the server (Namecheap)

In Namecheap, open **Domain List → Manage → Advanced DNS** for each domain and add:

| Domain | Type | Host | Value |
|---|---|---|---|
| corven.space | A Record | `@` | your static IP |
| corven.space | CNAME Record | `www` | `corven.space.` |
| corvan.space | A Record | `staging-api` | your static IP |

Remove any conflicting parking-page records for `@` and `www`. Check propagation before deploying (Caddy can't get certificates until DNS resolves):

```bash
dig +short corven.space
dig +short staging-api.corvan.space
```

## 3. Get the code onto the server

SSH in:

```bash
ssh -i LightsailDefaultKey-ap-south-1.pem ubuntu@<static-ip>
```

If the repositories are private, give the server read access first. The simplest way is a deploy key per repository:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/corven_backend -N ""
ssh-keygen -t ed25519 -f ~/.ssh/corven_platform -N ""
cat ~/.ssh/corven_backend.pub   # add in GitHub: repo → Settings → Deploy keys
cat ~/.ssh/corven_platform.pub  # same, on the other repository

cat >> ~/.ssh/config <<'EOF'
Host github-backend
    HostName github.com
    IdentityFile ~/.ssh/corven_backend
Host github-platform
    HostName github.com
    IdentityFile ~/.ssh/corven_platform
EOF
```

Clone both repositories under `/opt/corven`:

```bash
sudo mkdir -p /opt/corven && sudo chown ubuntu:ubuntu /opt/corven
cd /opt/corven
git clone git@github-backend:corvenide/corven-backend-v2.git backend
git clone git@github-platform:lestonEth/corven-platform.git platform
```

(For public repositories, clone with the plain `https://github.com/...` URLs instead.)

## 4. Set up the server (once)

```bash
cd /opt/corven/backend
bash deploy/setup-server.sh
newgrp docker   # or log out and back in
```

This installs Docker, enables log rotation for all containers, adds a 4 GB swap file if there is none, creates `/opt/corven/web` for the frontend, and writes `deploy/.env` with a generated database password and JWT secret.

Open `deploy/.env` and check the domains and `CORS_ORIGINS`. Keep this file private; it holds the secrets.

## 5. Deploy the backend

```bash
cd /opt/corven/backend
bash deploy/deploy.sh
```

The first run takes a while (about 15–30 minutes) because it builds the workspace runtime image with LLVM and Rust tools. It then builds the backend image, runs database migrations, and starts every service and Caddy.

Check it:

```bash
curl https://staging-api.corvan.space/api/health
curl https://staging-api.corvan.space/api/health/runtime
```

## 6. Deploy the frontend

```bash
cd /opt/corven/platform
bash deploy/deploy.sh
```

This builds the app in a temporary Node container with:

- `VITE_API_URL=https://staging-api.corvan.space/api`
- `VITE_TERMINAL_URL=https://staging-api.corvan.space`

and copies the result to `/opt/corven/web`, which Caddy serves at `https://corven.space`. Override either URL by setting it before the command.

## Updating

```bash
cd /opt/corven/backend && bash deploy/deploy.sh    # backend
cd /opt/corven/platform && bash deploy/deploy.sh   # frontend
```

Each script pulls the latest code on the checked-out branch, rebuilds, and restarts only what changed. Add `--no-pull` to deploy what is already checked out.

## Operating

```bash
cd /opt/corven/backend
docker compose -f deploy/docker-compose.yml ps                  # status
docker compose -f deploy/docker-compose.yml logs -f api-gateway # logs of one service
docker compose -f deploy/docker-compose.yml restart runtime-service
docker ps --filter name=fiberdev-                               # workspace containers
```

**Backups.** Enable **automatic snapshots** on the instance (Lightsail console → Snapshots). For a database-only backup:

```bash
docker compose -f deploy/docker-compose.yml exec -T postgres \
    pg_dump -U corven corven | gzip > ~/corven-$(date +%F).sql.gz
```

## Scaling

What limits the number of users is the number of **running workspaces**, since each one is a pair of containers with reserved memory. The API, auth, and the static frontend are light and won't be the bottleneck on a single instance.

In order of effort:

1. **Bigger instance.** Snapshot and recreate on a larger plan (see the table above). This is the only step needed for the first few hundred users, as long as they aren't all running workspaces at once.
2. **Managed database.** Create a Lightsail managed PostgreSQL database in the same region, set `DATABASE_URL` in `deploy/.env` to it (with `?sslmode=require`), and redeploy. This takes database load and backups off the instance.
3. **CDN for the frontend.** Put a Lightsail distribution in front of `corven.space` to serve the static files from edge locations.
4. **Stop idle workspaces.** The frontend already calls `POST /workspaces/:id/heartbeat`, but the backend doesn't implement it yet, so workspaces keep running until a user stops them. Stopping workspaces with no recent heartbeat frees memory for active users.
5. **More than one workspace server.** The runtime, file and terminal services currently talk to a single Docker daemon, so all workspaces run on one machine. Spreading workspaces across several servers needs a backend change: record which server hosts each workspace, and route runtime, file and terminal calls to that server's Docker daemon.

## Troubleshooting

**Browser shows a certificate error or Caddy logs `challenge failed`.** DNS doesn't point at the server yet, or port 80 is closed in the Lightsail firewall. Fix it and run `docker compose -f deploy/docker-compose.yml restart caddy`.

**Frontend loads but API calls fail with a CORS error.** The page's origin isn't in `CORS_ORIGINS` in `deploy/.env`. Add it and redeploy.

**Starting a workspace fails with an image error.** The workspace images are missing. Rebuild them with `bash deploy/deploy.sh --no-pull`.

**Workspaces fail to start or containers get killed.** The instance is out of memory. Check `free -h` and `docker stats`, stop unused workspaces, or move to a bigger plan.
