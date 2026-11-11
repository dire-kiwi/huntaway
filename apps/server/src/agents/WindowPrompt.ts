import { Context, Effect, Layer, Schema } from "effect"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { claudeCallEnv } from "./configEnv.ts"

// The throwaway prompt that starts a config's next 5-hour window (huntaway's agent/window.ts `send`): Haiku with no
// tools, no MCP servers, no session kept, in the data folder. A service of its own so tests give its output instead
// of running a model.

const SYSTEM_PROMPT = "Reply with only the word OK."
const PROMPT = "OK"

/** The prompt could not be sent, or `claude` failed. */
export class WindowPromptFailed extends Schema.TaggedError<WindowPromptFailed, { readonly brand: unique symbol }>()("WindowPromptFailed", {
  reason: Schema.String,
}) {}

/** What `claude` printed (stream-json lines), and why it failed if it exited badly: its output is read either way. */
export interface PromptOutput {
  readonly stdout: string
  readonly error: string | null
}

export interface WindowPromptShape {
  readonly send: (config: AgentConfigRow) => Effect.Effect<PromptOutput, WindowPromptFailed>
}

export class WindowPrompt extends Context.Service<WindowPrompt, WindowPromptShape>()("huntaway-server/agents/WindowPrompt") {
  /**
   * `claude -p --model haiku --output-format stream-json --verbose --tools "" --strict-mcp-config
   * --no-session-persistence --disable-slash-commands --system-prompt "Reply with only the word OK."`, `OK` on its
   * input, with the config's folder, for up to 60 seconds.
   */
  static readonly layer = Layer.effect(
    WindowPrompt,
    Effect.gen(function* () {
      const proc = yield* Proc
      const server = yield* ServerConfig
      const dataDir = yield* DataDir
      const args = ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config"]
      args.push("--no-session-persistence", "--disable-slash-commands", "--system-prompt", SYSTEM_PROMPT)
      const send = Effect.fn("WindowPrompt.send")(function* (config: AgentConfigRow) {
        const out = yield* proc
          .run(server.claudeBin, args, {
            cwd: dataDir.root,
            env: { ...server.agentEnv, ...claudeCallEnv(config, null, server.home) },
            stdin: PROMPT,
            timeout: "60 seconds",
          })
          .pipe(Effect.mapError((e) => new WindowPromptFailed({ reason: `failed to run claude: ${e.reason}` })))
        const output: PromptOutput = {
          stdout: out.stdout,
          error: out.code === 0 ? null : `claude exited with exit status: ${out.code}: ${out.stderr.trim()}`,
        }
        return output
      })
      return WindowPrompt.of({ send })
    }),
  )
}
