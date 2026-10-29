#!/usr/bin/env bash
# Build a site-deploy bundle (a ZIP) for the broker.
#
#   BROKER_TOKEN=… deploy/broker/bundle.sh OUT.zip DOMAIN [DEFAULT_HOST]
#
# BROKER_TOKEN is the token hosts connect with (`huntaway serve --broker-token`); DEFAULT_HOST is
# the host that browsers get when they don't pick one (see deploy/broker/README.md).
#
# The binary is built in a rust:bookworm container, so it runs on the bundle's debian:bookworm-slim
# image whatever this machine's glibc is (its build cache is the `huntaway-broker-target` Docker
# volume). BROKER_BIN=<path> uses a binary built elsewhere instead.
set -euo pipefail
[[ $# -ge 2 && $# -le 3 ]] || { echo "usage: BROKER_TOKEN=… $0 OUT.zip DOMAIN [DEFAULT_HOST]" >&2; exit 2; }
out=$(realpath -m "$1") domain=$2 default_host=${3:-}
[[ ${#BROKER_TOKEN} -ge 16 ]] || { echo "set BROKER_TOKEN (at least 16 characters, e.g. \$(openssl rand -hex 32))" >&2; exit 2; }
root="$(cd "$(dirname "$0")/../.." && pwd)"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/app"
if [[ -n ${BROKER_BIN:-} ]]; then
  cp "$BROKER_BIN" "$dir/app/huntaway-broker"
else
  docker run --rm -v "$root/server:/src:ro" -v huntaway-broker-target:/target -v huntaway-broker-cargo:/usr/local/cargo/registry \
    -e CARGO_TARGET_DIR=/target -w /src rust:1-bookworm cargo build --release --locked -p huntaway-broker
  docker run --rm -v huntaway-broker-target:/target -v "$dir/app:/out" debian:bookworm-slim cp /target/release/huntaway-broker /out/
fi
sed -e "s/@DOMAIN@/$domain/g" "$root/deploy/broker/compose.template.yaml" > "$dir/compose.yaml"
(umask 077 && printf 'BROKER_TOKEN=%s\nBROKER_DEFAULT_HOST=%s\n' "$BROKER_TOKEN" "$default_host" > "$dir/broker.env")
rm -f "$out"
(cd "$dir" && zip -qr "$out" .)
echo "$out"
