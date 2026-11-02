# Can Huntaway run its agents on agent-threads?

A feasibility study for task HA-94. [agent-threads](https://github.com/dire-kiwi/agent-threads) (`~/personal/agent-threads`,
`main` at `4b40ae1`, 2026-11-02) is the library extracted from Huntaway's thread layer in tasks AT-2 to AT-18. It has
native backends in Rust, Go and Node, React components, a normalized item/event protocol, and `agent-threads-shim`, a
port of `ia-shim`. Its design doc names "move Huntaway's thread layer onto the Rust backend and React components" as a
follow-up. This doc asks whether that move is feasible now, what blocks it, and what it would cost.

Huntaway is described as of `master` at `716b056` (API 90, run format 2). Both codebases were read, not run. Size
figures for the live board come from a read-only query of its database.

**In one line:** it's feasible, and agent-threads is built for it: it has the same dependencies, the same run
supervision and the same steering semantics. But Huntaway can't adopt it today. Four things block it: the repository
is private, the Claude driver can't be configured per thread, several features Huntaway relies on are missing, and
there's no way to carry over existing threads or runs. Fix the gaps upstream first, then move Huntaway over in stages.
A wholesale swap now would mean rewriting about 12k lines of server code and 2-3k lines of UI, with two message
formats in use until every linked host upgrades.

## What fits already

