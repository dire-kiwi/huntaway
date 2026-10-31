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
# setup or status scripts, no Claude configs, no Asana tokens, no pending prompts and no linked hosts. Then the test
# server restarts on it. IA_LIVE_DATA_DIR overrides where the live data is (~/.local/share/issue-agent).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

live=${IA_LIVE_DATA_DIR:-$HOME/.local/share/issue-agent}
src=$live/huntaway.db
[[ -f $src ]] || src=$live/issue-agent.db
[[ -f $src ]] || { echo "no database in $live" >&2; exit 1; }
[[ "$(cd "$dir" && pwd -P)" != "$(cd "$live" && pwd -P)" ]] || { echo "that's the live data dir" >&2; exit 1; }

pid="$(cat "$dir/server.pid" 2>/dev/null || true)"
if [[ -n $pid ]] && [[ -r /proc/$pid/cmdline ]] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- "$dir"; then
  kill -TERM "$pid"
  for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
fi
rm -f "$dir"/huntaway.db "$dir"/huntaway.db-wal "$dir"/huntaway.db-shm "$dir"/issue-agent.db*
sqlite3 -readonly "$src" ".backup '$dir/huntaway.db'"
sqlite3 "$dir/huntaway.db" <<'SQL'
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
SQL
# Nor the profiles' Asana tokens (in databases from API 57 on).
if [[ -n $(sqlite3 "$dir/huntaway.db" "SELECT 1 FROM pragma_table_info('profiles') WHERE name='asana_token'") ]]; then
  sqlite3 "$dir/huntaway.db" "UPDATE profiles SET asana_token=NULL, asana_user=NULL;"
fi
"$root/scripts/test-server.sh" restart "$dir"
