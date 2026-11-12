#!/usr/bin/env bash
# Moves an old Huntaway board (profiles, projects, tasks with their threads, runs and the rest) onto this server for
# good, replacing the board this server already has (docs/guide/switching.md, Switching onto a board already in use):
#
#   scripts/switch-board.sh --rehearse     # beside both running servers: converts a snapshot, changes nothing
#   scripts/switch-board.sh                # with both servers stopped: the switch
#   scripts/switch-board.sh --undo <dir>   # with the new server stopped: put back the board set aside in <dir>
#
# The switch runs `huntaway import-legacy --from <old folder> --data-dir <new folder> --check --replace`: the new
# folder's board (its database, identity, attachments and run folders) is set aside in <new folder>/replaced-<time>/,
# and the old board is imported in its place, with the old host's identity and token. The old folder is only read.
# Worktrees stay where they are, in both folders. It refuses while either server has its database open, or while runs
# of either board are live (--force records them as interrupted).
#
#   --from <dir>       the old server's data folder (default $HUNTAWAY_OLD_DATA_DIR, else ~/.local/share/issue-agent,
#                      else ~/.local/share/huntaway)
#   --data-dir <dir>   the new server's (default $HUNTAWAY_DATA_DIR, else ~/.local/share/huntaway-effect)
#   --rehearse         import a snapshot into a fresh folder under $TMPDIR as a rehearsal (read-only) and stop there
#   --undo <dir>       put the board set aside in <dir> (a replaced-<time> folder) back in the data folder it is in, in
#                      place of the import (only a replaced-* folder directly inside the data folder is taken; the old
#                      server's folder was never written, so it starts as it was)
#   --force            live runs are recorded as interrupted rather than refused
#   --yes              don't ask before the switch
#
# HUNTAWAY_BIN is the launcher to run (default this checkout's apps/server/bin/huntaway; `pnpm install` first).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
from=${HUNTAWAY_OLD_DATA_DIR:-}
to=${HUNTAWAY_DATA_DIR:-$data_home/huntaway-effect}
bin=${HUNTAWAY_BIN:-$root/apps/server/bin/huntaway}
rehearse=0 force=() yes=0 undo= to_given=0
# What `import-legacy --replace` sets aside, and so what an import wrote in its place (REPLACED_FILES in
# apps/server/src/cli/importLegacy/run.ts).
replaced_files=(board.db board.db-wal board.db-shm import.json import-report.json host_id auth_token hub_token ssh
  attachments skill-sources runs)

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --data-dir) to=$2; to_given=1; shift 2 ;;
    --rehearse) rehearse=1; shift ;;
    --undo) undo=$2; shift 2 ;;
    --force) force=(--force); shift ;;
    --yes) yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "switch-board.sh: unknown argument $1 (--help lists them)" >&2; exit 2 ;;
  esac
done

# The processes that have <file> open (as the importer finds them: the links in /proc/<pid>/fd).
holders() {
  local real
  real="$(readlink -f "$1")"
  find /proc/[0-9]*/fd -maxdepth 1 -type l -lname "$real" 2>/dev/null | cut -d/ -f3 | sort -un | tr '\n' ' '
}

