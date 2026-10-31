#!/usr/bin/env bash
# Scratch huntaway server for testing a worktree build, kept apart from the live daemon:
# a fresh data dir, 127.0.0.1 only, a free port, no hub.
#
#   scripts/test-server.sh [start] [options] [serve args...]   # e.g. start --seed --demo
#   scripts/test-server.sh restart [<data-dir>]                # same port, data and agent runs
#   scripts/test-server.sh stop [<data-dir>]
#
# Options (anything else goes to `huntaway serve`):
#   --seed         (needs jq and curl) add a "test" profile on $IA_TEST_CLAUDE_CONFIG (default ~/.claude-personal)
#                  with default model $IA_TEST_MODEL (default haiku), and a project on a fresh
#                  git repo in <data-dir>/repo
#   --fake-claude  run agents with scripts/fake-claude (prints a reply and a result, no model);
#                  Codex runs fail
#   --no-agents    no agent runs at all (claude and codex are /bin/false)
#
# `start` prints shell assignments (IA_TEST_URL, IA_TEST_TOKEN, IA_TEST_PID, IA_TEST_DATA_DIR,
# IA_TEST_ENV, and with --seed IA_TEST_PROFILE, IA_TEST_PROJECT, IA_TEST_REPO), so
# `eval "$(scripts/test-server.sh)"` works. They're also in <data-dir>/env (IA_TEST_ENV), for
# `. "$IA_TEST_ENV"` in a later shell, and .ia-test-env in the worktree links to the latest
# server's, which scripts/ia-api reads by default. The server's log is <data-dir>/server.log.
# `restart` restarts the server with the same binary path (so a rebuild is picked up), args
# and environment; agent runs carry on, as they do over a real restart.
# `stop` kills the server and any agent runs it started, then removes the data dir.
# Without a data dir, `restart` and `stop` use $IA_TEST_DATA_DIR, then .ia-test-env's.
# Runs the newer of server/target/{release,debug}/huntaway (IA_TEST_BIN overrides).
# A restart from the board binds a new free port (use `restart` here instead).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
marker=.ia-test-server
latest="$root/.ia-test-env"

# The pid's command line mentions $2 (guards against killing a reused pid).
owns() {
  [[ -r /proc/$1/cmdline ]] && tr '\0' ' ' < "/proc/$1/cmdline" | grep -qF -- "$2"
}

