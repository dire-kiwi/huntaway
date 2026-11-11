// What a driver (docs/plan/07-agents.md, The two drivers) hands the runs area to start a run: types only. `agents/`
// sits above `runs/` in the dependency order, so a driver cannot see `Run`, `RunDir` or `RunRepo`; `runs/` takes this
// and writes the folder (`RunDir.prepare`) and starts the shim (`Shim.spawn`).

/** `mcp-run.json`: what the board's HTTP MCP servers need of a run (inventory 01, section 3). */
export interface McpRunSettings {
  /** The run's directory, where gh calls without a `dir` run. */
  readonly cwd: string
  /** The GitHub account the gh server acts as, if not gh's active one. */
  readonly github_account: string | null
  /** A review thread's run: the board's server offers the reviewers' tools. */
  readonly review: boolean
  /** The run calls the board's tools on its own output (an in-process server), so it has no board server: only gh's. */
  readonly in_process: boolean
  /** It was launched with the desktop server. */
  readonly desktop: boolean
}

/** The process to start under ia-shim. */
export interface ProcessSpec {
  readonly program: string
  readonly args: ReadonlyArray<string>
  /** Added to the agent's environment (the server's without its own settings). */
  readonly env: ReadonlyArray<readonly [string, string]>
  /** Absolute, or starting with `~`. */
  readonly cwd: string
}

/** Everything a run's launch needs: the process, and what goes in its folder before the shim starts. */
export interface LaunchSpec extends ProcessSpec {
  /** The config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), recorded in `spec.json`; null for the agent's default. */
  readonly configDir: string | null
  /** The bytes fed to the agent first (`prompt`). */
  readonly prompt: string
  /** The agent reads more input after its prompt (`input.jsonl`) until the server closes it. */
  readonly input: boolean
  /** The uuid of the prompt message whose echo the run's first turn waits for (`awaited`). */
  readonly promptId: string | null
  /** `system-prompt.md` (Claude's `--append-system-prompt-file`), if any. */
  readonly systemPrompt: string | null
  /** `mcp.json`'s servers (written with sorted keys), if any. */
  readonly mcpServers: Readonly<Record<string, unknown>> | null
  readonly mcpRun: McpRunSettings | null
  /** A Codex run's `codex.json` (`agents/codex/spec.ts`' `CodexSpec`), which also marks the run as Codex's; none for Claude's. */
  readonly codex?: unknown
}
