#!/usr/bin/env bash
# Gives a test server a copy of the live board's database, for measuring with real amounts of data
# (hundreds of tasks, threads of thousands of messages; see ui-profile.mjs):
#
#   scripts/test-server.sh --no-agents > /tmp/ia<N>-env
#   scripts/copy-live-board.sh /tmp/ia<N>-env      # the env file or the test server's data dir
#
# It only reads the live database (an online backup), and only into a server test-server.sh started
# with --no-agents. The copy is scrubbed so the test server leaves the live board's things alone: no
# runs to pick up, no repositories or worktrees (their paths are moved under /nonexistent), no
# setup or status scripts, no Claude configs, no Asana tokens, no Telegram bots, no pending prompts and no linked hosts.
# Then the test server restarts on it. IA_LIVE_DATA_DIR overrides where the live data is (~/.local/share/issue-agent).
#
# The copy goes in under the name of the live board's file: `huntaway-2.db` from a server that's moved onto it (see
# apps/server/src/db/file.ts), or `huntaway.db` (or `issue-agent.db`) from one before, which a test server (unless it was
# started with IA_NEW_DB_FILE=0) copies into its `huntaway-2.db` as it restarts, as the live board's does on its update. After a Roll back both are
# there, and the older one is in use, so the source is the file a running process (the live server) has open; with
# none open, the only file there, else IA_LIVE_DB (a file name in the live data dir) says which.
# `copy-live-board.sh --source` only prints the file it would copy (scripts/copy-live-board-test.sh tests it).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
live=${IA_LIVE_DATA_DIR:-$HOME/.local/share/issue-agent}

# The live board's database file: see above.
live_db() {
  local real files=() open=() f
  real="$(cd "$live" && pwd -P)" || { echo "no data dir $live" >&2; return 1; }
  if [[ -n ${IA_LIVE_DB:-} ]]; then
    [[ -f $real/$IA_LIVE_DB ]] || { echo "no $IA_LIVE_DB in $live" >&2; return 1; }
    echo "$real/$IA_LIVE_DB"
    return
  fi
  for f in huntaway-2.db huntaway.db issue-agent.db; do
    [[ -f $real/$f ]] && files+=("$f")
  done
  [[ ${#files[@]} -gt 0 ]] || { echo "no database in $live" >&2; return 1; }
  # Each file that a process has open (fds link to the canonical path; the -wal and -shm files don't count). By what
  # find prints: it fails on other users' processes, which it can't read.
  for f in "${files[@]}"; do
    if [[ -n $(find /proc/[0-9]*/fd -maxdepth 1 -type l -lname "$real/$f" -print -quit 2>/dev/null) ]]; then
      open+=("$f")
    fi
  done
  if [[ ${#open[@]} -eq 1 ]]; then
    echo "$real/${open[0]}"
  elif [[ ${#open[@]} -eq 0 && ${#files[@]} -eq 1 ]]; then
    echo "$real/${files[0]}"
  else
    echo "$live has ${files[*]}, and ${#open[@]} of them are open (${open[*]:-none}), so it can't tell which the live" \
      "board uses: say which with IA_LIVE_DB=<file>" >&2
    return 1
  fi
}

if [[ ${1:-} == --source ]]; then
  live_db
  exit
fi
where=${1:?usage: $0 <test-server env file or data dir>}
if [[ -f $where ]]; then
  dir="$(sed -n 's/^export IA_TEST_DATA_DIR=//p' "$where")"
else
  dir=$where
fi
dir="${dir%/}"
[[ -f $dir/.ia-test-server ]] || { echo "$dir wasn't made by test-server.sh; not touching it" >&2; exit 1; }
grep -qx 'export IA_CLAUDE_BIN=/bin/false' "$dir/launch" && grep -qx 'export IA_CODEX_BIN=/bin/false' "$dir/launch" ||
  { echo "start the test server with --no-agents: its agents would run on the live board's tasks" >&2; exit 1; }

src="$(live_db)"
db=$dir/$(basename "$src")
# A test server opens huntaway-2.db unless IA_NEW_DB_FILE turns it off (on by default, as ON_BY_DEFAULT in db/file.ts).
if [[ $(basename "$src") == huntaway-2.db ]] && grep -Eqix "export IA_NEW_DB_FILE=['\"]?(0|false|no|off)['\"]?" "$dir/launch"; then
  echo "the live board uses huntaway-2.db, which this test server doesn't open: start it without IA_NEW_DB_FILE=0" >&2
  exit 1
fi
[[ "$(cd "$dir" && pwd -P)" != "$(cd "$live" && pwd -P)" ]] || { echo "that's the live data dir" >&2; exit 1; }

pid="$(cat "$dir/server.pid" 2>/dev/null || true)"
if [[ -n $pid ]] && [[ -r /proc/$pid/cmdline ]] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- "$dir"; then
  kill -TERM "$pid"
  for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
fi
# Every database file the test server had (its own huntaway-2.db would be used over the copy), with their logs.
rm -f "$dir"/huntaway.db "$dir"/huntaway.db-* "$dir"/huntaway-2.db "$dir"/huntaway-2.db-* "$dir"/huntaway-2.db.* "$dir"/issue-agent.db* "$dir"/recopy-db
sqlite3 -readonly "$src" ".backup '$db'"
sqlite3 "$db" <<'SQL'
UPDATE runs SET status='exited', ended_at=coalesce(ended_at, created_at) WHERE status<>'exited';
UPDATE tasks SET running=0, merging=0, waiting=0, agent_wait=NULL,
  worktree_path='/nonexistent' || worktree_path, work_dir='/nonexistent' || work_dir;
UPDATE projects SET repo_path='/nonexistent' || repo_path, scratch_path='/nonexistent' || scratch_path,
  worktrees_root='/nonexistent' || worktrees_root, setup_script='', teardown_script='', status_script='', status_scripts='{}';
UPDATE claude_configs SET config_dir='/nonexistent/claude', show_usage=0;
UPDATE profiles SET claude_config_dir='/nonexistent/claude';
UPDATE permission_requests SET status='denied' WHERE status='pending';
DELETE FROM mcp_calls;
DELETE FROM links;
-- Nor do its automations run, or its tasks' pull requests get polled with the user's gh login.
UPDATE automations SET enabled=0, secret=NULL;
UPDATE projects SET done_when_merged=0;
DELETE FROM pr_watches;
DELETE FROM pr_states;
-- Nor do the assistants' Telegram bots poll with the live board's tokens (reading the owner's messages before the
-- live board does), or write to their chats: their tokens, owners, offsets and queued sends go.
DELETE FROM settings WHERE key LIKE 'telegram%';
SQL
# Nor the profiles' Asana tokens (in databases from API 57 on).
if [[ -n $(sqlite3 "$db" "SELECT 1 FROM pragma_table_info('profiles') WHERE name='asana_token'") ]]; then
  sqlite3 "$db" "UPDATE profiles SET asana_token=NULL, asana_user=NULL;"
fi
# Nor their sign-ins to hosted docs sites (migration 104 on), which would publish as the user.
if [[ -n $(sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE name='docs_site_connections'") ]]; then
  sqlite3 "$db" "DELETE FROM docs_site_connections;"
fi
"$root/scripts/test-server.sh" restart "$dir"
