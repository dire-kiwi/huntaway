# Agent tools (MCP)

Each run gets the `huntaway` MCP server, which the board serves itself, in process for Claude runs,
as dynamic tools (a `huntaway` namespace, answered on the run's input) for Codex sessions started
since they were, and over HTTP for older Codex sessions (Codex can't give a session it resumes new
dynamic tools) and compactions (see *How runs reach the board's MCP servers* below):
`list_projects`, `list_tasks`, `get_task`, `get_task_field`, `create_task`, `update_task`, `send_to_task`,
`delete_task` (once the user confirms), `get_project`, `update_project` (a project's settings), `create_project`,
`request_user_input`, `wait` (block until something happens, showing the task as waiting; see
[Waiting](concepts.md)), plus the internal `permission_prompt` (for compactions). Review threads
also get `submit_review`. `create_task` takes `subproject` (add the task to one; agents in a
subproject add to theirs by default) and `is_subproject` (or `type: "subproject"`, API 51), and
`list_tasks` takes `subproject`. `create_task` and `update_task` take `start_from` (API 96, see
[Starting from elsewhere](concepts.md)), and task summaries say what a task started from.

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
to *Ready for merge*, including while that merge waits in *Needs attention*): it runs without
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

**GitHub accounts.** gh can be signed in to several accounts on a host (`gh auth login` once for
each), and each profile can pick which one its agents act as there (*GitHub account* in Settings →
Profiles → Edit, per host); a project can pick its own in its settings, overriding the profile's.
The default is gh's active account. The run's launch records the account for the `gh` server
(or passes it as `IA_GH_ACCOUNT` to a `huntaway gh-mcp` helper), which runs each call with that account's token (`gh auth token --user`) and no
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
(`create_task`, say) isn't run again, and the agent is told so. A call Claude Code cancels (its turn
was interrupted) isn't answered: a `wait` ends, and an approval expires. Such runs are run format 4,
which an older build that's rolled back to stops rather than follow, as it couldn't answer their
calls. With `IA_MCP_STDIO=1` (below), Claude runs get the helpers instead.

Older Codex sessions and compactions reach the board's tools over MCP's streamable HTTP transport, and every
run reaches the `gh` server that way, at `/api/mcp/<run id>/huntaway` and `/api/mcp/<run id>/gh` on
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

Runs started before the board served these (they have `huntaway mcp` and `huntaway gh-mcp` stdio
helpers in their `mcp.json`) keep them: the helpers call `/api/internal/mcp` with the host's
token, which still works. `IA_MCP_STDIO=1` in the server's environment starts new runs with the
helpers too. Each helper is a Node process of about 90 MB (RSS) under the TypeScript server; with
five agents running on a test server, each agent's processes came to 424 MB RSS (242 MB PSS)
with the helpers and 239 MB (159 MB PSS) without (HA-180).
