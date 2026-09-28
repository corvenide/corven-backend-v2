# docker/build-cache/Dockerfile
#
# Shared Rust build cache for one Docker host (sccache over WebDAV).
#
#   :8081  read-only (GET/HEAD/PROPFIND). Every workspace on the host reads
#          from here as a second cache level, behind its own local cache.
#   :8082  read-write, bearer-token protected. Only Corven's cache warmer
#          writes here, building the project template with trusted inputs.
#
# Workspaces can't write to the shared cache: a user could otherwise plant a
# poisoned compilation result that another user's build would pick up.
#
# Build:
#   docker build -t corven/build-cache:dev docker/build-cache
#
# runtime-service starts one container of this image per host (see
# BUILD_CACHE_IMAGE and build-cache.service.ts).

FROM alpine:3.20

RUN apk add --no-cache nginx nginx-mod-http-dav-ext curl \
    && mkdir -p /cache/sccache /run/nginx \
    && chown -R nginx:nginx /cache

COPY nginx.conf.template /etc/corven/nginx.conf.template
COPY entrypoint.sh /usr/local/bin/corven-build-cache
RUN chmod +x /usr/local/bin/corven-build-cache

VOLUME ["/cache"]
EXPOSE 8081 8082

HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8081/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/corven-build-cache"]
