# T3 Code and Huntaway compared

Built on the two inventories: [t3code-overview.md](t3code-overview.md) (T3 Code v0.1.5, commit `9b1d351`)
and [huntaway-features.md](huntaway-features.md) (Huntaway at `90bb99b`, API 61). Each fact here is cited
in those files and the detail files they link.

## The difference

**T3 Code is a control surface for agent conversations. Huntaway is a workflow engine for agent tasks.**

In T3 Code the unit of work is a **thread**: one conversation with one agent, which you open, steer, rewind,
fork, hand to another provider, and eventually *settle*. It puts a great deal of tooling around that
conversation: per-turn checkpoints, a diff pane, a pull request review UI for seven code hosts, a built-in
browser, simulators, files and a terminal. And it lets you reach it from anywhere: many machines in one
client, a relay, iOS and Android apps with push notifications. The person drives each thread. The work ends
when its pull request merges on the code host, and T3 Code notices and settles the thread.

In Huntaway the unit of work is a **task card** on a kanban board: a thread together with its own worktree,
branch, review and merge. The board itself carries the work forward. A finished run moves the card to
*In review*, which starts reviewer agents. Serious findings go back to the agent for a round of fixes. *Ready
for merge* has the agent merge the work, one task at a time per project, and dependent tasks then start
on their own. Agents create and coordinate other tasks through the board's tools (subprojects, group
tasks, plans). The person supervises at the level of columns and approvals rather than turns.

So T3 Code makes **one person driving many agent conversations** faster and more capable, on more agents,
from more devices. Huntaway makes **agents carry many tasks to a merge** with less driving, inside a
self-hosted pipeline with gates.

## At a glance

| | T3 Code | Huntaway |
|---|---|---|
| Unit of work | Thread (a conversation) | Task card (thread + worktree + branch + review + merge) |
| Main view | Thread list in sections, one thread open, panels beside it | Kanban or list boards per project, group, subproject and profile |
| What moves work on | You: send, review the PR, merge on the code host; a merged PR settles the thread | The board: automatic columns, reviewer agents, fix rounds, a merge agent, dependencies |
| Agent runtimes | 10 drivers (Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Pi, Muse, fx) plus any ACP agent | Claude Code and Codex |
| Where an agent works | The project's checkout by default; a worktree if chosen; worktrees can be shared | Its own worktree and branch by default |
| Default permission mode | Full access | Ask (the host's default, changeable) |
| Server restart | Agents are stopped and threads resumed with "Continue where you left off." | Agents keep running under `ia-shim`; the new server picks their output up where it left off |
| Review | Human review UI for PRs (comments, verdicts, viewed files); model-written review guides (beta) | Up to six reviewer agents per project review every task automatically, with fix rounds |
| Merge | On the code host from T3's PR view: merge methods, auto-merge, stacks | The task's agent merges in *Ready for merge*; one merge at a time per project |
| Agents driving agents | `delegate_task` to any provider/model, `create_threads`, thread send/wait, `schedule_task`; ~65 MCP tools | `create_task`, `send_to_task`, `wait`, dependencies, subprojects, group tasks; 13 board tools plus a `gh` server |
| Triggers | Schedules, webhooks, PR watches that wake an agent | Column moves (status scripts), dependencies, `wait` on tasks or a shell command |
| Rewind and fork | Per-turn checkpoints, *Edit from here* with file restore, fork and merge back, switch provider mid-thread | None |
| Code hosts | GitHub, GitLab, Forgejo/Gitea, Bitbucket, Azure DevOps, GitCafe | GitHub (through `gh`, with per-profile accounts) |
| Workspace tools | Terminal, built-in browser with agent automation, simulators, file viewer and editor | Terminal (tmux), terminal tools (`lazygit`, `nvim`…) |
| Documents | Proposed-plan cards; visual HTML replies in the thread | Plan, artifact and diagram tasks with versions and answerable questions |
| Multi-machine | One client connects to many servers by LAN, Tailscale, SSH or the T3 Connect relay; linked environments (beta) | Hosts link to a hub (outbound, dial-in or SSH) into one board; board tools reach every host |
| Clients | Web (hosted or local), desktop, iOS, Android | Web, Electron |
| Notifications | Browser and desktop alerts with sound (off by default), dock badge, mobile push, Live Activities | None (status scripts can send them) |
| Separation of contexts | Provider instances (accounts) | Profiles (work/personal) with their own projects, logins, GitHub accounts, boards |
| Insight | Token, cost and limit history across providers and machines | Plan limits, cost per task, time-tracking report and calendar, disk usage |
| Access control | Scoped, revocable pairing sessions; OAuth for outside agents; guest links | One token per host |
| Install and update | Installers and packages, background service, staged updates with rollback, *Update everything* | Built from source; *Rebuild & restart* and *Update to <commit>* from the board |
| Telemetry | Product analytics on by default (opt-out) | None |
| Maturity | v0.1.5 "Beta", "over 500,000 users" claimed, very fast-moving, contributions mostly refused | Single-user self-hosted tool, API version 61, developed through its own board |

## Area by area

### Agents and providers

- **Both** run the user's own Claude Code and Codex logins, with several accounts each (T3's provider
  instances, Huntaway's agent configs), model and effort per thread, steering, plan mode, approvals in the
  thread, native subagents shown as rows or child threads, compaction and plan-limit usage.
- **T3 Code only**: eight more agents and the ACP Registry; a capability system with fallbacks; switching
  provider mid-thread with a budgeted handoff; forks with merge-back; a model manifest updated between
  releases; a fallback model when usage runs out; *Resume at reset* for limited threads; `/goal`;
  structured question and plan cards; force stop; a provider install, update and sign-in flow in the app;
  importing past Claude, Codex and Pi conversations.
- **Huntaway only**: six permission modes, *Plan* and *Don't ask* among them (T3 Code has four, with plan
  as a separate mode), set per host, project and thread; skills and MCP servers managed on the host per profile and project, including turning off ones
  that come from plugins or the repository; prompts per column; idle compaction while the prompt cache is
  warm (T3 has the same as a beta option); titles that follow your later messages unless pinned; a
  `/context` breakdown.

