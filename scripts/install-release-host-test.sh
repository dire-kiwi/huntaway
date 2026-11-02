#!/bin/sh
# Tests for install-release-host.sh, against a fake release (a curl stub and a tarball whose huntaway prints its
# arguments): the commands it prints run the installed server on the data dir it was given (or the default one), as
# they are, through a shell, and through authorized_keys' quoting.
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
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# A release 9.9.9 whose huntaway prints IA_RELEASE_UPDATES and then its arguments, one per line.
top=huntaway-server-9.9.9-$platform
mkdir -p "$tmp/build/$top" "$tmp/bin"
printf '#!/bin/sh\necho "updates=$IA_RELEASE_UPDATES"\nfor a; do printf "%%s\\n" "$a"; done\n' > "$tmp/build/$top/huntaway"
chmod 755 "$tmp/build/$top/huntaway"
tar -C "$tmp/build" -czf "$tmp/server.tar.gz" "$top"
sha=$(sha256sum "$tmp/server.tar.gz" | cut -d' ' -f1)
jq -n --arg name "$top.tar.gz" --arg sha "$sha" '[{tag_name: "v9.9.9", draft: false, prerelease: false,
  assets: [{name: $name, digest: "sha256:\($sha)", browser_download_url: "https://example.invalid/\($name)"}]}]' > "$tmp/releases.json"
# curl: the release list, or the tarball for -o.
cat > "$tmp/bin/curl" <<EOF
#!/bin/sh
out=
while [ \$# -gt 0 ]; do [ "\$1" = -o ] && out=\$2; shift; done
if [ -n "\$out" ]; then cp '$tmp/server.tar.gz' "\$out"; else cat '$tmp/releases.json'; fi
EOF
chmod 755 "$tmp/bin/curl"

# Runs the installer with $@, and checks that both printed commands start the server on data dir $1.
check() {
  want=$1
  shift
  out=$(HOME=$tmp/home XDG_DATA_HOME= PATH="$tmp/bin:$PATH" sh "$script" --dir "$tmp/servers" "$@") || fail "the installer failed: $out"
  serve=$(printf '%s\n' "$out" | sed -n 's/^  \(.* serve .*\) …$/\1/p')
  [ -n "$serve" ] || fail "no serve command in: $out"
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
  for cmd in "$serve" "$ssh"; do
    got=$(sh -c "$cmd" 2>&1) || fail "$cmd didn't run: $got"
    printf '%s\n' "$got" | grep -qxF 'updates=dire-kiwi/huntaway' || fail "no IA_RELEASE_UPDATES from: $cmd"
    printf '%s\n' "$got" | grep -A1 -xF -- '--data-dir' | tail -n1 | grep -qxF -- "$want" || fail "not on $want: $cmd gave: $got"
  done
  sh -c "$ssh" | grep -qxF ssh-host || fail "the forced command isn't ssh-host: $ssh"
}

# A data dir given, with a space, quotes and a backslash in it.
odd="$tmp/it's my \"board\" \\ here"
check "$odd" --data-dir "$odd"
# Backslashes next to quotes, and one at the end.
odd="$tmp/a\\'b\\\"c\\"
check "$odd" --data-dir "$odd"
# The default: huntaway's, or the one from before the rename when only that exists.
mkdir -p "$tmp/home/.local/share/issue-agent"
check "$tmp/home/.local/share/issue-agent"
mkdir -p "$tmp/home/.local/share/huntaway"
check "$tmp/home/.local/share/huntaway"
[ -x "$tmp/servers/current/huntaway" ] || fail "current doesn't point at the release"
echo "install-release-host.sh: ok"
