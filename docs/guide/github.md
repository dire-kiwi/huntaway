# Pull requests and checks

## Pull requests

The board doesn't prompt the agent when its task goes to _In review_: that happens when its run
ends. Instead, an agent working on its own branch in a repository on GitHub is told up front
to open a pull request before it finishes, unless the project's own instructions (such as its
CLAUDE.md) say otherwise: commit, push the branch and open the PR into the task's base branch
(the branch of the task it merges into, for a task with `merges_into`, or the subproject's branch
for a subproject's task), or push to the PR the branch already has. A
task with no changes on its branch doesn't need one. The repository counts as on GitHub when the
remote it pushes to is on github.com: the base branch's upstream remote, or else `origin` (or the
only remote), by its push URL. The PR goes in the repository the branch is pushed to, which the
agent names with `gh pr create --repo … --head …`, since gh would otherwise pick one from the
remotes' fetch URLs (so a fork's PR goes into the fork, not its upstream). Agents in a worktree in other repositories are told not to push unless asked, and
tasks without a worktree (working in the repository's own checkout) don't open pull requests.

A project's settings can turn pull requests off (API 85), on its _Review_ tab: _Open a pull
request for each task_ (`pull_requests`) for its tasks, subprojects included, and _Open a pull
request for each task in a subproject_ (`subproject_pull_requests`) for its subprojects' tasks,
which are then merged into the subproject's branch without one. Both are on by default. An agent
whose task has them off is told not to push its branch or open one unless the user asks, even if
the project's own instructions say to.

A task can carry its pull request's URL, shown on its card as a pull request icon next to the
branch icon that links to it. Its agent can set it (`pr_url` via `update_task`), or set it under
Pull request in the task's sidebar. Otherwise, whenever a run of a task with a branch ends and
the task has none yet, the host looks it up with `gh pr view <branch>` (if `gh` is installed and
signed in; with `--repo` for the GitHub repository the branch is pushed to, as above), so a PR the
agent opened shows up without it saying so.

A pull request merged on GitHub (by you, or by auto-merge) rather than through _Ready for merge_
moves its task to _Done_ (API 68). Every 3 minutes the host reads the state of the pull requests
of its tasks in _In review_ or _Needs attention_, with one GraphQL query per GitHub account and
host, as each task's own account (see _GitHub accounts_; gh's active account when none is set).
When one is merged, its task moves to _Done_ (resolution `done`) as if you'd moved it there, its
thread says so, and its worktree is removed if nothing in it would be lost, as **Remove merged
worktrees** does (the thread says why when it's kept). When one is closed without being merged, a
task in _In review_ moves to _Needs attention_ saying so, and one already there gets a note in its
thread (its reason stays the agent's). Each happens once per change of state, so a task you move
back out of _Done_ stays where you put it. Tasks whose agent or reviewer is running, tasks being
merged, a subproject's tasks (its own merge brings them in) and a subproject with open tasks are
left alone. Turn it off for a project with _Move a task to Done when its pull request is merged on
GitHub_ in its settings (`done_when_merged`, on by default). An agent `wait`ing on its pull
request is told it was merged and marks the task done itself, as its project's instructions say;
if its run ends without doing so, the next read moves the task.

A project can have its tasks' pull requests watched while they're in _In review_ (_Watch pull
requests in review_ in its settings' Review tab, `watch_pull_requests`, API 72): every 2 minutes,
while the agent is idle, the host reads the pull request (as a `wait` does, with the same record of
what the agent has been told) and wakes the agent with failed checks and conflicts (`failures`),
or with comments and reviews from people who can push to the repository too (`all`).

## Failed checks

The reads above (a `wait` on a pull request, watching it in review, and the reads for _Done when
merged_, which also ask for the head commit's checks) keep how the task's pull request's checks
stood on the task (`pr_checks`, API 94, DB 74): the head commit, the outcome (`failed`, `passed`,
`pending` or `none`), the failed checks' names, conclusions and links, and how many passed and are
still running. It's only written when that changes. No reads are added for it, so a task whose
pull request isn't read by any of them (in _In progress_ without a `wait`, or in a project with
_Done when merged_ off and no watching) has none. While the latest read found failed checks, the
task's card shows a red mark next to its pull request icon (naming them in its tooltip), and its
sidebar lists them under Pull request, each linking to its run.

**Fix broken checks** there (`POST /tasks/{id}/fix_checks`) reads the pull request again, as the
task's GitHub account, and sends its agent the failed checks with the end of each GitHub Actions
job's failed steps' log (`gh run view --job <id> --log-failed`, for 5 jobs at most: the last 80
lines, up to 6,000 characters, without times, colours or grouping markers) inside
`<untrusted-data>` tags, asking it to fix them and push. It goes as your message (to the agent
while it works, or starting its turn, which moves the task to _In progress_), but the task isn't
re-titled from it, and those failures count as told, so watching the task in review doesn't wake
the agent with them again. With no failed checks on the head commit, it says so and sends
nothing. A wake for failed checks while the task is watched in review brings the same log ends.

## Preview URLs

A task can carry a preview URL (Preview in the task's sidebar, or `preview_url` via
`update_task`), for example its PR's preview deployment. While the task is _In review_, its card
shows a dot linking to it: yellow until the URL answers `200`, then green. The server the board
is served from checks it every 2 seconds while the board is visible.

A project whose pull requests get preview deployments can say where, under _Pull request
previews_ in its settings' Review tab (`pr_preview_url`, API 79), with `{pr}` for the pull
request's number, e.g. `https://pr{pr}.example.com/`. A task then gets its pull request's preview
as its preview URL whenever its pull request is set or found (see above), and saving the setting
fills it in for the project's tasks that already have one (except done tasks, whose previews are
gone). A preview URL set otherwise, by hand or by its agent, stays; one the setting made follows
the task's pull request, and a change to the setting.
