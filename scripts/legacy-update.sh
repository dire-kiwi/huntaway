#!/bin/sh
# HA-263 moved app/ to apps/web, server-ts/ to apps/server and the Rust workspace to the checkout's root. A server from
# before that rebuilds its checkout after an Update by running `npm install` and `npm run build` in app/, then
# `cargo build --release -p ia-shim` in server/, and starts server-ts/bin/huntaway. app/package.json's `build` runs this,
# which builds the new layout; the rest finds its way: cargo finds the workspace above server/, and
# server-ts/bin/huntaway starts apps/server/bin/huntaway. app/package.json keeps the Electron that an older
# scripts/install.sh's launcher starts, with app/ as its app, which then loads apps/web's. Running install.sh again
# points the launcher at apps/web.
#
# Remove app/, server-ts/ and this script once every checkout that updates itself has updated past HA-263.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
if command -v pnpm >/dev/null 2>&1; then
  set -- pnpm
else
  set -- npx --yes "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
fi
"$@" install --frozen-lockfile --filter 'huntaway-server...' --filter 'huntaway-app...'
"$@" --filter huntaway-app run build
# A prebuilt ia-shim (install.sh's, on a machine without Rust) goes where the server now looks for it.
if [ -f server-ts/bin/ia-shim ] && [ ! -e apps/server/bin/ia-shim ]; then cp server-ts/bin/ia-shim apps/server/bin/ia-shim; fi
# The old Update builds ia-shim with cargo in server/, which only checkouts with an old build there still have.
mkdir -p server
