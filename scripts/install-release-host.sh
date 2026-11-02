#!/bin/sh
# Install a host from a GitHub release's server tarball, to update from releases (README "Release updates").
#
#   scripts/install-release-host.sh [--version <v>] [--dir <dir>] [--data-dir <dir>] [--repo <OWNER/REPO>]
#
# Downloads huntaway-server-<v>-linux-<arch>.tar.gz (the latest release by default), checks it against the sha256
# GitHub lists for it, unpacks it into <dir>/<v>/ (default ~/.local/share/huntaway-server), checks that it runs, and
# points <dir>/current at it. It changes nothing else: it prints how to start the host with release updates on, and
# the forced command for a hub that starts it over SSH.
set -eu

repo=dire-kiwi/huntaway
version=
dir=${XDG_DATA_HOME:-$HOME/.local/share}/huntaway-server
data_dir=
while [ $# -gt 0 ]; do
  case $1 in
    --version) version=${2#v}; shift 2 ;;
    --dir) dir=$2; shift 2 ;;
    --data-dir) data_dir=$2; shift 2 ;;
    --repo) repo=$2; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
for tool in curl jq tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "needs $tool" >&2; exit 1; }
done
# The data dir as the server picks it: huntaway, or issue-agent from before the rename.
if [ -z "$data_dir" ]; then
  base=${XDG_DATA_HOME:-$HOME/.local/share}
  data_dir=$base/huntaway
  [ ! -e "$data_dir" ] && [ -d "$base/issue-agent" ] && data_dir=$base/issue-agent
fi
case $(uname -s)-$(uname -m) in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  *) echo "no server tarball for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

# The release: the given version, or the highest that isn't a draft or prerelease and has a tarball for this machine.
releases=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/releases?per_page=100")
asset=$(printf '%s' "$releases" | jq -c --arg v "$version" --arg p "$platform" '
  [.[] | select(.draft | not) | (.tag_name | ltrimstr("v")) as $tv
    | select(if $v == "" then (.prerelease | not) and ($tv | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) else $tv == $v end)
    | .assets[] | select(.name == "huntaway-server-\($tv)-\($p).tar.gz" and (.digest // "" | startswith("sha256:")))
    | {version: $tv, url: .browser_download_url, sha256: (.digest | ltrimstr("sha256:"))}]
  | sort_by(.version | split(".") | map(tonumber? // 0)) | last // empty')
[ -n "$asset" ] || { echo "no release${version:+ $version} of $repo has a server tarball for $platform with a sha256" >&2; exit 1; }
version=$(printf '%s' "$asset" | jq -r .version)
target=$dir/$version
if [ -x "$target/huntaway" ]; then
  echo "$target is already installed"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $repo $version for $platform"
  curl -fSL --progress-bar -o "$tmp/server.tar.gz" "$(printf '%s' "$asset" | jq -r .url)"
  echo "$(printf '%s' "$asset" | jq -r .sha256)  $tmp/server.tar.gz" | sha256sum -c --quiet
  mkdir "$tmp/out"
  tar -xzf "$tmp/server.tar.gz" -C "$tmp/out" --no-same-owner
  unpacked=$tmp/out/huntaway-server-$version-$platform
  # That it runs here (releases before 0.2 have no --version).
  "$unpacked/huntaway" --version 2>/dev/null || "$unpacked/huntaway" --help >/dev/null
  mkdir -p "$dir"
  mv "$unpacked" "$target"
fi

# A path that stays the same when a newer tarball is installed. The server itself starts the release it last updated to
# (in <data dir>/app/), when that's newer than its own.
ln -sfn "$version" "$dir/current"
server=$dir/current/huntaway

# For the shell: single-quoted, with any ' in it as '\''.
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# The same data dir for both: without --data-dir, ssh-host would start a board in the default one instead. In
# authorized_keys' command="…", sshd only undoes \" (opt_dequote), and leaves other backslashes as they are.
serve="IA_RELEASE_UPDATES=$repo $(q "$server") serve --data-dir $(q "$data_dir")"
ssh_host="IA_RELEASE_UPDATES=$repo $(q "$server") ssh-host --port 7878 --data-dir $(q "$data_dir")"

cat <<EOF

Installed $version in $target, and pointed $dir/current at it.

Start it with release updates on (agents of a host running now keep running when you stop it):
  $serve …
For a host a hub starts over SSH, change the command in the hub's line in ~/.ssh/authorized_keys to
  command="$(printf '%s' "$ssh_host" | sed 's/"/\\"/g')"
(with your port), stop the host that's running now, and let the hub start it when it reconnects (or
run that command yourself). Its board then shows new releases under Settings → Server, and a hub's
Settings → Hosts offers Update to the release the hub runs.
EOF
