# T3 Code and Huntaway

Feature inventories of [T3 Code](https://github.com/pingdotgg/t3code) (v0.1.5, commit `9b1d351`,
2026-10-30) and of Huntaway (commit `90bb99b`, API 61), and a comparison of the two (task HA-6).

**In one line:** T3 Code is a control surface for agent *conversations*: many agents, many machines, phones
included, with rich tools around each thread. Huntaway is a workflow engine for agent *tasks*: a board on which
agents carry work through review and merge, with less driving from you. [comparison.md](comparison.md) has the
detail.

| File | What's in it |
|---|---|
| [comparison.md](comparison.md) | The difference, a side-by-side table, area-by-area comparison, where each is ahead, and what Huntaway could take from T3 Code |
| [t3code-overview.md](t3code-overview.md) | T3 Code's features in summary, linking the detail files below |
| [t3code-agents.md](t3code-agents.md) | Providers, models, permissions, plans, steering, subagents, forks and handoffs, orchestration, its MCP tools, outside agents, usage, checkpoints, scheduled tasks, evals |
| [t3code-ui.md](t3code-ui.md) | Threads and the sidebar, the composer, how output renders, panels, shortcuts, palette, themes, notifications, settings, onboarding |
| [t3code-source-control.md](t3code-source-control.md) | Worktrees, git actions, checkpoints, the diff pane, code hosts, PR review, project settings, terminal, browser, files, secrets |
| [t3code-remote.md](t3code-remote.md) | Install, the `t3` CLI, background service, updates, remote access and T3 Connect, pairing, guest links, devices, mobile and desktop apps, telemetry |
| [t3code-architecture.md](t3code-architecture.md) | Status and goals, stack, monorepo layout, data model, transport, restarts, the full API and MCP surface, server settings, undocumented features |
| [huntaway-features.md](huntaway-features.md) | Huntaway's features, area by area, in the same order as T3 Code's |
| [huntaway-ui-details.md](huntaway-ui-details.md) | Every Huntaway page, card badge, menu, dialog and shortcut, and UI gaps |
| [huntaway-server-details.md](huntaway-server-details.md) | Huntaway's CLI, API routes, data model, how runs are launched, what agents are told, and limits |

The T3 Code files were written by five research agents from a read-only clone (its docs, then its source
where the docs lag) and cite the file behind each fact; "(from code)" marks facts not in its docs. The
Huntaway files come from `README.md` and two agents' sweeps of `app/` and `server/`. Nothing in T3 Code was
built or run, so its behaviour is as documented or as read from code.
