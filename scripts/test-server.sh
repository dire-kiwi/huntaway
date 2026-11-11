#!/usr/bin/env bash
# Scratch huntaway server for testing a worktree build, kept apart from the live boards (the old server on 7878, the
# new one on 7879): a fresh data dir, 127.0.0.1 only, a free port, no hub. Carried over from dire-kiwi/huntaway
# (scripts/test-server.sh at f2298f0c) for the new server (docs/plan/10-testing.md, Tools for agents).
#
#   scripts/test-server.sh [start] [options] [serve args...]   # e.g. start --seed --demo
#   scripts/test-server.sh restart [<data-dir>]                # same port and data
#   scripts/test-server.sh stop [<data-dir>]
#
# Options (anything else goes to `huntaway serve`, e.g. --demo):
#   --seed         add an agent config "test" on $HUNTAWAY_TEST_CLAUDE_CONFIG (default ~/.claude-personal), a "test"
#                  profile on it with default model $HUNTAWAY_TEST_MODEL (default haiku), and a project "Test" (key
#                  TES) on a fresh git repo in <data-dir>/repo, through `huntaway rpc`
#   --fake-claude  run agents with packages/testing/bin/fake-claude (prints a reply and a result, no model; its
#                  HUNTAWAY_FAKE_CLAUDE_* knobs are kept for `restart`, and it logs to <data-dir>/fake-claude.log)
#   --no-agents    no agent runs at all (`serve --no-agents`)
#   --fake-gh      run gh as packages/testing/bin/fake-gh over a fake GitHub kept in <data-dir>/github.json (its state,
#                  which a test reads and changes: accounts, repositories, pull requests; see fake-gh.ts), starting from
#                  $HUNTAWAY_FAKE_GH_SEED's file if set, else from no accounts and no repositories
#
# `start` prints shell assignments (HUNTAWAY_TEST_URL, HUNTAWAY_TEST_TOKEN, HUNTAWAY_TEST_PID, HUNTAWAY_TEST_DATA_DIR,
# HUNTAWAY_TEST_ENV, and with --seed HUNTAWAY_TEST_PROFILE, HUNTAWAY_TEST_PROJECT, HUNTAWAY_TEST_REPO), so
# `eval "$(scripts/test-server.sh)"` works. They're also in <data-dir>/env (HUNTAWAY_TEST_ENV), for `. "$HUNTAWAY_TEST_ENV"`
# in a later shell, and .huntaway-test-env in the worktree links to the latest server's, which `huntaway rpc` reads by
# default. The server's log is <data-dir>/server.log.
# `restart` restarts the server with the same binary path (so a change is picked up), args and environment.
# `stop` stops the server by its PID, then removes the data dir.
# Without a data dir, `restart` and `stop` use $HUNTAWAY_TEST_DATA_DIR, then .huntaway-test-env's.
# Runs the server, apps/server/bin/huntaway (needs `pnpm install` at the top of the checkout), with an ia-shim:
# $HUNTAWAY_SHIM_BIN (given as --shim-bin), else the checkout's, which `start` builds (`cargo build -p ia-shim`) when
# there's none or rust/shim changed since, unless no agent runs (--no-agents).
# HUNTAWAY_TEST_BIN runs another build instead, such as a release package's huntaway.
# The board hands its token to any browser that asks (--open-token) unless HUNTAWAY_TEST_OPEN_TOKEN=0.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
marker=.huntaway-test-server
latest="$root/.huntaway-test-env"

# The pid's command line mentions $2 (guards against killing a reused pid).
owns() {
  [[ -r /proc/$1/cmdline ]] && tr '\0' ' ' < "/proc/$1/cmdline" | grep -qF -- "$2"
}

# Stops $1 (signalling $2, its process group say, if given): TERM, then KILL after 5 s.
stop_pid() {
  local pid=$1 target=${2:-$1}
  kill -TERM -- "$target" 2>/dev/null || return 0
  for _ in $(seq 250); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.02
  done
  kill -KILL -- "$target" 2>/dev/null || true
}

# The data dir to restart or stop: the argument, $HUNTAWAY_TEST_DATA_DIR, or the latest server's.
data_dir() {
  local dir=${1:-${HUNTAWAY_TEST_DATA_DIR:-}}
  if [[ -z $dir && -L $latest ]]; then
    dir="$(dirname "$(readlink "$latest")")"
  fi
  [[ -n $dir ]] || { echo "usage: $0 stop|restart <data-dir>" >&2; exit 2; }
  dir="${dir%/}"
  [[ -f $dir/$marker ]] || { echo "$dir wasn't made by $0; not touching it" >&2; exit 1; }
  echo "$dir"
}

