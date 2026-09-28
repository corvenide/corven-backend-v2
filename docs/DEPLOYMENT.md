# Deploying to AWS Lightsail

This guide deploys the backend and the frontend ([corven-fronted](https://github.com/corvenide/corven-fronted)) to one Ubuntu Lightsail instance:

| Domain | Serves |
|---|---|
| `https://corvanide.space` | Frontend (static build) |
| `https://staging-api.corvanide.space/api` | REST API (api-gateway) |
| `https://staging-api.corvanide.space/socket.io` | Terminal, build and test WebSockets (terminal-service) |

```text
                      ┌─────────────────────── Lightsail instance ────────────────────────┐
 corvanide.space ────▶│ Caddy :443 ── /srv/web (frontend build)                           │
 staging-api.    ────▶│   ├─ /socket.io/* ─▶ terminal-service ─┐                          │
 corvanide.space      │   └─ everything else ─▶ api-gateway ─▶ auth / workspace /         │
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

Stopped workspaces don't count, and workspaces nobody has used for 20 minutes are stopped automatically (`WORKSPACE_IDLE_MINUTES`). `setup-server.sh` sets `HOST_MAX_WORKSPACES` from the server's RAM; when the server is full, starting another workspace fails with a clear "at capacity" message instead of running out of memory. To move to a bigger plan later: create a snapshot, create a new instance from it with a larger plan, then move the static IP to it.

**Static IP.** Lightsail public IPs change when an instance is stopped and started. In the Lightsail console, open **Networking → Create static IP**, attach it to the instance, and use that IP in DNS below.

**Firewall.** On the instance's **Networking** tab, keep SSH (22) and add:

- HTTPS: TCP 443
- HTTP: TCP 80 (needed for certificate issuance and redirects)

Remove any other open ports.

## 2. Point DNS at the server (Namecheap)

In Namecheap, open **Domain List → corvanide.space → Manage → Advanced DNS** and add:

| Type | Host | Value |
|---|---|---|
| A Record | `@` | your static IP |
| CNAME Record | `www` | `corvanide.space.` |
| A Record | `staging-api` | your static IP |

Remove any conflicting parking-page records for `@` and `www`. Check propagation before deploying (Caddy can't get certificates until DNS resolves):

```bash
dig +short corvanide.space
dig +short staging-api.corvanide.space
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
git clone git@github-platform:corvenide/corven-fronted.git platform
```

(For public repositories, clone with the plain `https://github.com/...` URLs instead.)

## 4. Set up the server (once)

```bash
cd /opt/corven/backend
bash deploy/setup-server.sh
newgrp docker   # or log out and back in
```

This installs Docker, enables log rotation for all containers, adds a 4 GB swap file if there is none, creates `/opt/corven/web` for the frontend, and writes `deploy/.env` with a generated database password and JWT secret.

Open `deploy/.env` and check the domains and `CORS_ORIGINS`. To turn on the Claude assistant, set `ANTHROPIC_API_KEY`. Keep this file private; it holds the secrets.

## 5. Deploy the backend

```bash
cd /opt/corven/backend
bash deploy/deploy.sh
```

The first run takes a while (about 15–30 minutes) because it builds the workspace images (the runtime image includes LLVM and Rust tools) and the shared build-cache image. It then builds the backend image, runs database migrations, and starts every service and Caddy.

Check it:

```bash
curl https://staging-api.corvanide.space/api/health
curl https://staging-api.corvanide.space/api/health/runtime
```

## 6. Deploy the frontend

```bash
cd /opt/corven/platform
bash deploy/deploy.sh
```

This builds the app in a temporary Node container with:

- `VITE_API_URL=https://staging-api.corvanide.space/api`
- `VITE_TERMINAL_URL=https://staging-api.corvanide.space`

and copies the result to `/opt/corven/web`, which Caddy serves at `https://corvanide.space`. Override either URL by setting it before the command.

## Updating

```bash
cd /opt/corven/backend && bash deploy/deploy.sh    # backend
cd /opt/corven/platform && bash deploy/deploy.sh   # frontend
```

Each script pulls the latest code on the checked-out branch, rebuilds, and restarts only what changed. Add `--no-pull` to deploy what is already checked out.

## Automatic deploys (CI/CD)

Both repositories have two GitHub Actions workflows:

| Workflow | Runs on | Does |
|---|---|---|
| `test.yml` | every pull request | Builds and runs unit and end-to-end tests |
| `deploy.yml` | every push to `main` (and by hand from the Actions tab) | Runs the same tests, then deploys to the server and checks the site is up |

A deploy only happens when every test passes. It connects to the server over SSH and runs `deploy/ci-deploy.sh`, which runs the same `deploy/deploy.sh` described above. The SSH key GitHub uses can't do anything else on the server.

### One-time setup

**1. Make `git pull` work without a password on the server.** Deploys run `git pull` unattended. If you cloned with deploy keys (step 3 above), this already works. If you cloned over HTTPS with a token, store it once:

```bash
cd /opt/corven/backend && git config credential.helper store && git pull
cd /opt/corven/platform && git config credential.helper store && git pull
```

**2. Create a key for GitHub Actions** (on your laptop):

```bash
ssh-keygen -t ed25519 -f corven-deploy -N "" -C github-actions
```

This makes `corven-deploy` (private) and `corven-deploy.pub` (public).

**3. Let that key run deploys, and nothing else** (on the server). Add one line to `~/.ssh/authorized_keys`, replacing `ssh-ed25519 AAAA...` with the contents of `corven-deploy.pub`:

```bash
echo 'command="/opt/corven/backend/deploy/ci-deploy.sh",restrict ssh-ed25519 AAAA... github-actions' >> ~/.ssh/authorized_keys
```

`command=` forces the deploy script whatever the client asks for, and `restrict` turns off shells, port forwarding and the rest. Your own login key is unaffected.

**4. Get the server's host key** (on your laptop), so GitHub can check it's talking to your server:

```bash
ssh-keyscan -t ed25519 STATIC_IP
```

**5. Add secrets in both GitHub repositories.** In each repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the server's static IP |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | the whole contents of `corven-deploy` (the private key) |
| `DEPLOY_KNOWN_HOSTS` | the output of the `ssh-keyscan` command |

Then delete the private key from your laptop.

**6. (Optional) Require approval.** Deploy jobs use a GitHub environment called `production`. In **Settings → Environments → production**, add yourself under *Required reviewers* to approve each deploy by hand.

### Using it

- Merge a pull request, or push to `main`: tests run, then the deploy. Follow it in the repository's **Actions** tab.
- Re-deploy without a new commit: **Actions → Deploy → Run workflow**.
- A failed test stops the deploy, and the server keeps running the previous version.
- If the frontend and API move to other domains, set the repository variables `SITE_URL` (frontend repo) and `API_URL` (backend repo) under **Settings → Secrets and variables → Actions → Variables**, so the post-deploy checks look in the right place.

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

1. **Bigger instance.** Snapshot and recreate on a larger plan (see the table above), then raise `HOST_MAX_WORKSPACES` in `deploy/.env` and redeploy.
2. **More workspace servers.** The backend can place workspaces on several Docker hosts (`DOCKER_HOSTS`). Create more Lightsail instances in the same region, install Docker and build the three images on each (`fiberdev/ckb-node:dev`, `fiberdev/ckb-runtime:dev`, `corven/build-cache:dev`), and list them in `deploy/.env`, reachable over the private network with TLS. New workspaces go to the host with the most free slots. See [`HOSTS, BUILD CACHE AND AI.md`](HOSTS,%20BUILD%20CACHE%20AND%20AI.md) for the format, health checks and draining a host.
3. **Managed database.** Create a Lightsail managed PostgreSQL database in the same region, set `DATABASE_URL` in `deploy/.env` to it (with `?sslmode=require`), and redeploy. This takes database load and backups off the instance.
4. **CDN for the frontend.** Put a Lightsail distribution in front of `corvanide.space` to serve the static files from edge locations.

## Troubleshooting

**Browser shows a certificate error or Caddy logs `challenge failed`.** DNS doesn't point at the server yet, or port 80 is closed in the Lightsail firewall. Fix it and run `docker compose -f deploy/docker-compose.yml restart caddy`.

**Frontend loads but API calls fail with a CORS error.** The page's origin isn't in `CORS_ORIGINS` in `deploy/.env`. Add it and redeploy.

**Starting a workspace fails with an image error.** The workspace images are missing. Rebuild them with `bash deploy/deploy.sh --no-pull`.

**Workspaces fail to start or containers get killed.** The instance is out of memory. Check `free -h` and `docker stats`, stop unused workspaces, or move to a bigger plan.
