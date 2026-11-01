#!/usr/bin/env bash
# Runs a command with TMPDIR set to a new, empty folder, then fails if the command left anything in it, so tests that
# don't clean up after themselves (and fill /tmp across runs) fail too:
#
#   scripts/check-tmp-leftovers.sh cargo test
#
# It exits with the command's status if that failed, else 1 if something was left, listing it. The folder is removed
# either way.
set -euo pipefail

[[ $# -gt 0 ]] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
tmp="$(mktemp -d -t ia-leftovers-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

status=0
TMPDIR=$tmp "$@" || status=$?

left="$(cd "$tmp" && find . -mindepth 1 -maxdepth 2 | sort)"
if [[ -n $left ]]; then
  echo "left behind in TMPDIR ($(find "$tmp" -mindepth 1 | wc -l) files and folders):" >&2
  head -50 <<< "$left" >&2
  [[ $status -ne 0 ]] || status=1
fi
exit "$status"
