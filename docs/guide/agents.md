# Agents: Codex and the board's tools

## Codex agents

A thread whose config is a Codex one runs `huntaway codex-run` under ia-shim instead of
`claude -p`. That adapter starts `codex app-server`, starts (or resumes) the thread's Codex
thread, sends the prompt, steers messages sent meanwhile into the turn (`turn/steer`), and exits
when its input ends with no turn going. Codex's events are kept in the run's
output as they are, and the server writes them into the thread's items as they come (see
[docs/threads.md](docs/threads.md), "Codex writes items directly"), shown like Claude's: commands as Bash calls, file
changes as diffs, the plan as a todo list, MCP calls under their server's name. The board's
tools (as Codex dynamic tools), the project's MCP servers and skills, `/compact`, steering, stopping (`turn/interrupt`), queued messages and
reviews work the same.

Codex's native subagents appear in the thread and **Agents** list with their own transcripts,
permissions and lifecycle status, including nested agents and follow-up work on the same child.
Ask explicitly, for example: "Use two subagents to inspect the server and app, then combine their
findings." [Current Codex releases enable subagents by default](https://learn.chatgpt.com/docs/agent-configuration/subagents); Huntaway respects the Codex
config's `agents.enabled` setting and concurrency limit. Subagents share the task's worktree
and inherit its permissions and MCP servers.

Codex asks for approval through the board, like Claude's permission prompts: the adapter writes the app-server's
requests (approvals, questions, the board's tools' calls) to the run's output, and the board answers each on the run's
input, so a request still open when the server restarts is asked again. Permission modes
map onto Codex's approval policy and sandbox (writes stay in the working directory, the
repository's git directory and package caches such as `~/.npm`, `~/.cargo/registry` and
`~/.local/share/pnpm` (or where `CARGO_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` put them),
which are made before the run if they don't exist yet, with network access):

| Mode         | Codex                                                          |
| ------------ | -------------------------------------------------------------- |
| Ask          | asks before anything but known-safe commands (`untrusted`)     |
| Accept edits | edits in the sandbox go ahead, asks to leave it (`on-request`) |
| Auto         | Codex's own reviewer decides (`on-request`, `auto_review`)     |
| Plan         | read-only sandbox, Codex's plan mode                           |
| Don't ask    | never asks; what the sandbox blocks fails (`never`)            |
| Bypass       | no sandbox, never asks (`danger-full-access`)                  |

