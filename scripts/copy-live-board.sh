#!/usr/bin/env bash
# Gives a test server an import of a scrubbed copy of an old board's database, for measuring with real amounts of data
# (docs/plan/10-testing.md, Measurements; docs/plan/11-migration.md, Rehearsal: "In CI and for measurements"):
#
#   scripts/test-server.sh --no-agents > $TMPDIR/env    # or --fake-claude
#   scripts/copy-live-board.sh $TMPDIR/env               # the env file or the test server's data dir
#
# Carried over from the old repository's script of the same name (dire-kiwi/huntaway-legacy at f2298f0c), with one more step:
#   1. It snapshots the old board's database with SQLite's online backup through a read-only connection (the old server
#      may be running), into a folder of its own beside the test server's data dir, <data dir>-legacy-source (the
#      importer refuses an old folder inside the new one; test-server.sh stop removes it with the data dir).
#   2. It scrubs the snapshot as the old script did, so the test server leaves the old board's things alone: no runs to
#      pick up, no repositories or worktrees (their paths are moved under /nonexistent), no setup or status scripts, no
#      agent config folders, no Asana tokens, no Telegram bots, no pending prompts, no linked hosts, no automations, no
#      pull-request watches, no hosted-docs sign-ins and no telemetry.
#   3. It writes the test server's own identity files beside the snapshot (never the old board's), stops the test
#      server, removes its board, and imports the snapshot into it with `huntaway import-legacy --check`, then restarts
#      it. With nothing real left to act on, that server runs normally, as the measurements need. Looking at a real
#      board's import without scrubbing is a rehearsal (`import-legacy --rehearsal`), which only a read-only server opens.
#
# HUNTAWAY_LIVE_DATA_DIR says where the old board's data is (default ~/.local/share/issue-agent), HUNTAWAY_LIVE_DB which
# of its database files (when there are several: see `live_db`). It only ever reads there. It refuses a data dir that
# test-server.sh did not make, and a test server whose agents are real (start it with --no-agents or --fake-claude).
# `copy-live-board.sh --source` only prints the file it would copy, and `--scrub <db file>` only scrubs that file.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
live=${HUNTAWAY_LIVE_DATA_DIR:-$HOME/.local/share/issue-agent}

# The old board's database file: HUNTAWAY_LIVE_DB if given; else the one file there that a process has open; else the
# only one there.
live_db() {
  local real files=() open=() f
  real="$(cd "$live" && pwd -P)" || { echo "no data dir $live" >&2; return 1; }
  if [[ -n ${HUNTAWAY_LIVE_DB:-} ]]; then
    [[ -f $real/$HUNTAWAY_LIVE_DB ]] || { echo "no $HUNTAWAY_LIVE_DB in $live" >&2; return 1; }
    echo "$real/$HUNTAWAY_LIVE_DB"
    return
  fi
  for f in huntaway-2.db huntaway.db issue-agent.db; do
    [[ -f $real/$f ]] && files+=("$f")
  done
  [[ ${#files[@]} -gt 0 ]] || { echo "no old board database in $live" >&2; return 1; }
  # Each file that a process has open (fds link to the canonical path; the -wal and -shm files don't count).
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
    echo "$live has ${files[*]}, and ${#open[@]} of them are open (${open[*]:-none}), so it can't tell which the old" \
      "board uses: say which with HUNTAWAY_LIVE_DB=<file>" >&2
    return 1
  fi
}

# Scrubs old database file $1 so a test server leaves the old board's things alone (see the top). The old script's
# statements, and the rows the importer would carry that act on something outside the folder.
scrub() {
  local db=$1
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
UPDATE automations SET enabled=0, secret=NULL;
UPDATE projects SET done_when_merged=0;
DELETE FROM pr_watches;
DELETE FROM pr_states;
DELETE FROM settings WHERE key LIKE 'telegram%';
DELETE FROM settings WHERE key LIKE 'vapid%';
DELETE FROM push_subscriptions;
DELETE FROM device_tokens;
SQL
  if [[ -n $(sqlite3 "$db" "SELECT 1 FROM pragma_table_info('profiles') WHERE name='asana_token'") ]]; then
    sqlite3 "$db" "UPDATE profiles SET asana_token=NULL, asana_user=NULL;"
  fi
  if [[ -n $(sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE name='docs_site_connections'") ]]; then
    sqlite3 "$db" "DELETE FROM docs_site_connections;"
  fi
  sqlite3 "$db" "DELETE FROM settings WHERE key LIKE 'telemetry%';"
  if [[ -n $(sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE name='telemetry_outbox'") ]]; then
    sqlite3 "$db" "DELETE FROM telemetry_outbox;"
  fi
  if [[ -n $(sqlite3 "$db" "SELECT 1 FROM pragma_table_info('profiles') WHERE name='telemetry'") ]]; then
    sqlite3 "$db" "UPDATE profiles SET telemetry=0;"
  fi
}

if [[ ${1:-} == --source ]]; then
  live_db
  exit
fi
if [[ ${1:-} == --scrub ]]; then
  scrub "${2:?usage: $0 --scrub <db file>}"
  exit
fi
where=${1:?usage: $0 <test-server env file or data dir>}
if [[ -f $where ]]; then
  dir="$(sed -n 's/^export HUNTAWAY_TEST_DATA_DIR=//p' "$where")"
else
  dir=$where
fi
dir="${dir%/}"
[[ -n $dir && -f $dir/.huntaway-test-server ]] || { echo "$dir wasn't made by test-server.sh; not touching it" >&2; exit 1; }
# Agents off or the fake one: a real agent would run on the copy's tasks.
grep -qE -- '--no-agents|fake-claude' "$dir/launch" ||
  { echo "start the test server with --no-agents or --fake-claude: its agents would run on the old board's tasks" >&2; exit 1; }
[[ "$(cd "$dir" && pwd -P)" != "$(cd "$live" && pwd -P)" ]] || { echo "that's the old board's data dir" >&2; exit 1; }

src="$(live_db)"
source_dir=$dir-legacy-source
rm -rf "$source_dir"
mkdir -p "$source_dir"
touch "$source_dir/.huntaway-legacy-source"
snapshot=$source_dir/$(basename "$src")
sqlite3 -readonly "$src" ".backup '$snapshot'"
scrub "$snapshot"
# The test server's own identity, so the import keeps it (and its env file's token stays good).
for f in host_id auth_token hub_token; do
  [[ -f $dir/$f ]] && cp "$dir/$f" "$source_dir/$f"
done

pid="$(cat "$dir/server.pid" 2>/dev/null || true)"
if [[ -n $pid ]] && [[ -r /proc/$pid/cmdline ]] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- "$dir"; then
  kill -TERM "$pid"
  for _ in $(seq 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
fi
rm -f "$dir"/board.db "$dir"/board.db-* "$dir"/import.json "$dir"/import-report.json
# --force: a run the scrub marked exited is already so; one it could not see (a race with the snapshot) is interrupted.
"${HUNTAWAY_TEST_BIN:-$root/apps/server/bin/huntaway}" import-legacy --from "$source_dir" --data-dir "$dir" --check --force ||
  echo "the import's check failed: see $dir/import-report.json (the server starts on what was imported)" >&2
"$root/scripts/test-server.sh" restart "$dir"
