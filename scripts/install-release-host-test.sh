#!/bin/sh
# Tests for install-release-host.sh, against fake releases (a curl stub and tarballs whose huntaway prints its
# arguments), in a temp folder with a HOME of its own: the commands it prints run the installed server on the data dir
# and port it was given (or the defaults), as they are, through a shell, and through authorized_keys' quoting; it picks
# the highest release, refuses a tarball that doesn't match its sha256, and touches no service (systemctl and loginctl
# on PATH fail the test if run). Carried over from dire-kiwi/huntaway-legacy (scripts/install-release-host-test.sh).
#
#   sh scripts/install-release-host-test.sh
set -eu

for tool in jq tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "skipped: needs $tool"; exit 0; }
done
case $(uname -s)-$(uname -m) in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  *) echo "skipped: no server tarball for $(uname -s) $(uname -m)"; exit 0 ;;
esac
script=$(cd "$(dirname "$0")" && pwd)/install-release-host.sh
tmp=$(mktemp -d "${TMPDIR:-/tmp}/install-release-host-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Releases 9.9.9, 9.10.0 (the highest), 10.0.0-rc.1 (a prerelease) and 9.11.0 (a draft): each one's huntaway answers
# --version as that release, else prints HUNTAWAY_RELEASE_UPDATES and then its arguments, one per line.
mkdir -p "$tmp/build" "$tmp/assets" "$tmp/bin"
release() { # <version> <prerelease> <draft> [<the version its huntaway says>]
  top=huntaway-server-$1-$platform
  mkdir -p "$tmp/build/$top"
  cat > "$tmp/build/$top/huntaway" <<EOF
#!/bin/sh
[ "\$1" = --version ] && { echo "huntaway ${4:-$1}"; exit 0; }
echo "updates=\$HUNTAWAY_RELEASE_UPDATES"
for a; do printf "%s\\n" "\$a"; done
EOF
  chmod 755 "$tmp/build/$top/huntaway"
  tar -C "$tmp/build" -czf "$tmp/assets/$top.tar.gz" "$top"
  sha=$(sha256sum "$tmp/assets/$top.tar.gz" | cut -d' ' -f1)
  jq -n --arg v "$1" --arg name "$top.tar.gz" --arg sha "$sha" --argjson pre "$2" --argjson draft "$3" '{tag_name: "v\($v)",
    draft: $draft, prerelease: $pre, assets: [{name: $name, digest: "sha256:\($sha)", browser_download_url: "https://example.invalid/\($name)"}]}'
}
{ release 9.9.9 false false; release 9.10.0 false false; release 10.0.0-rc.1 true false; release 9.11.0 false true; } | jq -s . > "$tmp/releases.json"
# curl: the release list, or the asset its URL names for -o. It never reaches the network.
cat > "$tmp/bin/curl" <<EOF
#!/bin/sh
out= url=
while [ \$# -gt 0 ]; do
  case \$1 in -o) out=\$2; shift ;; https://*) url=\$1 ;; esac
  shift
done
if [ -n "\$out" ]; then cp "$tmp/assets/\${url##*/}" "\$out"; else cat '$tmp/releases.json'; fi
EOF
# Nothing here may install a service or change linger.
for tool in systemctl loginctl; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/touched"\nexit 1\n' "$tool" "$tmp" > "$tmp/bin/$tool"
done
chmod 755 "$tmp/bin/"*

run() { HOME=$tmp/home XDG_DATA_HOME= PATH="$tmp/bin:$PATH" sh "$script" --dir "$tmp/servers" "$@"; }

