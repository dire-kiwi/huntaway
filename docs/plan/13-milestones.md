# 13. Milestones and tasks

The work as board tasks: one agent, one pull request, merged to `main` on its own. A task depends on the ones named;
tasks with no dependency between them run in parallel. Sizes are a guide for splitting, taken from the old code that
each task replaces (non-test lines).

## What every task is given

A task's description on the board says, in this order:

1. The pages of this plan to read: always [12-conventions.md](12-conventions.md), then the ones in its row.
2. The inventory sections that are its checklist, and the old source paths they describe
   (`dire-kiwi/huntaway` at `f2298f0c`, to be read for behaviour, not for structure).
3. The old test files whose cases it ports ([10-testing.md](10-testing.md)).
4. `node_modules/effect/AGENTS.md`, and `docs/plan/spike/` for the shapes that were run.

## What "done" means for every task

- Every capability in its inventory sections is implemented, or named in the pull request as dropped with the line of
  [14-dropped-and-open.md](14-dropped-and-open.md) that drops it.
- The old tests' cases are ported; each dropped case is named with its reason.
- `pnpm check` passes with no new suppression that is not explained in `docs/effect.md`. `pnpm test` passes.
- A task that adds an RPC adds it to the contract with its scope and errors, and to the group's handler file. A task
  that changes the schema adds a named migration.
- A task that touches the UI is looked at in a browser, and the `tests/ui` files for that feature pass.
- The pull request says what it did not verify.

## M0: foundation

Sequential. Nothing else starts before 0.3.

| Task | Does                                                                                                                                              | Needs | Read                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------- |
| 0.1  | The workspace: pnpm, Vite+, `tsconfig.base.json`, the strict lint config (run it on a file that breaks it, as the spike did), Oxfmt, CI (`tree`, `check`, `rust`, `green`), `CLAUDE.md`, `docs/effect.md`. `rust/shim` with its tests, and `apps/server/bin/huntaway`, copied from the old repository | —     | 02, 12, spike/lint  |
| 0.2  | `packages/shared` and `packages/contracts` (ids, time, errors, session and scopes, `PublicRpcs`, `host.info`). The platform: `ServerConfig`, `DataDir`, `Identity`, `Db`, `Migrations` and the initial schema, `Backup`, `Events`, `Changes`, `KeyedLock`, `Proc`, `Secrets`, logging. The HTTP edge and its rules; RPC over websocket and HTTP with `Auth`; `serve`, `token`, `--version`; ready line; shutdown | 0.1   | 02–06               |
| 0.3  | `packages/testing`: `TestBoard`, `board` builders, `git`. `scripts/test-server.sh`, `huntaway rpc`. The structural tests. The whole-server tier with one test: start through the launcher, call `public.health`, stop | 0.2   | 10, 12              |

## M1: a board without agents

| Task | Does                                                                                                                                              | Needs | Read; inventory                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------- |
| 1.1  | `HostSettings`, `Profiles`, `AgentConfigs` (without archives and usage) and their RPC groups                                                      | 0.3   | 03, 06; inv 02 §2.1, 07 §7.9    |
| 1.2  | `Projects`: create from a folder, keys and former keys, update, archive, delete; `projects.*`                                                     | 1.1   | 06; inv 07 §7.9                 |
| 1.3  | The task: the full wire struct and row schema, `TaskRepo`, `threadKindOf`, `tasks/decide.ts` (update, create, derived columns) as pure functions with the old cases, `Tasks`, `TaskRefs`, `tasks.list/get/create/update/delete` | 1.2   | 03, 04, 06; inv 07 §7.7–7.8, 09 §3b, §9 |
| 1.4  | `board.watch` with snapshot, replay and resync; `Reactor` and `Recovery` skeletons; `Dependencies`                                                 | 1.3   | 01, 05, 06                      |
| 1.5  | `packages/client`: sessions, `hostBoardAtom`, `boardAtom`, `applyBoardEvent`, optimistic moves. `apps/web/src/state/` (`useBoard`, `useRpc`, route, prefs, drafts). `fakeHost` for component checks | 1.4   | 09; inv 10 §4, §14, §15         |
| 1.6  | The web app boots on the new server: `main.tsx`, `App.tsx`, the token screen, step 1 for `ui/`, `layout/` and `board/`. `tests/ui` harness; the board's checks pass | 1.5   | 09; inv 10 §2.4, §2.8           |
| 1.7  | `Pens`, `Attachments`, the demo seed (`--demo`), `--open-token`                                                                                    | 1.3   | inv 02 §2.9, 07                 |

