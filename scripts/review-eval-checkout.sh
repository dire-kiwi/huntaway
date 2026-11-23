#!/usr/bin/env bash
# Makes each row's checkout for a replay of evals/review (its README.md): a clone under <dir>/<key> whose history
# stops at the row's commit, so a reviewer there can't see what was fixed afterwards.
#   scripts/review-eval-checkout.sh <dir>
set -euo pipefail
dir=${1:?usage: review-eval-checkout.sh <dir>}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
mkdir -p "$dir"
node -e '
  for (const r of JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))) console.log([r.key, r.branch, r.commit].join("\t"))
' "$repo/evals/review/rows.json" | while IFS=$'\t' read -r key branch commit; do
  [ -d "$dir/$key/.git" ] && continue
  git init -q "$dir/$key"
  git -C "$dir/$key" fetch -q "$repo" "$commit"
  git -C "$dir/$key" checkout -q -b "$branch" "$commit"
done
