# Corven Backend

Backend services for **Corven IDE** (formerly FiberDev Studio), a browser-based development environment for Nervos CKB and Fiber Network projects.

The backend is a NestJS monorepo of microservices. It handles authentication (email/password and CKB wallet), workspace management, per-workspace Docker runtimes (a CKB dev node plus a Rust/RISC-V build container), workspace file operations, and real-time terminal, build, and test sessions over WebSockets.

## Architecture

```text
                     ┌──────────────────────┐
  Browser  ── HTTP ─▶│ api-gateway  :8000   │── TCP ─┬─▶ auth-service       :8001
  (Corven IDE)       │ (REST, /api prefix)  │        ├─▶ workspace-service  :8002 ──▶ runtime-service
                     └──────────────────────┘        ├─▶ runtime-service    :8003 ──▶ Docker
                                                     └─▶ file-service       :8005 ──▶ Docker
           ── WebSocket (socket.io) ─▶ terminal-service :8004 (/terminal) ──▶ Docker
                                                                   └─ TCP ─▶ auth-service
```

| Service | Transport | Default port | Responsibility |
|---|---|:---:|---|
| `api-gateway` | HTTP | 8000 | Public REST API (prefix `/api`); forwards requests to the microservices |
| `auth-service` | TCP | 8001 | Registration, login, JWT issuing/verification, CKB wallet challenge login |
| `workspace-service` | TCP | 8002 | Workspace CRUD; asks the runtime service to clean up on delete |
| `runtime-service` | TCP | 8003 | Docker networks, volumes, and containers for each workspace; build, test, run |
| `terminal-service` | HTTP + socket.io | 8004 | Interactive terminals and streamed build/test runs inside the runtime container |
| `file-service` | TCP | 8005 | List, read, create, update, rename, and delete files in a workspace volume |

Shared code lives in `libs/prisma` (Prisma client wrapper, backed by PostgreSQL).

## Tech stack

- NestJS 11 (monorepo mode, TCP microservices, socket.io gateway)
- Prisma 7 with PostgreSQL (`@prisma/adapter-pg`)
- Docker via `dockerode`
- JWT auth (`@nestjs/jwt`, `bcryptjs`) and CKB wallet signatures (`@ckb-ccc/core`)
- TypeScript, Jest, ESLint, Prettier, pnpm

## Repository layout

```text
apps/
  api-gateway/         REST entry point
  auth-service/        users, JWT, wallet auth
  workspace-service/   workspace records
  runtime-service/     Docker lifecycle for workspace runtimes
  terminal-service/    WebSocket terminal / build / test gateway
  file-service/        workspace file operations
libs/prisma/           shared PrismaService
prisma/                schema.prisma and migrations
docker/
  ckb-node/            CKB dev node image (offckb)
  ckb-runtime/         Rust + RISC-V + LLVM build image
docs/
  APIS DOCUMENTATION.md
  DOCKER RUNTIME IMAGE.md
```

## Prerequisites

- Node.js 22+ and pnpm
- PostgreSQL 14+
- Docker, with the daemon socket reachable by the runtime, terminal, and file services

## Getting started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure the environment

Create a `.env` file in the repository root. Set every service port explicitly: some services fall back to different defaults from the ones their clients expect (for example, the runtime service defaults to `4003` when unset, while the gateway expects `8004` and the workspace service expects `8003`).

```env
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corven

# Auth
JWT_SECRET=change-me
JWT_EXPIRES_IN=1d

# Service addresses
API_GATEWAY_HOST=127.0.0.1
API_GATEWAY_PORT=8000
AUTH_SERVICE_HOST=127.0.0.1
AUTH_SERVICE_PORT=8001
WORKSPACE_SERVICE_HOST=127.0.0.1
WORKSPACE_SERVICE_PORT=8002
RUNTIME_SERVICE_HOST=127.0.0.1
RUNTIME_SERVICE_PORT=8003
TERMINAL_SERVICE_PORT=8004
FILE_SERVICE_HOST=127.0.0.1
FILE_SERVICE_PORT=8005

# Docker runtime
DOCKER_SOCKET_PATH=/var/run/docker.sock
CKB_NODE_IMAGE=fiberdev/ckb-node:dev
FIBER_RUNTIME_IMAGE=fiberdev/ckb-runtime:dev
DEFAULT_PROJECT_NAME=ckb-rust-script
DEFAULT_CONTRACT_NAME=hello-world

# Optional container resource limits
CKB_NODE_MEMORY_BYTES=1073741824
CKB_NODE_NANO_CPUS=1000000000
RUNTIME_MEMORY_BYTES=2147483648
RUNTIME_NANO_CPUS=2000000000
```

Always set `JWT_SECRET` outside local development; the auth service falls back to a hard-coded default when it is missing.

### 3. Set up the database

```bash
pnpm prisma migrate dev     # apply migrations
pnpm prisma generate        # generate the client into src/generated/prisma
```

