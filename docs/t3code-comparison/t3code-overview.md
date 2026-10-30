# T3 Code: feature overview

A summary of what T3 Code does, area by area, with links to the detailed inventories. Gathered from a
shallow clone of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit `9b1d351`
(2026-10-30, release v0.1.5): its `docs/` and, where the docs lag, its source. The detail files cite the
file each fact came from and mark what was read from code rather than docs.

| Area | Detail |
|---|---|
| Agents, providers, permissions, orchestration, MCP tools, scheduling, checkpoints | [t3code-agents.md](t3code-agents.md) |
| Threads, sidebar, composer, how output renders, shortcuts, themes, settings | [t3code-ui.md](t3code-ui.md) |
| Worktrees, git actions, diffs, PR review, code hosts, terminal, browser, files, secrets | [t3code-source-control.md](t3code-source-control.md) |
| Install, `t3` CLI, remote access, pairing, T3 Connect, mobile and desktop apps, telemetry | [t3code-remote.md](t3code-remote.md) |
| Stack, layout, data model, transport, restarts, API surface, server settings, undocumented features | [t3code-architecture.md](t3code-architecture.md) |

## What it is

- An **"agent harness control surface"**: a web app (`app.t3.codes`, or served by a local server), an
  Electron desktop app and iOS/Android apps that drive the coding agents already installed and logged in on
  your machines. "T3 Code uses those harnesses. It is not a harness." Free and MIT-licensed, by T3 Tools
  (Theo). It uses your own subscriptions and has no local-model support.
- **Early**: version 0.1.5, labelled *Beta*, "very very early, expect bugs"; contributions mostly not
  accepted. Very high change volume (PR numbers above 27,000), nightly builds every 30 minutes, stable
  releases promoted from nightlies.
- **Shape**: an *environment* is one T3 server (Node, Effect 4, SQLite) on one machine that owns the
  providers, agents, files, terminals and browser tabs. Clients connect to any number of environments at
  once. The core is event-sourced: commands, events, read models and follow-up effects commit in one SQLite
  transaction, and clients talk to it over Effect RPC on one WebSocket (about 200 methods, each checked
  against a permission scope such as `orchestration:operate` or `terminal:read`).
- **Work is organised as threads** (durable conversations, one open at a time, in a sidebar), not as a
  board. A thread can run in the project's checkout (the default) or in its own worktree.

## Agents and providers

- **Ten agent drivers**: Codex (`codex app-server`), Claude (the Claude Agent SDK driving the installed
  `claude`), Cursor (`@cursor/sdk`), Grok Build, OpenCode (1.x and 2.x, local or external server), Google
  Antigravity (installed and signed in by T3), Pi, Meta's Muse Code, Vercel's fx, and any agent from the
  **ACP Registry** or a local ACP command.
- **Several accounts per provider** ("provider instances"), each with its own home, env vars (values can
  come from 1Password), accent colour and models. Codex "shadow homes" let two logins continue the same
  thread.
- **A capability system** drives behaviour: each provider declares whether it can roll back, fork, steer,
  ask structured questions, emit plans or expose subagents, and the UI and orchestrator fall back
  (interrupt-and-restart instead of steering, a portable handoff instead of a fork).
- **Switch provider mid-thread**: the same thread continues on another provider, which gets a budgeted
  handoff of the history (16k tokens by default). **Fork from this response** (natively where supported)
  and **merge back** the fork's work.
- **Models**: a picker per thread with favourites, effort, context window (200k/1M), thinking, fast mode;
  a model manifest fetched between releases says which CLI version unlocks which model; custom models;
  a **fallback model** when the default provider runs out of usage.
- **Four permission modes** (*Supervised*, *Auto-accept edits*, *Auto*, *Full access*), mapped to each
  provider's own mechanism; **new threads default to Full access**. Approvals inline (approve, decline,
  always this session); with Claude, typing a reply declines and sends feedback.
