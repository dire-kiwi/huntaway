#!/usr/bin/env bash
# Installs the Huntaway desktop app from source on Linux or macOS, or updates an install.
#
#   curl -fsSL https://raw.githubusercontent.com/dire-kiwi/huntaway/master/scripts/install.sh | bash
#   scripts/install.sh [options]          # from a checkout; run --help for the options
#
# It checks for the build tools, clones the repository (or fast-forwards a clone it made before),
# builds the UI, installs the server's dependencies (the server, server-ts/, runs on Node 24+ from its sources) and
# builds ia-shim, the Rust supervisor its agents run under (with cargo, or else it takes the latest release's prebuilt
# one, on Linux x64 and Apple silicon), and adds Huntaway to the app launcher (a .desktop entry on Linux,
# ~/Applications/Huntaway.app on macOS). With --update-from URL (or HUNTAWAY_UPDATE_FROM), the app's server follows
# the board deployed there: once that runs a newer commit, the sidebar shows
# "N new commits · Update", which fetches it, rebuilds and restarts like Rebuild & restart.
set -euo pipefail

REPO="${HUNTAWAY_REPO:-https://github.com/dire-kiwi/huntaway.git}"
BRANCH="${HUNTAWAY_BRANCH:-master}"
DIR="${HUNTAWAY_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/huntaway-app}"
UPDATE_FROM="${HUNTAWAY_UPDATE_FROM-}"
# The GitHub repository whose latest release has the prebuilt ia-shim, without cargo.
RELEASES="${HUNTAWAY_RELEASES:-dire-kiwi/huntaway}"
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

# ---------- dependencies ----------

pkg_hint() {
  if [ "$OS" = Darwin ]; then
    echo "  xcode-select --install          # git"
    echo "  brew install node               # and, to build ia-shim yourself: brew install rust"
  elif command -v pacman >/dev/null 2>&1; then
    echo "  sudo pacman -S --needed git nodejs npm      # and, to build ia-shim yourself: base-devel rustup"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  sudo apt-get install git curl"
    echo "  Node.js 24+: https://nodejs.org/en/download (Debian and Ubuntu's own is older)"
    echo "  To build ia-shim yourself: sudo apt-get install build-essential, and Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  elif command -v dnf >/dev/null 2>&1; then
    echo "  sudo dnf install git nodejs npm"
    echo "  To build ia-shim yourself: sudo dnf install gcc, and Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  else
    echo "  git and Node.js 24+ with npm (https://nodejs.org); to build ia-shim yourself, a C compiler and Rust (https://rustup.rs)"
  fi
}

# The release platform whose server tarball has a prebuilt ia-shim for this machine (see .github/workflows/release.yml).
release_platform() {
  case "$OS-$(uname -m)" in
    Linux-x86_64) echo linux-x64 ;;
    Darwin-arm64) echo mac-arm64 ;;
    *) return 1 ;;
  esac
}

check_deps() {
  local missing=() v
  for c in git node npm; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if command -v node >/dev/null 2>&1; then
    v="$(node -p 'process.versions.node')"
    # The server runs its .ts files with Node's type stripping and node:sqlite, as Node 24 has them.
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || missing+=("Node.js 24 or newer (this is $v)")
  fi
  # ia-shim: built with cargo when there's a Rust toolchain, else a release's prebuilt one.
  SHIM=prebuilt
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    SHIM=cargo
    v="$(rustc --version | awk '{print $2}')"
    # The workspace is edition 2024 (Rust 1.85+), and its locked dependencies need 1.89 (Cargo.toml's rust-version).
    [ "$(printf '%s\n' "$v" | awk -F. '{print ($1 > 1 || $2 >= 89) ? "ok" : "old"}')" = ok ] ||
      missing+=("Rust 1.89 or newer to build ia-shim (this is $v; rustup update)")
    if [ "$OS" = Darwin ]; then
      xcode-select -p >/dev/null 2>&1 || missing+=("Xcode command line tools, to build ia-shim")
    else
      command -v cc >/dev/null 2>&1 || missing+=("a C compiler (cc), to build ia-shim")
    fi
  elif ! release_platform >/dev/null; then
    missing+=("Rust (cargo and rustc), to build ia-shim: there's no prebuilt one for $OS $(uname -m)")
  else
    for c in curl tar; do
      command -v "$c" >/dev/null 2>&1 || missing+=("$c, to download a prebuilt ia-shim (or Rust, to build it)")
    done
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
  [ -f "$DIR/server-ts/package.json" ] && [ -f "$DIR/app/package.json" ] || die "$DIR doesn't look like a Huntaway checkout"
}

