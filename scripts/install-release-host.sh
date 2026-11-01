#!/bin/sh
# Install a host from a GitHub release's server tarball, to update from releases (README "Release updates").
#
#   scripts/install-release-host.sh [--version <v>] [--dir <dir>] [--data-dir <dir>] [--repo <OWNER/REPO>]
#
# Downloads huntaway-server-<v>-linux-<arch>.tar.gz (the latest release by default), checks it against the sha256
# GitHub lists for it, unpacks it into <dir>/<v>/ (default ~/.local/share/huntaway-server) and checks that it runs.
# Then writes <dir>/huntaway-host, a launcher that starts the release the server last updated to
# (<data dir>/app/<current>/huntaway), or else this one, with --release-updates on. It changes nothing else: it
# prints how to point a hub's SSH forced command at the launcher, and how to start the host with it.
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

launcher=$dir/huntaway-host
cat > "$launcher.new" <<EOF
#!/bin/sh
# Written by scripts/install-release-host.sh. Starts the release this host last updated to, or else $version.
# It doesn't compare versions: after installing a newer tarball, delete $data_dir/app/.
export IA_RELEASE_UPDATES=$repo
export IA_BUNDLED_SERVER='$target/huntaway'
v=\$(sed -n 's/^ *"current": *"\([^"]*\)".*/\1/p' '$data_dir/app/state.json' 2>/dev/null)
[ -n "\$v" ] && [ -x '$data_dir/app/'"\$v/huntaway" ] && exec '$data_dir/app/'"\$v/huntaway" "\$@"
exec '$target/huntaway' "\$@"
EOF
chmod 755 "$launcher.new"
mv "$launcher.new" "$launcher"

cat <<EOF

Installed $version in $target, and the launcher $launcher.

For a host a hub starts over SSH, change the command in the hub's line in ~/.ssh/authorized_keys to
  command="$launcher ssh-host --port 7878"
(with your port). Then stop the host that's running now (agents keep running), and start it with
  $launcher ssh-host --port 7878
or let the hub start it when it reconnects. A host you start yourself:
  $launcher serve --data-dir '$data_dir' …
Its board then shows new releases under Settings → Server, and a hub's Settings → Hosts offers
Update to the release the hub runs.
EOF
