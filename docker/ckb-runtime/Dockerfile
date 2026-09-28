# docker/ckb-runtime/Dockerfile
#
# Workspace runtime image.
#
# Everything a new workspace needs is baked in at build time, so creating a
# workspace never downloads or generates anything:
#   - Rust, the riscv64imac target, Clang/LLVM 18 and cargo-generate
#   - ckb-debugger
#   - sccache and corven-rustc-wrapper, so builds use the host's shared
#     read-only build cache (see docker/build-cache) plus a local cache
#   - moleculec, for Molecule schema bindings
#   - pre-built projects for each template in templates/ (hello world, sUDT
#     token, time lock) in /opt/corven/templates/<template>/<project>, which
#     the runtime service copies into each new workspace volume
#
# Build:
#   docker build -t fiberdev/ckb-runtime:dev docker/ckb-runtime
#
# TEMPLATE_PROJECT / TEMPLATE_CONTRACT must match DEFAULT_PROJECT_NAME /
# DEFAULT_CONTRACT_NAME in the backend .env (defaults: ckb-rust-script /
# hello-world).

ARG RUST_VERSION=1.96
# 0.117.x no longer compiles on current Rust (it pins wasm-bindgen 0.2.50).
ARG CKB_DEBUGGER_VERSION=1.1.1
ARG SCCACHE_VERSION=0.18.0

# -----------------------------------------------------------------------------
# Stage 1: build ckb-debugger in its own stage so its build cache and sources
# don't end up in the runtime image.
# -----------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS debugger

ARG CKB_DEBUGGER_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends clang libclang-dev pkg-config libssl-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

RUN cargo install --locked ckb-debugger \
        --version ${CKB_DEBUGGER_VERSION} \
        --root /opt/ckb-debugger

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm

ARG LLVM_VERSION=18
ARG SCCACHE_VERSION
ARG TEMPLATE_PROJECT=ckb-rust-script
ARG TEMPLATE_CONTRACT=hello-world

ENV DEBIAN_FRONTEND=noninteractive
ENV USER=root
ENV HOME=/root
ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup

ENV CC=clang-18
ENV CXX=clang++-18
ENV CLANG=clang-18

# Where the runtime service looks for baked project templates.
ENV CORVEN_TEMPLATE_DIR=/opt/corven/templates

RUN apt-get update && apt-get install -y \
    make \
    curl \
    wget \
    git \
    sed \
    bash \
    coreutils \
    build-essential \
    gnupg \
    lsb-release \
    software-properties-common \
    pkg-config \
    libssl-dev \
    ca-certificates \
    unzip \
    jq \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Install Clang/LLVM 18 from the official LLVM repository.
RUN wget -qO /tmp/llvm.sh https://apt.llvm.org/llvm.sh \
    && chmod +x /tmp/llvm.sh \
    && /tmp/llvm.sh ${LLVM_VERSION} \
    && apt-get update \
    && apt-get install -y \
        clang-${LLVM_VERSION} \
        llvm-${LLVM_VERSION} \
        lld-${LLVM_VERSION} \
        libclang-${LLVM_VERSION}-dev \
    && ln -sf /usr/bin/clang-${LLVM_VERSION} /usr/local/bin/clang \
    && ln -sf /usr/bin/clang++-${LLVM_VERSION} /usr/local/bin/clang++ \
    && ln -sf /usr/bin/llvm-config-${LLVM_VERSION} /usr/local/bin/llvm-config \
    && rm -f /tmp/llvm.sh \
    && rm -rf /var/lib/apt/lists/*

RUN clang --version \
    && test "$(clang -dumpversion | cut -d. -f1)" -ge 16

RUN rustup target add riscv64imac-unknown-none-elf

RUN cargo install cargo-generate --version "^0.21.3" --locked

COPY --from=debugger /opt/ckb-debugger/bin/ckb-debugger /usr/local/bin/ckb-debugger
RUN ckb-debugger --version

# sccache (0.15+ for multi-level caches; 0.16+ for read-only levels).
RUN arch="$(uname -m)" \
    && case "$arch" in x86_64|aarch64) ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/sccache-v${SCCACHE_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
        | tar -xz -C /tmp \
    && install -m 0755 "/tmp/sccache-v${SCCACHE_VERSION}-${arch}-unknown-linux-musl/sccache" /usr/local/bin/sccache \
    && rm -rf /tmp/sccache-* \
    && sccache --version

COPY corven-rustc-wrapper /usr/local/bin/corven-rustc-wrapper
RUN chmod 0755 /usr/local/bin/corven-rustc-wrapper

# Every rustc call goes through the wrapper; it falls back to plain rustc if
# sccache can't run. runtime-service sets the SCCACHE_* variables per host.
ENV RUSTC_WRAPPER=/usr/local/bin/corven-rustc-wrapper
ENV SCCACHE_DIR=/root/.cache/sccache
ENV SCCACHE_CACHE_SIZE=2G

# -----------------------------------------------------------------------------
# Project template
#
# Generated and built at /workspace/<project>, the same path it will have
# inside a workspace, then moved aside. Cargo's build cache records absolute
# paths, so copying it back to /workspace/<project> at runtime keeps the first
# `make build` in a new workspace warm instead of compiling from scratch.
# The crates it depends on stay in CARGO_HOME, so builds need no downloads.
#
# /workspace itself is left empty so Docker doesn't auto-copy anything into
# new workspace volumes; the runtime service copies explicitly.
# -----------------------------------------------------------------------------
WORKDIR /workspace

# moleculec, for generating Rust/C bindings from .mol schemas
# (POST /workspaces/:id/molecule/generate).
ARG MOLECULEC_VERSION=0.9.2
RUN cargo install --locked moleculec --version ${MOLECULEC_VERSION} \
    && moleculec --version

# Project templates: one pre-built project per template in
# ${CORVEN_TEMPLATE_DIR}/<template>/<project> (see build-templates.sh).
#
# CORVEN_SCCACHE_OFF: build the templates without filling a cache inside the
# image. The wrapper is still RUSTC_WRAPPER, so cargo's fingerprints match
# later builds in workspaces.
COPY templates /opt/corven/template-src
COPY build-templates.sh /usr/local/bin/corven-build-templates
RUN chmod 0755 /usr/local/bin/corven-build-templates \
    && export CORVEN_SCCACHE_OFF=1 TEMPLATE_PROJECT=${TEMPLATE_PROJECT} \
    && corven-build-templates /opt/corven/template-src \
    && test -f ${CORVEN_TEMPLATE_DIR}/hello-world/${TEMPLATE_PROJECT}/build/release/${TEMPLATE_CONTRACT}

CMD ["sh", "-c", "while true; do sleep 3600; done"]