**Shows:** a board in the browser with projects, tasks, drag and drop, search and filters, live across two tabs.

## M2: threads and Claude runs

| Task | Does                                                                                                                                              | Needs      | Read; inventory                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------- |
| 2.1  | The thread protocol in the contracts: schemas, the reducer, windows and pages, with the old protocol tests and examples                            | 0.2        | 03; inv 08 §3.1–3.2              |
| 2.2  | `ThreadStore`, `Threads`, `ThreadReaders`; `threads.watch`, `page`; write numbers                                                                  | 2.1, 1.3   | 04, 07; inv 08                   |
| 2.3  | `RunDir`, `Shim`, `RunRepo`, `RunFollower`; `fakeAgent`; `fake-claude` ported                                                                      | 1.3        | 07; inv 01 §3, §5, §10           |
| 2.4  | `ClaudeDriver`: launch spec (checked against specs recorded from the old server), line schemas, the translator, against the 22 recorded sessions    | 2.2, 2.3   | 07; inv 01 §5, 08 §3.5           |
| 2.5  | `Prompts` (text copied word for word), `Runs.send`, `decideSend`, register and launch, steer, queue, stop, abort, `/new`, `/compact`; `tasks.send`, `stop`, `dropQueued` | 2.4        | 07; inv 01 §2, §9, 02 §3.6       |
| 2.6  | The end of a run: `decideFinish` with the old table's cases, the reactor's `RunExited`, re-attach at startup. Whole-server tests: restart under a running fake agent; a power-cut replay | 2.5, 1.4   | 07; inv 01 §9                    |
| 2.7  | `threadAtom`, the preview, older pages; step 1 for `task/` and `task/thread/`; the thread and composer checks pass                                 | 2.2, 1.6   | 09; inv 10 §2.5, 08              |
| 2.8  | `Titles`, `Usage`, `UsageWindow`, `Tokens`, `ContextMeter`, `Compaction`, `BackgroundWork`, `DevServers`, `TaskTmp`                                 | 2.6        | 07; inv 01 §2, 02 §2.2–2.3, §2.11 |