### Organising work

- **T3 Code**: threads in *Pinned / Active / Working / Snoozed / Settled*, with unread state synced
  between devices, snooze, auto-settle, multi-select bulk actions, search through message text and a
  command palette. Projects can be grouped across machines. There is no board, no task dependencies and
  no notion of a task's stage beyond the thread's live status.
- **Huntaway**: boards with seven columns, drag and drop, search, filters and sorts; stars and reminders;
  project groups; a board per profile across projects and hosts; task kinds (code, subproject, group task,
  scratch, plan, artifact, diagram); dependencies; archiving. A token-driven new-task dialog (`/plan`,
  `@KEY`, `!model`, `^effort`, `#IA-3`).
- **Both** fan one prompt out to several models, each in its own worktree. Huntaway's README credits T3
  Code for this.

### The lifecycle: review, merge and dependencies

This is where the two differ most.

- **Huntaway** has gates. *In review* runs reviewer agents read-only on the branch, and their serious
  findings go back to the task's agent for a round of fixes, up to a set number of rounds. *Ready for
  merge* asks the agent to merge, queued one at a time per project and subproject. *Done* releases
  dependent tasks. Status scripts run on every column change.
- **T3 Code** has no review or merge stage of its own. Review is a person using its PR UI, or an agent
  asked to review. Merging happens on the code host: merge methods, auto-merge, stacks, merge queues.
  What it adds instead: PR watches that wake the agent when checks fail, comments arrive or the branch
  conflicts; *Fix in a thread* and *Resolve conflicts* buttons; review guides; and auto-settle once the PR
  merges.

### Agents driving agents

- **Both** give every agent an MCP server to create and message other units of work and to wait for them
  rather than poll, and both stop children when the parent is stopped.
- **T3 Code**'s tools are broader: delegation to *another provider and model* (a Claude agent can hand a
  task to Codex) with wake-on-completion, a cap that children never get more permission than the parent,
  thread forks and transfers, scheduling, PR watching, browser and device control, secret requests, and
  cross-machine delegation (beta). Outside agents (Claude Code, Codex, ChatGPT) can drive T3 over OAuth MCP,
  and `t3 thread` does it from a shell.
- **Huntaway**'s tools are about the board: tasks with dependencies, subprojects whose agent plans and
  merges a branch of tasks, group tasks across projects, cross-profile access (off by default, one way),
  `wait` on tasks or any shell command (`gh pr checks --watch`), and approval dialogs for project changes and
  deletions whatever the thread's mode. A Huntaway task carries its own worktree, review and merge, so
  what an agent creates is a full unit of work rather than a conversation.

### Conversation control

- **T3 Code**: queue or steer (choosable default) with an editable, reorderable server-side queue;
  *Edit from here* rewinds the conversation, and the files too in a worktree; fork from any response;
  citations of assistant text; prompt recall and a prompt stash; *Run in terminal* on code blocks.
- **Huntaway**: steering by default, a queued message you can take back, Stop as an interrupt. No rewind,
  fork, copy, retry or edit-and-resend.

