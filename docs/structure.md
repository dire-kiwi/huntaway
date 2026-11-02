# Project structure

Where code goes, and how big modules are split. Written for HA-96, which split the server's four
largest files; HA-101 split the next five and HA-102 grouped the server's modules into folders. The
rest of the plan, under *Next*, is for follow-up tasks.

## Layout

```
server/src/          the huntaway binary: one module per feature, grouped in folders by area
server/shim/         ia-shim, the per-run supervisor
server/broker/       huntaway-broker
app/src/             the UI: api.ts (types and calls), store.ts, feature helpers (*.ts)
app/src/components/  React components, one file per view or panel
app/tests/           unit tests (npm test); app/tests/ui/ browser tests (npm run test:ui)
scripts/             test servers, ia-api, ui-check and other tools (see README.md)
docs/                notes like this one
```

## Server modules

The server is one crate, so each module is a file named after its feature (`worktree.rs`, `hub.rs`,
`review.rs`…), in a folder for its area of `server/src/`:

| Folder | Modules |
|---|---|
| `agent/` | runner, runs, codex, context, title, task_tmp, window, usage, prompts, documents, agent_tools |
| `mcp/` | (`mcp.rs`, the stdio server) tools, gh_mcp, wait, pr_watch, permissions, questions |
| `git/` | worktree, worktree_files, checkpoints, git_view, changes, relocate |
| `hosts/` | hub, broker, proto, relay, ssh, terminal, pty |
| `update/` | admin, release, staging |
| `integrations/` | github, asana, push, automations, status_script |
| `review/` | (`review.rs`, automatic review) summary, merged, merge_gate, fanout |

`main`, `state`, `util`, `db`, `api`, `testing`, `demo`, `analytics`, `disk` and `attachments`
stay at the top. A folder's `agent.rs` (and so on) has its `//!` docs and a `pub mod` for each
module; `mcp.rs` and `review.rs` are modules of their own as well as their folders'. Paths name the
folder: `crate::agent::runner::send_message`, `use crate::git::{checkpoints, worktree};`. A new
module goes in the folder for what it's about, or at the top if it's used everywhere, as `util` is.

When a module outgrows one file it becomes a folder too, as `runner`, `db`, `api` and `tools` have:

```
server/src/agent/runner.rs         what the module is about (its //! docs), shared items, the core
server/src/agent/runner/queue.rs   one part of it each, with its own //! line
server/src/agent/runner/tests.rs   its tests
```

- Rust's file layout: `foo.rs` next to a `foo/` folder for its submodules (rather than
  `foo/mod.rs`). `foo.rs` keeps the module's docs, its imports and what every part uses.
- `foo.rs` declares `mod part;` and `pub use part::*;`, so the rest of the crate keeps using
  `crate::foo::item` and doesn't need to know which file has it. A part with nothing public
  enough to re-export (only `pub(super)` items) gets `use part::*;` instead: rustc warns about a
  `pub use` glob that re-exports nothing.
- Each part starts with `use super::*;`, which brings in `foo.rs`'s imports and the other parts'
  items. An item another part uses is `pub(super)`; one only its own part uses stays private.
- Tests go in `foo/tests.rs` (`#[cfg(test)] mod tests;` in `foo.rs`). They're still a child of
  `foo`, so `use super::*;` reaches everything, private items included.
- Split by what the code is about, not by kind: `db/tasks.rs` has the `Task` row and the task
  queries, rather than one file of structs and one of queries. Each `api/` part has the handlers
  for one resource. The route table stays in `api.rs` (`host_routes`), the one place that lists
  every route.

A file is due for a split when its code (not counting tests) passes about 1,000 lines, or it has
parts that change for different reasons. Moving its inline tests out to `tests.rs` is the cheap
first step: in several modules they're longer than the code.

### What HA-96 split

| Was | Lines | Now |
|---|---|---|
| `agent/runner.rs` | 4,546 | `runner.rs` (run lifecycle, startup), `queue`, `merge`, `send`, `launch`, `access`, `prompt`, `output`, `tests` |
| `db.rs` | 4,452 | `db.rs` (settings, field values), `schema` (`open`, migrations), `profiles`, `projects`, `tasks`, `task_data`, `messages`, `links`, `runs`, `tests` |
| `api.rs` | 4,209 | `api.rs` (routes, auth, websocket), `profiles`, `claude_configs`, `projects`, `tasks`, `new_task`, `thread`, `host`, `tests` |
| `mcp/tools.rs` | 4,055 | `tools.rs` (`Ctx`, errors), `dispatch`, `local`, `projects`, `approvals`, `automations`, `resolve`, `tasks`, `tests` |