| | Huntaway | agent-threads (Rust) |
|---|---|---|
| Runtime and dependencies | tokio 1.54, rusqlite 0.40.2 bundled, edition 2024, MSRV 1.89 | tokio 1.54, rusqlite 0.40.2 bundled (one `libsqlite3-sys`, no `links` clash), edition 2024, needs about 1.88. Adds async-trait, hyper and hyper-util; base64 0.22 sits next to Huntaway's 0.23 |
| Claude launch | `claude -p` stream-json in and out, `--replay-user-messages`, partial messages | The same |
| Steering | Written to stdin, counts once Claude echoes it back, 30s steer window after `result`, then requeued | The same (`steer_grace` 30s) |
| Stop | `control_request` interrupt, 10s, then close input and SIGTERM/SIGKILL to the process group | The same (`stop_grace` 10s) |
| Runs that outlive the server | `ia-shim` with a run dir, followed from a saved offset | `agent-threads-shim`, a port with the same files, plus `recover()` that re-attaches. Open permission requests survive the restart too (they're checkpointed with the run) |
| Codex | `huntaway codex-run` adapter over `codex app-server`, converting into Claude-shaped messages | Native driver over `codex app-server`: steer, interrupt, approvals, `requestUserInput`, dynamic tools, usage, retries as notices |
| Subagents | Grouped by `parent_tool_use_id` in the UI | `parent_id` on items, done in the backend |
| Tests | Unit tests and UI tests | 96 Rust tests, 26 recorded Claude and Codex fixtures, a kill-mid-turn restart suite |

What Huntaway would gain:

- **A data model of its own.** Claude's stream-json is Huntaway's storage format today, and Codex is converted into it
  (`server/src/codex.rs`, about 900 lines). The normalized items (`user_message`, `assistant_message`, `reasoning`,
  `tool_call` with a `kind`, `compaction`, `notice`, `turn_result`) mean less special-casing for Codex in the server and
  the UI.
- **In-process board tools.** Today the board's MCP server is a helper process (`huntaway mcp`). It gets the host's
  full token in its environment, and it says which run it is by a `run_id` in the request body, which the server
  trusts (`runs.rs:91`, `tools.rs:218`). agent-threads serves app tools in process (Claude's sdk MCP server over the
  control channel; Codex's `dynamicTools` or a loopback MCP server with a random token). A tool call then knows its
  thread without that trust.
- **`can_use_tool` permissions over stdio** instead of `--permission-prompt-tool mcp__huntaway__permission_prompt`,
  without the `MCP_TOOL_TIMEOUT=86400000` workaround.
- **Deltas per item** rather than one streamed string per task (`app/src/deltas.ts`), so a client that misses some
  catches up by `seq`.
- **One implementation to maintain.** Fixes to driver logic (Claude CLI changes, Codex protocol changes) would land
  once, for Huntaway and the other apps.

## Blockers

These have to be settled before Huntaway can depend on the crate at all.

1. **Visibility and licence.** `dire-kiwi/agent-threads` is private and has no licence. Huntaway is public (MIT), its
   CI runs on GitHub-hosted runners, and `install.sh` builds from source. A git dependency on a private repository
   breaks all three. Options: make agent-threads public with a licence (simplest), publish the crates, or vendor the
   crate into Huntaway (which gives up the one shared implementation).
2. **Per-thread launch settings.** Huntaway sets these for each run (`runner.rs:1169-1257`, `runs.rs:83-144`). The
   crate takes them per harness instance or not at all:
   - `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per profile (crate: `config_dir` per harness instance);
   - `--add-dir` for the repo, group projects, documents, skills, attachments and the task's TMPDIR;
   - `--allowedTools` / `--disallowedTools` (board tools by mode, gh tools while merging, reviewer limits, disabled
     skills and MCP servers);
   - `--settings` with the `gh` PreToolUse hook;
   - environment per run (`TMPDIR`);
   - `--resume-session-at` for rewind.

   A wrapper `Harness` that builds a `claude_code(...)` from the thread's metadata for each `open` would cover most of
   this without changing the crate (the core looks harnesses up by name, and `Harness::open` is public). But
   per-thread `args`, `env` and `add_dirs` in `CreateOptions` would be the cleaner upstream fix.
3. **Config isolation has to be off, all of it.** The crate passes `--setting-sources "" --strict-mcp-config` unless
   `user_settings` is set. Huntaway relies on the profile's CLAUDE.md, settings, hooks and plugins, so it would run
   with `user_settings: true`. Then the crate's skills plugin and the user's skills both load. Check that this
   matches Huntaway's skill enabling and disabling, which uses `--add-dir` for skills and `--disallowedTools Skill(name)`
   to turn skills off.
4. **Features Huntaway uses that the crate doesn't have:**

   | Huntaway feature | Where | In agent-threads |
   |---|---|---|
   | ExitPlanMode approval that switches mode (`updatedPermissions: setMode`), and "keep planning" feedback | `permissions.rs:88-105, 324-330, 421` | No special case. ExitPlanMode is a plain `other` tool, and `Resolution` can't carry a mode or updated permissions |
   | Rewind: `--resume-session-at`, Codex `thread/revert`, a fresh session from the first message | `checkpoints.rs` | None. `create` takes no session id (it can be put in the store directly), and there's no resume-at or revert |
   | Context usage: a `get_context_usage` control request at turn end | `context.rs:196-236` | No way for the app to send control requests or see responses |
   | Rate limits: `rate_limit_event`, `usage_limit_reached` | `usage.rs`, `runner.rs:2228-2297` | Dropped |
   | Background subagents: `task_started`, `task_progress`, `task_updated`, `task_notification`, `run_in_background`, Skill-forked agents | `subagents.ts`, `db.rs:2733` | Not translated |
   | "Always allow" that outlives the run | `task.auto_allow` | In memory per thread (`thread.rs:135`) |
   | Answering a prompt after its run ended (sent as the next message), and pending prompts updated when the mode changes | `permissions.rs:231, 350-371` | Requests are cancelled when their turn ends, and decided once |
   | `/compact` runs and the idle auto-compact; Codex `thread/compact/start` | `runner.rs:624-631` | No compact command. A Claude `/compact` sent as a message is untested; Huntaway runs it without stream-json input |
   | Codex sandbox writable roots, the reviewers' filesystem profile, and model validation | `codex.rs:101-159` | `permission_mode` maps to approval policy and sandbox only, plus extra `config` |
   | Raw harness payload | Stored per message | `raw` is in the protocol, but the Rust backend never fills it in |

   The design doc ruled checkpoints, usage dashboards and multi-host relaying out of scope, but Huntaway needs the
   harness-level hooks behind them. The smallest general fix is a way to pass through what the crate doesn't
   translate: fill in `raw`, or add a callback for each harness line and a way to send control requests. Then
   Huntaway could keep its own rate-limit, context and background-subagent handling. ExitPlanMode, resume-at and
   revert, compaction, and persisted "always" answers need real API.
5. **Run directories can't be shared or adopted.** Huntaway's run format is 2 and the crate's is 1. A crate backend
   stops runs whose format is newer than it knows, and its pruning deletes run dirs its store doesn't know, so it
   must not share `<data>/runs`. Huntaway's in-flight runs have no crate `RunRecord`. At the switch-over, old runs
   have to finish on the old code path (keep the legacy follower until none are left) or be drained first. Huntaway
   promises that updates don't interrupt agents, so draining is a regression.
6. **Existing threads.** The live board holds 205k messages (about 490 MB of JSON, 197k of them raw Claude lines)
   across 1,174 tasks. Nothing imports them into the event model. They're slimmed (no `stream_event`, `init` or
   `tool_use_result`), so they can't simply be replayed through the crate's translator. Either write a converter
   (stored rows to items, run once per task, maybe lazily when a thread is opened) or keep the old renderer for old
   threads.

## What Huntaway would have to change

**Server.** About 7.5k lines are the thread and run layer proper: runner.rs (about 2.5k of its 4.5k), runs.rs,
codex.rs, permissions.rs, mcp.rs, wait.rs, questions.rs, context.rs, usage.rs, attachments.rs, MCP dispatch in
tools.rs and the message helpers in db.rs. Another 4.7k lines are board features that read raw messages, and they'd
need porting to items:

- review.rs: `tool_calls_since` and `changes_code`, which read Edit, Write and Bash inputs, and the user's replies;
- summary.rs and title.rs (`last_assistant_text`, `user_replies`);
- wait.rs (SQL over `tool_use_id` and Agent/Task calls);
- checkpoints.rs (message ids, the first user message);
- `get_task`'s `last_message`, message paging (`message_page`, `subagent_messages`) and attachments.

The run gates around a run (dependencies, usage limits, the merge queue, queued messages, auto-compact, review runs)
stay Huntaway's and would call the crate instead of `launch`.

**Store.** `SqliteStore` creates `threads`, `events`, `snapshots` and `runs`. Huntaway already has `runs`, and `CREATE
TABLE IF NOT EXISTS` would quietly reuse it. Implement `Store` on Huntaway's database under other table names (the
crate has store conformance tests for this), or use a separate file and give up writing task state and thread
events in one transaction.

**Live updates and linked hosts.** The `/api/ws` events (`message`, `message_updated`, `delta`, `delta_reset`)
become protocol events. Linked hosts on an older version keep sending raw messages through the hub
(`hub.rs:288, 492`), and API changes have to be additive (`proto.rs`). So the UI has to render both formats, gated
on `api_version`, until the old ones are gone.

**UI.** About 4.7k of the app's 34k lines are thread code. The React package could replace threadModel.ts,
subagents.ts, deltas.ts and Thread.tsx up to the composer (about 1.75k lines). It has tool rows by kind, edit diffs,
subagent rows, permission and question cards, compaction, turn results, streaming and row reuse. Huntaway would keep
its composer (drafts, line comments, the skill menu, attachments, mode cycling, the usage-limit queue) and its board
cards. It would add, upstream or through `renderItem`/`tools`:

- answered requests left in the thread (the reducer drops a request on `request.resolved`), and "moved on" greying;
- the plan card (approve with a mode, keep planning);
- paging: the package loads the whole snapshot, while Huntaway pages threads with thousands of messages and keeps the
  scroll position and group keys when older ones are prepended;
- rewind marks on user messages;
- attachment thumbnails by host path;
- the full-screen subagent view with breadcrumbs;
- the theme: the package uses `--at-*` CSS variables and is light by default; Huntaway is Tailwind and dark-only.

## Options

| | What | Cost | Verdict |
|---|---|---|---|
| A. Swap now | Replace the server thread layer and the UI thread in one go | Rewrite about 12k lines of server and 2-3k lines of UI, convert or dual-render old threads, drain runs, keep both formats for linked hosts. Blocked by 1-4 above | No |
| B. Upstream first, then migrate in stages | Close the gaps in agent-threads with Huntaway as the driving client, then move Huntaway behind a per-task engine switch | The upstream work below, then a staged migration of a similar total size, without a big-bang release | **Recommended**, if one shared implementation matters |
| C. Share the protocol only | Huntaway keeps its runner but emits agent-threads events (translating its own messages), and the UI moves to the protocol reducer and components | Gives the UI convergence and the normalized model without the run-layer risk, but keeps two driver implementations | A fallback if B stalls |
| D. Don't adopt | Keep the two codebases separate and port fixes by hand | None now, and they drift from here on | Only if agent-threads stays private |

### Upstream work for B (agent-threads tasks)

1. Make the repository public with a licence, or decide to publish the crates.
2. Per-thread `args`, `env`, `add_dirs` and harness config (config dir / CODEX_HOME) in `CreateOptions`, kept with the
   thread.
3. Create a thread from an existing session id, resume at a message (`--resume-session-at`), and Codex
   `thread/revert` and `thread/compact/start`, plus a compact command for Claude (`/compact`).
4. ExitPlanMode as a request type, or a `Resolution` that can carry a mode change and `updatedPermissions`; a
   `set_options` that applies the permission mode to a running Claude process.
5. Pass-through: fill in `raw` (behind an option), an event or callback for harness lines the driver doesn't
   translate (rate limits, `task_*` system events), and a way to send a control request (`get_context_usage`) and
   get its response.
6. Persisted "always" answers, and an option to keep a request open after its turn ends.
7. Background subagents (`task_*` events, `run_in_background`) in the Claude translator, with fixtures.
8. React: keep resolved requests in state, paged snapshots (`events_since` already exists; add a snapshot of a
   window of items), and a dark theme or Tailwind token mapping.

### Staged migration in Huntaway (after the upstream work)

1. Implement `Store` on Huntaway's database (`at_threads`, `at_events`, …) with a `run_engine` column on tasks.
   Old tasks stay on the legacy runner; new tasks opt in behind a setting.
2. Board tools as in-process app tools, with the `huntaway mcp` helper kept for legacy runs. The permission policy
   is Huntaway's (`auto_allow`, `documents::writes_own_folder`, modes, approvals that always ask).
3. Port the raw-message readers (review, summary, title, wait, `last_message`, checkpoints) to read items, with a
   legacy path for old tasks.
4. UI: render new-engine threads with the package and Huntaway's own renderers, gated on API version. Keep the old
   renderer for old threads and older hosts.
5. Once no legacy runs are active and linked hosts have upgraded: convert or archive old threads, then delete the
   legacy runner, the Codex adapter and the old renderer.

## Recommendation

Not now as a drop-in replacement. Huntaway is still where the features land first (plan mode, rewind, background
agents, rate limits), and agent-threads trails it on each of them. Swapping now would lose features or keep both
implementations alive inside Huntaway.

It is feasible, and the fit at the bottom of the stack is unusually good: same dependencies, same shim, same
steering and stop semantics. So the right next step is option B's upstream list, which also makes agent-threads
better for its other apps. Decide first whether agent-threads goes public: without that, Huntaway can't depend on
it at all, and only option C or D are left.

## Not verified

- No build of Huntaway with the crate as a dependency, so the dependency claims come from the manifests, not
  `cargo tree`.
- Whether skills behave as Huntaway expects with `user_settings: true` (blocker 3).
- How much of the crate's Claude translator could convert stored, slimmed rows (blocker 6).
- The Go and Node backends weren't looked at: only the Rust crate and the React package matter for Huntaway.
