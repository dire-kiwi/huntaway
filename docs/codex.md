# Codex agents

A thread whose config is a Codex one runs `huntaway codex-run` under ia-shim instead of
`claude -p`. That adapter starts `codex app-server`, starts (or resumes) the thread's Codex
thread, sends the prompt, steers messages sent meanwhile into the turn (`turn/steer`), and exits
when its input ends with no turn going. Codex's events are kept in the run's
output as they are, and the server writes them into the thread's items as they come (see
[docs/threads.md](threads.md), "Codex writes items directly"), shown like Claude's: commands as Bash calls, file
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

| Mode | Codex |
|---|---|
| Ask | asks before anything but known-safe commands (`untrusted`) |
| Accept edits | edits in the sandbox go ahead, asks to leave it (`on-request`) |
| Auto | Codex's own reviewer decides (`on-request`, `auto_review`) |
| Plan | read-only sandbox, Codex's plan mode |
| Don't ask | never asks; what the sandbox blocks fails (`never`) |
| Bypass | no sandbox, never asks (`danger-full-access`) |

Reviewers run in a read-only sandbox that can still write the temp directories, the package caches
and the worktree's git-ignored directories (such as `target` or `node_modules`, but not `.claude`
or `.codex`), so they can build the work and run its tests without being able to change it. This
uses a Codex permission profile (`huntaway-review`, a beta feature); a Codex that doesn't take it
gets a plain read-only sandbox. A thread's model and effort are Codex's own (the new task
dialog lists the config's models); Claude models set on its project, profile or host are
skipped. Auto-compacting idle sessions is Claude-only.
