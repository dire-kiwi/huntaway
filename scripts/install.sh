#!/usr/bin/env bash
# Installs the Huntaway desktop app from source on Linux or macOS, or updates an install.
#
#   curl -fsSL https://raw.githubusercontent.com/dire-kiwi/huntaway/master/scripts/install.sh | bash
#   scripts/install.sh [options]          # from a checkout; run --help for the options
#
# It checks for the build tools, clones the repository (or fast-forwards a clone it made before),
# builds the UI and the server, and adds Huntaway to the app launcher (a .desktop entry on Linux,
# ~/Applications/Huntaway.app on macOS). The app's server follows the board deployed at
# --update-from (https://code.dire.nz by default): once that runs a newer commit, the sidebar shows
# "N new commits · Update", which fetches it, rebuilds and restarts like Rebuild & restart.
set -euo pipefail

REPO="${HUNTAWAY_REPO:-https://github.com/dire-kiwi/huntaway.git}"
BRANCH="${HUNTAWAY_BRANCH:-master}"
DIR="${HUNTAWAY_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/huntaway-app}"
UPDATE_FROM="${HUNTAWAY_UPDATE_FROM-https://code.dire.nz}"
BUILD=1
SHORTCUT=1
OPEN=0

usage() {
  cat <<EOF
Usage: install.sh [options]

  --dir DIR            Where to clone and build Huntaway (default: $DIR)
  --branch BRANCH      Branch to clone (default: $BRANCH)
  --repo URL           Repository to clone (default: $REPO)
  --update-from URL    Deployment whose commits the app offers to update to (default: ${UPDATE_FROM:-none})
  --no-update-from     Don't follow a deployment (update with Rebuild & restart after a git pull)
  --no-shortcut        Build only; don't add Huntaway to the app launcher
  --shortcut-only      Only (re)write the launcher entry for an existing build
  --open               Start the app when done
EOF
}

say() { printf '\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a directory}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --branch) BRANCH="${2:?--branch needs a branch}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --repo) REPO="${2:?--repo needs a URL}"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --update-from) UPDATE_FROM="${2:?--update-from needs a URL}"; shift 2 ;;
    --update-from=*) UPDATE_FROM="${1#*=}"; shift ;;
    --no-update-from) UPDATE_FROM=""; shift ;;
    --no-shortcut) SHORTCUT=0; shift ;;
    --shortcut-only) BUILD=0; shift ;;
    --open) OPEN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Linux | Darwin) ;;
  *) die "this installer supports Linux and macOS, not $OS" ;;
