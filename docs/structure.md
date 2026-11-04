# Project structure

Where code goes, and how big modules are split. Written for HA-96, which split the server's four
largest files; HA-101 split the next five and HA-102 grouped the server's modules into folders, and
HA-103 grouped the app's components into feature folders and split its largest files. The rest of
the plan, under *Next*, is for follow-up tasks.

## Layout

```
server/src/          the huntaway binary: one module per feature, grouped in folders by area
server/shim/         ia-shim, the per-run supervisor
server/broker/       huntaway-broker
app/src/             the UI: App.tsx, store.ts, router.ts and the helpers several features use (*.ts)
app/src/api/         the web board's client: packages/client's, for the page's own board
packages/client/     the API's types and calls, a file per resource, shared with the mobile app
app/src/components/  React components in a folder per feature (see App modules)
app/tests/           unit tests (npm test); app/tests/ui/ browser tests (npm run test:ui)
scripts/             test servers, ia-api, ui-check and other tools (see README.md)
docs/                notes like this one
```

## Server modules

The server is one crate, so each module is a file named after its feature (`worktree.rs`, `hub.rs`,
`review.rs`…), in a folder for its area of `server/src/`:

| Folder | Modules |
|---|---|
| `agent/` | runner, runs, codex, context, title, task_tmp, window, usage, tokens, prompts, documents, agent_tools, assistant, approval_rules |
| `mcp/` | (`mcp.rs`, the stdio server) tools, gh_mcp, wait, pr_watch, permissions, questions |
| `git/` | worktree, worktree_files, checkpoints, git_view, changes, relocate |
| `hosts/` | hub, broker, proto, relay, ssh, terminal, pty, uplink (board tools up a link) |
| `update/` | admin, release, staging |
| `integrations/` | github, asana, push, automations, status_script |
| `review/` | (`review.rs`, automatic review) summary, merged, merge_gate, fanout, stats |

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

### What HA-104 split

HA-101 left these two alone while open PRs #53 (HA-53) and #52 (HA-55) rewrote large parts of them.

| Was | Lines | Now |
|---|---|---|
| `git/worktree.rs` | 2,978 (1,629 of code) | `worktree.rs` (running git, the helpers every part uses), `upstream`, `scripts`, `setup`, `start`, `remove`, `pr`, `remote`, `changes`, `tests`, `approval_tests` |
| `mcp/pr_watch.rs` | 2,431 (1,623 of code) | `pr_watch.rs` (`Target`, `Request`, the fake GitHub for tests), `read`, `seen`, `pr`, `in_review`, `failed`, `tests` |

Their parts are 70 to 460 lines.

## App modules

The app groups its components by feature (see *bulletproof-react* below): a folder in
`app/src/components/` for each, with the helpers only that feature uses beside its components.
Helpers several features use stay in `app/src/` (`store.ts`, `router.ts`, `threadModel.ts`,
`analytics.ts`…).

| Folder | What's in it |
|---|---|
| `board/` | the board and its views (TaskBoard, TaskCard, BoardControls, Graph and Triage views, PendingPrompts, Fanout, Dependencies, ConfirmDone), `boardQuery.ts`, `taskOrder.ts` |
| `task/` | the task panel (TaskView, and `view/` for its title, tabs and Details column), the thread (Thread, and `thread/` for its markdown, tool calls, subagents, items and the composer), Approvals, Questions, Review, Reviewers, Context, Rewind, Reminders, ExternalLinks, Attachments, Document, Terminal, WorktreeSetup, SkillMenu, AssistantPage, ApprovalRules, ActionLog; `turns.ts`, `planTheme.ts`, `planAnswers.ts`, `openingTab.ts`, `htmlFrame.ts`, `mermaid.ts` |
| `changes/` | the Changes tab (Changes, and `git/` for its parts), DiffLines, Compare; `changes.ts`, `lineComments.ts`, `highlight.ts` and its worker |
| `settings/` | the settings page and its sections (Server, Hosts, HostPage, ClaudeConfigs, AgentTools, Automations, GithubRepos, Usage, DiskUsage, Analytics, chart), NewProjectModal, DirPicker, ArchivedProjects, Onboarding, TokenScreen, and `project/` for project settings, a file per tab; `disk.ts`, `githubRepos.ts`, `versions.ts`, `uiVersion.ts` |
| `layout/` | Sidebar, Notifications, NewTaskModal (and `newTask/`, its hooks and sections), TitleModal, UnhandledErrors, AgentsPill; `harnesses.ts`, `taskTokens.ts` |
| `ui/` | the shared building blocks, a file per kind (`controls`, `Modal`, `ContextMenu`, `status`, `links`, `time`, `hooks`, `format`) re-exported by `ui/index.ts`, AgentIcon, `preview.ts` |