stop_pid() {
  local pid=$1 target=${2:-$1}
  kill -TERM -- "$target" 2>/dev/null || return 0
  for _ in $(seq 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "$target" 2>/dev/null || true
}

# The data dir to restart or stop: the argument, $IA_TEST_DATA_DIR, or the latest server's.
data_dir() {
  local dir=${1:-${IA_TEST_DATA_DIR:-}}
  if [[ -z $dir && -L $latest ]]; then
    dir="$(dirname "$(readlink "$latest")")"
  fi
  [[ -n $dir ]] || { echo "usage: $0 stop|restart <data-dir>" >&2; exit 2; }
  dir="${dir%/}"
  [[ -f $dir/$marker ]] || { echo "$dir wasn't made by $0; not touching it" >&2; exit 1; }
  echo "$dir"
}

# Start the server saved in <dir>/launch on port $2 (0 for a free one) and wait until it's
# ready. Sets $pid and $port.
launch() {
  local dir=$1
  local bin serve
  # shellcheck disable=SC1091
  . "$dir/launch"
  # Nothing from an agent's or the live daemon's environment (hubs, tokens) carries over.
  env -u IA_HUB -u IA_HUB_TOKEN -u IA_TOKEN -u IA_OPEN_TOKEN -u IA_DEMO -u IA_UI_DIR \
    setsid "$bin" serve --host 127.0.0.1 --port "$2" --data-dir "$dir" --name test "${serve[@]}" \
    > "$dir/server.log" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$dir/server.pid"

  local ready=""
  for _ in $(seq 300); do
    ready="$(grep -m1 '^IA_READY ' "$dir/server.log" || true)"
    [[ -n $ready ]] && break
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "server exited before it was ready; log:" >&2
      tail -20 "$dir/server.log" >&2
      return 1
    fi
    sleep 0.1
  done
  if [[ -z $ready ]]; then
    echo "server not ready after 30s; log: $dir/server.log" >&2
    stop_pid "$pid"
    return 1
  fi
  port="$(grep -o '"port":[0-9]*' <<< "$ready" | cut -d: -f2)"
}

# Write <dir>/env (and point .ia-test-env at it), then print it.
write_env() {
  local dir=$1 token
  token="$(cat "$dir/auth_token")"
  {
    echo "export IA_TEST_URL=http://127.0.0.1:$port"
    echo "export IA_TEST_TOKEN=$token"
    echo "export IA_TEST_PID=$pid"
    echo "export IA_TEST_DATA_DIR=$dir"
    echo "export IA_TEST_ENV=$dir/env"
    [[ -f $dir/seed.env ]] && cat "$dir/seed.env"
    echo "# open: http://127.0.0.1:$port/?token=$token"
    echo "# stop: $0 stop $dir"
  } > "$dir/env"
  ln -sfn "$dir/env" "$latest"
  cat "$dir/env"
}

api() {
  local method=$1 path=$2 body=$3 token
  token="$(cat "$IA_DIR/auth_token")"
  curl -sS --fail-with-body -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$body" "http://127.0.0.1:$port/api$path"
}

# A "test" profile and a project on a new git repo, written to <dir>/seed.env.
seed() {
  local dir=$1 repo="$1/repo" profile project
  local config=${IA_TEST_CLAUDE_CONFIG:-~/.claude-personal} model=${IA_TEST_MODEL:-haiku}
  # Called from a condition, where set -e doesn't apply: hence the &&s.
  git init -q -b main "$repo" &&
    echo "# Test repo" > "$repo/README.md" &&
    git -C "$repo" add README.md &&
    git -C "$repo" -c user.name=test -c user.email=test@example.invalid commit -qm "Initial commit" &&
    profile="$(api POST /profiles "$(jq -n --arg c "$config" --arg m "$model" '{name: "test", claude_config_dir: $c, default_model: $m}')" | jq -er .id)" &&
    project="$(api POST "/profiles/$profile/projects" "$(jq -n --arg r "$repo" '{name: "Test", repo_path: $r}')" | jq -er .id)" ||
    return 1
  {
    echo "export IA_TEST_PROFILE=$profile"
    echo "export IA_TEST_PROJECT=$project"
    echo "export IA_TEST_REPO=$repo"
  } > "$dir/seed.env"
}

start() {
  local bin=${IA_TEST_BIN:-} do_seed="" serve=()
  for a in "$@"; do
    case $a in
      --seed) do_seed=1 ;;
      --fake-claude) export IA_CLAUDE_BIN="$root/scripts/fake-claude" IA_CODEX_BIN=/bin/false ;;
      --no-agents) export IA_CLAUDE_BIN=/bin/false IA_CODEX_BIN=/bin/false ;;
      *) serve+=("$a") ;;
    esac
  done
  if [[ -z $bin ]]; then
    # The newer of the release and debug builds, so a stale one isn't picked up.
    for b in "$root/server/target/release/huntaway" "$root/server/target/debug/huntaway"; do
      [[ -x $b && ( -z $bin || $b -nt $bin ) ]] && bin=$b
    done
  fi
  [[ -n $bin && -x $bin ]] || { echo "no huntaway build in $root/server/target; run cargo build there first" >&2; exit 1; }
  if [[ -n $do_seed ]]; then
    for tool in jq curl; do
      command -v "$tool" > /dev/null || { echo "--seed needs $tool, which isn't on PATH" >&2; exit 1; }
    done
  fi

  local dir
  dir="$(mktemp -d -t ia-test-XXXXXX)"
  touch "$dir/$marker"
  [[ ${IA_CLAUDE_BIN:-} == "$root/scripts/fake-claude" ]] && export IA_FAKE_CLAUDE_LOG="$dir/fake-claude.log"
  # What `restart` needs to start the same server again.
  {
    declare -p bin serve
    for v in IA_CLAUDE_BIN IA_CODEX_BIN $(compgen -e IA_FAKE_CLAUDE_ || true); do
      [[ -n ${!v+x} ]] && printf 'export %s=%q\n' "$v" "${!v}"
    done
  } > "$dir/launch"

  local pid port
  if ! launch "$dir" 0; then
    rm -rf "$dir"
    exit 1
  fi
  if [[ -n $do_seed ]] && ! IA_DIR=$dir seed "$dir" >&2; then
    echo "seeding failed; log: $dir/server.log" >&2
    stop_pid "$pid"
    rm -rf "$dir"
    exit 1
  fi
  write_env "$dir"
}

restart() {
  local dir
  dir="$(data_dir "${1:-}")"
  local pid port
  port="$(sed -n 's/^export IA_TEST_URL=.*:\([0-9]*\)$/\1/p' "$dir/env")"
  pid="$(cat "$dir/server.pid" 2>/dev/null || true)"
  if [[ -n $pid ]] && owns "$pid" "$dir"; then
    stop_pid "$pid"
  fi
  cat "$dir/server.log" >> "$dir/server.prev.log"
  launch "$dir" "$port" || { echo "restart failed; the old log is $dir/server.prev.log" >&2; exit 1; }
  write_env "$dir"
}

stop() {
  local dir
  dir="$(data_dir "${1:-}")"

  local pid
  pid="$(cat "$dir/server.pid" 2>/dev/null || true)"
  if [[ -n $pid ]] && owns "$pid" "$dir"; then
    stop_pid "$pid"
  fi
  # Agent runs outlive the server (each under its own ia-shim); stop those too.
  for run in "$dir"/runs/*/; do
    [[ -d $run ]] || continue
    local shim agent
    shim="$(cat "$run/shim.pid" 2>/dev/null || true)"
    agent="$(cat "$run/pid" 2>/dev/null || true)"
    [[ -n $shim ]] && owns "$shim" "$dir" || continue
    # The agent leads its own process group.
    [[ -n $agent ]] && stop_pid "$agent" "-$agent"
    stop_pid "$shim"
  done
  rm -rf "$dir"
  [[ $(readlink "$latest" 2>/dev/null) == "$dir/env" ]] && rm -f "$latest"
  echo "stopped; removed $dir"
}

case "${1:-start}" in
  start) shift || true; start "$@" ;;
  restart) shift; restart "$@" ;;
  stop) shift; stop "$@" ;;
  -*) start "$@" ;;
  *) echo "usage: $0 [start [options] [serve args...]] | restart [<data-dir>] | stop [<data-dir>]" >&2; exit 2 ;;
esac