esac
case "$DIR" in
  /*) ;;
  *) DIR="$PWD/$DIR" ;;
esac
UPDATE_FROM="${UPDATE_FROM%/}"

# Where rustup and Homebrew put their tools, in case this shell's PATH doesn't have them yet.
for d in "$HOME/.cargo/bin" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH

# ---------- dependencies ----------

pkg_hint() {
  if [ "$OS" = Darwin ]; then
    echo "  xcode-select --install          # compiler and git"
    echo "  brew install node rustup && rustup-init -y"
  elif command -v pacman >/dev/null 2>&1; then
    echo "  sudo pacman -S --needed git base-devel nodejs npm rustup && rustup default stable"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  sudo apt-get install git build-essential curl"
    echo "  Node.js 22+: https://nodejs.org/en/download (Debian and Ubuntu's own is often older)"
    echo "  Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  elif command -v dnf >/dev/null 2>&1; then
    echo "  sudo dnf install git gcc nodejs npm"
    echo "  Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  else
    echo "  git, a C compiler, Node.js 22+ with npm (https://nodejs.org) and Rust (https://rustup.rs)"
  fi
}

check_deps() {
  local missing=() v
  for c in git node npm cargo rustc; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [ "$OS" = Darwin ]; then
    xcode-select -p >/dev/null 2>&1 || missing+=("Xcode command line tools")
  else
    command -v cc >/dev/null 2>&1 || missing+=("a C compiler (cc)")
  fi
  if command -v node >/dev/null 2>&1; then
    v="$(node -p 'process.versions.node')"
    # Vite needs 22.12+ (or 20.19+), and the tests strip types, so 22.12 it is.
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' ||
      missing+=("Node.js 22.12 or newer (this is $v)")
  fi
  if command -v rustc >/dev/null 2>&1; then
    v="$(rustc --version | awk '{print $2}')"
    # The server is edition 2024 (Rust 1.85+).
    [ "$(printf '%s\n' "$v" | awk -F. '{print ($1 > 1 || $2 >= 85) ? "ok" : "old"}')" = ok ] ||
      missing+=("Rust 1.85 or newer (this is $v; rustup update)")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    printf '\033[1;31merror:\033[0m missing build tools:\n' >&2
    printf '  - %s\n' "${missing[@]}" >&2
    printf '\nTo install them:\n%s\n' "$(pkg_hint)" >&2
    exit 1
  fi
  command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 ||
    warn "neither claude (Claude Code) nor codex is on PATH: agents need one of them."
  command -v tmux >/dev/null 2>&1 || warn "tmux isn't on PATH: task terminals need it."
}

# ---------- source ----------

fetch_source() {
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
      warn "$DIR has uncommitted changes; building it as it is."
    elif ! git -C "$DIR" pull --ff-only --quiet; then
      warn "couldn't fast-forward $DIR; building it as it is."
    fi
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and isn't a git checkout; pick another folder with --dir"
  else
    say "Cloning $REPO ($BRANCH) into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
  fi
  [ -f "$DIR/server/Cargo.toml" ] && [ -f "$DIR/app/package.json" ] || die "$DIR doesn't look like a Huntaway checkout"
}

build() {
  say "Building the UI"
  # npm install once there's a node_modules, as Rebuild & restart does: npm ci would delete the Electron a running app is using.
  local npm_install=ci
  [ -d "$DIR/app/node_modules" ] && npm_install=install
  (cd "$DIR/app" && npm "$npm_install" --no-audit --no-fund && npm run build)
  say "Building the server (the first build takes a few minutes)"
  (cd "$DIR/server" && cargo build --release --locked)
}

# ---------- launcher ----------

# $1 single-quoted for sh.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# The folders of the tools the app's server runs (the build tools for updates, and the agents'
# CLIs), which a desktop session's PATH may not have (nvm, rustup, Homebrew, ~/.local/bin).
tool_path() {
  local p="" c d
  for c in node npm cargo git claude codex tmux gh; do
    c="$(command -v "$c" 2>/dev/null)" || continue
    d="$(dirname "$c")"
    case ":$p:" in *":$d:"*) ;; *) p="${p:+$p:}$d" ;; esac
  done
  printf '%s' "$p"
}

electron_bin() {
  if [ "$OS" = Darwin ]; then
    echo "$DIR/app/node_modules/electron/dist/Electron.app"
  else
    echo "$DIR/app/node_modules/electron/dist/electron"
  fi
}

shortcut_linux() {
  local bin_dir="$HOME/.local/bin" apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  local launcher="$bin_dir/huntaway-desktop"
  mkdir -p "$bin_dir" "$apps"
  {
    echo "#!/bin/sh"
    echo "# Starts the Huntaway desktop app from its checkout. Written by scripts/install.sh: run that again to change it."
    echo "PATH=$(shq "$(tool_path)"):\"\$PATH\""
    echo "export PATH"
    if [ -n "$UPDATE_FROM" ]; then
      echo "IA_UPDATE_FROM=\${IA_UPDATE_FROM-$(shq "$UPDATE_FROM")}"
      echo "export IA_UPDATE_FROM"
    fi
    echo "exec $(shq "$(electron_bin)") $(shq "$DIR/app") \"\$@\""
  } >"$launcher"
  chmod 755 "$launcher"
  # Named after app/package.json's desktopName, which Electron reports as the window's app id.
  cat >"$apps/huntaway-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Huntaway
Comment=Kanban board for Claude Code and Codex agents
Exec=$launcher
Icon=$DIR/app/build/icon.png
Terminal=false
Categories=Development;
StartupWMClass=huntaway-app
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$apps" 2>/dev/null || true
  say "Added Huntaway to the app launcher ($apps/huntaway-app.desktop) and $launcher"
  case ":$PATH:" in *":$bin_dir:"*) ;; *) warn "$bin_dir isn't on PATH, so start huntaway-desktop from the launcher, or by its full path." ;; esac
  # Electron's sandbox needs unprivileged user namespaces, which Ubuntu 24.04+ restricts through AppArmor.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    local sandbox="$DIR/app/node_modules/electron/dist/chrome-sandbox"
    warn "this system restricts user namespaces, so Electron needs its setuid sandbox helper:"
    echo "  sudo chown root:root $(shq "$sandbox") && sudo chmod 4755 $(shq "$sandbox")" >&2
  fi
  LAUNCH=("$launcher")
}

shortcut_mac() {
  local app="$HOME/Applications/Huntaway.app" tmp
  mkdir -p "$HOME/Applications"
  rm -rf "$app"
  # A copy of the Electron that npm installed, renamed, whose app is a stub that runs the checkout's.
  ditto "$(electron_bin)" "$app"
  plutil -replace CFBundleName -string Huntaway "$app/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string Huntaway "$app/Contents/Info.plist"
  plutil -replace CFBundleIdentifier -string nz.dire.huntaway "$app/Contents/Info.plist"
  tmp="$(mktemp -d)"
  mkdir "$tmp/huntaway.iconset"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$DIR/app/build/icon.png" --out "$tmp/huntaway.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" "$DIR/app/build/icon.png" --out "$tmp/huntaway.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$tmp/huntaway.iconset" -o "$app/Contents/Resources/electron.icns" || warn "couldn't make the app's icon"
  rm -rf "$tmp"
  rm -f "$app/Contents/Resources/default_app.asar"
  mkdir -p "$app/Contents/Resources/app"
  # Electron names the window's storage after this (as for `npm run electron`).
  echo '{ "name": "huntaway-app", "private": true, "main": "main.cjs" }' >"$app/Contents/Resources/app/package.json"
  # JSON strings, which are JavaScript strings too.
  local src path update
  src="$(node -p 'JSON.stringify(process.argv[1])' "$DIR")"
  path="$(node -p 'JSON.stringify(process.argv[1])' "$(tool_path)")"
  update="$(node -p 'JSON.stringify(process.argv[1])' "$UPDATE_FROM")"
  cat >"$app/Contents/Resources/app/main.cjs" <<EOF
// Written by scripts/install.sh: starts Huntaway from its checkout. Run that script again to change it.
const { app } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const src = $src;
process.env.PATH = $path + ":" + process.env.PATH;
if ($update && !process.env.IA_UPDATE_FROM) process.env.IA_UPDATE_FROM = $update;
let wanted = null;
try {
  wanted = JSON.parse(fs.readFileSync(src + "/app/node_modules/electron/package.json", "utf8")).version;
} catch {}
if (wanted && wanted !== process.versions.electron) {
  // An update installed another Electron: copy this app from it again, then start that.
  spawn("/bin/bash", [src + "/scripts/install.sh", "--dir", src, "--shortcut-only", "--open"], { detached: true, stdio: "ignore" }).unref();
  app.exit(0);
} else {
  require(src + "/app/electron/main.cjs");
}
EOF
  # Editing the bundle broke Electron's signature; sign it again (ad hoc), or Apple silicon won't start it.
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || warn "couldn't sign $app; if macOS won't open it, run: codesign --force --deep --sign - $(shq "$app")"
  say "Added $app"
  LAUNCH=(open "$app")
}

# ---------- main ----------

LAUNCH=()
if [ "$BUILD" = 1 ]; then
  check_deps
  fetch_source
  build
else
  [ -x "$DIR/server/target/release/huntaway" ] || die "no build in $DIR; run this without --shortcut-only first"
fi
[ -e "$(electron_bin)" ] || die "Electron isn't installed in $DIR/app; run this without --shortcut-only"

if [ "$SHORTCUT" = 1 ]; then
  if [ "$OS" = Darwin ]; then shortcut_mac; else shortcut_linux; fi
fi

if [ "$BUILD" = 1 ]; then
  port="$(node -e '
    const fs = require("fs"), path = require("path"), os = require("os");
    const base = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    for (const d of ["huntaway", "issue-agent"]) try { console.log(JSON.parse(fs.readFileSync(path.join(base, d, "desktop.json"), "utf8")).port || 7878); process.exit(0) } catch {}
    console.log(process.env.IA_PORT || 7878)')"
  if command -v curl >/dev/null 2>&1 && curl -fsS -m 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    warn "a Huntaway server is already running on port $port. The app uses it rather than starting its own, so it updates only if that server runs from a checkout (and follows a deployment only if it was started with --update-from)."
  fi
  say "Huntaway is installed in $DIR"
  if [ -n "$UPDATE_FROM" ]; then
    echo "It follows $UPDATE_FROM: when that runs a newer commit, the sidebar shows \"N new commits · Update\"."
  else
    echo "To update it, git pull in $DIR and use Rebuild & restart (Settings → Server), or run this script again."
  fi
fi

if [ "$OPEN" = 1 ] && [ ${#LAUNCH[@]} -gt 0 ]; then
  if [ "$OS" = Darwin ]; then "${LAUNCH[@]}"; else nohup "${LAUNCH[@]}" >/dev/null 2>&1 & fi
fi