Reviewers run in a read-only sandbox that can still write the temp directories, the package caches
and the worktree's git-ignored directories (such as `target` or `node_modules`, but not `.claude`
or `.codex`), so they can build the work and run its tests without being able to change it. This
uses a Codex permission profile (`huntaway-review`, a beta feature); a Codex that doesn't take it
gets a plain read-only sandbox. A thread's model and effort are Codex's own (the new task
dialog lists the config's models); Claude models set on its project, profile or host are
skipped. Auto-compacting idle sessions is Claude-only.

## Agent tools (MCP)

Each run gets the `huntaway` MCP server, which the board serves itself, in process for Claude runs,
as dynamic tools (a `huntaway` namespace, answered on the run's input) for Codex sessions started
since they were, and over HTTP for older Codex sessions (Codex can't give a session it resumes new
dynamic tools), sessions whose Codex wouldn't take dynamic tools, and compactions (see _How runs reach the board's MCP
servers_ below). A newer Codex session's subagents don't have them (Codex doesn't pass a thread's dynamic tools on to the
threads it spawns): their parent does. The tools:
`list_projects`, `list_tasks`, `get_task`, `get_task_field`, `create_task`, `update_task`, `send_to_task`,
`delete_task` (once the user confirms), `get_project`, `update_project` (a project's settings), `create_project`,
`request_user_input`, `wait` (block until something happens, showing the task as waiting; see
_Waiting_), and the pen tools (API 127, see _Pens_ in [Using the board](board.md)): `list_pens`,
`create_pen`, `update_pen` and `delete_pen`, with `pen` on `create_task`, `update_task` and
`list_tasks`. Review threads
also get `submit_review`. `create_task` takes `subproject` (add the task to one; agents in a
subproject add to theirs by default) and `is_subproject` (or `type: "subproject"`, API 51), and
`list_tasks` takes `subproject`. `create_task` and `update_task` take `start_from` (API 96, see
_Starting from elsewhere_), and task summaries say what a task started from.

From API 59, helpers that advertise `get_task_field` receive a bounded overview from `get_task`:
small fields stay inline, `field_lengths` lists every available field's length, and
`omitted_fields` names those left out. Values over
1,000 serialized bytes are omitted, with a 6,000-byte budget for inline values in total. Read
any field with `get_task_field`, for example
`{"task_id":"IA-132","field":"last_message","offset":0,"limit":2000}`. Follow its
`next_offset` until it is null. Offsets and lengths count Unicode characters, starting at zero;
the default limit is 2,000 and the maximum is 4,000. String fields return plain text in
`content`; other fields (such as `review` and `created_tasks`) return pretty JSON, including
`null` for a null value, with `format` saying `text` or `json`. Pages reflect the current field
value, so a task changing between calls may change them. Both tools use the same profile access
and task-key resolution as other board tools. The helper opts in with `task_fields: true` in
the internal MCP request, which is carried through forwarded requests outside the tool arguments.
Older helpers and linked hosts omit it and keep receiving full details, so upgrading only the
serving host does not hide content from callers that cannot use `get_task_field`. For newer
helpers reading linked hosts before API 59, the calling host summarizes or slices the legacy
`get_task` response before returning it to the agent.

Each run also gets the `gh` MCP server, also served by the board, which runs the GitHub CLI for the
agent. MCP servers run outside Claude Code's Bash sandbox, where `gh` and `git push` often can't
reach GitHub or the user's login, so these work either way. They run in the agent's working
directory (or `dir`, or against `repo`): `pr_create`, `pr_view`, `pr_list`, `pr_checks`,
`pr_diff`, `pr_comment`, `pr_edit`, `pr_merge`, `issue_view`, `issue_list`, `issue_create`,
`issue_comment`, `run_list`, `run_view`, `api` (`gh api`), `gh` (any gh command) and `git_push`.
The read-only ones run without asking; the rest go through permission prompts like any tool, and
review threads don't get them. The exception is `pr_merge` while a Claude task is merging (moved
to _Ready for merge_, including while that merge waits in _Needs attention_): it runs without
asking then, so a merge doesn't stall when auto mode's check fails to answer. Reviewers find the
pull request with these tools rather than `gh` in the shell, and Codex agents are told to use them
for GitHub: `gh` in Codex's sandbox may not reach GitHub or the user's login, and Codex's own
GitHub app (the `codex_apps` server's `github_*` tools) only reaches repositories the ChatGPT
GitHub app was installed on. A project can turn the server off like any other (it's listed
under its MCP servers once a run has had it), or replace it with a server of its own named `gh`.
It needs `gh` installed and signed in (`gh auth login`) on the host.

While a run has this server, agents are told to use it rather than the gh CLI. Claude runs also
get a PreToolUse hook (`huntaway gh-hook`, passed with `--settings`) that denies Bash commands
running `gh` (`cd x && gh pr view`, `$(gh …)`, `bash -c 'gh …'` and the like) and says to use the
tools instead. Codex has no such hook, so Codex agents are only told. A project that turns the
server off, or has its own `gh`, gets neither.

**Docs.** Each run also gets the `docs` MCP server (HA-280), for documents the user reads on the
board: reports, plans, research. Its tools are the hosted docs app's (`publish_document`,
`list_documents`, `get_document`, `read_page` and `list_components`, with the same schemas, checks,
errors and warnings, from its renderer `@dire-kiwi/docs-render`), but the documents are kept on the
host, in the profile of the run's task: each publish makes a new version of the document, with its
Markdown or MDX pages (`mode: "merge"` keeps the previous version's other pages, `delete_paths`
drops some), and slugs are unique per profile. Feedback and sharing (`get_feedback`,
`share_document`) aren't there yet, so agents are told that form fields collect no answers here and
to ask in the thread instead. Its tools run without asking (in `--allowedTools`, or approved
in Codex's config), and agents are told to publish write-ups there and give the user the URL it
returns: `<board>/docs/<profile id>/d/<slug>/` (the host's _Public URL_, or its own address), with
`-/v/<n>/` for a version. The board reads them at `/api/profiles/{id}/docs` (API 124), and shows
them on the profile's Docs page (see [board.md](board.md)), with links built from its own address. A project
can turn the server off (its runs then have no `docs` server at all, nor the note about it), or
replace it with its own named `docs`.

**Computer use.** On a host where it's turned on, runs also get the `desktop` MCP server (HA-273):
the agent sees and uses the host's own desktop (native apps' windows) through
[Cua Driver](https://github.com/trycua/cua) (MIT). It's off by default. On the host's page
(Settings → Hosts → the host), _Computer use_ has **Install Cua Driver**, which downloads the
release Huntaway pins (`desktop.ts`'s `VERSION`; Cua marks every driver release a prerelease) from
GitHub, checks its size and SHA-256, and unpacks it into `<data dir>/cua-driver/<version>/`;
**Check**, which starts the driver and shows what it may do; and the switch that lets the host's
agents use it, from their next run. `IA_CUA_DRIVER` runs another build instead, and a `cua-driver`
on PATH is used when none is installed.

- The server runs one `cua-driver mcp` for the host (on Linux it owns the driver's runtime), started
  when an agent first needs it and stopped after 10 minutes without a call. It needs the graphical
  session: a host started as a service picks up `WAYLAND_DISPLAY`, `DISPLAY` and the session bus
  from `systemctl --user show-environment` (or a `wayland-N` socket), and sets
  `CUA_DRIVER_RS_ENABLE_WAYLAND=1` on Wayland.
- Agents don't get Cua's own MCP server but ours, shaped after `agentcast`
  ([pingdotgg/t3code#28050](https://github.com/pingdotgg/t3code/pull/28050)): `health`, `apps`,
  `windows`, `read` (a window's accessibility tree, `query` and `since` to keep it small), `screen`,
  `zoom`, `verify` and `op_status` only look and need no approval; `act` (a batch of steps, Cua's
  `run_steps`, which reports what changed), `launch` and `clipboard` ask first, unless the run is in
  Bypass. A reviewer and a run in plan mode only get the ones that look. Their arguments are Cua's,
  and each task's calls are Cua's session `huntaway-<key>`.
- Nothing but `health` and `op_status` runs while the screen is locked (logind's `LockedHint`, or a
  screen locker running), and only one task drives the desktop at a time: another's actions are
  refused until two minutes after its last. Actions are journaled (`desktop_ops`): one the agent
  names with `op_id` runs at most once, so after a lost answer it asks `op_status` instead of acting
  again.
- The task panel's monitor button (shown when the host has computer use on) opens a view beside the
  thread: the window the agent last read or acted on, live while the driver runs (a capture that
  leaves the agent's snapshot alone), and what it did there. `GET /api/desktop/frame?task_id=` and
  `GET /api/tasks/{id}/desktop` (API 128) are what it reads; paired devices can't.
- Agents share the host's one keyboard, pointer and focus with whoever is at it, so they're told to
  keep to the background and leave the desktop as they found it. On Hyprland, Cua's background input
  needs its experimental plugin; without it the driver refuses background input, and an agent can
  only act in the foreground, which it has to ask for. A project can turn the server off, like any
  other.

**GitHub accounts.** gh can be signed in to several accounts on a host (`gh auth login` once for
each), and each profile can pick which one its agents act as there (_GitHub account_ in Settings →
Profiles → Edit, per host); a project can pick its own in its settings, overriding the profile's.
The default is gh's active account. The run's launch records the account for the `gh` server
(see below), which runs each call with that account's token (`gh auth token --user`) and no
other credentials, so switching gh's active account doesn't matter. gh gets a config folder of its
own for the call (`GH_CONFIG_DIR`, private to the user and removed afterwards) with a login for the
account's host only, so it has no token for any other host, whatever the call names; no tokens in
the environment; `GH_HOST` set to the account's host; and on Linux no session bus, so it can't
fall back on the system keyring's logins. A call that goes to another host is refused before it
runs: `--hostname`, a repository given as `HOST/OWNER/REPO` or a URL with `--repo` (or `--source`,
`--branch-repo`), and the arguments that say where the command goes, which gh's own help for the
command tells apart (a pull request's or issue's URL, an API endpoint's, a repository as
`HOST/OWNER/REPO`, `[USER@]HOST:PATH` or a URL). What the call only says (a body, fields, a search
query, a repository's homepage) doesn't count. One about a repository whose remotes are on another
host fails.
`git_push` takes a remote's name, all of whose push URLs (as git rewrites them) must be on the
account's host; it uses the account's token over HTTPS, and pushes over SSH use the host's SSH
keys (or the SSH alias the remote names). Worktree setup and merged-worktree cleanup also use
the selected account for fetches from HTTPS remotes on its GitHub host, without changing git's
saved configuration. SSH and local fetches keep git's usual authentication. If a fetch fails,
setup logs the reason in the warning's details and branches from the locally available copy.
The host's own gh calls for a task (finding its pull
request, checking a merged one before removing its worktree) and the commands of the agent's
`wait` calls use the same account, as do the reads of a wait's pull request. A wait's command doesn't get the token: `gh` on its `PATH` is a
script that runs `huntaway gh-run`, which checks each call's targets as the tools do and runs gh
with the token. The `gh` tool (and `gh` in a wait's command) refuses `gh auth` (`gh auth token`
would put the token in the thread), `config get` of a host's settings (with `-h`/`--host`, or of
`oauth_token`, which prints the token too), `gh extension` and changes to gh's aliases and settings
(`alias set`, `alias import`, `alias delete`, `config set`, `config clear-cache`), whatever the
thread's permission mode. gh's command has to come first (only `--help` and `--version` may come
before it), and so does `alias`'s and `config`'s subcommand. An account that isn't signed in to gh fails the tool call
(and a `wait` with a command, without running it) with a message saying so, and the host skips its
own lookups. `GET /github-accounts` lists the accounts gh is signed in to on a host
(API 50), and profiles and projects take `github_account` (a login, or `HOST/LOGIN` for a GitHub
Enterprise host; null for the default). Agents can't change it with `update_project`.

**How runs reach the board's MCP servers.** The board serves both servers itself, so a run has no
MCP helper process of its own.

A Claude run that takes input (every run but a `/compact`) has the board's tools as an in-process
("SDK") MCP server of Claude Code's, over its control protocol, as its permission prompts are (HA-221,
`apps/server/src/agent/runner/requests.ts`). The run's input starts with an `initialize` control
request that registers the `huntaway` server (`sdkMcpServers`), with no time limit on its calls and
none moved to the background, and gives Claude Code its handshake's results (`sdkMcpServerManifests`:
its `initialize` and `tools/list`, the reviewers' tools for a review thread), so it needn't ask for
them before the first turn. Claude Code sends each MCP message as an `mcp_message` control request
on the run's output (`out.jsonl`), and gets the server's JSON-RPC answer in a `control_response` on
its input (`input.jsonl`). A tool call is a board call like any other (the same dispatch, the same
policy: reviewers' and planning threads' limits, approvals, approval rules, linked hosts), recorded
in `mcp_calls` as `stdio:<run id>:<request id>` with what answering it takes, and its task is its
run's: the run's `mcp.json` has no board server, and the board's HTTP server refuses the run (it has
only `gh` there). After a restart the run's output is followed from its saved offset, past the calls
already read, so those still going (a `wait`, an approval that `delete_task` or `update_project`
asked for) are taken up again from `mcp_calls` and answered when they're done: a `wait` keeps its
deadline and what it watches. A call that may have taken effect before the restart cut it short
(`create_task`, say) isn't run again, and the agent is told so. A call Claude Code gives up on (its
turn was interrupted, or a tool call beside it failed) isn't answered: a `wait` ends, and an approval
that `delete_task` or `update_project` asked for expires, so it can't be given once the agent has
moved on. Claude Code says so with a `notifications/cancelled` MCP message (`mcp_message`) naming the
call's JSON-RPC id, which the board finds among the run's open calls in `mcp_calls`; a permission
prompt it gives up on is a `control_cancel_request` instead. Such runs are run format 4,
which an older build that's rolled back to stops rather than follow, as it couldn't answer their
calls.

Older Codex sessions and compactions reach the board's tools over MCP's streamable HTTP transport, and every
run reaches the `gh` and `docs` servers that way, at `/api/mcp/<run id>/huntaway`, `/api/mcp/<run id>/gh` and `/api/mcp/<run id>/docs` on
the host's internal address (`127.0.0.1:<port>`, the host that runs the agent). Each run's `mcp.json` has them as `http` servers with a bearer token of the
run's own (an HMAC of the run's id with the host's token), which only acts as that run: the server
says which run a call is for, not the agent, and the agent never holds the host's token. What the
`gh` server needs of the run (its working directory and GitHub account) is in the run's folder
(`mcp-run.json`), not in the request. Not through the broker. Claude Code gives an HTTP server's call 5 minutes
without news before it aborts it, so the entries set `timeout` (a day for the board's, as
`MCP_TOOL_TIMEOUT`, and 15 minutes for gh's).

Each tool call is answered as a server-sent event stream that starts with an event id (and a
`retry` time of 5 seconds). When the stream breaks, as a server restart does, Claude Code and
Codex reconnect with that id (`Last-Event-ID`) and get the call's answer on the new stream: the
board's call picks up where it was (a permission prompt or `wait` carries on, a finished call
answers what it recorded, and a call the restart cut short says so, as for a retried helper's
call). A `gh` call's output is lost if the server restarted while it ran, and the agent is told
it may or may not have taken effect. Claude Code tries twice, 5 seconds apart, before it gives
the call up (the agent then sees that it failed); a restart takes a second or two. Codex keeps
trying, with backoff. Claude Code also drops a call 90 seconds after its connection broke unless
the call has made progress since, so the streams send progress notifications every 20 seconds
(and as soon as a client reconnects).

Runs used to start `huntaway mcp` and `huntaway gh-mcp` stdio helpers of their own (before HA-180, or with
`IA_MCP_STDIO=1`), which called `/api/internal/mcp`: HA-225 removed them. Each was a Node process of about 90 MB (RSS)
under the TypeScript server; with five agents running on a test server, each agent's processes came to 424 MB RSS
(242 MB PSS) with the helpers and 239 MB (159 MB PSS) without (HA-180).
