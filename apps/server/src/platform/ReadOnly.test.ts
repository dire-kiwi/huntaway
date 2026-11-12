import { describe, expect, it } from "@effect/vitest"
import { isReadingGit } from "./ReadOnly.ts"

// What a read-only server runs (docs/plan/06-server.md, A read-only server): reading git, and nothing else.

const reads = (line: string) => isReadingGit(line.split(" ")[0] ?? "", line.split(" ").slice(1))

describe("isReadingGit", () => {
  it("takes git's reading subcommands, after -C and the safe settings", () => {
    for (const line of [
      "git status --porcelain=v2",
      "git -C /repo diff --no-color --no-ext-diff",
      "git -C /repo -c core.quotePath=false log -n 5",
      "git show -s HEAD",
      "git rev-parse --show-toplevel",
      "git merge-base a b",
      "git for-each-ref refs/heads",
      "git --literal-pathspecs ls-files -z",
      "git cat-file -p HEAD:readme.md",
      "git rev-list --count a ^b",
      "git ls-tree -r HEAD",
      "git stash list",
      "git stash show -p stash@{0}",
      "git worktree list --porcelain",
      "git remote",
      "git remote get-url origin",
      "git symbolic-ref -q --short HEAD",
      "git config branch.main.remote",
      "git config --get user.name",
      "git config get user.name",
      "git config --list",
      "git -c core.fsmonitor=false -c core.hooksPath=/dev/null status",
    ])
      expect([line, reads(line)]).toEqual([line, true])
  })

  it("refuses every other program, a writing git command, and an option or setting that writes or runs something", () => {
    for (const line of [
      "sh -c true",
      "gh pr list",
      "tmux list-sessions",
      "/usr/bin/git status",
      "git",
      "git commit -m x",
      "git worktree add x",
      "git worktree remove x",
      "git stash push",
      "git stash",
      "git remote add x y",
      "git remote show origin",
      "git symbolic-ref HEAD refs/heads/x",
      "git config user.name x",
      "git config --unset user.name",
      "git config set user.name x",
      "git fetch",
      "git diff --output=/tmp/x",
      "git log --ext-diff",
      "git -c core.fsmonitor=touch status",
      "git -c alias.st=!rm status",
      "git -c core.hooksPath=/tmp/hooks status",
      "git --exec-path=/tmp status",
      "git update-ref refs/heads/x HEAD",
    ])
      expect([line, reads(line)]).toEqual([line, false])
    expect(isReadingGit("git", [{ redacted: true }, "status"])).toBe(false)
  })
})