- A feature may import from another (the composer sends line comments from `changes/`, the Changes
  tab reads turns from `task/`); what every feature needs goes in `ui/` or `app/src/`.
- `packages/client/src/` (`@huntaway/client`) has a file per resource, as the server's `api/` has
  (`tasks`, `thread`, `git`, `projects`, `hosts`…), with `http.ts` for the requests themselves. It's
  plain TypeScript with no DOM (`npm run typecheck` in `app/` checks it on its own), for the mobile
  app too: each resource's calls are made from a board's `Http` (`tasksApi(http)`), and
  `createClient(adapter)` puts them together for one board, whose address, token, storage and
  websocket address the adapter gives (an app with several boards makes a client for each).
  `app/src/api/index.ts` makes the web board's, for the page's own board with its token in
  localStorage, as `api`, and re-exports the package's types, so `import { api, type Task } from
  "../../api"` works from anywhere. Tests stub calls on that one `api` object.
- When a component outgrows its file, it becomes a folder named after it beside it
  (`changes/git/`, `task/thread/`, `layout/newTask/`): its state in hooks (`useX.ts`, each owning
  one part of it), its sections or panes in components, and the file it had keeps the component
  that puts them together. Importers then import from the file that has what they need, rather
  than through a re-export.
- The unit tests import the app's modules by path (`../src/components/changes/changes.ts`). Their
  resolve hook adds `.ts`, or `/index.ts` for a folder, to imports without an extension.

### What HA-103 split

| Was | Lines | Now |
|---|---|---|
| `api.ts` | 1,918 | `api/`: `http`, `hosts`, `push`, `profiles`, `claudeConfigs`, `github`, `projects`, `agentTools`, `analytics`, `tasks`, `thread`, `git`, `terminal`, `approvals`, `automations`, `server`, `labels`, `index` |
| `Changes.tsx` | 2,173 | `Changes.tsx` (`GitView` putting it together, 344) and `git/`: `useGitStatus`, `useGitSelection`, `useFileDiffs`, `useStaging`, `useShownDiffs`, `useGitActions`, `useGitKeys`, `SidePanels`, `MainPanel`, `Panels`, `Patches`, `ReviewBar`, `Dialogs`, `model` |
| `Thread.tsx` | 1,617 | `Thread.tsx` (280) and `thread/`: `Markdown`, `context`, `tools`, `subagents`, `items`, `ItemList`, `ModeSelect`, `Composer` |
| `TaskView.tsx` | 1,574 | `TaskView.tsx` (397) and `view/`: `layout`, `hooks`, `TabContent`, `ReviewThreadView`, `Title`, and `details/` (Details and its sections and dialogs) |
| `Settings.tsx` | 1,525 | `Settings.tsx` (80), `DirPicker`, `NewProjectModal`, `ArchivedProjects`, `Onboarding`, `TokenScreen`, and `project/`: `ProjectSettings` and a file per tab |
| `NewTaskModal.tsx` | 1,243 | `NewTaskModal.tsx` (129) and `newTask/`: hooks for the draft, text, destination, agent, tokens, options, submission, completion and editor layout, and the `Editor`, `ReadsAs`, `OptionsRow`, `Notes` and `Footer` sections |
| `ui.tsx` | 823 | `ui/`: `controls`, `Modal`, `ContextMenu`, `status`, `links`, `time`, `hooks`, `format`, `index` |

The largest files left in the app are `Hosts.tsx`, `Automations.tsx` and `Analytics.tsx` in
`settings/` (about 1,100 lines each), which could split the same way.

## Next

### Server: the next files

No server file but `db/schema.rs` (1,131 lines, most of them the migrations' SQL) has more than
1,000 lines of code now. The next largest are `agent/agent_tools.rs` (995), `git/worktree_files.rs`
(952, 575 of code) and `agent/runs.rs` (937, 629 of code): `agent_tools` would be the next to split,
and the other two can move their tests to `tests.rs` first.

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
