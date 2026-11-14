# huntaway-effect

[Huntaway](https://github.com/dire-kiwi/huntaway-legacy), a kanban board for orchestrating Claude Code and Codex agents,
written again on [Effect](https://effect.website) v4.

The port is under way. **[docs/plan/](docs/plan/README.md)** is the plan: the architecture, the directory layout
and dependencies, the shapes of the types, the protocol, every service, how the frontend moves over, how an existing
board's database is imported, and the tasks. Beside it are [an inventory](docs/plan/inventory/README.md) of what the
old code does and [a spike](docs/plan/spike/README.md) that ran the plan's building blocks against Effect 4.1.4.

How code is written here is [docs/effect.md](docs/effect.md); how to work in a checkout is [CLAUDE.md](CLAUDE.md).

```sh
pnpm install
pnpm check        # format, lint, type check and Effect's rules: every rule an error
pnpm test         # the server's and the packages' tests
cargo test        # ia-shim
```
