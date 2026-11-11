# 04 — Git, worktrees, merging and automatic review

Source: `the huntaway repository/apps/server/src` (paths below are relative to it). Docs: `docs/guide/concepts.md`, `docs/guide/github.md`.

## 1. Purpose

Gives every code task its own git worktree and branch in the project's repository, shows and edits that worktree's git state (the lazygit-style *Changes* tab), snapshots it per agent turn (checkpoints) so a task can be rewound, and decides what a task's "own work" is (its base branch and start commit). On top of that it runs the two automated board stages: **In review** (read-only reviewer agents in their own threads, verdicts via `submit_review`, rounds of fixes, then summaries) and **Ready for merge** (a per-branch merge queue in which the task's *own agent* does the merge, with optional user approval, `merges_into` lanes, stack levels restacked by the server, and whole-stack runs). It also tracks pull requests (lookup, approval check, merged/closed detection, GitHub stacked PRs, preview URLs), cleans worktrees up safely, and moves a project's repository folder. The server never merges code itself: it only rebases stack levels, force-pushes them with a lease, and edits PR bases.

## 2. Capabilities

### 2.0 End-to-end flows (the detail is in 2.1–2.21)
**Worktree lifecycle.** (1) Task created with `use_worktree` (project default), optionally `start_from` / `merges_into` / `base_branch`; nothing on disk yet (`worktree_state=none`). (2) First agent run (or *Set up worktree*) → `setup`: resolve start, `git worktree add`, save path/branch/base, copy ignored files, link folders, run setup script → `ready`. (3) Each run: launch waits for relocation and restack, takes a `start` checkpoint if anything changed; each turn end takes a `turn` checkpoint; run end advances start refs and looks up the PR. (4) Review threads and summary threads run in the same worktree, read-only. (5) After Done the worktree stays until: the PR-merged poll removes it (if safe), *Remove merged worktrees* / *Reclaim space*, a manual teardown, fan-out pick, or task/project deletion (forced). The branch is kept unless asked. (6) If the agent runs again, the worktree is re-made in the same folder from the kept branch.

