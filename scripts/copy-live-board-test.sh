#!/usr/bin/env bash
# Tests which database file scripts/copy-live-board.sh copies (`--source`), in a fake old data dir: the one a
# process has open, the only one there, or HUNTAWAY_LIVE_DB's; and what `--scrub` removes from an old database (made
# from the old schema, packages/testing/fixtures/legacy/schema.sql). Carried over from the old repository's test.
# Run: bash scripts/copy-live-board-test.sh
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
  if got="$(env "$@" HUNTAWAY_LIVE_DATA_DIR="$live" bash "$script" --source 2>/dev/null)"; then :; else got=error; fi
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
expect "both open, HUNTAWAY_LIVE_DB says" huntaway.db HUNTAWAY_LIVE_DB=huntaway.db
release
expect "both there, neither open" error
expect "both there, HUNTAWAY_LIVE_DB says" huntaway-2.db HUNTAWAY_LIVE_DB=huntaway-2.db
expect "HUNTAWAY_LIVE_DB names no file" error HUNTAWAY_LIVE_DB=issue-agent.db

# --scrub, on a database with the old server's schema, where sqlite3 is there: what would have a test server act for
# the old board goes, and the rest stays.
if command -v sqlite3 > /dev/null; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  db="$live/scrub.db"
  sqlite3 "$db" ".read $root/packages/testing/fixtures/legacy/schema.sql"
  sqlite3 "$db" <<'SQL'
INSERT INTO profiles (id, name, created_at, telemetry) VALUES ('p', 'p', '2026', 1);
INSERT INTO settings (key, value) VALUES ('telemetry_url', 'x'), ('telemetry_password', 'x'), ('default_model', 'opus'),
  ('vapid_private_key', 'x'), ('telegram_token:p', 'x');
INSERT INTO telemetry_outbox (target, row, at) VALUES ('events', '{}', '2026');
INSERT INTO links (id, name, mode, created_at) VALUES ('h', 'h', 'outbound', '2026');
SQL
  bash "$script" --scrub "$db"
  # check <what> <sql> <want>
  check() {
    local got
    got="$(sqlite3 "$db" "$2")"
    if [[ $got == "$3" ]]; then echo "ok   $1"; else
      echo "FAIL $1: got $got, want $3"
      failed=1
    fi
  }
  check "scrub: telemetry's settings go" "SELECT count(*) FROM settings WHERE key LIKE 'telemetry%'" 0
  check "scrub: the rows waiting to be sent go" "SELECT count(*) FROM telemetry_outbox" 0
  check "scrub: no profile sends" "SELECT count(*) FROM profiles WHERE telemetry=1" 0
  check "scrub: the push key, Telegram and links go" "SELECT (SELECT count(*) FROM settings WHERE key LIKE 'vapid%' OR key LIKE 'telegram%') + (SELECT count(*) FROM links)" 0
  check "scrub: other settings stay" "SELECT value FROM settings WHERE key='default_model'" opus
else
  echo "skip --scrub (needs sqlite3)"
fi

exit $failed
