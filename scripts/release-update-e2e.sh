#!/usr/bin/env bash
# End-to-end check of release updates (HA-61) on real packages: builds releases of this checkout as the release
# workflow does, serves them from a fake GitHub on 127.0.0.1, and runs the packaged desktop app (headless Electron)
# through a check, background staging, Update, a version that won't start, Roll back, prereleases, a server the app
# only attached to, and the AppImage replacing itself (scripts/release-update-e2e.mjs). With --pacman, it also installs
# the .pacman in a throwaway Arch container (docker) and updates the package from inside the app.
#
#   scripts/release-update-e2e.sh [--work DIR] [--no-build] [--pacman] [--keep]
#
# --work      where builds and runs go (default ~/.cache/huntaway-release-e2e, about 2 GB: not /tmp, which may be a
#             small tmpfs); builds are reused with --no-build
# --no-build  use the packages already in DIR/assets
# --build-only  only build
# --pacman    run the container check too (needs docker and the archlinux image; downloads the package's deps)
# --keep      keep each run's data dirs (they're in DIR/runs)
#
# Builds (in DIR/src, a copy of this checkout with its uncommitted changes, sharing app/node_modules and a cargo target
# dir in DIR/target):
#   0.9.0, 0.9.1  the app (AppImage, pacman), the server tarball and huntaway-<v>-release.json, as release.yml makes them
#   0.9.3         the same, with a changed shell (a line added to electron/preload.cjs), so its manifest's stamp differs
#   0.9.2         a server tarball whose huntaway passes --version but exits at once on serve (0.9.1's shim and UI)
#   0.9.4-rc.1    a prerelease tarball, like 0.9.2 but with a server that works (0.9.1's, saying it's 0.9.4-rc.1)
#
# Nothing here uses port 7878 or the live data dir: every app and server gets a fresh data dir and a free port.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${XDG_CACHE_HOME:-$HOME/.cache}/huntaway-release-e2e"
build=1
run=1
run_args=()
while (($#)); do
  case $1 in
    --work) work=$2; shift ;;
    --no-build) build="" ;;
    --build-only) run="" ;;
    --pacman | --keep) run_args+=("$1") ;;
    -h | --help) sed -n '2,/^set -e/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$work"
work="$(cd "$work" && pwd)"
assets="$work/assets"

[[ -x $root/app/node_modules/electron/dist/electron ]] || { echo "run npm ci in app/ (with Electron's install script) first" >&2; exit 1; }

# Copy the checkout (tracked and untracked files, not ignored ones) into $work/src, and link what it shares.
copy_source() {
  rm -rf "$work/src"
  mkdir -p "$work/src" "$work/target"
  (cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - --ignore-failed-read -cf - 2> /dev/null) |
    tar -xf - -C "$work/src"
  ln -s "$root/app/node_modules" "$work/src/app/node_modules"
  ln -s "$work/target" "$work/src/server/target"
}

# Set the version as the workflow's Version step does.
set_version() {
  local v=$1
  (cd "$work/src/app" && npm version --no-git-tag-version --allow-same-version "$v" > /dev/null)
  (cd "$work/src/server" &&
    sed -i "0,/^version = \".*\"$/s//version = \"$v\"/" Cargo.toml &&
    cargo metadata --format-version 1 > /dev/null &&
    grep -A1 '^name = "huntaway"$' Cargo.lock | grep -qxF "version = \"$v\"")
}

# Build release $1 as the workflow does, and put its files in $assets.
build_release() {
  local v=$1 src="$work/src" name
  echo "== building $v" >&2
  set_version "$v"
  (cd "$src/app" && npm run build > "$work/build-$v.log" 2>&1) || { tail -20 "$work/build-$v.log" >&2; exit 1; }
  (cd "$src/server" && cargo build --release --locked >> "$work/build-$v.log" 2>&1) || { tail -20 "$work/build-$v.log" >&2; exit 1; }
  rm -rf "$src/app/release"
  (cd "$src/app" && npx electron-builder --linux --x64 --publish never >> "$work/build-$v.log" 2>&1) ||
    { tail -20 "$work/build-$v.log" >&2; exit 1; }
  # The release manifest, as the workflow's step writes it.
  (cd "$src/app" && VERSION=$v node -e 'const fs = require("node:fs"); const { shellStamp } = require("./electron/stamp.cjs");
    const electron = require("./node_modules/electron/package.json").version;
    const manifest = { version: process.env.VERSION, shell: shellStamp("electron", electron), electron };
    fs.writeFileSync(`release/huntaway-${process.env.VERSION}-release.json`, JSON.stringify(manifest, null, 2) + "\n")')
  name="huntaway-server-$v-linux-x64"
  mkdir -p "$src/app/release/$name"
  cp "$src/server/target/release/huntaway" "$src/server/target/release/ia-shim" "$src/app/release/$name/"
  cp -R "$src/app/dist" "$src/app/release/$name/ui"
  tar -C "$src/app/release" -czf "$src/app/release/$name.tar.gz" "$name"
  cp "$src/app/release/"*.{AppImage,pacman,tar.gz,json} "$assets/"
}

# A server tarball for $1 from 0.9.1's, whose huntaway is the script $2 (which gets 0.9.1's binary as $REAL).
fake_release() {
  local v=$1 script=$2 dir="$work/fake/huntaway-server-$1-linux-x64"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$assets/huntaway-server-0.9.1-linux-x64.tar.gz" -C "$dir" --strip-components 1
  mv "$dir/huntaway" "$dir/huntaway-0.9.1"
  printf '#!/bin/sh\nREAL="$(dirname "$0")/huntaway-0.9.1"\n%s\n' "$script" > "$dir/huntaway"
  chmod +x "$dir/huntaway"
  tar -C "$work/fake" -czf "$assets/huntaway-server-$v-linux-x64.tar.gz" "huntaway-server-$v-linux-x64"
}

if [[ -n $build ]]; then
  rm -rf "$assets"
  mkdir -p "$assets"
  copy_source
  build_release 0.9.0
  build_release 0.9.1
  echo "// a changed shell for the e2e check's 0.9.3" >> "$work/src/app/electron/preload.cjs"
  build_release 0.9.3
  # 0.9.2 passes the smoke test (--version) and exits at once otherwise.
  fake_release 0.9.2 '[ "$1" = --version ] && { echo "huntaway 0.9.2"; exit 0; }
echo "huntaway 0.9.2: broken on purpose" >&2; exit 3'
  # The prerelease runs 0.9.1's server, but says it's 0.9.4-rc.1 for the smoke test.
  fake_release 0.9.4-rc.1 '[ "$1" = --version ] && { echo "huntaway 0.9.4-rc.1"; exit 0; }
exec "$REAL" "$@"'
  ls -l "$assets"
fi

[[ -n $run ]] || exit 0
exec node "$root/scripts/release-update-e2e.mjs" --work "$work" "${run_args[@]}"
