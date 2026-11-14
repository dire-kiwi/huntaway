# Inventory of the old code

What Huntaway does today, area by area, read from `dire-kiwi/huntaway-legacy` at commit `f2298f0c` (11 November 2026). These
eleven notes are the checklist the port is held to: each lists an area's capabilities, data, in-memory state, processes,
timers, routes, events and the rules its comments record, and ends with what looks accidental and what is essential.

They were written by survey agents reading the source (nothing was run), one per area, to a common brief. They describe
the old code's structure, names and file paths, **not** the new design: read them for behaviour, and read
[the plan](../README.md) for where that behaviour goes. Where a note and the old source disagree, the source is right.

| Note                                           | Covers (old paths under `apps/server/src/` unless said)                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [01-run-lifecycle.md](01-run-lifecycle.md)     | `agent/runner*`, `agent/runs*`, `agent/codex*`, `rust/shim`: launching, following, steering, stopping, restart  |
| [02-agent-support.md](02-agent-support.md)     | The rest of `agent/`: configs, usage, titles, prompts, skills and MCP servers, approval rules, documents, docs, pens, the assistant |
| [03-mcp.md](03-mcp.md)                         | `mcp.ts`, `mcp/`: the four MCP servers and every tool, permissions, questions, `wait`, PR watching, the hooks    |
| [04-git-review.md](04-git-review.md)           | `git/`, `review*`: worktrees, the Changes tab, checkpoints, the merge queue, stacks, automatic review            |
| [05-hosts-update.md](05-hosts-update.md)       | `hosts/`, `update/`, `settings_sync.ts`, `devices.ts`, `desktop*`: links, relay, discovery, terminals, updates   |
| [06-integrations.md](06-integrations.md)       | `integrations/`: workflows, automations, push, Asana, GitHub repositories, hosted docs, status scripts           |
| [07-server-root-api.md](07-server-root-api.md) | `main.ts`, `serve.ts`, `api*`: the CLI, startup order, auth, all 183 routes, task status rules, telemetry         |
| [08-threads.md](08-threads.md)                 | `threads/`: the item model, translation from Claude and Codex output, the live protocol, the readers             |
| [09-data-model.md](09-data-model.md)           | `db*`, `wire/`: all 54 tables, the task row, settings keys, enumerations, legacy forms in existing rows          |
| [10-web-client.md](10-web-client.md)           | `apps/web`, `packages/client`, the Electron shell: the store, the event feed, fetching patterns, storage keys    |
| [11-mobile-tooling.md](11-mobile-tooling.md)   | `apps/mobile`, `scripts/`, CI, packaging and releases                                                            |

Row counts in 09 come from one board's database, read read-only for its schema and counts.