- **Plans and questions**: proposed-plan cards with *Refine*, *Implement* and *Implement in a new thread*;
  structured question cards (options, multi-select, attachments); `/goal` keeps an agent going across turns.
- **Turn control**: steer or queue (server-side queue, editable and reorderable), interrupt, **force stop**,
  **Edit from here** (rewind the conversation, optionally the files too), compaction (by hand, by threshold,
  or before the prompt cache expires).
- **After a restart, crash or update** the server stops leftover agents and resumes supported active
  threads with "Continue where you left off." (at most three times in a row). Agents don't outlive the
  server.
- **Usage**: a Usage page that reads every provider's local history (tokens, cache savings, API-equivalent
  cost, custom prices) and pools subscription limits across accounts and machines, with reset credits,
  *Resume at reset* for limited threads, and mobile widgets.

## Orchestration and agent tools

- Every agent session gets T3's **MCP server** (about 65 tools, per-session scoped token):
  `delegate_task` (a child on **any provider and model**, optionally in its own worktree, waking the parent
  when done, never with more permissions than the parent), `create_threads`, thread read/search/send/wait/
  interrupt/configure/organise/fork/merge-back, queue management, worktree handoff, project create/clone,
  PR link/watch/review guides, `schedule_task`, `preview_*` browser automation, `device_*`, `html_preview`,
  `request_secret` (the agent gets a reference, never the value).
- **Native subagents** of Claude, Codex, Cursor, Grok, OpenCode and fx appear as read-only child threads;
  Claude "workflows" are tracked with phases.
- **Outside agents over MCP**: Claude Code, Codex or ChatGPT can sign in to an environment's `/mcp` with
  OAuth and a pairing code, read-only or up to a chosen permission level. `t3 thread start|send|show|list`
  does the same from a shell.
- **Scheduled tasks and webhooks**: run a prompt on an interval, at a time of day, or per webhook (HMAC
  checks, filters, dedupe, coalescing; the relay can hold webhooks while the machine is offline), in a new
  thread or queued into an existing one. Agents can create them.
- **Linked environments** (beta): agents on one machine can run, message and delegate to threads on
  another, under an access ceiling.

## Threads and the UI

