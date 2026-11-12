#!/usr/bin/env bash
# Tests scripts/switch-board.sh on old boards made from the old schema (packages/testing/fixtures/legacy/schema.sql)
# with sqlite3, in temp folders: the switch into an empty folder, the switch over a board already there (set aside,
# then put back with --undo), the refusal while the new board is open, and a rehearsal that leaves the new folder alone.
# Run: bash scripts/switch-board-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script=$root/scripts/switch-board.sh
command -v sqlite3 > /dev/null || { echo "skip switch-board-test.sh: no sqlite3"; exit 0; }
tmp="$(mktemp -d)"
tmp="$(cd "$tmp" && pwd -P)"
holder=
cleanup() {
  [[ -n $holder ]] && kill "$holder" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
failed=0

# old_board <dir> <host id> <profile name>
old_board() {
  mkdir -p "$1"
  sqlite3 "$1/huntaway-2.db" ".read $root/packages/testing/fixtures/legacy/schema.sql"
  sqlite3 "$1/huntaway-2.db" "INSERT INTO profiles (id, name, created_at) VALUES ('p-$2', '$3', '2026-01-01T00:00:00.000Z')"
  echo "$2" > "$1/host_id"
  echo "token-$2" > "$1/auth_token"
}
# check <what> <got> <want>
check() {
  if [[ $2 == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: got '$2', want '$3'"
    failed=1
  fi
}
switch() { TMPDIR=$tmp bash "$script" --data-dir "$tmp/new" --yes "$@" > "$tmp/out" 2>&1; }
profiles() { sqlite3 "$1/board.db" "SELECT group_concat(name) FROM profiles"; }

old_board "$tmp/a" host-a "Board A"
old_board "$tmp/b" host-b "Board B"

switch --from "$tmp/a" || { cat "$tmp/out"; exit 1; }
check "into an empty folder: the old board" "$(profiles "$tmp/new")" "Board A"
check "into an empty folder: the old identity" "$(cat "$tmp/new/host_id")" host-a
check "into an empty folder: nothing set aside" "$(find "$tmp/new" -maxdepth 1 -name 'replaced-*' | wc -l)" 0

mkdir -p "$tmp/new/projects/j1/worktrees/1-x" "$tmp/new/runs/r1"
sleep 300 3<"$tmp/new/board.db" &
holder=$!
if switch --from "$tmp/b"; then got=switched; else got=refused; fi
check "while the new board is open: refused" "$got" refused
check "while the new board is open: the board as it was" "$(profiles "$tmp/new")" "Board A"
kill "$holder"
wait "$holder" 2>/dev/null || true
holder=

before="$(ls "$tmp/new" | sort | tr '\n' ' ')"
TMPDIR=$tmp bash "$script" --from "$tmp/b" --data-dir "$tmp/new" --rehearse > "$tmp/out" 2>&1 || { cat "$tmp/out"; exit 1; }
check "a rehearsal leaves the new folder alone" "$(ls "$tmp/new" | sort | tr '\n' ' ')" "$before"
check "a rehearsal makes a board of its own" "$(profiles "$(ls -d "$tmp"/huntaway-rehearsal-*)")" "Board B"

switch --from "$tmp/b" || { cat "$tmp/out"; exit 1; }
aside="$(find "$tmp/new" -maxdepth 1 -name 'replaced-*')"
check "over a board: the old board" "$(profiles "$tmp/new")" "Board B"
check "over a board: the old identity" "$(cat "$tmp/new/host_id")" host-b
check "over a board: worktrees stay" "$(test -d "$tmp/new/projects/j1/worktrees/1-x" && echo yes)" yes
check "over a board: the board set aside" "$(profiles "$aside")" "Board A"
check "over a board: its identity and runs set aside" "$(cat "$aside/host_id") $(test -d "$aside/runs/r1" && echo runs)" "host-a runs"

switch --undo "$aside" || { cat "$tmp/out"; exit 1; }
check "--undo: the board back" "$(profiles "$tmp/new")" "Board A"
check "--undo: its identity back" "$(cat "$tmp/new/host_id") $(cat "$tmp/new/auth_token")" "host-a token-host-a"
check "--undo: its runs back" "$(test -d "$tmp/new/runs/r1" && echo yes)" yes
check "--undo: the folder set aside is gone" "$(test -e "$aside" && echo there || echo gone)" gone
check "the old folders are as they were" "$(cat "$tmp/a/host_id") $(cat "$tmp/b/host_id")" "host-a host-b"

exit $failed