**Shows:** start a task with a real `claude`, watch the thread stream, steer it, stop it, restart the server under
it. **Measure** ([10-testing.md](10-testing.md#measurements)) before going on.

## M3: what agents ask

| Task | Does                                                                                                                                              | Needs      | Read; inventory          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| 3.1  | `ToolCalls` with at-most-once and resume; the control transport and the HTTP transport; the per-run secret                                         | 2.6        | 07; inv 03 §2.1–2.4      |
| 3.2  | Board tools, first set: the read tools, `create_task`, `update_task`, `send_to_task`, `request_user_input`, `finish_work`; `resolve.ts`; `Questions` | 3.1        | 07; inv 03 §2.3, §2.5    |
| 3.3  | `Permissions`: ask, answer, modes, plans, late answers, expiry and the sweeper; `permissions.*`; step 1 for the approval and question cards         | 3.1, 2.7   | 07; inv 03 §2.7          |
| 3.4  | `Approvals` and the tools that always ask (`create_project`, risky `update_project`, `delete_task`); the remaining board tools                     | 3.2, 3.3   | inv 03 §2.5–2.6          |
| 3.5  | `Wait`: tasks, messages, a command, stop, restart behaviour; `background_wait`                                                                     | 3.2        | 07; inv 03 §2.8          |
| 3.6  | `ApprovalRules`, the action log, `approval-hook` and `gh-hook` as plain entries, the import-graph test                                             | 3.3        | 06; inv 02 §2.6, 03 §2.13 |

## M4: git, GitHub, review, merge

| Task | Does                                                                                                                                              | Needs      | Read; inventory          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| 4.1  | `Git`, `Worktrees` (setup, ignored files, scripts, teardown, remove merged), `TaskBase`, `StatusScripts`                                           | 2.5        | 06; inv 04 §2.1–2.7      |
| 4.2  | `ChangesTab` and `git.*`; step 1 for `changes/`                                                                                                    | 4.1, 2.7   | inv 04 §2.8              |
| 4.3  | `Checkpoints` and rewind; `checkpoints.*`                                                                                                          | 4.1        | inv 04 §2.9              |
| 4.4  | `Gh` with account isolation and hardening; the `gh` server's 17 tools; `gh-run`                                                                    | 3.1, 4.1   | inv 03 §2.10             |
| 4.5  | `PullRequests`, `PrWatch`, waiting on a pull request, the in-review watcher, fix checks, `MergedWatcher`                                           | 4.4, 3.5   | inv 03 §2.9, 04 §2.11, §2.17 |
| 4.6  | `Reviews`, `Summaries`, `ReviewStats`, `submit_review`; the reactor's `ReviewFinished`; step 1 for the review views                                | 4.1, 3.2   | 06; inv 04 §2.12–2.13, §2.19 |
| 4.7  | `Merges` and `merge/decide.ts` with the lane cases, `MergeGate`, the merge prompts                                                                 | 4.5, 4.6   | 06; inv 04 §2.14–2.15    |
| 4.8  | Stacks: `merges_into`, `Restack`, `GhStacks`, whole-stack merges, choosing a merge target                                                          | 4.7        | inv 04 §2.16             |

**Shows:** a task goes from To do to Done on its own: worktree, agent, pull request, reviewers, a round of fixes,
merge. This is the point at which this repository's own work can move onto a board running the new server.

As checked in HE-5: `apps/server/tests/e2e/flow.test.ts` runs it on a whole server through the launcher, with the fake
agent and the fake GitHub: the worktree set up, the agent's commit, its pull request found as the run ends, a reviewer
that finds an issue, a round of fixes, a review that passes and a summary, then the move to Ready for merge, the merge
request to the task's own agent, its `gh pr merge` and `update_task` to Done. The same test runs the task with Codex
as its agent (the fake `codex app-server` under `codex-run`), its reviewer the fake claude. A real model was not used.

## M5: Codex

| Task | Does                                                                                           | Needs | Read; inventory          |
| ---- | ---------------------------------------------------------------------------------------------- | ----- | ------------------------ |
| 5.1  | `codex-run`, the adapter process                                                               | 2.3   | inv 01 §5 _Codex_        |
| 5.2  | `CodexDriver`: launch spec, permission-mode mapping, line schemas, the translator against the 20 recorded sessions, requests, the dynamic-tools transport | 5.1, 3.3 | 07; inv 01 §5, 08 §3.6, 03 §2.7 |
| 5.3  | Codex queries: models, skills, rate limits, titles; approval rules as server config            | 5.2   | inv 01 §2, 02            |

**Shows** (HE-5): the M4 flow with Codex as the task's agent (`tests/e2e/flow.test.ts`), and one run of a real
codex-cli on a test server (07-agents.md, Codex).

## M6: the rest of one host

Independent of each other unless said; all need M3, and the ones touching git need 4.1.

| Task | Does                                                                                               | Needs      | Inventory                |
| ---- | -------------------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| 6.1  | `Terminals`, `Pty`, the terminal socket; the Terminal tab                                          | 4.1        | 05 §2.5                  |
| 6.2  | `TaskDocuments`: plans, artifacts, diagrams, answers                                               | 2.6        | 02 §2.7                  |
| 6.3  | `Docs`, `DocImages`, the `docs` server, `HostedDocs`; step 1 for `docs/`                           | 3.1        | 02 §2.8, 03 §2.11        |
| 6.4  | `AgentTools`: skills, MCP servers, switches, sources, a task's skills                              | 2.5        | 02 §2.5                  |
| 6.5  | `Automations`, `Scheduler`, `Webhooks`, `Routines` and their tools                                 | 3.4        | 06 §2.3                  |
| 6.6  | `workflows/graph.ts` with the old cases, `WorkflowEngine`, its tools, the reactor's workflow steps | 4.7        | 06 §2.1–2.2              |
| 6.7  | `Assistant`, `Memory`, `Tracked`, `Brief`                                                          | 6.5        | 02 §2.12                 |
| 6.8  | `Push` (web push)                                                                                  | 3.3        | 06 §2.4                  |
| 6.9  | `Telemetry` with the OTLP receiver, `Analytics`, `Disk`, `Lag`                                     | 2.8        | 07                       |
| 6.10 | Computer use: `CuaDriver`, `DesktopClaims`, the `desktop` server                                   | 3.1        | 05 §2.8, 03 §2.12        |
| 6.11 | `GithubRepos` (clone, create), `Relocation`, Asana, `Fanout`, config archives                      | 4.4        | 06 §2.5, 04 §2.18, §2.20 |
| 6.12 | Step 1 for `settings/` (95 files, in three pull requests by subfolder)                             | the areas it shows | 10 §2.7          |

As done in HE-7 (one pull request): every area above is on the server and reachable from the UI; each has an "As built
in 6.x" section in [06-server.md](06-server.md) and, for its web part, in [09-frontend.md](09-frontend.md). 6.12 came as
one pull request with the rest, its settings parts that waited for M7 and M8 (Server's updates, the host page) done
after HE-6 merged. No component in `apps/web/src` shows "not yet on this server" for an M6 area any more; the ones left
are earlier milestones' cuts (the board's setup thread, a pen's thread, Triage, attachments in New task, the background
banner's Stop).

## M7: hosts

| Task | Does                                                                                               | Needs      | Read; inventory          |
| ---- | -------------------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| 7.0  | Two checks, as tests: upgrade headers reach RPC middleware and the signed session cannot be forged; two piped sockets keep back-pressure | 0.3 | 08 _To check early_ |
| 7.2  | `Links`, `LinkConnections` for dialled links, `hub.hosts.*`, `Relay`; relayed sessions in the client; the Hosts settings | 7.0, 1.5 | 08; inv 05 §2.2 |
| 7.3  | Dial-in links (`link.attach`) and SSH links, with the trust rules                                  | 7.2        | 08; inv 05 §9            |
| 7.4  | Board tools across hosts; `Uplink`; the assistant on its own host                                  | 7.3, 6.7   | inv 03 §2.3, 05          |
| 7.5  | `Discovery`, `SettingsSync`, copying a config between hosts                                        | 7.2        | inv 05 §2.4, §2.7        |

## M8: updates, packages, desktop

| Task | Does                                                                                               | Needs      | Inventory                |
| ---- | -------------------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| 8.1  | `Supervisor`, `Updater` (rebuild from a checkout, follow a deployment, a hub's push), `admin.*`    | 7.2        | 05 §2.6                  |
| 8.2  | `scripts/package-server.sh`, `Releases` (check, stage, try, settle, roll back), `Service`, the install scripts | 8.1 | 05 §2.6, 11          |
| 8.3  | `apps/desktop`                                                                                     | 8.2        | 10 §9                    |
| 8.5  | The release workflow; pull request previews                                                        | 8.2        | 11                       |

## M9: the switch

| Task | Does                                                                                               | Needs      | Read |
| ---- | -------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 9.1  | `import-legacy` and `--check` (database, paths made absolute, files copied, the refusals, threads not yet items), `--rehearsal` with `ImportGuard` and the read-only server and its test, the throwaway switch of an old test server, tests per table family and a nightly run on a scrubbed copy | M6         | 11, 06 |
| 9.2  | The parity run: all of `tests/ui` against the new server; the measurements; a week of this repository's own work on a board running it | 9.1, M7, M8 | 10 |
| 9.3  | The guide (`docs/guide/`) brought into line; the switch on each host                               | 9.2        | 11   |

## M10: step 2 of the frontend

From 2.7 on, in parallel with everything above and after the switch: one task per feature folder or large file, in
the order in [09-frontend.md](09-frontend.md#step-2-by-hand-a-feature-folder-at-a-time). Each removes its files from
the lint override.

## Order at a glance

```
M0 ─► M1 ─► M2 ─► M3 ─┬─► M4 ─┬─► M6 (twelve in parallel) ─► M9
                      │       └─► M5
                      └─► M7 ─► M8 ────────────────────────► M9
                 2.7 ─────────────────► M10 (ongoing)
```

About 65 tasks. The old server is 85,000 lines without tests and the port should come out smaller: the compatibility
code, the serde emulation, the legacy thread path and the three host protocols are a fair share of it.

## Working on a board while building its replacement

The tasks run on the existing Huntaway board, in a project on this repository. Three habits from the old
repository carry over because they are what kept 190 merges a week workable: a pull request merges the day it opens;
a task never stacks on another's branch; and a named migration, a new RPC and a new board tool are each a file of
their own, so two tasks rarely edit the same lines. `packages/contracts/src/rpc/<group>.ts` is one file per group
for the same reason.