if [[ -n $undo ]]; then
  # Only a replaced-* folder directly inside the data folder, which is then the folder it goes back into: anything else
  # (the data folder itself, a folder of another data folder's) would have the board here deleted with nothing put back.
  [[ -d $undo ]] || { echo "switch-board.sh: there is no folder $undo" >&2; exit 1; }
  undo="$(cd "$undo" && pwd -P)"
  parent="$(dirname "$undo")"
  if [[ $(basename "$undo") != replaced-* ]]; then
    echo "switch-board.sh: $undo isn't a replaced-<time> folder (--undo takes the folder import-legacy --replace set a board aside in)" >&2
    exit 1
  fi
  if [[ $to_given == 1 ]]; then
    [[ -d $to ]] || { echo "switch-board.sh: there is no folder $to" >&2; exit 1; }
    if [[ $(cd "$to" && pwd -P) != "$parent" ]]; then
      echo "switch-board.sh: $undo isn't in $to: a replaced-<time> folder goes back into the data folder it is in ($parent)" >&2
      exit 1
    fi
  fi
  to=$parent
  [[ -f $undo/board.db ]] || { echo "switch-board.sh: $undo has no board.db: it isn't a folder --replace set a board aside in" >&2; exit 1; }
  if [[ -f $to/board.db && -n $(holders "$to/board.db") ]]; then
    echo "switch-board.sh: processes $(holders "$to/board.db")have $to/board.db open: stop the new server first" >&2
    exit 1
  fi
  echo "This puts the board set aside in $undo back in $to, and removes the import that replaced it."
  if [[ $yes != 1 ]]; then
    read -r -p "Go ahead? [y/N] " answer
    [[ $answer == [yY]* ]] || { echo "Nothing done."; exit 1; }
  fi
  for name in "${replaced_files[@]}"; do rm -rf "${to:?}/$name"; done
  for name in "${replaced_files[@]}"; do
    if [[ -e $undo/$name ]]; then mv "$undo/$name" "$to/$name"; fi
  done
  rmdir "$undo" 2>/dev/null || echo "($undo has other files in it, so it was left)"
  echo "Done: $to has its board back. Start the old server again if you are going back to it."
  exit 0
fi

if [[ -z $from ]]; then
  if [[ -d $data_home/issue-agent ]]; then from=$data_home/issue-agent; else from=$data_home/huntaway; fi
fi
[[ -d $from ]] || { echo "switch-board.sh: there is no old data folder $from (--from says where it is)" >&2; exit 1; }
[[ -x $bin ]] || { echo "switch-board.sh: no launcher at $bin (HUNTAWAY_BIN says where it is)" >&2; exit 1; }
if [[ $bin == "$root/apps/server/bin/huntaway" && ! -d $root/node_modules ]]; then
  echo "switch-board.sh: run pnpm install in $root first" >&2
  exit 1
fi

if [[ $rehearse == 1 ]]; then
  spare="$(mktemp -d "${TMPDIR:-/tmp}/huntaway-rehearsal-XXXXXX")"
  echo "Rehearsing: a snapshot of $from into $spare (nothing else is written)."
  status=0
  "$bin" import-legacy --from "$from" --data-dir "$spare" --rehearsal --check || status=$?
  echo
  echo "The report is $spare/import-report.json. To look through the board it made (read-only):"
  echo "  $bin serve --data-dir $spare --port 0    # and $bin token --data-dir $spare for its token"
  echo "Delete $spare when done."
  exit $status
fi

echo "This switches $to onto the old board in $from, for good:"
if [[ -f $to/board.db ]]; then
  echo "  - the board now in $to (its tasks, projects, profiles, identity and token) is set aside in $to/replaced-<time>/;"
fi
echo "  - the old board is imported in its place, with the old host's identity and board token;"
echo "  - $from is only read. Worktrees stay where they are."
echo "Both servers must be stopped (the old one for good) and no agent running."
if [[ $yes != 1 ]]; then
  read -r -p "Go ahead? [y/N] " answer
  [[ $answer == [yY]* ]] || { echo "Nothing done."; exit 1; }
fi

"$bin" import-legacy --from "$from" --data-dir "$to" --check --replace "${force[@]}"

cat <<EOF

Done. Next:
  - Start the new server (the desktop app, or $bin serve --data-dir $to). Its board token is now the old board's.
  - Leave the old server stopped: the new one refuses to start while a process has the old database open.
  - Keep $from: the imported tasks' worktrees, work folders and agents' sessions are still in it.
Going back: stop the new server, then scripts/switch-board.sh --undo <the replaced-<time> folder named above>
puts the board that was here back, and the old server starts on its folder as it was.
EOF
