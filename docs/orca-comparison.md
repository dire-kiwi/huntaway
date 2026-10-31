# Orca and Huntaway

A comparison of [Orca](https://github.com/stablyai/orca) (Stably AI's "agent development environment", v1.4.245,
released 2026-10-30) with Huntaway (`master` at `7fe14c6`, API 79), for task HA-48. The Orca facts come from its
README, its docs at [onorca.dev](https://www.onorca.dev/docs) and its release notes, read on 2026-11-01. Orca wasn't
installed or run. "Not found" means the pages read don't mention it, not that Orca lacks it. Pages not read include
Session restore, Chat UI, Annotate AI Diff and the Settings reference. The Huntaway facts come from `README.md`
and [the HA-6 inventory](t3code-comparison/huntaway-features.md), updated for what came after it (API 61).

This covers `stablyai/orca`. A separate, early project, [orca-cli/orca](https://github.com/orca-cli/orca), is a
Go CLI that runs Claude Code, Codex and Aider in worktrees with a DAG of runs, a TUI review queue and an MCP
server. Both install a command named `orca`.

**In one line:** Orca is an IDE for driving a fleet of terminal agents yourself. Huntaway is a pipeline that
carries agent tasks through review and merge with less driving. Orca is far wider: about 50 agents, an editor, a
browser, five code hosts and native phone apps. Huntaway goes deeper on what happens after the agent stops:
automatic review, fix rounds, a merge queue, dependencies, checkpoints, and agents that survive restarts.

## Side by side

| | Orca | Huntaway | Ahead |
|---|---|---|---|
| Form factor | Electron desktop app (macOS, Windows, Linux) with installers, Homebrew, AUR and signed Windows builds; MIT | Self-hosted Rust server and web UI, Electron shell, installable on a phone as a web app; built from source | Orca |
| Unit of work | A worktree with its agent terminals, tabs and browser | A task card: a thread together with its worktree, branch, review and merge | — |
| Telemetry | Anonymous usage data to PostHog, on unless turned off | None | Huntaway |
| Agents | About 50 CLIs (Claude Code, Codex, Gemini, Cursor, Copilot, OpenCode, Pi, Amp, Goose…) plus any terminal command | Claude Code and Codex | Orca |
| How agents run | In real terminals (TUI); an opt-in Chat UI for some; status from terminal titles and hooks | Headless structured streams, shown as a thread with tool calls, diffs and subagents | — |
| Permissions | Each CLI's bypass flag by default ("Yolo", e.g. `--dangerously-skip-permissions`); "Manual" in Settings | Six modes per host, project and thread, Ask by default; approval cards; project and automation changes always ask | Huntaway |
| Questions and plans | A "waiting" status; answer in the terminal or Chat UI; Claude plan approval | Question cards with options, AskUserQuestion and Codex questions, plan approval that picks the next mode | Huntaway |
| Steering and context | Typing into the agent's terminal or chat | Steering mid-turn, queued messages, `/compact` and idle compaction, context breakdown | Huntaway |
| Accounts | Hot-swaps Claude and Codex accounts | Profiles with their own logins, projects, GitHub accounts and boards; Copy login between hosts | — |
| Usage and cost | About 11 providers, reset timers, an 80% warning; estimated cost from a local price table | Claude and Codex plan limits; actual cost per run and task (Claude); time report, calendar, disk | Orca |
| Creating worktrees | From the base ref, another branch (to stack on a PR), a SHA or a remote branch; parent workspaces | From the freshly fetched base branch; tasks in a subproject branch from the subproject's branch | Orca |
| Worktree setup | Shared paths, `sharedDirectories`, `.worktreeinclude` (ignored files to copy), a cloud VM or sandbox per worktree | Setup and teardown scripts; worktrees can be turned off per project or task | Orca |
| Cleaning up | Delete worktree and branch in one click; sleep, archive, bulk delete that keeps unmerged branches | Remove merged worktrees when nothing would be lost; Done status script; reclaimable space on the disk tab | — |
| Changes and diffs | A diff against the start ref; Annotate AI Diff sends line comments to the agent; commit | Lazygit-style Changes tab: stage lines, commit, amend, stash, reset, each turn's diff, line comments to the agent | Huntaway |
| Checkpoints and rewind | Not found | A checkpoint per turn; rewind files and conversation | Huntaway |
| Automatic AI review | Not found | Up to six reviewer agents per project, with fix rounds | Huntaway |
| PR review in the app | Checks with failing logs, review threads, reactions; "Fix broken checks" sends failures to an agent | PR link and preview dot on the card; review happens on GitHub | Orca |
| Merging | You merge from the PR view (auto-merge, stacked PRs, "Merge through #N") | The agent merges in Ready for merge, one task at a time per project; dependent tasks then start | Huntaway |
| Code hosts | GitHub, GitLab, Bitbucket Cloud, Azure DevOps, Gitea | GitHub (Enterprise too), with GitHub accounts per profile and project | Orca |
| Issue trackers | GitHub and GitLab issues, GitHub Projects boards, Linear and Jira links | Asana links; webhook automations can turn GitHub issues into tasks | Orca |
| Board | Experimental Agent Dashboard (a kanban of agents: Needs you, Working, Done, Idle); Agents feed | Kanban and list boards per project, group, subproject and profile; seven columns; filters, stars, reminders | Huntaway |
| Lifecycle automation | Status comes from the agent; you move the work along | Columns follow the agent; review and merge start from columns; status scripts | Huntaway |
| One prompt, many agents | A recipe: make N worktrees, paste the prompt into each, compare diffs by eye, PR the winner | `!model` makes one task per model; siblings show each other's state and cost; no compare view | — |
| Agents driving agents | Experimental CLI orchestration: runs, a task DAG, dispatches, supervised workers, decision gates, workers on other hosts | Board MCP tools, dependencies, subprojects, group tasks, plans that break into tasks, across profiles and hosts | — |
| Scheduled and triggered work | Automations on presets, cron or RRULE, with a precheck; no webhooks found | Interval, time of day, or signed GitHub webhooks with filters, de-duplication and coalescing | Huntaway |
| Documents | Markdown editing; HTML, Mermaid, PDF and image viewers | Plan, Artifact and Diagram labels: versioned agent-written documents, with questions in plans | — |
| Terminal | WebGL terminals, unlimited splits, scrollback that survives restarts | A tmux shell per task that survives restarts; terminal tool buttons | Orca |
| Editor and files | Monaco editor, file explorer, Quick Open, Cmd-J palette | None | Orca |
| Browser and computer use | Chromium per worktree, Design Mode (click an element to send it to the agent), DevTools, computer use | None; a preview URL dot | Orca |
| Extending it | Plugins (themes, highlighting, custom editors); external MCP servers; Orca's skills | Skills and MCP servers per profile and project; prompts per column; status scripts | — |
| Remote machines | SSH worktrees with port forwarding; Remote Orca Servers (beta); cloud VMs per worktree | Hosts join one board (added, dialling out, or over SSH); a broker; hosts update to a commit; board tools span hosts | — |
| Surviving restarts | Remote sessions survive disconnects and closing the app; local quits not covered by the pages read | Agents run under `ia-shim` and survive server restarts; tool calls run once; pending prompts persist | Huntaway |
| Phone | Native iOS and Android companions (beta) with dictation, chat or terminal, commits, push | A narrow layout, installable as a web app, with web push | Orca |
| Notifications | On agent idle: system notification, sound, unread chip, inbox, dock badge | Browser notifications or a chime per event, tab and dock badges, phone push | — |

## What Huntaway could take from Orca

Ranked by value for effort:

1. **A compare view for fan-out siblings**: the `!model` siblings' diffs, cost and review results together, and
   "Pick this one" to keep the winner and close the others. Orca's own "race" is manual.
2. **Copy ignored files into new worktrees**: a project setting listing files (`.env`, local config) to copy and
   folders to symlink, like `.worktreeinclude`, with no setup script needed.
3. **"Fix broken checks"**: when a task's PR checks fail, offer to send the failing jobs and log tails to its agent.
4. **Usage resets and limits**: when each limit resets, a warning at 80%, and holding new runs or switching to the
   profile's next config when one runs out.
5. **Start a task from another ref**: a branch, PR or SHA, to stack on a PR in review without a subproject.
6. **A preview browser with an element picker**, like Design Mode, on the task's preview URL.
7. **Terminal tasks for other CLIs** (Gemini, OpenCode, Cursor…), run in the task's tmux terminal and tracked on
   the board.
8. **Installers**: AppImage, `.dmg`, a Homebrew tap.

## Sources

[README](https://github.com/stablyai/orca) and [releases](https://github.com/stablyai/orca/releases);
docs: [worktrees](https://www.onorca.dev/docs/model/worktrees), [supported agents](https://www.onorca.dev/docs/agents/supported),
[agents & sessions](https://www.onorca.dev/docs/model/agents-sessions), [race three agents](https://www.onorca.dev/docs/recipes/parallel-agents),
[orchestration](https://www.onorca.dev/docs/cli/orchestration), [automations](https://www.onorca.dev/docs/cli/automations),
[skills & MCP](https://www.onorca.dev/docs/cli/skills), [hosted reviews](https://www.onorca.dev/docs/review/github),
[notifications](https://www.onorca.dev/docs/notifications), [agents feed](https://www.onorca.dev/docs/activity),
[SSH](https://www.onorca.dev/docs/ssh), [ways to run](https://www.onorca.dev/docs/ways-to-run),
[remote servers](https://www.onorca.dev/docs/remote-servers), [mobile](https://www.onorca.dev/docs/mobile),
[usage tracking](https://www.onorca.dev/docs/agents/usage-tracking), [telemetry](https://www.onorca.dev/docs/telemetry);
[Better Stack's guide](https://betterstack.com/community/guides/ai/orca-ai/).
