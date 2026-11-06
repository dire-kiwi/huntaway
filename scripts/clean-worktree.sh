#!/usr/bin/env bash
# Remove a task worktree's build output (Rust's target, the UI's dist, release and tsbuildinfo, in the
# layout from before HA-263 as well: server/target and app/) to free disk space once its task is done. Building again recreates it.
#
#   scripts/clean-worktree.sh [worktree]   # defaults to the current directory
#
# Meant for the project's Done status script (Settings → Status scripts):
#
#   "$IA_REPO_PATH/scripts/clean-worktree.sh" "$IA_WORKTREE_PATH"
#
# An empty worktree (a task without one) is nothing to clean. It refuses to clean a
# repository's main checkout (the live daemon may run from its build), and leaves node_modules
# alone.
set -euo pipefail

if (($# > 0)) && [[ -z $1 ]]; then
  echo "No worktree to clean"
  exit 0
fi
dir=$(cd "${1:-.}" && pwd)

# Both from git in one call, so they're resolved the same way (against $dir, symlinks and all).
dirs=$(git -C "$dir" rev-parse --path-format=absolute --git-dir --git-common-dir 2>/dev/null) || {
  echo "$dir is not a git worktree" >&2
  exit 1
}
{ read -r git_dir; read -r common; } <<<"$dirs"
# A linked worktree's git dir is <common dir>/worktrees/<name>; anything else is left alone.
if [[ -z $common || $git_dir != "$common"/worktrees/* ]]; then
  echo "$dir is a main checkout, not a linked worktree; not cleaning it" >&2
  exit 1
fi
top=$(git -C "$dir" rev-parse --show-toplevel)

shopt -s nullglob
paths=()
for p in "$top"/target "$top"/release-server "$top"/apps/web/dist "$top"/apps/web/release "$top"/apps/web/*.tsbuildinfo \
  "$top"/server/target "$top"/app/dist "$top"/app/release "$top"/app/*.tsbuildinfo; do
  [[ -e $p ]] && paths+=("$p")
done
if ((${#paths[@]} == 0)); then
  echo "No build output in $top"
  exit 0
fi

size=$(du -sch "${paths[@]}" | tail -1 | cut -f1)
rm -rf -- "${paths[@]}"
echo "Freed $size in $top:"
printf '  %s\n' "${paths[@]#"$top"/}"