# Start the server saved in <dir>/launch on port $2 (0 for a free one) and wait until it's ready. Sets $pid, $port
# and $token.
launch() {
  local dir=$1
  local bin serve
  # shellcheck disable=SC1091
  . "$dir/launch"
  # Nothing from an agent's or a live server's environment (hubs, tokens, profiles, its restart file) carries over:
  # every HUNTAWAY_* variable but Node's. Its temp folder goes with the data dir.
  local unset=() v
  for v in $(compgen -e HUNTAWAY_ || true); do
    [[ $v == HUNTAWAY_NODE || $v == HUNTAWAY_FAKE_CLAUDE_* ]] || unset+=(-u "$v")
  done
  mkdir -p "$dir/tmp"
  # 6.11: Asana is the fake a test gives ($HUNTAWAY_ASANA_URL), else none at all: a test server never reaches Asana.
  local asana=${HUNTAWAY_ASANA_URL:-http://127.0.0.1:9/no-asana-on-test-servers}
  TMPDIR="$dir/tmp" env "${unset[@]}" HUNTAWAY_ASANA_URL="$asana" \
    setsid "$bin" serve --host 127.0.0.1 --port "$2" --data-dir "$dir" --name test "${serve[@]}" \
    > "$dir/server.log" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$dir/server.pid"

  local ready=""
  for _ in $(seq 1500); do
    ready="$(grep -m1 '^HUNTAWAY_READY ' "$dir/server.log" || true)"
    [[ -n $ready ]] && break
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "server exited before it was ready; log:" >&2
      tail -20 "$dir/server.log" >&2
      return 1
    fi
    sleep 0.02
  done
  if [[ -z $ready ]]; then
    echo "server not ready after 30s; log: $dir/server.log" >&2
    stop_pid "$pid"
    return 1
  fi
  port="$(grep -o '"port":[0-9]*' <<< "$ready" | cut -d: -f2)"
  # The ready line's token is null when one was given (--token): the data folder's is the one it uses then.
  token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<< "$ready")"
  [[ -n $token ]] || token="$(cat "$dir/auth_token" 2>/dev/null || true)"
}

# Write <dir>/env (and point .huntaway-test-env at it), then print it.
write_env() {
  local dir=$1
  {
    echo "export HUNTAWAY_TEST_URL=http://127.0.0.1:$port"
    echo "export HUNTAWAY_TEST_TOKEN=$token"
    echo "export HUNTAWAY_TEST_PID=$pid"
    echo "export HUNTAWAY_TEST_DATA_DIR=$dir"
    echo "export HUNTAWAY_TEST_ENV=$dir/env"
    [[ -f $dir/seed.env ]] && cat "$dir/seed.env"
    echo "# open: http://127.0.0.1:$port/?token=$token"
    echo "# stop: $0 stop $dir"
  } > "$dir/env"
  ln -sfn "$dir/env" "$latest"
  cat "$dir/env"
}

# `huntaway rpc` against this server; prints the result's field $3.
rpc_field() {
  local dir=$1 method=$2 field=$3 payload=$4 out
  out="$("$bin" rpc --env "$dir/env" "$method" "$payload")" || return 1
  node -e 'const v = JSON.parse(process.argv[1])[process.argv[2]]
    if (typeof v !== "string") process.exit(1)
    console.log(v)' "$out" "$field"
}

# A JSON string.
json() {
  node -e 'console.log(JSON.stringify(process.argv[1]))' "$1"
}

# An agent config, a "test" profile on it and a project on a new git repo, written to <dir>/seed.env.
seed() {
  local dir=$1 repo="$1/repo" config profile project
  local config_dir=${HUNTAWAY_TEST_CLAUDE_CONFIG:-~/.claude-personal} model=${HUNTAWAY_TEST_MODEL:-haiku}
  # Called from a condition, where set -e doesn't apply: hence the &&s.
  git init -q -b main "$repo" &&
    echo "# Test repo" > "$repo/README.md" &&
    git -C "$repo" add README.md &&
    git -C "$repo" -c user.name=test -c user.email=test@example.invalid commit -qm "Initial commit" &&
    config="$(rpc_field "$dir" configs.create id "{\"config\":{\"name\":\"test\",\"config_dir\":$(json "$config_dir")}}")" &&
    profile="$(rpc_field "$dir" profiles.create id "{\"profile\":{\"name\":\"test\",\"claude_config_ids\":[\"$config\"],\"default_model\":$(json "$model")}}")" &&
    project="$(rpc_field "$dir" projects.create id "{\"project\":{\"profile_id\":\"$profile\",\"name\":\"Test\",\"key\":\"TES\",\"repo_path\":$(json "$repo")}}")" ||
    return 1
  {
    echo "export HUNTAWAY_TEST_PROFILE=$profile"
    echo "export HUNTAWAY_TEST_PROJECT=$project"
    echo "export HUNTAWAY_TEST_REPO=$repo"
  } > "$dir/seed.env"
}

# Builds ia-shim (debug) where the checkout has none, or its sources (rust/shim, Cargo.lock) changed since the one the
# server would run: the newer of target/release's and target/debug's (apps/server/src/runs/Shim.ts). Unchanged, nothing
# runs (not even cargo); without cargo, it's left to the check after it.
build_shim() {
  command -v cargo > /dev/null || return 0
  local release=$root/target/release/ia-shim debug=$root/target/debug/ia-shim built=""
  [[ -x $release ]] && built=$release
  [[ -x $debug && (-z $built || $debug -nt $built) ]] && built=$debug
  [[ -n $built && -z $(find "$root/rust/shim" "$root/Cargo.toml" "$root/Cargo.lock" -newer "$built" -print -quit 2>/dev/null) ]] && return 0
  echo "building ia-shim (cargo build -p ia-shim)" >&2
  # Several starting at once (the browser checks) wait for each other's build: cargo locks the target dir.
  (cd "$root" && cargo build -q -p ia-shim >&2) || { echo "cargo build -p ia-shim failed in $root" >&2; exit 1; }
  # Up to date now, even where cargo found nothing to build and left the binary older than those files (HA-392).
  touch "$debug"
}

