import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result } from "effect"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import { TestPlatform, tempDir } from "@huntaway/testing"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../profiles/AgentConfigRepo.ts"
import { TitleModel } from "./TitleModel.ts"

// The live model call against a stand-in `claude` (a shell script): its arguments, input, folder and environment, and
// how its output is read. No model is called.

const config = (fields: Partial<AgentConfigRow> = {}): AgentConfigRow => ({
  id: AgentConfigId.make("c"),
  name: "c",
  config_dir: "~/.claude-work",
  agent: "claude",
  show_usage: false,
  restart_window: false,
  api_url: null,
  has_api_key: false,
  has_management_key: false,
  created_at: Timestamp.make("2026-11-12T00:00:00.000Z"),
  ...fields,
})

/** A `claude` that records what it was given in `<dir>/seen` and prints `out`, exiting with `code`. */
const fakeClaude = (dir: string, out: string, code = 0) =>
  `#!/bin/sh
{ for a in "$@"; do printf '%s\\n' "[$a]"; done; echo "cwd=$(pwd)"; echo "dir=$CLAUDE_CONFIG_DIR"; echo "in=$(cat)"; } > ${dir}/seen
printf '%s' '${out}'
exit ${code}
`

const withClaude = (out: string, code = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* tempDir
    yield* fs.writeFileString(`${dir}/claude`, fakeClaude(dir, out, code)).pipe(Effect.orDie)
    yield* fs.chmod(`${dir}/claude`, 0o755).pipe(Effect.orDie)
    return dir
  })

const ask = (bin: string, cfg: AgentConfigRow | null) =>
  Effect.gen(function* () {
    const model = yield* TitleModel
    return yield* model.ask(cfg, "the system prompt", "<task>\nx\n</task>")
  }).pipe(Effect.provide(TitleModel.layer.pipe(Layer.provideMerge(AgentConfigRepo.layer), Layer.provideMerge(TestPlatform({ claudeBin: bin })))))

describe("TitleModel", () => {
  it.live("asks Haiku through claude -p, in the data folder, with the config's folder, and reads its result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* withClaude(
        '{"type":"result","is_error":false,"result":"Fix login.","modelUsage":{"claude-haiku-5-5":{"inputTokens":2,"outputTokens":7,"costUSD":0.0002}}}',
      )
      const answer = yield* ask(`${dir}/claude`, config())
      assert.deepStrictEqual(answer.reply, Result.succeed("Fix login."))
      assert.strictEqual(answer.spent?.models["claude-haiku-5-5"]?.output, 7)
      const seen = (yield* fs.readFileString(`${dir}/seen`).pipe(Effect.orDie)).split("\n")
      assert.deepStrictEqual(seen.slice(0, 13), [
        "[-p]",
        "[--model]",
        "[haiku]",
        "[--output-format]",
        "[json]",
        "[--tools]",
        "[]",
        "[--strict-mcp-config]",
        "[--no-session-persistence]",
        "[--disable-slash-commands]",
        "[--system-prompt]",
        "[the system prompt]",
        seen[12] ?? "",
      ])
      assert.isTrue(seen[12]?.startsWith("cwd=") === true && !seen[12].includes(dir), seen[12])
      assert.isTrue(seen[13]?.startsWith("dir=") === true && seen[13].endsWith("/.claude-work"), seen[13])
      assert.strictEqual(seen[14], "in=<task>")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("an error, a failed exit or output that isn't a result fails the call, keeping what it used", () =>
    Effect.gen(function* () {
      const failedResult = yield* withClaude('{"type":"result","is_error":true,"result":"Not logged in","modelUsage":{}}')
      let answer = yield* ask(`${failedResult}/claude`, null)
      assert.deepStrictEqual(answer.reply, Result.fail("claude failed: Not logged in"))
      assert.isNotNull(answer.spent)
      const exited = yield* withClaude("nope", 3)
      answer = yield* ask(`${exited}/claude`, null)
      assert.deepStrictEqual([answer.reply, answer.spent], [Result.fail("claude exited with exit status: 3: "), null])
      const notResult = yield* withClaude('{"type":"assistant"}')
      answer = yield* ask(`${notResult}/claude`, null)
      assert.deepStrictEqual(answer.reply, Result.fail("claude's reply isn't a result"))
      // Codex titles come with Codex (M5): no call.
      answer = yield* ask(`${notResult}/claude`, config({ agent: "codex" }))
      assert.isTrue(Result.isFailure(answer.reply))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