### Git and code hosts

- **Both** create worktrees from the latest base branch (fetched first), run setup scripts, clean up merged
  worktrees safely while keeping branches, find a task's PR, and use per-account GitHub credentials
  (GitHub Enterprise too).
- **T3 Code only**: per-turn checkpoints and diffs; a rich diff pane (split view, file tree, find, comments
  sent to the agent); commit, push and PR from the UI with model-written messages; a PR list and review UI;
  seven code hosts; branch names chosen by a model; submodule handling and visible setup progress.
- **Huntaway only**: worktrees on by default per task; teardown scripts; status scripts per column; a `gh` MCP
  server that runs outside the agent's sandbox, with a hook that keeps agents off `gh` in Bash and a check
  that every call stays on the account's host; moving a project's repository folder without losing
  sessions.
- **Huntaway's diff view is minimal**: one cumulative diff, read-only, with no syntax highlighting.

### Workspace tools

- **T3 Code** puts a workspace around the thread: server-owned terminals with history, a browser agents can
  drive (Playwright-like tools, annotations sent back as context), iOS and Android simulators, a file
  viewer and editor, content search, *Open in* 20+ editors, window capture into the prompt.
- **Huntaway** has a tmux terminal per task that survives restarts, and terminal tools for TUI programs. It
  has no browser, files panel or editor integration; a preview URL is a dot on the card.

### Multi-machine and remote

- **T3 Code** puts the multi-machine view in the **client**: a web, desktop or mobile app connects directly
  to many servers, trying routes in order (LAN, Tailscale, SSH, relay). T3 Connect gives reachability from
  anywhere through Cloudflare tunnels, with a hosted account. It has load balancing of new threads,
  *Update everything* across machines, and machine-to-machine links for agents (beta).
- **Huntaway** puts it in the **hub**: hosts link to one board, and events from all of them arrive on one
  socket. A host can dial out (no inbound port) or be reached over SSH, so no hosted service is involved.
  Agents' board tools reach every host, profiles and configs merge by name, *Copy login* moves a config
  between machines, and the hub pushes updates to hosts as git bundles.

### Clients and attention

- **T3 Code**: hosted and local web, a polished desktop app (auto-update, deep links, badge), iOS and
  Android apps with nearly the full feature set, push notifications, Live Activities, widgets, an offline
  draft and queue, ~75 configurable shortcuts, light/dark themes with an editor, accessibility work.
- **Huntaway**: one web UI in a browser or a thin Electron window; dark theme only; no notifications, mobile
  layout or command palette. Attention is shown on the board: *Needs attention* column, amber counts in the
  sidebar, a working timer and the reason on each card.

### Operations

- **Restarts**: Huntaway's runs live outside the server, so restarts, rebuilds and updates don't interrupt
  agents; board tool calls and permission prompts survive too. T3 Code deliberately kills agents with the
  server (and makes the kernel kill agents before the server when memory runs out), then resumes threads.
- **Installing**: T3 Code has installers, packages for every platform, a managed background service and
  staged updates with rollback. Huntaway builds from a source checkout and rebuilds itself from the board.
- **Security**: T3 Code has scoped, revocable sessions, OAuth for outside agents, HTTPS through Tailscale or
  the relay, and guest links. Huntaway has one token per host over plain HTTP and leaves the network to you
  (Tailscale, a VPN or a TLS proxy).
- **Telemetry**: T3 Code sends product analytics by default (no prompts or content). Huntaway sends nothing
  anywhere.

### Insight

- **T3 Code**: a Usage page of tokens, cache savings and API-equivalent cost across every provider and
  machine, with custom prices, pooled subscription limits and reset credits.
- **Huntaway**: plan limits per config, cost per task and run (Claude only), and time tracking of your own
  prompting (report, calendar, CSV) for timesheets, plus disk usage per project.

## Where each is ahead

**Huntaway has what T3 Code lacks**
1. A board of tasks with stages, drag and drop, dependencies and a profile-wide view.
2. Automatic review by up to six reviewer agents, with fix rounds.
3. Agent merges with a per-project merge queue, and dependent tasks starting on merge.
4. Planning structures: subprojects that collect a branch of tasks, group tasks across repositories, plans
   that become tasks.
5. Agents that survive server restarts, rebuilds and updates mid-turn.
6. Status scripts on column changes, and `wait` on any shell command.
7. Profiles that keep work and personal apart, with one-way sharing between their boards.
8. Plan, artifact and diagram tasks: documents with versions and questions you answer in place.
9. Time tracking for timesheets.
10. Nothing hosted and no telemetry; a hub that needs no inbound ports.