The largest part is now `db/schema.rs` (about 1,000 lines, mostly the migrations' SQL); the
others are 60 to 800. A new DB migration goes in `db/schema.rs`.

### What HA-101 split

| Was | Lines | Now |
|---|---|---|
| `integrations/automations.rs` | 2,185 | `automations.rs` (types, database), `check`, `delivery`, `running`, `handlers`, `tests` |
| `mcp/gh_mcp.rs` | 1,938 | `gh_mcp.rs` (the MCP server, the Bash hook), `account`, `targets`, `env`, `tests` |
| `git/checkpoints.rs` | 1,803 | `checkpoints.rs` (types, database, the queue), `git`, `capture`, `changed`, `handlers`, `restore`, `tests` |
| `agent/codex.rs` | 1,683 | `codex.rs` (`Spec`, policies), `rpc`, `adapter`, `queries`, `output`, `tests`, `subagent_tests` |
| `hosts/hub.rs` | 1,437 | `hub.rs` (links, startup), `inbound`, `dial_out`, `endpoints`, `manage`, `tests` |

Their parts are 100 to 530 lines. `release`, `agent_tools`, `broker`, `relocate`, `push`, `review`,
`wait`, `permissions`, `git_view` and `changes` (under 1,000 lines of code each) moved their tests
to `tests.rs`.

## Next

### Server: the next files

`mcp/pr_watch.rs` (1,878 lines, 1,304 of code) and `git/worktree.rs` (1,790, 1,153) are the last files
over 1,000 lines of code. They split as above, with their tests moved to `tests.rs`, once open PRs
#53 and #52, which rewrite large parts of them, have merged.

### App: feature folders

`app/src/components` has 49 files side by side, eight of them over 1,000 lines. React projects of
this size usually group by feature (see *bulletproof-react* below): each feature's components,
hooks and helpers together, with shared pieces in one place.

| Folder | Components |
|---|---|
| `board/` | Board, TaskBoard, TaskCard, BoardControls, GraphView, TimelineView, TriageView, LiveView, Fanout, Dependencies, ConfirmDone |
| `task/` | TaskView, Thread, Approvals, Questions, Review, Reviewers, Context, ContextStats, Rewind, Reminders, ExternalLinks, Attachments, Document, Terminal, WorktreeSetup, SkillMenu |
| `changes/` | Changes, DiffLines, Compare |
| `settings/` | Settings, Server, Hosts, HostPage, ClaudeConfigs, AgentTools, Automations, GithubRepos, Usage, DiskUsage, Analytics, chart |
| `layout/` | Sidebar, Notifications, NewTaskModal, UnhandledErrors, AgentsPill |
| `ui/` | ui.tsx (split by component), AgentIcon |

Each folder takes the `app/src/*.ts` helpers only it uses (`changes.ts` and `lineComments.ts` go to
`changes/`, `threadModel.ts`, `turns.ts` and `timeline.ts` to `task/`). Of the big files:

- `Changes.tsx` (2,173 lines) is mostly `GitView`, one component of about 1,260 lines. It needs
  its state and handlers pulled into hooks and its panes into components, which is a refactor
  rather than a move.
- `Thread.tsx`, `Settings.tsx`, `TaskView.tsx` and `NewTaskModal.tsx` (1,200–1,600 lines) split
  into a component per section or tab.
- `api.ts` (1,918 lines of types and calls) becomes `api/` with a file per resource, as the
  server's `api/` has, and an `index.ts` that re-exports them so imports don't change.

The redesign (PR #30) touches most components, so this waits for it.

### README

`README.md` is 1,700 lines. Its *Concepts* section (about 750 lines) and the hosts and release
sections could move to `docs/`, leaving the README with the overview, running it and links.

## Sources

- [Rust Book: separating modules into different files](https://doc.rust-lang.org/book/ch07-05-separating-modules-into-different-files.html)
  and the [Rust Reference on module source filenames](https://doc.rust-lang.org/reference/items/modules.html#module-source-filenames):
  `foo.rs` with a `foo/` folder is the current style; `foo/mod.rs` still works.
- [Using submodules to split large Rust files](https://www.slingacademy.com/article/using-submodules-to-split-large-rust-files-into-manageable-components/)
  (Sling Academy) and [Rust project structure for large applications](https://reintech.io/blog/rust-project-structure-best-practices-large-applications) (Reintech).
- [Axum REST API best practices](https://www.skills.sh/alexandretrotel/skills/axum-rest-api-best-practices)
  and [a basic project structure for an Axum application](https://app.studyraid.com/en/read/11158/346211/basic-project-structure-for-an-axum-application):
  handlers by resource.
- [bulletproof-react](https://github.com/alan2207/bulletproof-react) and its
  [overview](https://dev.to/alan2207/bulletproof-react-3lej): feature folders for React apps.
