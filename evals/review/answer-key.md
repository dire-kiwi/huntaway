# Answer key for the review prompt

Each row is a past change to this repository, at the commit a reviewer was first given, with the problems a good review
of that commit must find. The row's facts for the replay (branch, base, commit, the task's text) are in
[rows.json](rows.json), under the same key.

**Only a person edits this file.** No agent in the loop may change it, and a reviewer being replayed must never read
it.

An expected issue counts as found when the review names the same fault, in the same place, whatever its wording. The
grader marks each one `serious` (in `serious_issues`), `minor` (only in `minor_issues` or the summary) or `missed`.

Where a row's issues come from: every one here was raised by a reviewer on the board, fixed by the task's agent in a
later commit, and confirmed fixed by the next review. So this key measures how reliably one review finds what the
board's reviews have found before. It has no problem that every review missed.

## HE-59 · Visual indicator when task downgrades to Opus 4.8

Fixed in `1ac315b`.

1. **Notice drawn as the agent's words.** The fallback notice the server adds to the thread carries a `code`, and the
   web thread draws a notice with a code as the agent's own text. So the "moved to Opus 4.8" notice shows as if the
   agent said it, with no warning style (`apps/server/src/agents/claude/translate.ts`, the web's thread item model).
2. **Every reply ends its chunk's transaction.** Each assistant reply now gives a `ModelAnswered` effect that is not
   deferrable and reads the task, so every reply ends the transaction its chunk of lines shares and costs a read
   (`apps/server/src/runs/claude/output.ts`).

## HE-64 · Restore last position when switching profiles

Fixed in `bb41712` (1) and `5b5b641` (2). The second was found only in the second round of review.

1. **The active profile's row no longer opens its board.** Clicking the profile that is already active goes to its
   kept page, which from Settings, the guide or analytics is not its board, as it was before
   (`apps/web/src/components/layout/sidebar/useActiveProfile.ts`, `switchTo`).
2. **A kept page the profile no longer lists.** `switchTo` goes to a profile's kept page even when the sidebar would
   move off that profile there: a project since unpinned, moved to another profile or deleted, or a group it left. The
   profile can then not be reached from its row or with `p`/`P`.

## HE-84 · Forward port: one slow tailcat start shouldn't hold up the others

Fixed in `a2ba249`.

1. **The tests can signal their own process group.** The fake tailcat scripts write their pid with `echo $$ > file`,
   which a test polling for the file can read while it is empty. The pid then parses as 0, and
   `process.kill(0, "SIGUSR1")` signals the test runner's own process group
   (`apps/server/src/runs/PortForwards.test.ts`, `apps/desktop/src/main/forwards.test.ts`). On CI the `test` job hung.

## HE-85 · Forward port: share servers that listen only on a non-loopback address

Fixed in `2133f2d`.

1. **A server on several addresses can be refused.** A task lists one server per port, at the address the scan met
   first. A server that listens on both a LAN address and 127.0.0.1 can be listed on the LAN address, and is then
   refused (tailcat without mappings) or mapped, when it could be shared as a plain port
   (`apps/server/src/runs/DevServers.ts`, `apps/server/src/runs/devServers/proc.ts`, `PortForwards.ts`).

## HE-90 · Show hidden files in code browser

Fixed in `312f574`.

1. **Endless render loop.** The Code tab builds the `open` list of its `git.files` request from the last answer's
   ignored folders, and sets that last answer during render on every new answer. Two cached answers that disagree on
   what is ignored (a `dist/` removed or rebuilt) each ask for the other, and React gives up with error 301
   (`apps/web/src/components/code/Code.tsx`, `tree.ts`).

## HE-92 · Hide forward port from same-host client

Fixed in `caddfec`.

1. **A loopback address is not proof of being on the task's host.** The button is hidden when the page's hostname is
   a loopback one. A board reached through a tunnel (`ssh -L`) is at localhost too, and hiding the button there
   leaves no way to reach the task's servers (`apps/web/src/components/task/thread/forwardPort.ts`, `onTaskHost`).

## HE-94 · Auto-init git and commit placeholder README on new project

Fixed in `7cf18ab`.

1. **A UI test relies on the old behaviour.** `apps/web/tests/ui/fanout.test.mjs` makes its `plain` project on a
   folder that does not exist and expects a folder that is not a git repository. With this change the folder becomes
   one, and the test fails.

## HE-86 · Add back-navigation links to docs pages

Expected verdict: `pass`. The board's review passed this commit and nothing was fixed after it.

## HE-93 · Browser warning when connecting from another host

Expected verdict: `pass`. The board's review passed this commit and nothing was fixed after it.