**T3 Code has what Huntaway lacks**
1. Many more agents (Cursor, OpenCode, Gemini, Grok, Pi, ACP) and cross-provider delegation and switching.
2. Mobile apps, push notifications and reachability from anywhere.
3. Per-turn checkpoints with rewind, forks and merge-back.
4. A real diff and PR review UI across seven code hosts, with comments that go to the agent.
5. A built-in browser and simulators agents can drive, and a file viewer and editor.
6. Scheduled and webhook-triggered agent runs; PR watches that wake an agent.
7. Notifications, a command palette, configurable shortcuts, themes, structured question and plan cards,
   syntax highlighting.
8. Packaged installs, a background service and safe auto-updates.
9. Scoped access: pairing, OAuth for outside agents, guest links.

## Same idea, different choices

- **Worktrees**: on by default per task in Huntaway; off by default in T3 Code, where threads can also share
  one.
- **Permissions**: Huntaway starts at *Ask* and asks the user before agents change a project or delete a
  task, whatever the mode. T3 Code starts at *Full access* and caps what an agent's children and outside
  agents may do.
- **Restarts**: Huntaway keeps agents alive; T3 Code stops and resumes them.
- **Plans**: Huntaway makes a plan its own task, an HTML document that is versioned and answered in place.
  T3 Code shows a plan card in the thread, with *Implement* or *Implement in a new thread*.
- **Several machines**: Huntaway links hosts into one board through a hub. T3 Code links many servers in
  each client, and offers a relay.
- **Waiting**: Huntaway's `wait` takes tasks or any shell command. T3 Code has dedicated waits: thread
  waits, delegate wake-ups, PR watches, background-task waits.
- **Titles**: both generate them. Huntaway re-asks after each user message and keeps the title unless the
  goal changed. T3 Code generates once and lets you or the agent regenerate, with per-project instructions.
- **Fan-out**: the same in both: one prompt, one worktree per model.

## What Huntaway could take from T3 Code

Ordered by value to Huntaway's workflow against effort, as candidate follow-up tasks:

1. **Notifications** (small): browser notifications and sound when a task goes to *Needs attention* or *In
   review*, and a count in the tab title or favicon. Huntaway has none, and its model of leaving agents
   to work is exactly when you need them.
2. **Structured question and plan cards** (small to medium): render `request_user_input` with options,
   Claude's `AskUserQuestion` and `ExitPlanMode` as cards with buttons instead of JSON in a permission card or
   a free-text reply.
3. **A better Changes tab** (medium): syntax highlighting, a file tree, a split view, and line comments sent to
   the agent as a message (T3's review-comment chips). Reviews would also be easier to check by hand.
4. **PR watch for `wait`** (small): a built-in wait that ends on failed checks, new review comments or merge
   conflicts, not only on a command's exit.
5. **Scheduled and webhook-created tasks** (medium): a schedule or a GitHub webhook that creates and starts a
   task, so recurring work and issue triage land on the board.
6. **A mobile layout and push** (medium to large): a narrow layout for the board and task panel first, then
   web push or a PWA. T3 Code treats the phone as a main client.
7. **Per-turn checkpoints** (large): hidden-ref snapshots per turn would give turn diffs and an *Edit from
   here* rewind; they would also let reviewers see what each fix round changed.
8. **More runtimes through ACP** (large): one generic ACP adapter brings in many agents (Gemini/Antigravity,
   OpenCode, Cursor through adapters) without a bespoke runner for each.
9. **Polish**: syntax highlighting in the thread, images from tool results, a command palette, copy and retry
   on messages, a light theme.
10. **`request_secret`** (small): let an agent ask for a secret it never sees, instead of the user pasting
    it into the thread.

And what T3 Code might take from Huntaway: a board with stages, automatic reviewer gates, a merge queue,
task dependencies, and agents that survive the server.

## How this was gathered

- T3 Code was read from a shallow clone of `pingdotgg/t3code` at `9b1d351` (2026-10-30) by five research
  agents, one per area, from its `docs/` and source. Nothing in it was built or run, so behaviour is as
  documented or as read from code, not observed. Its docs say parts of the orchestration docs describe a
  target design. Features marked beta, alpha or Labs there are off by default.
- Huntaway was read from this repository's `README.md` and source by two agents (UI and server), and
  checked against the code for the claims the comparison rests on: no notifications, no structured
  question cards, the default permission mode, and the review and merge flow.
- Claims checked directly in T3 Code's source: the *Full access* default, the *local* checkout default,
  agents killed with the server and resumed with "Continue where you left off.", no task dependencies or
  board, and that its "review" service only serves diffs.
