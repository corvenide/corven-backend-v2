#docker/ckb-node/Dockerfile
FROM node:22-bookworm

# Pinned: runtime-service drives `offckb deploy` (needs -y / --type-id / --output)
# and `offckb debug`.
ARG OFFCKB_VERSION=0.4.13
ARG CKB_DEBUGGER_VERSION=1.1.1

RUN npm install -g @offckb/cli@${OFFCKB_VERSION}

# ckb-debugger replays devnet transactions for the IDE's Debug panel.
RUN arch="$(uname -m)" \
    && case "$arch" in x86_64|aarch64) ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/nervosnetwork/ckb-standalone-debugger/releases/download/v${CKB_DEBUGGER_VERSION}/ckb-debugger_v${CKB_DEBUGGER_VERSION}_${arch}-unknown-linux-gnu.tar.gz" \
        | tar -xz -C /usr/local/bin ckb-debugger \
    && ckb-debugger --version

RUN mkdir -p /ckb-data

ENV HOME=/ckb-data

EXPOSE 8114
EXPOSE 28114

CMD ["offckb", "node"]
