import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Stream } from "effect"
import { writeSync } from "node:fs"
import { homedir } from "node:os"
import { runAdapter } from "./agents/codex/adapter/run.ts"
import { VERSION } from "./platform/ServerConfig.ts"

// `huntaway codex-run <run dir>/codex.json` (docs/plan/06-server.md, The CLI): the Codex adapter, a run's own process
// under ia-shim, between the run's files and `codex app-server` (agents/codex/adapter/run.ts says what it does). The
// launcher (bin/huntaway) runs this file directly, not through bin.ts and effect/cli: its stdout is the run's
// `out.jsonl`, its stderr `err.log`, its stdin the prompt and then `input.jsonl`. It exits 0 once the run's work is done,
// and 1 with why on its stderr if it couldn't do it.

/** A whole line, at once: nothing is lost when the process exits, and no line is split by another. */
const writeAll = (fd: number, text: string) =>
  Effect.sync(() => {
    const bytes = Buffer.from(text, "utf8")
    let at = 0
    while (at < bytes.length) {
      try {
        at += writeSync(fd, bytes, at)
      } catch (e) {
        // A non-blocking pipe full for a moment is written again; a reader that's gone (EPIPE) ends the writing.
        if (!(e instanceof Error && "code" in e && e.code === "EAGAIN")) return
      }
    }
  })

const specPath = process.argv[2]
const program = process.env["HUNTAWAY_CODEX_BIN"] ?? "codex"
const home = process.env["HOME"] ?? homedir()

const main = Effect.gen(function* () {
  if (specPath === undefined || specPath === "") return yield* Effect.fail("usage: huntaway codex-run <run dir>/codex.json")
  yield* runAdapter(specPath, {
    stdin: Stream.fromAsyncIterable(process.stdin, (e) => e),
    writeLine: (line) => writeAll(1, `${line}\n`),
    warn: (text) => writeAll(2, `${text}\n`),
    program,
    home,
    version: VERSION,
  }).pipe(Effect.scoped)
  return 0
}).pipe(
  Effect.catch((e) => writeAll(2, `huntaway codex-run: ${typeof e === "string" ? e : e.reason}\n`).pipe(Effect.as(1))),
  // Its stdin may still be open (the board's input file): the process ends here, once its scope has closed.
  Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
  Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(main)
