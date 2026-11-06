// Rust's `github::tests` helpers (`pub(crate) mod tests`), which other modules' tests use: a fake gh. The tests
// themselves are in ../github.test.ts.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as testing from "../../testing.ts";

/**
 * A folder (removed when the test file's tests end) with a fake GitHub: `<dir>/gh` is a gh whose `repo clone
 * o/NAME DIR` clones the repository o/NAME made in it, with GitHub's URL for its remote, as gh
 * would. `o/checkout-fails`'s checkout fails (a filter it needs fails), `o/upstream-fails`
 * fails once it's cloned (as gh does when it can't fetch a fork's parent), and `o/slow` takes
 * a second once it's cloned. Anything else fails.
 */
export function fake_github(): string {
  const dir = testing.temp_dir();
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  for (const name of ["r", "checkout-fails", "upstream-fails", "slow"]) {
    const work = join(dir, "work", name);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "README"), name);
    if (name === "checkout-fails") writeFileSync(join(work, ".gitattributes"), "README filter=broken\n");
    git(["init", "-q", "-b", "main", work]);
    git(["-C", work, "add", "-A"]);
    git(["-C", work, "commit", "-qm", "init"]);
    git(["clone", "-q", "--bare", work, join(dir, `o/${name}.git`)]);
  }
  const gh = `#!/bin/sh
[ "$1 $2" = "repo clone" ] || exit 99
repo=$3 dir=$4
clone() { git -c "url.${dir}/.insteadOf=git@github.com:" "$@" clone -q "git@github.com:$repo.git" "$dir"; }
case $repo in
  */checkout-fails) clone -c filter.broken.smudge=false -c filter.broken.required=true; exit $? ;;
esac
clone || exit $?
case $repo in
  */upstream-fails) echo "failed to run git: couldn't fetch upstream" >&2; exit 1 ;;
  */slow) sleep 1 ;;
esac
`;
  writeFileSync(join(dir, "gh"), gh);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

/**
 * A folder (removed when the test file's tests end) with a fake `gh repo create TARGET --private|--public
 * --source DIR --remote origin [--push]`, as gh does it: it logs its arguments to `create.log`,
 * makes the bare repository `bare/NAME.git`, adds a GitHub URL as `origin` to DIR, prints that
 * URL and, with `--push`, pushes HEAD to it. `fails` can't be created (`slow-fails` after a second) and `push-fails` is made
 * but can't be pushed to.
 */
export function fake_gh_create(): string {
  const base = testing.temp_dir();
  const gh = `#!/bin/sh
[ "$1 $2" = "repo create" ] || exit 99
echo "$*" >> "${base}/create.log"
target=$3 src= push=
shift 3
while [ $# -gt 0 ]; do
  case $1 in
    --source) src=$2; shift ;;
    --push) push=1 ;;
  esac
  shift
done
name=\${target##*/}
case $target in */*) owner=\${target%/*} ;; *) owner=me ;; esac
[ "$name" = slow-fails ] && { sleep 1; echo "GraphQL: Name already exists on this account (createRepository)" >&2; exit 1; }
[ "$name" = fails ] && { echo "GraphQL: Name already exists on this account (createRepository)" >&2; exit 1; }
git init -q --bare "${base}/bare/$name.git"
cd "$src" || exit 1
git remote add origin "https://github.com/$owner/$name.git"
echo "https://github.com/$owner/$name"
if [ -n "$push" ]; then
  [ "$name" = push-fails ] && { echo "remote: Permission denied" >&2; exit 1; }
  git -c "url.${base}/bare/$name.git.insteadOf=https://github.com/$owner/$name.git" push -q -u origin HEAD || exit 1
fi
`;
  writeFileSync(join(base, "gh"), gh);
  chmodSync(join(base, "gh"), 0o755);
  return base;
}