# Runs the installer with $@, and checks that the printed commands run the server on data dir $1 and port $2.
check() {
  want=$1 want_port=$2
  shift 2
  out=$(run "$@") || fail "the installer failed: $out"
  serve=$(printf '%s\n' "$out" | sed -n 's/^  \(.* serve .*\) …$/\1/p')
  [ -n "$serve" ] || fail "no serve command in: $out"
  service=$(printf '%s\n' "$out" | sed -n 's/^  \(.* install-service .*\)$/\1/p')
  [ -n "$service" ] || fail "no install-service command in: $out"
  # authorized_keys' command="…" as sshd reads it (opt_dequote in OpenSSH's misc.c): \" is ", any other backslash
  # stays, and the first " that isn't escaped ends it, which has to be the line's last.
  ssh=$(printf '%s\n' "$out" | sed -n 's/^  command="//p' | awk '{
    o = ""
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (c == "\"") break
      if (c == "\\" && substr($0, i + 1, 1) == "\"") { i++; c = "\"" }
      o = o c
    }
    if (i != length($0)) exit 1
    print o
  }') || fail "the forced command doesn't end at its closing quote: $out"
  [ -n "$ssh" ] || fail "no forced command in: $out"
  for cmd in "$serve" "$service" "$ssh"; do
    got=$(sh -c "$cmd" 2>&1) || fail "$cmd didn't run: $got"
    printf '%s\n' "$got" | grep -qxF 'updates=dire-kiwi/huntaway' || fail "no HUNTAWAY_RELEASE_UPDATES from: $cmd"
    printf '%s\n' "$got" | grep -A1 -xF -- '--data-dir' | tail -n1 | grep -qxF -- "$want" || fail "not on $want: $cmd gave: $got"
    printf '%s\n' "$got" | grep -A1 -xF -- '--port' | tail -n1 | grep -qxF -- "$want_port" || fail "not on port $want_port: $cmd gave: $got"
  done
  sh -c "$ssh" | grep -qxF ssh-host || fail "the forced command isn't ssh-host: $ssh"
}

# The defaults: huntaway-effect's data folder and port 7879, and the highest release that isn't a draft or prerelease.
check "$tmp/home/.local/share/huntaway-effect" 7879
[ "$(readlink "$tmp/servers/current")" = 9.10.0 ] || fail "current doesn't point at 9.10.0, the highest release: $(readlink "$tmp/servers/current")"
[ -x "$tmp/servers/current/huntaway" ] || fail "current doesn't point at an installed release"
# A data dir given, with a space, quotes and a backslash in it, and another port.
odd="$tmp/it's my \"board\" \\ here"
check "$odd" 7900 --data-dir "$odd" --port 7900
# Backslashes next to quotes, and one at the end.
odd="$tmp/a\\'b\\\"c\\"
check "$odd" 7879 --data-dir "$odd"
# A version asked for: a prerelease, by its tag with or without the v.
check "$tmp/home/.local/share/huntaway-effect" 7879 --version v10.0.0-rc.1
[ "$(readlink "$tmp/servers/current")" = 10.0.0-rc.1 ] || fail "current doesn't point at 10.0.0-rc.1"
out=$(run --version 9.11.0 2>&1) && fail "installed a draft: $out"
# A tarball that isn't what GitHub's digest says is refused, and nothing of it is installed.
echo tampered > "$tmp/build/huntaway-server-9.9.9-$platform/extra"
tar -C "$tmp/build" -czf "$tmp/assets/huntaway-server-9.9.9-$platform.tar.gz" "huntaway-server-9.9.9-$platform"
out=$(run --version 9.9.9 2>&1) && fail "installed a tarball that doesn't match its sha256: $out"
[ ! -e "$tmp/servers/9.9.9" ] || fail "a tarball that doesn't match its sha256 left $tmp/servers/9.9.9"
# A tarball whose huntaway says it's another release is refused.
{ jq '.[]' "$tmp/releases.json"; release 9.12.0 false false 9.10.0; } | jq -s . > "$tmp/r" && mv "$tmp/r" "$tmp/releases.json"
out=$(run 2>&1) && fail "installed a tarball whose huntaway isn't 9.12.0: $out"
[ ! -e "$tmp/servers/9.12.0" ] || fail "a tarball of another release left $tmp/servers/9.12.0"
[ ! -e "$tmp/touched" ] || fail "the installer ran: $(cat "$tmp/touched")"
echo "install-release-host.sh: ok"
