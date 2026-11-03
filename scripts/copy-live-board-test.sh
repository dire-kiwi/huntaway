#!/usr/bin/env bash
# Tests which database file scripts/copy-live-board.sh copies (`--source`), in a fake live data dir: the one a
# process has open, the only one there, or IA_LIVE_DB's. Run: bash scripts/copy-live-board-test.sh
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/copy-live-board.sh"
live="$(mktemp -d)"
live="$(cd "$live" && pwd -P)"
holders=()
cleanup() {
  for p in "${holders[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$live"
}
trap cleanup EXIT
failed=0

# Keep a file open, as a server does its database.
hold() {
  sleep 300 3<"$live/$1" &
  holders+=($!)
}
release() {
  for p in "${holders[@]}"; do kill "$p" 2>/dev/null || true; done
  holders=()
}
# expect <what> <file, or "error"> [env...]
expect() {
  local what=$1 want=$2 got
  shift 2
  if got="$(env "$@" IA_LIVE_DATA_DIR="$live" bash "$script" --source 2>/dev/null)"; then :; else got=error; fi
  [[ $want == error ]] || want=$live/$want
  if [[ $got == "$want" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what: got $got, want $want"
    failed=1
  fi
}

expect "an empty data dir" error
touch "$live/issue-agent.db"
expect "only issue-agent.db" issue-agent.db
rm "$live/issue-agent.db"
touch "$live/huntaway.db" "$live/huntaway-2.db" "$live/huntaway-2.db-wal"

hold huntaway.db
# What a newer build left's log being open doesn't count.
hold huntaway-2.db-wal
expect "rolled back: huntaway.db open, huntaway-2.db there too" huntaway.db
release
hold huntaway-2.db
expect "huntaway-2.db open" huntaway-2.db
hold huntaway.db
expect "both open" error
expect "both open, IA_LIVE_DB says" huntaway.db IA_LIVE_DB=huntaway.db
release
expect "both there, neither open" error
expect "both there, IA_LIVE_DB says" huntaway-2.db IA_LIVE_DB=huntaway-2.db
expect "IA_LIVE_DB names no file" error IA_LIVE_DB=issue-agent.db

exit $failed
