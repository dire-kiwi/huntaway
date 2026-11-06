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
# Builds (in DIR/src, a copy of this checkout with its uncommitted changes, sharing its node_modules folders (pnpm
# install first) and a cargo target dir in DIR/target):
#   0.9.0, 0.9.1  the app (AppImage, pacman), the server tarball and huntaway-<v>-release.json, as release.yml makes them
#   0.9.3         the same, with a changed frame (a line added to electron/boot.cjs), so its manifest's stamp differs
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
# electron-builder and fpm stage packages in $TMPDIR, a few hundred MB each: keep them out of a small /tmp too.
export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"
assets="$work/assets"

# Electron downloads its binary the first time it's required.
node -e 'require(process.argv[1])' "$root/apps/web/node_modules/electron" > /dev/null ||
  { echo "no Electron in apps/web: run pnpm install first" >&2; exit 1; }

# Copy the checkout (tracked and untracked files, not ignored ones) into $work/src, and link what it shares.
copy_source() {
  rm -rf "$work/src"
  mkdir -p "$work/src" "$work/target"
  (cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - --ignore-failed-read -cf - 2> /dev/null) |
    tar -xf - -C "$work/src"
  # pnpm's: the packages' node_modules link into the root's.
  local d
  for d in node_modules apps/*/node_modules packages/*/node_modules; do
    [[ ! -d $root/$d ]] || ln -s "$root/$d" "$work/src/$d"
  done
  ln -s "$work/target" "$work/src/target"
}

# Set the app's version as the workflow's Version step does (the server's is VERSION, for scripts/package-server.sh).
set_version() {
  node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    p.version = process.argv[2]; fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n")' "$work/src/apps/web/package.json" "$1"
}

# Build release $1 as the workflow does, and put its files in $assets.
build_release() {
  local v=$1 src="$work/src" name
  echo "== building $v" >&2
  set_version "$v"
  (cd "$src/apps/web" && pnpm run build > "$work/build-$v.log" 2>&1) || { tail -20 "$work/build-$v.log" >&2; exit 1; }
  (cd "$src" && cargo build --release --locked -p ia-shim >> "$work/build-$v.log" 2>&1) || { tail -20 "$work/build-$v.log" >&2; exit 1; }
  # The server the app and the tarball carry, as the workflow packages it (the copy isn't a git checkout: its commit is this one's).
  (cd "$src" && VERSION=$v IA_BUILD_COMMIT=$(git -C "$root" rev-parse HEAD) scripts/package-server.sh release-server "$(command -v node)" \
    >> "$work/build-$v.log" 2>&1) || { tail -20 "$work/build-$v.log" >&2; exit 1; }
  rm -rf "$src/apps/web/release"
  (cd "$src/apps/web" && pnpm exec electron-builder --linux --x64 --publish never >> "$work/build-$v.log" 2>&1) ||
    { tail -20 "$work/build-$v.log" >&2; exit 1; }
  # The release manifest, as the workflow's step writes it.
  (cd "$src/apps/web" && VERSION=$v node -e 'const fs = require("node:fs"); const { frameStamp } = require("./electron/stamp.cjs");
    const electron = require("./node_modules/electron/package.json").version;
    const manifest = { version: process.env.VERSION, shell: frameStamp("electron", electron), electron };
    fs.writeFileSync(`release/huntaway-${process.env.VERSION}-release.json`, JSON.stringify(manifest, null, 2) + "\n")')
  # The server tarball, as the workflow's Package the server step makes it: the package, and this release's desktop shell.
  name="huntaway-server-$v-linux-x64"
  cp -R "$src/release-server" "$src/apps/web/release/$name"
  mkdir "$src/apps/web/release/$name/electron"
  cp "$src/apps/web/electron/"*.cjs "$src/apps/web/release/$name/electron/"
  (cd "$src/apps/web" && node -e 'const electron = require("./node_modules/electron/package.json").version;
    require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ electron, boot: 1 }) + "\n")' "release/$name/electron/shell.json")
  tar -C "$src/apps/web/release" -czf "$src/apps/web/release/$name.tar.gz" "$name"
  cp "$src/apps/web/release/"*.{AppImage,pacman,tar.gz,json} "$assets/"
}

# A server tarball for $1 from 0.9.1's, whose huntaway is the script $2 (which gets 0.9.1's binary as $REAL).
fake_release() {
  local v=$1 script=$2 dir="$work/fake/huntaway-server-$1-linux-x64"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$assets/huntaway-server-0.9.1-linux-x64.tar.gz" -C "$dir" --strip-components 1
  # Only the server changes: a desktop shell of its own would have the app relaunch onto it (the appimage check covers that).
  rm -rf "$dir/electron"
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
  echo "// a changed frame for the e2e check's 0.9.3" >> "$work/src/app/electron/boot.cjs"
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
