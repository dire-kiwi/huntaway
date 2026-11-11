#!/usr/bin/env bash
# Tests for install.sh's launcher entry (--shortcut-only, on Linux), against a fake build in a temp folder with a HOME
# of its own: the launcher it writes starts the checkout's desktop shell with its Electron, with the deployment to
# follow and the launcher's own path in its environment, whatever the folder's name; the .desktop entry runs the
# launcher and names the shell's window class; a folder with no build is refused. It builds and clones nothing, and
# nothing reaches the network (curl on PATH fails the test if run).
#
#   bash scripts/install-test.sh
set -euo pipefail

[[ $(uname -s) == Linux ]] || { echo "skipped: the launcher entry is tested on Linux"; exit 0; }
command -v node >/dev/null || { echo "skipped: needs node"; exit 0; }
script=$(cd "$(dirname "$0")" && pwd)/install.sh
tmp=$(mktemp -d "${TMPDIR:-/tmp}/install-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$tmp/bin" "$tmp/home"
for tool in curl update-desktop-database; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/touched"\n' "$tool" "$tmp" > "$tmp/bin/$tool"
done
chmod 755 "$tmp/bin/"*
run() { HOME=$tmp/home XDG_DATA_HOME= HUNTAWAY_UPDATE_FROM= PATH="$tmp/bin:$PATH" bash "$script" "$@"; }

# A checkout with nothing built is refused.
app="$tmp/it's an \"app\" here"
mkdir -p "$app/apps/server" "$app/apps/desktop"
out=$(run --dir "$app" --shortcut-only 2>&1) && fail "--shortcut-only went on with no build: $out"
grep -q "no build in" <<< "$out" || fail "no 'no build' error: $out"

# A build: the server's dependencies, and the desktop shell with an Electron whose binary prints what it was given.
mkdir -p "$app/apps/server/node_modules/effect" "$app/apps/desktop/node_modules/electron/dist"
echo '{ "name": "effect", "version": "4.1.4" }' > "$app/apps/server/node_modules/effect/package.json"
echo '{ "name": "huntaway-desktop", "main": "dist/main.js" }' > "$app/apps/desktop/package.json"
electron="$app/apps/desktop/node_modules/electron"
echo '{ "name": "electron", "version": "45.0.0" }' > "$electron/package.json"
echo 'module.exports = require("node:path").join(__dirname, "dist", "electron")' > "$electron/index.js"
printf electron > "$electron/path.txt"
cat > "$electron/dist/electron" <<'EOF'
#!/bin/sh
echo "update-from=${HUNTAWAY_UPDATE_FROM-unset}"
echo "launcher=$HUNTAWAY_LAUNCHER"
for a; do printf 'arg=%s\n' "$a"; done
EOF
chmod 755 "$electron/dist/electron"

out=$(run --dir "$app" --shortcut-only --update-from https://board.example.invalid/ 2>&1) || fail "the installer failed: $out"
launcher=$tmp/home/.local/bin/huntaway-effect-desktop
entry=$tmp/home/.local/share/applications/huntaway-effect.desktop
[[ -x $launcher ]] || fail "no launcher at $launcher: $out"
[[ -f $entry ]] || fail "no .desktop entry at $entry: $out"
got=$(env -u HUNTAWAY_UPDATE_FROM "$launcher" --flag) || fail "the launcher failed: $got"
grep -qxF "update-from=https://board.example.invalid" <<< "$got" || fail "the launcher doesn't follow the deployment: $got"
grep -qxF "launcher=$launcher" <<< "$got" || fail "the launcher doesn't name itself: $got"
grep -qxF "arg=$app/apps/desktop" <<< "$got" || fail "the launcher doesn't start the checkout's desktop shell: $got"
grep -qxF "arg=--flag" <<< "$got" || fail "the launcher doesn't pass its arguments on: $got"
# A deployment set where the launcher runs wins over the one it was installed with.
got=$(HUNTAWAY_UPDATE_FROM=https://other.example.invalid "$launcher")
grep -qxF "update-from=https://other.example.invalid" <<< "$got" || fail "the launcher overrode HUNTAWAY_UPDATE_FROM: $got"
grep -qxF "Exec=$launcher" "$entry" || fail "the .desktop entry doesn't run the launcher: $(cat "$entry")"
grep -qxF "StartupWMClass=huntaway-desktop" "$entry" || fail "the .desktop entry doesn't name the shell's window class: $(cat "$entry")"
icon=$(sed -n 's/^Icon=//p' "$entry")
[[ $icon == "$app/apps/web/public/icon-512.png" ]] || fail "the .desktop entry's icon isn't the web app's: $icon"

# Installed again without a deployment, the launcher follows none.
run --dir "$app" --shortcut-only --no-update-from > /dev/null 2>&1 || fail "the installer failed the second time"
got=$(env -u HUNTAWAY_UPDATE_FROM "$launcher")
grep -qxF "update-from=unset" <<< "$got" || fail "the launcher still follows a deployment: $got"
[[ ! -e $tmp/touched ]] || ! grep -q '^curl' "$tmp/touched" || fail "the installer reached for the network: $(cat "$tmp/touched")"
echo "install.sh: ok"
