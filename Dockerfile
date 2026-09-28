# One image for every backend service. Pick the service at run time with
# SERVICE (api-gateway, auth-service, workspace-service, runtime-service,
# file-service or terminal-service).

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

WORKDIR /app

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN for app in api-gateway auth-service workspace-service runtime-service file-service terminal-service; do \
        pnpm nest build "$app" || exit 1; \
    done

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma

ENV SERVICE=api-gateway

CMD ["sh", "-c", "exec node dist/apps/$SERVICE/main.js"]
