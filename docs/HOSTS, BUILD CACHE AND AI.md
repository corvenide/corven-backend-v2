# Hosts, build cache and AI

Operator notes for three features: running workspaces on several Docker hosts, the shared Rust build cache, and the Claude assistant.

## 1. Several Docker hosts

Each workspace lives on one host (`Workspace.hostId`), because its volumes are local to that host.

### Configure

With no `DOCKER_HOSTS` set, there is one host called `local`, on `DOCKER_SOCKET_PATH`. Single-machine setups need no change.

To add hosts, set `DOCKER_HOSTS` in `backend/.env`. Every service that talks to Docker reads it: runtime-service, file-service and terminal-service.

```env
DOCKER_HOSTS=[{"id":"local","endpoint":"unix:///Users/me/.colima/default/docker.sock","maxWorkspaces":4},{"id":"eu-1","endpoint":"tcp://10.0.0.12:2376","certPath":"/etc/corven/certs/eu-1","maxWorkspaces":20},{"id":"eu-2","endpoint":"ssh://corven@10.0.0.13","maxWorkspaces":20}]
```

You can also use the short form `id=endpoint,id=endpoint`. In that form every host gets the capacity set by `HOST_MAX_WORKSPACES` (default 8).

The endpoint can be one of:

| Endpoint | Connection |
|---|---|
| `unix:///path` | A local socket. |
| `tcp://host:2376` | A remote daemon. Uses TLS when `certPath` points at a folder containing `ca.pem`, `cert.pem` and `key.pem`. |
| `ssh://user@host` | SSH, using your ssh-agent (`SSH_AUTH_SOCK`). |

Every host needs the three images: `fiberdev/ckb-runtime:dev`, `fiberdev/ckb-node:dev` and `corven/build-cache:dev`.

### Placement

- **New workspace:** goes to the online, non-draining host with the most free slots. Free slots are `maxWorkspaces` minus the workspaces running or starting there. Placement takes a Postgres advisory lock, so two starts can't both take a host's last slot.
- **Workspace that has run before:** stays on its host.
- **Moving hosts:** a workspace moves only when its host is offline, draining or full, *and* the database holds a copy of its files. The copy is restored on the new host, and files the user deleted stay deleted. Build output and the devnet chain are not moved, so the first build on the new host is a full one.
- **Everything full:** the start fails with "All workspace servers are at capacity…".

### Health

runtime-service pings every host once a minute. A host is marked OFFLINE after 3 failed checks in a row. At that point its running workspaces are marked FAILED with a clear message, so users can start them again, on another host if needed.

Containers left behind by workspaces that moved away are removed when their host comes back.

### Take a host out of service

Mark the host as draining:

```sql
UPDATE "Host" SET draining = true WHERE id = 'eu-1';
```

Running workspaces keep running. From then on, each one moves to another host the next time it starts. The change takes effect within a minute.

## 2. Shared Rust build cache

Every workspace build goes through sccache (the `corven-rustc-wrapper` in the runtime image). It uses two cache levels:

1. **A local cache** inside the workspace container. It is read-write.
2. **A shared cache for the host** (`corven-build-cache`), reached at `http://corven-cache:8081`. It is **read-only** for workspaces.

Only Corven's cache warmer writes to the shared cache. The warmer builds the project template with trusted inputs, once per runtime image per host.

Users can't write to the shared cache. If they could, one user could plant a compiled artifact that another user's build would then pick up.

If the cache is unreachable, builds fall back to the local cache. If sccache can't start at all, they fall back to plain rustc. A cache problem never fails a build.

### Setup

Run once per host:

```bash
docker build -t corven/build-cache:dev docker/build-cache
docker build -t fiberdev/ckb-runtime:dev docker/ckb-runtime   # rebuild: adds sccache and the wrapper
```

runtime-service then starts the cache container, attaches it to workspace networks and runs the warmer by itself.

### Settings

| Setting | Effect |
|---|---|
| `BUILD_CACHE=off` | Disables the shared cache. |
| `BUILD_CACHE_IMAGE` | Image for the cache container. Default `corven/build-cache:dev`. |
| `BUILD_CACHE_WARM=off` | Skips the warmer. |
| `BUILD_CACHE_WARM_CRATES="molecule ckb-hash"` | Extra crates to pre-build (best effort). |
| `BUILD_CACHE_WRITE_TOKEN` | Optional token for the warmer. Otherwise one is generated per host. |

Cache entries older than 30 days are dropped (`CACHE_MAX_AGE_DAYS` on the cache container). The warmer refills them.

## 3. Claude assistant

The API key stays on the server. The browser only talks to `/api/ai/*` on the gateway, which streams Claude's replies back.

```env
ANTHROPIC_API_KEY=sk-ant-...
# optional
ANTHROPIC_MODEL=claude-sonnet-5
ANTHROPIC_MODELS=claude-sonnet-5,claude-opus-5-5,claude-haiku-4-5-20251001
ANTHROPIC_MAX_TOKENS=4096
AI_REQUESTS_PER_10_MIN=40
```

Restart the API gateway after changing these settings.

Each question sends:

- the conversation (bounded in size);
- the open file and its selection, unless the user turns that off;
- the project's file list;
- for "Ask Claude" on a failed build or test, the end of that output.

There are two endpoints:

| Endpoint | What it does |
|---|---|
| `GET /api/ai/status` | Reports whether the assistant is enabled and which models can be used. |
| `POST /api/ai/chat` | Server-sent events: `delta`, `done`, `error`. |