- **Sidebar sections** *Pinned / Active / Working / Snoozed / Settled*, with status labels (*Approval*,
  *Input*, *Working*, *Failed*, *Limited*, *Plan Ready*, *Done* while unseen), server-synced unread state,
  search including message text, multi-select bulk actions, undo, snooze presets, and **auto-settle**
  (after 3 inactive days or when the thread's PR merges).
- **Composer**: a Markdown rich-text editor; inline **context chips** for files (`@`), threads, machines,
  PRs (`#`), skills (`$`), commands (`/`), terminal excerpts, diff review comments, browser annotations and
  quoted assistant text; up to 100 attachments; prompt recall and a prompt stash; prompt links that open a
  pre-filled draft; voice input on iPhone.
- **Output**: virtualised timeline, grouped tool calls with live command output, per-turn changed-file
  cards, syntax-highlighted code with *Run in terminal*, Mermaid, maths, a timeline minimap, find in thread
  (server-side), **visual replies** (agents publish sandboxed HTML pages) and MCP Apps (Codex).
- **Panels** beside the thread: browser, terminal, files (view and edit), diff, PR, device; a thread
  details card (environment, scripts, branch and PR, git actions, running dev servers with *Stop*,
  automations, lineage, usage).
- **About 75 configurable shortcuts** (`keybindings.json` with `when` conditions), a command palette,
  F6 focus cycling, light and dark themes with a theme editor and VS Code theme import, browser and
  desktop notifications with sound and a dock badge.
- **One prompt, several models**: Shift-click models to start one thread and worktree per model.
- No board, kanban or split view of several threads; no task dependencies; no time tracking.

## Source control and review

- **Worktrees are optional**: per project, machine or the repository's `t3.json`, defaulting to the
  current checkout. Worktrees can be shared between threads and reused; a model names the branch after the
  first message; cleanup policies (inactive days, settled, merged) keep branches.
- **Per-turn checkpoints** as hidden git refs: diffs of each turn's own changes, and file rewind for
  worktree threads.
- **Git actions** from the thread: *Commit*, *Commit & push*, *Commit, push & PR* with model-written
  messages that follow the repository's style and PR templates. No local merge, stash or staging.
- **Diff pane**: per turn, branch vs base, uncommitted or per commit; split or stacked, file tree, find;
  line comments become chips sent to the agent.
- **Pull requests page and review UI** across seven code hosts (GitHub and GitHub Enterprise, GitLab,
  Forgejo/Gitea, Bitbucket, Azure DevOps, GitCafe; Jujutsu detected but not implemented): line comments,
  verdicts, viewed-file marks, merge methods, auto-merge, stacks, labels, reviewers. *Fix in a thread* and
  *Resolve conflicts* hand a PR to an agent. **Review guides** (beta): a model writes a guided tour of a PR.
- **PR watch**: an agent can watch its PR and is woken on failed checks, new comments or conflicts; a
  merged PR settles the thread.

## Workspace tools

- **Terminal**: server-owned PTYs per thread, split panes, 5,000 lines of history kept across restarts,
  rendered with Ghostty's VT core (WebAssembly); *Add to chat* sends an excerpt to the agent.
- **Built-in browser**: tabs, device viewports, profiles with cookies imported from your browser, element
  annotation and screen recording; agents drive it with Playwright-like tools; a headless Chromium on the
  server streams it to remote clients; dev servers are discovered automatically.
- **Devices**: live, interactive iOS Simulator and Android Emulator screens that agents can drive too
  (local, over SSH, or Expo's cloud).
- **Files**: tree, viewer for code, Markdown, PDF, Office, notebooks and media, in-app editing, fuzzy file
  picker and content search, *Open in* 20+ editors (remote-aware).
- **SnapShots** (desktop): a global shortcut captures any app window, with its accessibility text, into the
  draft.

## Remote, multi-machine and clients

- **Many machines in one client**: each saved machine has ordered routes (LAN, Tailscale, SSH, T3 Connect)
  and the client moves to the fastest one that answers. **T3 Connect** (a Clerk account and a hosted relay;
  traffic goes through a Cloudflare tunnel, not the relay) reaches machines from anywhere; free for 3
  machines.
- **Pairing**: one-time pairing links and QR codes with scoped, revocable sessions; `t3 auth` for headless
  servers; desktop-managed SSH environments that install and start T3 on the remote host; WSL backends.
- **Load balancing** of new threads across machines by CPU and memory (off by default).
- **Mobile apps** (iOS/Android): threads, approvals, questions, diffs and full PR review, terminal, files,
  browser and device streams, offline drafts and queue, push notifications, iOS Live Activities and Android
  Live Updates, a usage widget, a share extension.
- **Guest links** (beta): share one thread read-only with one browser for 24 hours; the guest can only
  propose messages.
- **Desktop app**: auto-update, deep links, notification badge, macOS default browser, remote-only mode.

## Install, updates and operations

- `curl … | sh`, `npx t3`, or desktop packages (Homebrew, winget, scoop, deb, AppImage, AUR, Nix). The
  `t3` CLI: `start`, `serve`, `pair`, `auth`, `connect`, `environment`, `service`, `update`, `doctor`,
  `project`, `thread`, `theme`, `trace`, `triage`.
- **Background service** (systemd user unit or launchd) with staged updates that roll back on failure,
  including a database snapshot; **Update everything** updates provider CLIs, servers and the desktop app on
  every connected machine.
- **Telemetry** on by default (server-side product analytics without prompts or content; opt out with an
  env var), optional OpenTelemetry export, a diagnostics page with a process list, and `t3 triage`, which
  hands a T3 problem to Claude or Codex.