build() {
  say "Building the UI"
  # npm install once there's a node_modules, as Rebuild & restart does: npm ci would delete the Electron a running app is using.
  # --no-save keeps it from rewriting package-lock.json, which would stop a hub's Update ("uncommitted changes").
  local npm_install=ci
  [ -d "$DIR/app/node_modules" ] && npm_install="install --no-save"
  (cd "$DIR/app" && npm $npm_install --no-audit --no-fund && npm run build)
  say "Installing the server's dependencies"
  # npm ci when its lockfile changed since the last install (as Rebuild & restart does, see lockfile_changed in
  # server-ts/src/update/admin.ts), which leaves a running server's node_modules alone otherwise.
  local installed="$DIR/server-ts/node_modules/.package-lock.json"
  if [ ! -f "$installed" ] || [ "$DIR/server-ts/package-lock.json" -nt "$installed" ]; then
    (cd "$DIR/server-ts" && npm ci --no-audit --no-fund)
  fi
  if [ "$SHIM" = cargo ]; then
    say "Building ia-shim (the first build takes a minute)"
    (cd "$DIR/server" && cargo build --release --locked -p ia-shim)
  else
    prebuilt_shim
  fi
}

# The latest release's ia-shim, from its server tarball (checked against the sha256 GitHub lists for it), into
# server-ts/bin/, where the server looks for it beside bin/huntaway. Rebuild & restart keeps it while there's no cargo.
prebuilt_shim() {
  local platform tmp asset name sum
  platform="$(release_platform)"
  say "Downloading a prebuilt ia-shim from $RELEASES's latest release ($platform)"
  tmp="$(mktemp -d)"
  curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$RELEASES/releases/latest" >"$tmp/release.json" ||
    { rm -rf "$tmp"; die "couldn't read $RELEASES's latest release; install Rust to build ia-shim instead"; }
  # name, url and sha256 of the server tarball, a line each.
  asset="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = String(r.tag_name || "").replace(/^v/, "");
    const a = (r.assets || []).find((a) => a.name === `huntaway-server-${v}-${process.argv[2]}.tar.gz` && /^sha256:/.test(a.digest || ""));
    if (a) console.log([`huntaway-server-${v}-${process.argv[2]}`, a.browser_download_url, a.digest.slice(7)].join("\n"))' "$tmp/release.json" "$platform")"
  [ -n "$asset" ] || { rm -rf "$tmp"; die "$RELEASES's latest release has no server tarball for $platform; install Rust to build ia-shim instead"; }
  name="$(printf '%s\n' "$asset" | sed -n 1p)"
  curl -fSL --progress-bar -o "$tmp/server.tar.gz" "$(printf '%s\n' "$asset" | sed -n 2p)" || { rm -rf "$tmp"; die "couldn't download $name.tar.gz"; }
  if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$tmp/server.tar.gz" | cut -d' ' -f1)"; else sum="$(shasum -a 256 "$tmp/server.tar.gz" | cut -d' ' -f1)"; fi
  [ "$sum" = "$(printf '%s\n' "$asset" | sed -n 3p)" ] || { rm -rf "$tmp"; die "$name.tar.gz doesn't match its sha256"; }
  tar -xzf "$tmp/server.tar.gz" -C "$tmp" "$name/ia-shim" || { rm -rf "$tmp"; die "$name.tar.gz has no ia-shim"; }
  mkdir -p "$DIR/server-ts/bin"
  # Moved into place, so that a shim that's running (an agent's) keeps its file.
  cp "$tmp/$name/ia-shim" "$DIR/server-ts/bin/.ia-shim.new" && chmod 755 "$DIR/server-ts/bin/.ia-shim.new" &&
    mv -f "$DIR/server-ts/bin/.ia-shim.new" "$DIR/server-ts/bin/ia-shim"
  rm -rf "$tmp"
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

# Electron downloads its binary the first time it's required (and again once an update has
# installed another version), not when npm installs it.
ensure_electron() {
  node -e 'require(process.argv[1])' "$DIR/app/node_modules/electron" >/dev/null || die "couldn't download Electron"
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
    # For the app to relaunch through this, which downloads a new Electron after an update.
    echo "HUNTAWAY_LAUNCHER=$(shq "$launcher")"
    echo "export HUNTAWAY_LAUNCHER"
    echo "electron=$(shq "$DIR/app/node_modules/electron")"
    echo "node -e 'require(process.argv[1])' \"\$electron\" >/dev/null || exit 1"
    echo "exec \"\$electron/dist/\$(cat \"\$electron/path.txt\")\" $(shq "$DIR/app") \"\$@\""
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
  ditto "$DIR/app/node_modules/electron/dist/Electron.app" "$app"
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

# All in a function that runs on the last line, so that a download cut short under `curl | bash` runs nothing.
main() {
  local d port
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

  LAUNCH=()
  if [ "$BUILD" = 1 ]; then
    check_deps
    fetch_source
    build
  else
    [ -f "$DIR/server-ts/node_modules/ws/package.json" ] || die "no build in $DIR; run this without --shortcut-only first"
  fi
  ensure_electron

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
}

main "$@"