### 4. Build the Docker images

Each workspace runs these two images:

```bash
docker build -t fiberdev/ckb-node:dev docker/ckb-node
docker build -t fiberdev/ckb-runtime:dev docker/ckb-runtime
```

See [`docs/DOCKER RUNTIME IMAGE.md`](docs/DOCKER%20RUNTIME%20IMAGE.md) for verification, rebuilds, cleanup, and troubleshooting.

### 5. Start the services

Run each service in its own terminal:

```bash
pnpm nest start auth-service --watch
pnpm nest start workspace-service --watch
pnpm nest start runtime-service --watch
pnpm nest start file-service --watch
pnpm nest start terminal-service --watch
pnpm nest start api-gateway --watch
```

Shortcuts exist for some of them: `pnpm start:auth:dev`, `pnpm start:workspace:dev`, and `pnpm start:dev` (the gateway, which is the default project).

Check that everything is up:

```bash
curl http://localhost:8000/api/health
curl http://localhost:8000/api/health/runtime
curl http://localhost:8004/health
```

## API overview

All REST routes are served by the gateway under `http://localhost:8000/api`. Authenticated routes need `Authorization: Bearer <token>`.

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/verify`, `GET /auth/me`, `POST /auth/wallet/challenge`, `POST /auth/wallet/login` |
| Workspaces | `POST /workspaces`, `GET /workspaces`, `GET /workspaces/:id`, `DELETE /workspaces/:id` |
| Runtime | `POST /workspaces/:id/start`, `/stop`, `/reset`, `/execute`, `/build`, `/test`, `/run-contract`; `GET /workspaces/:id/status`; `DELETE /workspaces/:id/runtime` |
| Files | `GET /workspaces/:id/files`, `GET /workspaces/:id/files/content`, `POST`/`PUT`/`DELETE /workspaces/:id/files`, `PUT /workspaces/:id/files/rename`, `POST /workspaces/:id/directories` |
| Health | `GET /health`, `GET /health/runtime` |

Request and response formats are in [`docs/APIS DOCUMENTATION.md`](docs/APIS%20DOCUMENTATION.md).

### Wallet login

1. `POST /auth/wallet/challenge` with `{ "walletAddress": "ckt1..." }` returns a challenge message and ID.
2. The client signs the message with the CKB wallet.
3. `POST /auth/wallet/login` with `{ walletAddress, challengeId, signature }` returns an access token.

### Terminal WebSocket

The terminal service exposes a socket.io namespace at `ws://localhost:8004/terminal` (WebSocket transport only). Pass the JWT as `auth.token` in the handshake or as an `Authorization` header.

| Client event | Purpose |
|---|---|
| `terminal:open`, `terminal:input`, `terminal:resize`, `terminal:close` | Interactive shell in the workspace runtime container |
| `build:start`, `build:cancel` | Streamed contract build |
| `test:run`, `test:cancel` | Streamed test run |
| `projects:list` | List projects in the workspace |

On a successful connection the server emits `terminal:authenticated`.

## Workspace runtime lifecycle

`POST /workspaces/:id/start` makes the runtime service:

1. Create a dedicated Docker network, a source-code volume, and a CKB data volume.
2. Start the CKB node container and wait for its RPC (port 8114).
3. Start the Fiber runtime container.
4. Generate the default project (`DEFAULT_PROJECT_NAME`) and contract (`DEFAULT_CONTRACT_NAME`).
5. Mark the workspace `RUNNING`.

`stop` keeps the volumes, `reset` recreates everything from scratch, and `DELETE /workspaces/:id/runtime` removes the infrastructure while keeping the workspace record.

## Data model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma):

- `User`: email/password or CKB wallet account (`authProvider`), role `USER` or `ADMIN`
- `WalletChallenge`: one-time sign-in nonces for wallet login
- `Workspace`: owner, status (`PENDING`, `PROVISIONING`, `RUNNING`, `IDLE`, `STOPPED`, `FAILED`, `DELETED`), Docker network and volume names
- `WorkspaceContainer`: one container per workspace and type (`IDE`, `CKB_NODE`, `FIBER_RUNTIME`, `PREVIEW`, `TEST_RUNNER`)

## Scripts

| Command | Description |
|---|---|
| `pnpm build` | Build the default project (api-gateway); use `pnpm nest build <app>` for others |
| `pnpm start:prod` | Run the built gateway from `dist/apps/api-gateway/main` |
| `pnpm lint` | ESLint with auto-fix |
| `pnpm format` | Prettier over `apps/` and `libs/` |
| `pnpm test` | Unit tests (Jest) |
| `pnpm test:cov` | Unit tests with coverage |
| `pnpm test:e2e` | Gateway end-to-end tests |

## Related repositories

- [lestonEth/corven-platform](https://github.com/lestonEth/corven-platform): the Corven IDE web frontend

## License

UNLICENSED. All rights reserved.
