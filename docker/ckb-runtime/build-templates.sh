#!/usr/bin/env bash
# docker/ckb-runtime/build-templates.sh
#
# Builds every project template into $CORVEN_TEMPLATE_DIR/<template>/<project>.
# Run at image build time (see the Dockerfile).
#
# Each template in $1 (default /opt/corven/template-src) is a directory with:
#   template.json                     { "id", "name", "contracts": [crate, ...] }
#   contracts/<crate>/src/...         optional: replaces the generated sources
#   tests.rs                          optional: replaces tests/src/tests.rs
#
# A template is generated from cryptape/ckb-script-templates and built at
# /workspace/<project>, the path it has inside a workspace, so cargo's
# fingerprints still match after the runtime service copies it back. Then
# `make build` and (when the template has its own tests) `make test` must
# pass, or the image build fails.
set -euo pipefail

SRC="${1:-/opt/corven/template-src}"
PROJECT="${TEMPLATE_PROJECT:-ckb-rust-script}"
OUT="${CORVEN_TEMPLATE_DIR:-/opt/corven/templates}"

mkdir -p "$OUT"

for template in "$SRC"/*/; do
    template="${template%/}"
    id="$(jq -r .id "$template/template.json")"
    contracts="$(jq -r '.contracts[]' "$template/template.json")"
    echo "==> template $id ($(echo $contracts | tr '\n' ' '))"

    rm -rf "/workspace/$PROJECT"
    cd /workspace
    cargo generate gh:cryptape/ckb-script-templates workspace --name "$PROJECT"
    cd "$PROJECT"

    for crate in $contracts; do
        make generate CRATE="$crate"
        if [ -d "$template/contracts/$crate/src" ]; then
            rm -rf "contracts/$crate/src"
            cp -a "$template/contracts/$crate/src" "contracts/$crate/src"
        fi
    done

    if [ -f "$template/tests.rs" ]; then
        cp "$template/tests.rs" tests/src/tests.rs
    fi

    make build
    for crate in $contracts; do
        test -f "build/release/$crate"
    done
    if [ -f "$template/tests.rs" ]; then
        make test
    fi

    mkdir -p "$OUT/$id"
    cp "$template/template.json" "$OUT/$id/template.json"
    mv "/workspace/$PROJECT" "$OUT/$id/$PROJECT"
done

# Images built before templates had ids kept the default at $OUT/$PROJECT;
# keep that path working for anything that still expects it.
if [ -d "$OUT/hello-world/$PROJECT" ] && [ ! -e "$OUT/$PROJECT" ]; then
    ln -s "hello-world/$PROJECT" "$OUT/$PROJECT"
fi

ls -la "$OUT"