start() {
  local bin=${HUNTAWAY_TEST_BIN:-} do_seed="" agents=1 fake="" fake_gh="" serve=()
  for a in "$@"; do
    case $a in
      --seed) do_seed=1 ;;
      --fake-claude) fake=1 ;;
      --fake-gh) fake_gh=1 ;;
      --no-agents) agents="" ;;
      *) serve+=("$a") ;;
    esac
  done
  if [[ -z $agents ]]; then
    serve+=(--no-agents)
  elif [[ -n $fake ]]; then
    serve+=(--claude-bin "$root/packages/testing/bin/fake-claude")
  fi
  # --open-token: a board that hands out its token never shows system notifications, so a test server opened in the
  # user's browser doesn't pop up on their desktop. HUNTAWAY_TEST_OPEN_TOKEN=0 starts a normal board instead.
  if [[ ${HUNTAWAY_TEST_OPEN_TOKEN:-1} != 0 && " ${serve[*]} " != *" --open-token "* ]]; then serve+=(--open-token); fi
  if [[ -z $bin ]]; then
    bin="$root/apps/server/bin/huntaway"
    [[ -d $root/apps/server/node_modules/effect ]] ||
      { echo "apps/server has no node_modules; run pnpm install in $root first" >&2; exit 1; }
    # Where the server looks for ia-shim (apps/server/src/runs/Shim.ts), save beside a release's huntaway.
    if [[ -n $agents ]]; then
      if [[ -n ${HUNTAWAY_SHIM_BIN:-} ]]; then
        serve+=(--shim-bin "$HUNTAWAY_SHIM_BIN")
      else
        build_shim
        [[ -x $root/target/release/ia-shim || -x $root/target/debug/ia-shim ]] ||
          { echo "no ia-shim build in $root/target; run cargo build -p ia-shim in $root first (or start with --no-agents)" >&2; exit 1; }
      fi
    fi
  fi
  [[ -n $bin && -x $bin ]] || { echo "HUNTAWAY_TEST_BIN=$bin isn't an executable" >&2; exit 1; }

  local dir
  dir="$(mktemp -d -t huntaway-test-XXXXXX)"
  touch "$dir/$marker"
  [[ -n $fake ]] && export HUNTAWAY_FAKE_CLAUDE_LOG="$dir/fake-claude.log"
  if [[ -n $fake_gh ]]; then
    if [[ -n ${HUNTAWAY_FAKE_GH_SEED:-} ]]; then cp "$HUNTAWAY_FAKE_GH_SEED" "$dir/github.json"; else echo '{}' > "$dir/github.json"; fi
    printf '#!/bin/sh\nHUNTAWAY_FAKE_GH_STATE=%q exec %q "$@"\n' "$dir/github.json" "$root/packages/testing/bin/fake-gh" > "$dir/gh"
    chmod +x "$dir/gh"
    serve+=(--gh-bin "$dir/gh")
    # The fake claude's merge (HUNTAWAY_FAKE_CLAUDE_MERGE=pr) merges with this gh, never the machine's.
    export HUNTAWAY_FAKE_CLAUDE_GH="$dir/gh"
  fi
  # What `restart` needs to start the same server again, the fake claude's knobs too.
  {
    declare -p bin serve
    for v in $(compgen -e HUNTAWAY_FAKE_CLAUDE_ || true); do
      printf 'export %s=%q\n' "$v" "${!v}"
    done
  } > "$dir/launch"

  local pid port token
  if ! launch "$dir" 0; then
    rm -rf "$dir"
    exit 1
  fi
  if [[ -n $do_seed ]]; then
    write_env "$dir" > /dev/null
    if ! seed "$dir" >&2; then
      echo "seeding failed; the server's log:" >&2
      tail -20 "$dir/server.log" >&2
      stop_pid "$pid"
      rm -rf "$dir"
      [[ $(readlink "$latest" 2>/dev/null) == "$dir/env" ]] && rm -f "$latest"
      exit 1
    fi
  fi
  write_env "$dir"
}

restart() {
  local dir
  dir="$(data_dir "${1:-}")"
  local pid port token
  port="$(sed -n 's/^export HUNTAWAY_TEST_URL=.*:\([0-9]*\)$/\1/p' "$dir/env")"
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
  # Agent runs outlive the server (each under its own ia-shim, which writes runs/<id>/shim.pid and the agent's pid):
  # stop those too, or a fake agent waiting for more input runs on.
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
  # A process the server started (a git command) may still be writing in it for a moment: "Directory not empty".
  rm -rf "$dir" 2>/dev/null || { sleep 0.5; rm -rf "$dir"; }
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
