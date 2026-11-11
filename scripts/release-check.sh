#!/usr/bin/env bash
# Checks a release package that scripts/package-server.sh made, as the release workflow does before it ships it:
#
#   scripts/release-check.sh <release dir> [<version>]
#
# - `huntaway --version` prints `huntaway <version>` (default: build.json's), which a host installing it checks;
# - the server is compiled to .js (no .ts in server/src or server/migrations);
# - the packaged server starts on 127.0.0.1, on a free port (--port 0), on a fresh data folder under $TMPDIR, with no
#   agents, and answers /api/health with this version and build.json's commit, and serves the UI from ui/;
# - the approval hook answers through the packaged huntaway, and how long it takes.
# It stops the server it started, by its PID, whatever happens, and removes its data folder.
set -euo pipefail

rel=$(cd "${1:?usage: $0 <release dir> [<version>]}" && pwd)
node=$rel/node/bin/node
version=${2:-$("$node" -p 'require(process.argv[1]).version' "$rel/build.json")}
commit=$("$node" -p 'require(process.argv[1]).commit' "$rel/build.json")
fail() { echo "release-check: $*" >&2; exit 1; }

got=$("$rel/huntaway" --version)
[[ $got == "huntaway $version" ]] || fail "huntaway --version says '$got', not 'huntaway $version'"
[[ -f $rel/server/src/bin.js && -z $(find "$rel/server/src" "$rel/server/migrations" -name '*.ts' -print -quit) ]] ||
  fail "expected the server compiled to .js in server/src and server/migrations"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/release-check.XXXXXX")
pid=
cleanup() {
  if [[ -n $pid ]]; then
    kill -TERM "$pid" 2> /dev/null || true
    wait "$pid" 2> /dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
"$rel/huntaway" serve --host 127.0.0.1 --port 0 --data-dir "$tmp/data" --no-agents --no-discovery > "$tmp/out" 2> "$tmp/log" < /dev/null &
pid=$!
port=
for _ in $(seq 300); do
  port=$(sed -n 's/^HUNTAWAY_READY {"port":\([0-9]*\).*/\1/p' "$tmp/out")
  [[ -n $port ]] && break
  kill -0 "$pid" 2> /dev/null || break
  sleep 0.1
done
[[ -n $port ]] || { cat "$tmp/log" >&2; fail "the packaged server didn't say it was ready"; }
url=http://127.0.0.1:$port
health=$(curl -fsS "$url/api/health")
echo "health: $health"
"$node" -e 'const h = JSON.parse(process.argv[1]); if (h.version !== process.argv[2]) process.exit(1)' "$health" "$version" ||
  fail "/api/health doesn't report version $version"
"$node" -e 'if (JSON.parse(process.argv[1]).commit !== process.argv[2]) process.exit(1)' "$health" "$commit" ||
  fail "/api/health doesn't report build.json's commit $commit"
curl -fsS "$url/" | grep -qi '<html' || { cat "$tmp/log" >&2; fail "$url/ doesn't serve the UI (ui/index.html)"; }
kill -TERM "$pid"
wait "$pid" || true
pid=

# The approval hook through the launcher, as an agent CLI starts it: with no rules it lets the call through.
input='{"tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s","cwd":"/"}'
times=
for _ in 1 2 3 4 5; do
  t0=${EPOCHREALTIME:-}
  printf '%s' "$input" | NODE_COMPILE_CACHE=$tmp/cache "$rel/huntaway" approval-hook '[]' > /dev/null ||
    fail "the approval hook failed"
  [[ -n $t0 ]] && times="$times $("$node" -p "Math.round((${EPOCHREALTIME/,/.} - ${t0/,/.}) * 1000)")"
done
[[ -n $times ]] && echo "approval-hook through huntaway (ms, the first with an empty compile cache):$times"
echo "release-check: $rel is huntaway $version and runs"