**Review.** agent run ends cleanly → task `in_review` → `review.start` (skip rules) → N reviewer threads run in parallel → each calls `submit_review` and ends → combine → `passed` (→ summaries → task waits in In review for the user) or `issues` (→ issues sent to the task's agent, `fixes+1`, task In progress → run ends → In review → next round) until `review_rounds + extra_rounds` is used up (→ Needs attention; *N more rounds* = `extend`, *Review again* = manual start). Any new prompt run on the task stops the review and summaries.

**Merge.** user (or agent, or stack merge) moves task to `ready_for_merge` → nothing-to-merge shortcut to Done, PR-approval check, `merging=1` → `start_next_merge`: [if approval required: agent summarises, user answers the card] → when its lane's slot is free and it isn't held or waiting for a level below, the task's **own agent** gets the merge prompt → it merges the PR (gh `pr_merge`) or the branch, then calls `update_task status=done` → server restacks levels stacked on it, starts dependants and the next merge. Agent ends without Done → Needs attention (slot still held). Agent steps out (`remerge`) → In progress, slot freed, back to the queue's end when it finishes. Separately, a PR merged on GitHub by anyone moves an In review / Needs attention task to Done within 3 minutes.

### 2.1 Git plumbing (`git/worktree.ts`)
- Run `git -C <dir> …` with `GIT_TERMINAL_PROMPT=0`, output as text or bytes, optional stdin and timeout; `git_ok` throws `git <args> failed: <stderr>`.
- `is_git_repo`, `current_branch` (symbolic-ref), `commit(rev)` (`rev-parse --verify --quiet rev^{commit}`), `is_ancestor`, `checked_out_in(repo, refs/heads/x)` and `is_worktree_of` (both from `git worktree list --porcelain`), `valid_branch_name` (`git check-ref-format --branch`, run in `/` with `GIT_DIR`/`GIT_WORK_TREE` removed; rejects `@{`).
- Path helpers that compare by whole components and canonical path (`canonicalize`, `path_starts_with`, `strip_path_prefix`, `same_path`).

### 2.2 Worktree setup (`git/worktree/setup.ts`)
- `setup(task)` is idempotent: returns at once if `worktree_state=ready` and the folder exists. Runs at an agent run's launch (`agent/runner/launch.ts`) for a task with `use_worktree`, from `POST /tasks/{id}/worktree/setup`, and recursively for a task another needs first.
- One setup/teardown/restack at a time per task (`locked(task_id)`); a setup also holds the project's folder in place against relocation (`relocate.hold`).
- Folder: `<project.worktrees_root>/<name>`; `worktrees_root` defaults to `<data-dir>/projects/<project id>/worktrees` (settable; must be absolute or `~/…`, not the repo folder itself).
- `name` (`folder_name`): if the task already has a branch `ia/<key or former key, lowercase>-<rest>` and `<rest>` has no `/`, it is `<rest>` (so a re-made worktree gets the same folder and the agent's conversation, which Claude keeps by cwd, carries on); else `<number>-<slugify(title, 40)>` or just `<number>`.
- Branch: `ia/<project key lowercase>-<name>`. A task with no branch yet whose name is taken by a branch that has no worktree folder gets `-2`, `-3`… (another task's branch from a deleted/re-added project).
- An existing folder at the path must be a worktree of this repo that is on this branch or is the task's recorded path; otherwise "is in the way".
- New branch: `git worktree add --no-track -b <branch> <wt> <start rev>`; existing branch: `git worktree add <wt> <branch>`. `git worktree prune` first.
- Base branch priority: what `start_from` picked → task's `base_branch` → subproject's branch (legacy; the subproject's worktree is set up first) → project `base_branch` → repo's current branch → `HEAD`.
- State machine on the task: `worktree_state` `none → setting_up → ready | error` (+`worktree_error`); `worktree_path`, `branch`, `base_branch` are saved as soon as git has made them (before copy/links/setup script), again with `ready` at the end.
- Writes `refs/huntaway/start/<task id>` = the new branch tip when the task has `start_from`; sets `branch.<b>.gh-merge-base` when the base isn't the project's (so `gh pr create` targets it).
- Thread events: "Worktree ready at … on branch … (from …)", start notes, copy/link report, "Running setup script…", "Setup script finished" (log ≤ 20000 chars), "Worktree setup failed".

### 2.3 Where a branch starts (`git/worktree/upstream.ts`, `start.ts`)
- `upstream(base)`: the branch's configured upstream; else same-named branch on `origin` (or the only remote) if it was fetched before or there's no local branch; `remote/branch` names; none for a tag/commit/`HEAD`.
- `fetch`: `git fetch --quiet --no-tags <remote> +<merge>:<tracking>`, 60 s limit, authenticated as the task's GitHub account for HTTPS (`gh_mcp.authenticate_fetch`), skipped for remote `.`.
- `start_point(base)`: fetch upstream (failure → warn, use last fetched), then: no local → upstream tip; local contains upstream → local (ahead/unpushed kept); diverged → upstream, warn with count of local-only commits; behind → fast-forward local (`merge --ff-only` in the worktree that has it checked out, else `update-ref` with old-value check) and use upstream tip; if ff fails, branch from upstream anyway.
- `compare_ref(base)`: same choice without fetching; what a task's work is compared with.
- `pick_start(start_from)` resolves the four kinds (see §3 `StartFrom`): branch (remote-only branch on the PR remote is treated as the branch; another remote's branch → start from its tip commit with the project's base); task (merged → where it went; no branch yet → set its worktree up first; else its branch, "Lands after KEY"); pull_request (`gh pr view N --repo R --json state,headRefName,baseRefName,headRefOid,isCrossRepository`: merged → its base; open, same repo and the branch name follows that remote → its branch; else fetch head SHA and start from it with the PR's base); commit (fetch by full 40-hex SHA from the push remote if absent).
- `branches(repo)`: up to 200 branches, newest commit first (`for-each-ref --sort=-committerdate --count=400`), remote-only ones as `origin/x`, no `HEAD`.
- `unstack(gone)`: before deleting a merged task, tasks started from it are re-pointed (to the unmerged task it was itself stacked on, or to `{type:"commit"}` of their start ref with the resolved base).
- `remote_base(task)`: the branch whose remote decides where the task's PR goes (walks down stacked tasks whose branch has no `branch.<b>.remote` yet, max 16).

### 2.4 Ignored files into a new worktree (`git/worktree_files.ts`)
- `copy_files` patterns (+ repo-root `.worktreeinclude`, ≤ 64 KiB, not a symlink): list with `git ls-files -z --others --ignored -x <pattern>…`; copy only files ignored both in the repo and on the task's branch (`check-ignore -z --stdin` in each), never tracked, never overwriting, never through symlinks, not under linked folders or the worktrees folder. `copyFileSync` (docs say copy-on-write where possible).
- `link_folders`: symlink repo folder into worktree; must be a real folder inside the repo, git-ignored, nothing tracked in it, worktree not inside it. If git doesn't ignore the *link*, append `/<path>` to the common `info/exclude` under a fixed header comment; if still not ignored, remove the link. Each link is recorded in `<worktree git dir>/huntaway-links`.
- Validation for the settings API: ≤ 200 entries each, no `..`, links relative, no `.git`.
- Report → one thread event (`Copied N files and linked M folders from the repository (K left out)`, detail lists each).
- `relink` after a repository move.

### 2.5 Project scripts (`git/worktree/scripts.ts`, `integrations/status_script.ts`)
- Setup and teardown scripts: `bash -c <script>` in the worktree, own process group, killed after `SCRIPT_LIMIT` = 30 min; non-zero exit throws with the last 8000 chars. Env = agent env + `IA_REPO_PATH`, `IA_WORKTREE_PATH`, `IA_BRANCH`, `IA_TASK_ID`, `IA_TASK_NUMBER`, `IA_PROJECT_KEY`.
- Status scripts (owned by integrations, uses `run_script`): the any-column script then the column's script on every status change of a `kind=task`, per-task FIFO queue, 5 min limit each, cwd = worktree or repo, extra env `IA_TASK_KEY`, `IA_TASK_TITLE`, `IA_OLD_STATUS`, `IA_NEW_STATUS`, `IA_RESOLUTION`, `IA_PR_URL`; result is a thread event.

### 2.6 Worktree removal (`git/worktree/remove.ts`)
- `teardown(task, force, delete_branch)` (under the setup lock): refuses unless `force` when `uncommitted()` is non-empty or HEAD has commits on no branch/remote/tag (`stray`); sets `tearing_down`; kills the task's terminals; stops leftover processes (`agent/leftovers.ts`); runs the teardown script (failure aborts unless forced); non-forced re-checks uncommitted+strays after the script, then plain `git worktree remove`; forced uses `--force` and falls back to deleting the folder by hand only if it is inside `worktrees_root`, isn't the root or the repo, and isn't a main checkout; `worktree prune`; drops checkpoints; sets `worktree_state=none`, path/error null; optional `git branch -D` (clears `branch`).
- `uncommitted(wt)`: `git status --porcelain --untracked-files=all --ignore-submodules=none` plus tracked files flagged assume-unchanged/skip-worktree whose content or exec bit differs from the index (`ls-files -v -s -z`, `hash-object --stdin-paths`). Ignored files don't count.
- `remove_if_merged(task, fetch)`: only for `kind=task`, `status=done`, worktree ready and present, no agent or reviewer in it, not a subproject with open tasks; nothing uncommitted; HEAD is an ancestor of the local base, or of its upstream, or is the head of the branch's **merged** PR (`gh pr view <branch> --json state,headRefOid,baseRefName,url`); a stacked task also counts if merged into the project's base. Then non-forced teardown keeping the branch. Result `{Removed: where}` or `{Kept: why}`.
- `remove_merged(project)`: fetch each distinct base's upstream once, then `remove_if_merged` for each done task with a ready worktree, by number; returns per-task `{task_id, number, title, removed, detail}`.
- `agent_in_worktree(task)`: its own run or any of its review threads running.

### 2.7 A task's diff and base (`git/worktree/changes.ts`)
- `changes_dir`: worktree if ready, else the project repo.
- `changes_base` → `[base branch, start commit]`: start = the latest of the merge-bases of HEAD with: `compare_ref(task_base)`, the task's own `base_branch` when it differs (stacked on a since-merged task), a `start_from` commit, and `refs/huntaway/start/<id>`.
- `keep_start`/`keep_starts`: advance the start ref to as much of the parent branch as the task has merged in (only forward, with old-value check). Called when either task's run ends, when a task becomes done, before a teardown, on restack, and whenever changes are read.
- `work_scope` for reviewers/summarizers: `[ref to diff against, own_start?]` (own_start = the start is later than where the branch left its base, so the PR diff has foreign commits).
- `diff(task)` (`GET /tasks/{id}/diff`): `git diff --stat=200 <start>` + patch of tracked changes vs start (includes uncommitted), plus `git diff --no-index /dev/null <f>` for the first 50 untracked files; `git log --oneline start..HEAD`; patch truncated to 2,000,000 chars. If the task uses a worktree that isn't there: diff of the branch's commits in the repo (`branch` field set). `{available:false, reason}` when not a repo / no branch.
- `has_work_to_merge`, `unmerged` (see 2.11), `forget_start`.

### 2.8 Changes tab (`git/git_view.ts`) — every operation
All run at the top of the working tree with `-c core.quotePath=false`, `GIT_EDITOR=true`, `GIT_OPTIONAL_LOCKS=0`; git's own message comes back as 409. If the project folder is a subfolder of a repo, the view is limited to it and whole-repo actions (amend/reword, stash, reset, committing with files staged outside) are refused.
- Status: `status --porcelain=v2 -z --branch --untracked-files=all` → head, branch, upstream, ahead/behind, files `{path, orig_path, x, y}` (max 5000, `truncated`), base + merge_base, repo state (`rebasing|merging|cherry-picking|reverting` from files in the git dir), commits (≤ 300 on the branch since the start, then 30 from before it; `{sha, author, time, subject, on_branch, unpushed}`), stashes `{index, sha, time, subject}`.
- File diff: unstaged, `staged` (`--cached`) or `untracked` (`--no-index /dev/null`), `--no-renames`; > 4 MiB → `too_large`; non-UTF-8 → `{not_utf8, preview}` with no patch.
- Show: a commit (`show -M -m --first-parent`, metadata sha/author/email/time/message) or a stash (`stash show -p --include-untracked`, retried without that flag for git < 2.32).
- Stage (`add -A -- paths` or all), unstage (`reset -q HEAD -- paths`; before the first commit `rm -r --cached`), discard (files only: `restore --worktree`, or with `staged` `restore --source=HEAD --staged --worktree` / `rm -f` for added files; `clean -f` for untracked), apply a client-built patch (`apply --whitespace=nowarn [--cached] [-R] -`, body limit 32 MiB), commit (`commit -q -F -`; `amend`; `reword` = `--amend --only --allow-empty`), stash push (`all` = `--include-untracked`, `staged` = `--staged`, `unstaged` = `--keep-index --include-untracked`, optional message) / apply / pop / drop (by `index` **and** `sha`, refused if they no longer match), reset (`soft|mixed|hard` to a hex sha).
- Path/rev validation: paths relative, no `..`; revs 4–64 hex.

### 2.9 Checkpoints, turns and rewind (`git/checkpoints.ts`, `checkpoints/*`)
- Only for `kind=task` with a ready own worktree that isn't a documents/scratch task; not for `compact` runs.
- Snapshot: read HEAD first; copy the worktree's index to `<git dir>/huntaway-checkpoint-<uuid>.index` keeping its mtime to the second; `git ls-files --others --exclude-standard` (refuse if > 20,000 untracked); `git -c core.splitIndex=false add -A --ignore-errors --pathspec-from-file` excluding untracked files > 50 MB; `write-tree`; `commit-tree --no-gpg-sign -m "Huntaway checkpoint" [-p HEAD]` as `Huntaway <huntaway@localhost>`; ref `refs/huntaway/checkpoints/<task id>/<n>`; row in `checkpoints`. Same tree+head as the last checkpoint reuses its sha.
- `before_run` (awaited in launch): kind `start`, only if tree or HEAD changed since the latest non-stale checkpoint.
- `after_turn(run, status done|stopped|failed)` (background, queued): kind `turn` with `before_n`, `turn` number, `message_id` (from `runs.turn_message_id`, then cleared), `session`, `agent_at` (from `runs.agent_at`), `stats`; emits `{type:"checkpoints", task_id}`.
- Keep the last 200 per task (`prune`); `forget` deletes all refs and rows when the worktree is removed.
- Turn stats/diff exclude files "git brought in": paths changed only by commits HEAD moved to (not made here, judged from `git log -g` reflog subjects: commit/cherry-pick/revert/am/rebase pick…/"Merge made by") or by merges made here except where `git show --remerge-diff` shows a manual resolution; skipped when > 5000 commits or no reflog.
- `GET /tasks/{id}/turns`, `GET /tasks/{id}/turns/diff?from=&to=` (patch ≤ 4 MiB else `too_large`), `POST /tasks/{id}/rewind`, `DELETE /tasks/{id}/rewind`.
- Rewind (queued per task): refused while the agent or any review thread runs, or with a merge/rebase/cherry-pick/revert in progress; finds the first non-stale turn started by `message_id`; snapshots the present files as a `rewind` checkpoint (stale=1); optional branch move back (`reset --soft`, only if the old HEAD is an ancestor of the current one); restores only differing files (`diff-tree` of trees, `read-tree` + `checkout-index -f` via an empty scratch index); skips submodules, skip-worktree/assume-unchanged files, paths through symlinks or nested repos, folders in the way, files the pre-rewind snapshot didn't have; unstages the touched paths; marks later checkpoints stale (1 files only, 2 conversation too); sets the task's `rewind` (or clears `session_id`/`context` when the message was the thread's first); thread event; returns the message text for the composer.
- Conversation rollback is applied by the next run: Claude `--resume <session> --resume-session-at <agent_at of the turn before>`, Codex `thread/revert` to `before_turn`; only if the task's session still equals `rewind.session`.

### 2.10 "Did the agent change code?" (`git/changes.ts`)
- `changes_code(tool_use, result)`: `Edit|MultiEdit|Write|NotebookEdit|ApplyPatch` that succeeded; `Bash` not denied whose command (own shell tokenizer: quotes, ANSI-C, heredocs, redirects, wrappers like `sudo/env/timeout/xargs`, `bash -c` to depth 3) does `git commit|push|apply|am|cherry-pick|merge|rebase|revert|mv|rm`, `gh pr create`, `sed/perl -i`, `patch`, `tee/touch/rm/rmdir/mkdir/truncate/cp/mv/install/ln/rsync` or an output redirect to a non-scratch path (`/dev/`, `/tmp`, `/var/tmp/`, `$TMPDIR` are scratch).
- `runs_program(command, "gh")`: used by the `gh-hook` PreToolUse hook to turn away `gh` in Bash (follows substitutions, `eval`, `case`; unclosed substitution counts as a hit).

### 2.11 Pull requests (`git/worktree/pr.ts`, `remote.ts`, `state.ts`, `mcp/pr_watch*`, `mcp/gh_mcp.ts`)
- PRs are **opened by the agent**, told so in its system prompt when the task has its own branch, the project's `pull_requests` (or `subproject_pull_requests`) is on and the push remote is on github.com (`agent/runner/prompt.ts`): commit, `git push -u <remote> <branch>`, `pr_create` with explicit `repo`, `head`, `base`. With a workflow that opens PRs itself (`board_pr`) the agent is told not to push.
- `github(repo, base)`: push remote = base's `branch.<b>.remote`, else `origin`, else the only remote; its push URL parsed to host + `OWNER/REPO`; SSH aliases resolved with `ssh -G` (5 s); must be `github.com|www.github.com|ssh.github.com`.
- `find_pr(task)` after each task run ends: if it has a branch and no `pr_url`, `gh pr view <branch> --json url [--repo R]` as the task's account; stores `pr_url` unless set meanwhile.
- `pr_url` can also be set by the agent (`update_task`) or the user; must be http(s); blank clears.
- Setting `pr_url` (a) fills `preview_url` from the project's `pr_preview_url` template (`{pr}` → number) unless the task has a hand-set preview (`state.ts preview_following_pr`); saving the template re-derives previews for non-done tasks; (b) triggers GitHub stack linking.
- `GET /preview-status?url=`: server-side fetch with 5 s timeout → `{up, status}`; the web polls it every 2 s while the task is in review.
- `pr_approval_required` (project `require_pr_approval`, else profile's; only when the task would have a PR on GitHub) and `pr_approved` (`gh pr view --json reviewDecision,reviews`: GitHub's decision, else per-reviewer latest verdict counting approvals only from OWNER/MEMBER/COLLABORATOR, dismissals clear) gate the move to Ready for merge.
- `unmerged(task)` (`GET /tasks/{id}/unmerged`): has work to merge and its PR isn't `MERGED` (5 s limit) → the UI asks before Done.
- `review/merged.ts`: poll for PRs merged/closed on GitHub (see 2.17).
- Elsewhere but relied on: `wait` on a PR, watching PRs of in-review tasks (`watch_pull_requests` off|failures|all; read every 2 min, tick 15 s), `pr_checks` on the task, *Fix broken checks* (`POST /tasks/{id}/fix_checks`), the `gh` MCP server (`pr_merge` refuses via `merge_gate`, uses `merge-async` for stacked PRs).

### 2.12 Automatic review (`review.ts`)
- Trigger: a `kind=task` entering `in_review` (run ended cleanly, or moved there) → `on_in_review`; manual `POST /tasks/{id}/review` (*Review now*).
- Skips (silently when automatic, 409 "Can't review: …" when manual): not a project task; agent running; `auto_review` off or `use_workflows` on (automatic only); host can't run agents; no ready worktree or no branch; a review already running; this HEAD already reviewed (`passed`, or `issues` unless the branch has no commits of its own); branch has no own commits and the agent didn't change code elsewhere (`changed_elsewhere`: tool calls since the last finished review per 2.10, uncommitted changes, or before the first review a `pr_url`) → event "Not reviewed: no code changes".
- Reviewers: `reviewers_for(project)` = project's, else profile's, else one with the task's config (max 6). One review thread per reviewer (`kind=review`, `parent_id`=task, `task_type` null, `use_worktree=false`), reused when config+model+effort match, titled `Review of KEY-N[ (label)]`. Label = `config name · model · effort`.
- Each round: thread `session_id` cleared (fresh conversation, thread keeps all rounds' messages), per-thread skills set, prompt built (task title/description, where the work is, the user's replies in the task thread, reviewer's own `prompt` or the project's `review_prompt` or default, how to report, previous round's issues to re-check), sent as a `review`-kind run in the **task's worktree**.
- Reviewer sandbox: allowed `Read, Grep, Glob, Skill, Agent, Task, Bash(git diff|log|show|status|merge-base|rev-parse:*), Bash(gh pr view|diff|list|checks:*)`; disallowed `Edit, Write, NotebookEdit` and the gh server's write tools; only read-only board tools + `submit_review`.
- `submit_review {verdict: pass|needs_fixes, summary, serious_issues[], minor_issues[]}` records the part's verdict (needs_fixes with no issues → the summary becomes the issue); verdict acted on when the reviewer's **run ends**.
- Part end states: `passed`, `issues`, `failed` (run failed / asked a question / ended without a verdict / couldn't start), `stopped`. Combined: any issues → `issues` (each prefixed `(label)` when several); all passed → `passed`; all stopped → `stopped`; else `failed`.
- On `passed`: event "Review passed", start summaries. On `issues`: if the task is still `in_review` and idle and `fixes < review_rounds + extra_rounds` → `fixes += 1`, send the numbered issues to the task's agent (`send_fixes`, message marked `auto` + `review_round`), which moves it to In progress and, when it finishes, back to In review → reviewed again; if out of rounds → `needs_attention` "The review found N serious issues after K rounds of fixes"; if the task moved on, just an event. Otherwise "Review didn't finish".
- `extend` (`POST /tasks/{id}/review/extend`): only when latest review is `issues`, rounds used up, agent idle, not done/merging → `extra_rounds += max(review_rounds,1)`, `fixes += 1`, send issues; rolled back if the send fails.
- Manual review resets `fixes` and `extra_rounds` to 0. A pass resets both.
- `supersede`: any new `prompt` run on the task stops the running review and summaries ("Stopped because the agent started working on the task again"). `stop`: the user's Stop also stops them.
- Starting a review of a task in `in_progress`/`needs_attention` (manual) moves it to `in_review` unless a later run started.
- No timeout on a review: it ends when each reviewer's run ends.

### 2.13 Summaries (`review/summary.ts`)
- After a review passes (and `auto_summary`, not `use_workflows`, task still `in_review`), or `POST /tasks/{id}/summary`.
- Summarizers: project's → profile's → one default; each `{claude_config_id, model, effort, name?, skills?, prompt?}`; thread per summarizer (`kind=review`, `task_type=summary`), matched by config+model+effort+`description == variant_key` (JSON of name/prompt/skills, or ""); title `Summary of KEY-N[ · name]`.
- A summarizer already `done` at this HEAD isn't rerun (automatic). The summary is the thread's last assistant text since it was asked; states `running|done|failed|stopped`.

### 2.14 Merge queue (`agent/runner/merge.ts`, `db/tasks/merges.ts`, `api/tasks.ts`)
- Moving a `kind=task` to `ready_for_merge` (user, agent's `update_task`, stack merge): refused while its agent runs; if nothing to merge (scratch/doc-only task, or `has_work_to_merge` false) it goes straight to `done` with an event; if PR approval is required and missing → 409; else `merging=1`, `merge_approval=null` unless already approved, `stack_run` set/cleared, position = end of column if none given.
- `has_work_to_merge`: true if it is a subproject with non-scratch tasks, or non-scratch tasks merge into it, or `rev-list --count branch ^base ^upstream` ≠ 0, or the worktree is dirty; "can't tell" → true; no branch: repo not on base branch or dirty.
- `start_next_merge(project)` is called after every status change, run end, restack, approval, deletion, startup. For each lane with waiting tasks: if the lane's slot is free, the first queued task in column order (`position, created_at`) gets `request_merge`; tasks needing approval are summarised regardless of the slot.
- Lane (`merge_lane`): id of the first unmerged task it merges into (following merged targets and merged levels below), else its subproject (`parent_id`), else null (project top level).
- Slot holder (`active_merge`): `merging=1` and (`running=1` or `status=needs_attention`), not `merge_approval=pending`; or a "merge handoff" (ready_for_merge, not merging, latest run `finished=1`) waiting for a workflow to move it to Done.
- Queued (`queued_merges`): `merging=1, running=0, status=ready_for_merge`, not pending approval, project not archived, not `merge_held`, not `stack_waits`.
- `request_merge` sends the agent (as an `auto` user message) : "The user moved this task to "Ready for merge". [The user approved the merge.] Merge branch `X` into `Y`." + stack/merges-into wording + project `merge_prompt` or default + "If you can't merge, call `request_user_input`" + "Once it is merged, call `update_task` to set this task's status to `done`" + the step-out paragraph; extra text for stack runs, tasks merging into it (ask the user if some aren't done), `carries`, legacy subprojects.
- Run end while `merging` (`agent/runner/output.ts`): task already `done` → nothing; pending approval → `needs_attention` "Approve or deny the merge" + approval card; else → `needs_attention` "The agent finished without marking the task merged". Question/permission during merge → `needs_attention` and still holds the slot. Run failure/stop → needs attention (a merge never waits for a usage-limit reset).
- Step out: agent calls `update_task {status:"in_progress", remerge:true}` (only while merging and running, not while approval is pending) → `merging=0, remerge=1`; when that run ends the task goes to the **end** of `ready_for_merge` with `merging=1` ("Back in the merge queue"); moving it anywhere but in_progress/needs_attention clears `remerge`.
- A user message to a task queued behind another merge is refused (409). A message to a stack level waiting in Ready for merge takes it out (`in_progress`, `remerge=1`).
- Failure to build the merge request → `needs_attention` "Couldn't start the merge: …" (stays merging, holds the lane).
- Startup: `start_queued_merges` for every project with queued merges.

### 2.15 Merge approval gate (`review/merge_gate.ts`)
- `required`: project `merge_approval` (nullable) else profile's.
- A queued task with `merge_approval=null` under a requiring project: set `pending`, agent asked to summarise what would merge (and commit/push first) without merging; out of the queue meanwhile.
- When that run ends: `needs_attention` + a `question` message `{question, options:[Approve, Deny], multi_select:false, allow_other:false, merge_approval:true, status:"pending"}`; older pending cards are settled `replaced`.
- `decide`: Approve → `merge_approval=approved`, `status=ready_for_merge` (rejoins queue); Deny → `merging=0`, `status=in_review`. Refused if no longer pending/merging or the agent is running.
- `blocked(task)` gives the gh MCP server the text to refuse merges with (pending approval, or project requires approval and task isn't merging); a review thread goes by its parent.

### 2.16 `merges_into`, stack levels, restack, GitHub stacks, whole-stack merge
- `merges_into` (`api/tasks.ts`, `api/incoming.ts`, `api/new_task.ts check_merges_into`): target must be an open code task in the same project with a branch or worktree, not a subproject, no cycle through `merges_into`/`start_from`/`parent_id`; changeable until merging or done. Before a branch exists the task also gets `start_from={task}`; with a branch it keeps its start commit and re-bases its `base_branch`; `gh-merge-base` follows.
- `task_base(task)`: `merges_into` target's branch while open; where a merged target went (recursively, max 16); a task started from a since-merged task goes where that went; else own `base_branch`, else project's.
- Target closed without merge (done with resolution ≠ done) or deleted → all open tasks whose work reaches it (`reaching`) and stack levels on it are flagged: event, `needs_attention` with reason ending ": choose where it merges now", `merging/remerge/merge_approval` cleared (running ones at run end). `POST /tasks/{id}/merge-target {to}`: `onward` (where it was going), `close` (same resolution as the gone task, default `not_done`), or a sibling's id (takes its place, others merge into / stack on it). Sets `carries {key, commit}` when a branch may still hold the gone task's commits.
- Stack level = task with `start_from.type=task` and no `merges_into` (`stacked_below`). `stack_state`: none/open/restack/conflict/merged/closed/deleted; `stack_waits` (open|restack|conflict) keeps it out of the queue.
- When a task becomes merged: `restack_stacked_on` marks each open level with a branch `restack=due`, then `schedule_restack` (one at a time per repository, in order; under the task's setup lock).
- `restack(level)`: later if an agent/reviewer is in its worktree; fetch new base; conflict if remote branch has commits not local (unless GitHub rebased it), worktree dirty, no start ref, start no longer in branch, base missing; rebase `start..head` onto the base tip in a throwaway detached worktree under `mkdtemp(huntaway-restack-)` with hooks off (`-c core.hooksPath=/dev/null`, `rebase --no-autosquash --no-update-refs --onto`, 5 min); re-check agent and branch tip; move branch (`reset --keep` in its worktree, or `update-ref` with old value); `git push --no-verify --force-with-lease=<ref>:<remote head read>` (120 s), rolling the local move back if the push fails; start ref → merge-base(tip,new head); `restack=null`, `base_branch=base`; `gh pr edit <url> --base <to>` if needed (unstacking on GitHub first); event; re-link GitHub stack; then levels above follow, and `start_next_merge`.
- GitHub-stacked level: waits up to 90 s (poll 3 s) for GitHub's own rebase (`pulls/N`: head sha changed → `rebased`; base retargeted and `mergeable_state=dirty` → `conflict`; no `stack` → `unstacked`, clears `github_stack`), then adopts the remote head and rebases only unpushed local commits onto it.
- Conflict: first time → the agent is asked once to rebase/push itself (task out of the queue with `remerge=1` if it was merging); second time (or the ask fails) → `needs_attention` "Couldn't restack it onto X: …".
- GitHub stacks (`gh_stack.ts`): when a level's and the one below's PRs are both open in the same repo and the level's PR base is the lower one's head branch, `POST repos/O/R/stacks` (`pull_requests[]=low, up`) or `…/stacks/N/add`; store `github_stack`; bottom of a new stack must be a plain project task whose PR targets its base; one attempt per PR pair (memo), links serialised; `unstack_github` (`…/stacks/N/unstack`) before a base change clears `github_stack` on every task of that stack. Tried when a `pr_url` is set, after a restack, and at startup.
- Stack model (`db/tasks/stacks.ts`): `stack_of` (bottom + all levels, ≤ 256), `stack_line` (main line; at a fork follow the one with `github_stack`, else lowest number). Stack title/description on the bottom task (`agent/stack_title.ts`, `PATCH /tasks/{id}/stack`).
- Whole-stack merge (`api/stack_merge.ts`, `POST /tasks/{id}/merge-stack`): every open main-line level must be in_review+idle+review passed/none, or already ready_for_merge; no open task merging into any; lowest not held; each has work to merge and PR approval where required; re-validated after the GitHub reads; then all get one `stack_run` id and are moved bottom-first to the end of the column. The run holds its lane from its first level's turn to its last (`stack_run_lanes`); all levels are summarised for approval up front and the run starts only when none is pending (`awaits_approvals`); a level leaving the merge takes the levels above out of the run (`settle_stack_runs`).

### 2.17 Merged/closed on GitHub (`review/merged.ts`)
- Every 180 s (first at 30 s): tasks in `in_review|needs_attention` with `pr_url`, not merging/running, `task_type` null, project `done_when_merged=1`, no agent/reviewer running, not in a subproject, not a subproject with open tasks; grouped by (account, host), ≤ 50 PRs per GraphQL query (aliases `pr0…`), reading `state` + head checks.
- `merged` → conditional update to `done`/resolution `done` (only if still same status set, idle, same `pr_url`), event, telemetry, `restack_stacked_on`, `start_unblocked`, `start_next_merge`, workflows, kill terminals, `remove_if_merged(fetch=true)` (event says why when kept).
- `closed` → `in_review` task to `needs_attention` "PR #N was closed on GitHub without being merged"; one already in needs_attention only gets an event.
- Acts once per change of state via `pr_states`; also records `pr_checks` for open PRs.

### 2.18 Fan-out compare and pick (`review/fanout.ts`)
- `GET /tasks/{id}/fanout` → per sibling `{id, run_secs, runs, working, uncommitted[≤20], uncommitted_count, uncommitted_error, stray_commits, branch, pushed}`.
- `POST /tasks/{id}/fanout/pick {delete_branches, close_prs, discard_uncommitted}`: one pick at a time; for each other sibling: abort its agent and reviewers, wait ≤ 20 s for them to stop (else leave it), complete as `done/not_done`, optionally `gh pr close`, teardown (kept if stray commits or uncommitted without discard), then delete pushed branch (`git push <remote> --delete`, 60 s; only if the upstream is its own name) and local branch; returns `{task, results:[{id,key,stopped,completed,worktree,branch,pushed_branch,pr,notes}]}`.

### 2.19 Review statistics (`review/stats.ts`, `db/review_stats.ts`)
- One row per `submit_review` (a run's later submission replaces its earlier); round = `Review.started_at`; effort = the reviewed task's latest prompt run's effort; `minor_noted` from `minor_issues` or a summary mentioning minor/nit/suggestion without a negation. Telemetry event `review`. Backfills for old data (migrations 79, 82).

### 2.20 Repository relocation and fingerprint (`git/relocate.ts`)
- `check`/`change(project, new path, move_folder)`: verify same repo (has the tasks' worktrees, or shares a root commit, or has a task branch) or move the folder (`rename`; refused across filesystems, into itself, while agents run, when other projects live in it); rewrite tasks' `worktree_path`; `git worktree repair`; fix `.git`/`gitdir` links and submodule links by hand; `relink` folder links; copy Claude session transcripts (`<config>/projects/<cwd with non-alnum → ->/<session>.jsonl` and its folder) to the new cwd's folder.
- `fingerprint` = sorted root commits (`rev-list --max-parents=0 HEAD`), `"git"` for a repo without commits, `""` for a non-repo; stored in `projects.repo_root`; rechecked hourly until it is a history.
- `Moving`/`Holding`/`settled`: a move waits for setups, setups and launches wait for a move.

### 2.21 Adding a project from GitHub (`integrations/github.ts`) — not PR-related
- List/search repos the account can reach (`gh api user/repos` 3 pages of 100, GraphQL `repositoriesContributedTo`, `search/repositories` ≤ 50; owners cached 5 min), `gh repo clone` (1 h limit, process group, failed clone removed), `gh repo create --source --remote origin [--push]` (15 min) with rollback, per-folder lock.

## 3. Data

### 3.1 Task fields this area owns (table `tasks`; JSON columns marked)
| field | meaning |
|---|---|
| `use_worktree` bool | task wants its own worktree |
| `worktree_state` | `none|setting_up|ready|tearing_down|error`; `worktree_error` text |
| `worktree_path`, `branch`, `base_branch` | set by setup; `base_branch` is rewritten by restack / retarget |
| `start_from` JSON | `{type:"branch",branch}` \| `{type:"task",task_id}` \| `{type:"pull_request",number,repo?}` \| `{type:"commit",commit}`; mutually exclusive with a user-set `base_branch`; fixed once the branch exists |
| `merges_into` | task id; kept after done and after the target is deleted |
| `carries` JSON | `{key, commit}`: branch may hold a closed parent's commits |
| `restack` | `due|conflict|null` (cleared when done) |
| `github_stack` | number of the GitHub stack its PR is in |
| `stack_title`, `stack_description`, `stack_pinned` (+ hidden `stack_input`) | on the stack's bottom task only |
| `stack_run` | id of a whole-stack merge run |
| `merging` bool | in the merge (queued when not running and in ready_for_merge) |
| `remerge` bool | stepped out; rejoins the queue's end when its run ends |
| `merge_approval` | `pending|approved|null` |
| `attention_reason` | includes held/approval/review reasons above |
| `pr_url`, `preview_url`, `pr_checks` JSON | PR link, preview link, last-read checks `{url, head, outcome, failed[], more_failed, pending, passed, since}` |
| `review` JSON | `Review` below |
| `summary` JSON | list of `ChangeSummary` (API also sends first as `summary`) |
| `rewind` JSON | `{turn, message_id, session, resume_at?, before_turn?}` |
| `fanout_id` | shared by tasks made from one prompt |
| `kind=review` rows | review threads (`task_type` null), summary threads (`summary`), workflow steps (`workflow`); `parent_id` = reviewed task; `description` of a summary thread = variant key |

`Review`: `{thread_id (first reviewer), state: running|passed|issues|failed|stopped, head, summary, issues[], fixes, extra_rounds, updated_at, started_at?, reviewers: ReviewerRun[]}`; `ReviewerRun`: `{thread_id, label, state, summary, issues[], verdict? ("pass"|"issues", only while running), after_run? (thread's last run id before this round)}`.
`ChangeSummary`: `{thread_id, label, name?, skills?, custom_prompt?, state: running|done|failed|stopped, head, text, after_run?, updated_at}`.
`is_merged(task)` = `status=done` and resolution null or `done`.

### 3.2 Project fields used
`repo_path`, `worktrees_root`, `scratch_path`, `base_branch`, `key`, `former_keys`, `use_worktrees`, `setup_script`, `teardown_script`, `copy_files`, `link_folders`, `status_script`, `status_scripts`, `auto_review`, `review_rounds` (default 2), `reviewers[]`, `auto_summary`, `summarizers[]` (+legacy `summarizer`), `review_prompt`, `merge_prompt`, `merge_approval?`, `require_pr_approval?`, `pull_requests`, `subproject_pull_requests`, `done_when_merged` (default on), `watch_pull_requests`, `pr_preview_url`, `github_account`, `use_workflows`, `repo_root` (hidden fingerprint), `is_git`/`has_commits` (computed), `setup_task_id`. Profile: `reviewers`, `summarizers`, `merge_approval`, `require_pr_approval`, `github_account`.
`Reviewer`: `{claude_config_id|null, model|null, effort|null, name?, skills?, prompt?}`.

### 3.3 Tables
- `checkpoints(task_id, n, kind start|turn|rewind, sha, tree, head, before_n, run_id, turn, message_id, status, session, agent_at, stats JSON {files, additions, deletions, excluded[≤200], excluded_count}, stale 0|1|2, created_at)` PK (task_id, n), cascade on task delete.
- `pr_states(task_id, pr_url, state open|merged|closed, updated_at)` PK (task_id, pr_url).
- `review_stats(id, task_id, thread_id, round, run_id, at, verdict pass|issues, serious, minor nullable, minor_noted, label, effort)`.
- `pr_watches(task_id, pr, state JSON, updated_at)` (owned by pr_watch; what the agent has been told).
- `runs` columns read here: `kind` (prompt|review|compact), `turn_message_id`, `agent_at`, `finished`, `effort`, `status`, `attention`.
- Settings key read: `default_effort`.

### 3.4 On disk / in git
- Worktrees: `<worktrees_root>/<name>` (default `<data-dir>/projects/<project id>/worktrees/…`).
- Refs in the project repo: `refs/heads/ia/<key>-<name>`, `refs/huntaway/start/<task id>`, `refs/huntaway/checkpoints/<task id>/<n>`.
- Git config: `branch.<b>.gh-merge-base`.
- `<common git dir>/info/exclude` lines for linked folders; `<worktree git dir>/huntaway-links`; scratch `<git dir>/huntaway-checkpoint-<uuid>.index`; temp `<tmp>/huntaway-restack-XXXX/wt`.
- Task temp folders `<tmp>/ha-<fnv1a(data dir) 8 hex>/<first 12 alnum of task id>` (owned by `agent/task_tmp.ts`; shared with the task's review threads; removed when done+idle, on delete, sweep every 10 min).

## 4. In-memory state

| state | purpose | across restart |
|---|---|---|
| `SETUPS` map task → mutex+users (`setup.ts`) | one setup/teardown/remove/restack per task | none needed; `setting_up`/`tearing_down` left in DB are not repaired here |
| `relocating.moving` set, `holds` counts (`relocate.ts`) | folder move vs setups/launches | none |
| `QUEUES` per task promise chain (`checkpoints.ts`) | order captures, rewinds, forget | lost; a missed turn checkpoint just isn't there |
| `RESTACKING` per task, `CHAINS` per repo (`restack.ts`) | serialise restacks; launches wait | `tasks.restack='due'` → `resume_restacks` at startup |
| `TRIED` map, link `CHAIN` (`gh_stack.ts`) | one GitHub link attempt per PR pair, serial | forgotten; `link_all_github_stacks` at startup retries |
| `STARTING` mutexes in `review.ts` and `summary.ts` | one review/summary start at a time (global) | DB `review.state=running` persists; orphaned reviewer runs are handled by the runner's restart logic |
| `PICKING` mutex (`fanout.ts`) | one pick at a time | none |
| `failing` map, timer (`merged.ts`) | log a repeated read failure once | `pr_states` persists the acted-on state |
| `KNOWN` owners cache (5 min), `FOLDERS` locks (`integrations/github.ts`) | repo search, clone reservation | none |
| status script `QUEUES` | per-task script order | lost |
Merge queue has **no** in-memory state: it is recomputed from task rows each time (`merging`, `running`, `status`, `position`, `merge_approval`, `stack_run`).

## 5. Outside the process

- `git` (everything above); notable flags: `worktree add [--no-track -b]`, `worktree remove [--force]`, `worktree prune|repair|list --porcelain`, `fetch --quiet --no-tags [--no-write-fetch-head]`, `push --force-with-lease=… --no-verify`, `push <remote> --delete`, `update-ref [-d|--stdin]`, `commit-tree`, `write-tree`, `read-tree`, `checkout-index -f -z --stdin`, `check-ignore`, `hash-object --stdin-paths`, `apply`, `stash`, `reset`, `rebase --onto`.
- `gh`: `pr view … --json …`, `pr edit --base`, `pr close`, `api repos/O/R/pulls/N`, `api -X POST repos/O/R/stacks[/N/add|/N/unstack]`, `api graphql` (via pr_watch), `repo clone`, `repo create`, `config get git_protocol`, `auth token --user` (via `GhEnv`). Always with `GH_PROMPT_DISABLED=1`, usually `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`; per-account env applied by `GhEnv.apply` and dropped after. Timeouts 30 s (`gh_json`), 60 s (api/edit/close), 5 s (unmerged check).
- `ssh -G -- <host>` (5 s) to resolve host aliases; `bash -c` for scripts.
- HTTP: `fetch(preview url)` 5 s for `/preview-status`.
- Env read: `VITEST` (test mode), `CLAUDE_CONFIG_DIR` (session copy fallback), process env passed through; env cleared for checkpoint git: `GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR, GIT_NAMESPACE`. Env set for scripts: `IA_*` above.
- No file watchers, sockets or ports of its own.

## 6. Background work

- `merged.start`: first read 30 s after start, then every 180 s after each pass finishes; ≤ 50 PRs/query.
- `relocate.start_recording`: fingerprints now and hourly.
- Restack: wait for GitHub ≤ 90 s, poll 3 s; rebase ≤ 5 min; push ≤ 120 s; fetch ≤ 60 s.
- Scripts: setup/teardown 30 min; status scripts 5 min.
- Fan-out pick: wait ≤ 20 s (2 s in tests) for agents to stop, poll 200 ms.
- Stack title: debounce 5 s, resume pass 60 s after start.
- Startup (`agent/runner.ts`): `start_queued_merges`, `start_unblocked`, `resume_restacks`, `link_all_github_stacks`, `stack_title.resume`.
- Neighbours: in-review PR watch (tick 15 s, read each PR every 120 s, backoff ×2^n to ×10, gives a warning after 5 failures, at most 10 comment-only wakes in a row); temp-folder sweep 10 min.

## 7. Surface

HTTP (all under the API prefix):
- `POST /tasks/{id}/worktree/setup` — 409 if an agent/reviewer is in it; 400 on failure.
- `POST /tasks/{id}/worktree/teardown {force?, delete_branch?}` — 409 with the reason (uncommitted list ≤ 2000 chars).
- `POST /projects/{id}/remove-merged-worktrees` → `{results:[MergedWorktreeResult]}`.
- `GET /projects/{id}/branches` → `{branches:[{name, remote}]}`.
- `POST /projects/{id}/setup-thread {message?}` — task without worktree that readies the folder.
- `GET /tasks/{id}/diff` → `DiffResult {available, reason?, dir, base, merge_base, commits, stat, patch, untracked[], branch?}`.
- `GET /tasks/{id}/unmerged` → `{unmerged}`.
- `GET /tasks/{id}/git`, `GET …/git/diff?path=&staged=&untracked=`, `GET …/git/show?rev=&stash=`, `POST …/git/stage|unstage {paths}`, `…/git/discard {paths, staged}`, `…/git/apply {patch, cached, reverse}`, `…/git/commit {message, amend, reword}` → `{ok, head}`, `…/git/stash {action, mode?, message?, index?, sha?}`, `…/git/reset {rev, mode}`.
- `GET /tasks/{id}/turns`, `GET /tasks/{id}/turns/diff?from=&to=`, `POST /tasks/{id}/rewind {message_id, conversation, branch}`, `DELETE /tasks/{id}/rewind`.
- `POST /tasks/{id}/review`, `POST /tasks/{id}/review/extend`, `POST /tasks/{id}/summary`, `POST /tasks/{id}/stop` (also stops review/summaries).
- `POST /tasks/{id}/fix_checks` (pr_watch).
- `GET /tasks/{id}/fanout`, `POST /tasks/{id}/fanout/pick`.
- `POST /tasks/{id}/merge-target {to: "onward"|"close"|<task id>}` → `{tasks}`.
- `POST /tasks/{id}/merge-stack` → `{tasks}` (409 lists why not).
- `PATCH /tasks/{id}/stack {title?, description?, regenerate?}`.
- `PATCH /tasks/{id}` fields handled here: `status` (ready_for_merge/done rules), `remerge`, `merges_into`, `start_from`, `base_branch`, `use_worktree`, `pr_url`, `preview_url`, `resolution`. `DELETE /tasks/{id}?delete_branch=`.
- `GET /preview-status?url=`; `GET /default-prompts`.
- Merge approval is answered through the questions endpoint (`POST /tasks/{id}/questions/{message id}` with choice `Approve`/`Deny`).

Websocket/events: see §8. MCP tools: `submit_review` (review threads only), `finish_work`, and the board's `update_task`/`create_task` fields `status`, `remerge`, `pr_url`, `preview_url`, `merges_into`, `start_from`; the `gh` server's `pr_merge` consults `merge_gate.blocked`. CLI: `huntaway gh-hook` uses `runs_program`. No CLI subcommands of its own.

## 8. Events

Emits:
- `{type:"task", task}` on every task update (via `state.update_task`); `{type:"task_deleted", id, project_id}`; `{type:"project", project}`; `{type:"checkpoints", task_id}` after a turn checkpoint or rewind.
- Thread messages: `event` `{level: info|warn|error, text, detail}` for every step named above; `question` approval card; `user` messages with `auto:true` (merge request, restack request, approval summary request), `review_round:n` (fix rounds), sent with run kind `prompt`; review/summary prompts with run kind `review`.
- Telemetry: `merge` (`outcome: requested|merged`), `review` (per submission), `task_status`.
Consumes (direct calls, not a bus): task entered `in_review` (`on_in_review`); a `prompt` run started on a task (`supersede`); a run ended (`review.finished` / `summary.finished` / merge handling / `find_pr` / `keep_starts` / `schedule_restack`); a turn ended (`after_turn`); run launch (`setup`, `before_run`, `pending_rewind`, `restack_settled`, `relocate.settled`); task done/closed/deleted (`restack_stacked_on`, `on_task_changed`, `unstack`, `follow_deleted`, `forget_start`); `pr_url` set (`link_github_stacks`, preview). The `wait` tool observes `Review.updated_at`.

## 9. Invariants and hard-won rules

- **Save branch facts immediately.** `worktree_path/branch/base_branch` are stored as soon as git makes them "so a setup script that fails (or a restart meanwhile) doesn't lose where the branch started" (`setup.ts`); `start_from` only counts while the branch doesn't exist.
- **Never adopt someone else's folder or branch**: a folder in the way must be this task's worktree; a name-clashing branch with no worktree belongs to another task (`setup.ts`).
- **New branches don't track** what they start from (`--no-track`); the server only force-pushes a branch whose upstream is its *own name* (restack, fan-out delete) — "an upstream the agent set to another branch … isn't force-pushed".
- **Start from the newest base even if local can't fast-forward**; diverged → upstream (where the PR goes); ahead → local (`upstream.ts`).
- **Removal never loses work**: uncommitted check sees through `assume-unchanged`/`skip-worktree` and submodules; detached-HEAD-only commits block removal; non-forced teardown re-checks after the teardown script and lets plain `git worktree remove` have the last word; hand deletion only inside `worktrees_root` and never a main checkout (`remove.ts`).
- **`remove_if_merged` re-checks `busy()` after fetching** ("fetching takes a while").
- **Squash merges**: merged detection also accepts "HEAD is the head of the branch's merged PR"; a stack level's own work is defined by `refs/huntaway/start/<id>`, not by merge-base with a parent that may be squashed or deleted; the ref is advanced as the level merges the parent in (`changes.ts`).
- **Checkpoint index mtime (HA-237)**: the scratch index copy keeps the original's mtime (to the second) or git treats racily-modified files as unchanged (`checkpoints/git.ts`). HEAD is read before the files. Checkpoints never touch the real index, branch or stash; git env vars are cleared.
- **Polling must not take the index lock**: `GIT_OPTIONAL_LOCKS=0` in git_view and checkpoints.
- **Non-UTF-8 diffs are never turned into patches** (would write U+FFFD back) (`git_view.ts`); stash ops verify `index`+`sha`.
- **Rewind checks everything before changing anything**, keeps the current files as a checkpoint first, and `checkout-index -f` is only used where `safe_to_write` says nothing else would be destroyed.
- **Review start races** (`review.ts`): read `last_run` *before* checking that the agent isn't running; after reading git, re-check `later_run`/running before recording the review, "so this one would [not] review work that's changing"; once recorded, a starting run finds it and stops it. Moving to `in_review` afterwards is conditional on no later run.
- **Late reviewer runs**: `after_run` on each part/summary makes a previous round's late `submit_review` or run end a no-op (409 "the review this run was asked for has ended").
- **A verdict is only acted on when the reviewer's run ends**, and only once every reviewer has ended.
- **No-commit branches** (work done in another repo): HEAD never changes, so an `issues` review is re-run after fixes, and automatic review needs evidence of code changes.
- **Issues go back only if the task still waits in `in_review` and is idle**; otherwise they're left as an event.
- **Merge queue is derived state and `start_next_merge` is synchronous**, so two calls can't both take a slot (Rust had a `MERGE_SLOT` lock). Status changes use `update_task_if` with a re-check (`still`) so two requests can't both pass.
- **A merge waiting on the user holds its lane**; an approval wait and a stack level waiting for the one below do not.
- **Held merges leave the queue** when flagged or at run end so they don't hold a lane they're no longer in (`output.ts`).
- **`merges` detection in the gh server errs on refusing** (any `api` call mentioning "merge" or reading a body from a file) while approval is pending.
- **Restack**: never while an agent/reviewer is in the worktree (checked at start, after GitHub wait, after rebase); never over remote commits that aren't local; lease on the remote head it read; hooks disabled ("the agent's checks of its own work, not the board's to run"); never pushes its own rebase over GitHub's; a run doesn't launch mid-restack.
- **GitHub stacks are single chains**, refuse base changes and legacy merges; a new stack's bottom must have a base the board never changes; unstacking one PR unstacks the whole stack.
- **Merged-on-GitHub acts once per state change** (`pr_states`), never as another GitHub account, and stores the state only after acting so a blocked move is retried.
- **`changed_elsewhere` reads commands, not effects**: scripts writing files from code aren't seen; accepted, *Review now* covers it.
- **Link folders**: git doesn't treat a symlink as a folder, so `name/` ignore patterns don't hide the link — hence `info/exclude`; `exclude` reads and appends without awaiting so concurrent setups don't lose lines.
- **Fan-out pick order**: worktree first, then pushed branch, then local branch, so anything that fails can be redone by picking again; a PR kept open keeps its branch.
- **Relocation**: older `git worktree repair` leaves stale links that still resolve through a symlink, so links are also fixed by hand; transcripts are copied asynchronously (can be gigabytes).

## 10. How it is tested

- Vitest (`VITEST` → `IN_TEST`): real git repos in temp dirs; helpers `testing/git.ts`, `testing/board.ts` (`git_project`, `reload`), `testing/stacks.ts` (`remote_project` with a bare `origin`, `level`, squash-merge as GitHub does, wait for restacks via `restack_settled`/`is_restacking`).
- Seams: `pr_testing.GH` (fake gh binary path), `remote_testing.SSH_CONFIG`, `changes_testing.diff_read`, `restack_testing.reached(point, task)`, `gh_stack_testing.{wait_ms, poll_ms}`, `gh_mcp.merge_testing`, `merged.set_fake(fn)` and `pr_watch.fake/fake_pages/response` (fake GraphQL), `checkpoints.caps.checkpoints`, `checkpoints.settled`, `github_links_settled`, `stack_title.TEST`, `util.reached("review:last-run" | "review:recording" | "review:reviewer-started" | "finish:…")` race hooks; in tests gh API calls are refused unless a fake gh is given, and temp folders live in the data dir.
- Test files: `git/worktree/tests.test.ts`, `approval_tests.test.ts`, `git/checkpoints/tests.test.ts`, `git/git_view/tests.test.ts`, `git/changes/tests.test.ts`, `git/relocate/tests.test.ts`, `git/worktree_files.test.ts`, `review/*.test.ts`, `api/stack_merge.test.ts`, `api/stacks.test.ts`, `api/incoming.test.ts`, `integrations/github.test.ts`.

## 11. Dependencies

Calls: db (tasks, projects, profiles, runs, messages), `state.update_task[_if]`, `add_event`, `add_message`, `emit`; runner (`send_as`, `send_review`, `send_fixes`, `stop`, `abort`, `start_next_merge`, `start_unblocked`, `task_gh_env`, `task_github_account`, `key_prefix`); `agent/runs.can_run_agents`, `agent_env`; `agent/context.clear`; `agent/prompts`; `agent/documents` (doc-only tasks); `agent/leftovers`, `agent/task_tmp`; `hosts/terminal.kill_all`; `mcp/gh_mcp` (accounts, `authenticate_fetch`), `mcp/pr_watch` (Target parsing, GraphQL, checks), `mcp/questions`, `mcp/permissions`; `threads/history` (user replies, tool calls since, last assistant text, said-since-asked); `integrations/workflows` (replace review/summary when `use_workflows`, merge handoff); `telemetry`.
Called by: runner launch/output/send, `api/tasks.ts`, `api/thread.ts`, `api/projects.ts` (settings validation, relocation, project delete), `api/new_task.ts`, MCP tool dispatch (`submit_review`, `update_task`, project approvals), analytics (*Reclaim space*), `serve.ts` startup, workflows engine (`send_fixes`, `send_review`).

## 12. Rewrite notes

Essential:
- The agent merges; the server only queues, gates, restacks and observes. "Merged" = the task is `done` with resolution `done` (set by the agent, the user, or the GitHub poll).
- The three custom ref namespaces, the lane/slot rules, `task_base` resolution, the review round state machine and the removal safety checks.

Accidental / candidates to simplify:
- Rust-port shape: snake_case, `Removal = {Removed}|{Kept}` serde enum, `drop()` guards, `[a,b]` tuples, hand-written axum-style 422 messages, `lines()`/`splitn` helpers, field-order-preserving `order()` in summaries, latin1-string byte paths.
- Former name: branch prefix `ia/`, env `IA_*`, temp `ha-…`, tmux `ia-…`; refs already use `huntaway`. Existing branches/worktrees depend on `ia/<key>-…` for folder naming.
- Legacy subprojects (`subproject`, `parent_id` lane, `subproject_pull_requests`, `sync_subproject`) are frozen: no new ones, existing must keep working — decide whether to carry them.
- Compatibility shims: `Review` without `reviewers` (`with_parts`), `summary` vs `summaries`, `summarizer` vs `summarizers`, parts without `after_run`, reviews without `started_at` (`run_round`), review-stats backfills, git < 2.32 / < 2.36 fallbacks.
- Merge state is spread over six task columns (`merging`, `remerge`, `merge_approval`, `stack_run`, `restack`, `status`) plus rules in `db.update_task`; an explicit merge state machine would be clearer, but every transition above must survive.
- Review and summary share most of their thread/round machinery but are two copies; reviewer threads are full `tasks` rows of `kind=review`.
- `changes.ts` is a ~750-line shell parser serving a heuristic and the gh hook.
- Global mutexes (`STARTING`, `PICKING`) serialise unrelated tasks.
- `worktree_state` stuck in `setting_up`/`tearing_down` after a crash isn't repaired here.
- `integrations/github.ts` is project creation, not PR handling; PR reading lives in `mcp/pr_watch`, which this area leans on heavily.
