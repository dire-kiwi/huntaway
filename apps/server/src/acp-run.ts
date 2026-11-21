import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Stream } from "effect"
import { writeSync } from "node:fs"
import { listModels } from "./agents/acp/adapter/models.ts"
import { runAdapter } from "./agents/acp/adapter/run.ts"
import { VERSION } from "./platform/ServerConfig.ts"

// `huntaway acp-run <run dir>/acp.json` (docs/plan/07-agents.md, ACP agents): the ACP adapter, a run's own process under
// ia-shim, between the run's files and an ACP agent (agents/acp/adapter/run.ts says what it does). The launcher
// (bin/huntaway) runs this file directly, as it does codex-run.ts: its stdout is the run's `out.jsonl`, its stderr
// `err.log`, its stdin the prompt and then `input.jsonl`. It exits 0 once the run's work is done, and 1 with why on its
// stderr if it couldn't do it.
//
// `huntaway acp-run --list-models <spec.json>` (the server's model listing) writes one JSON line of the models the
// agent offers (agents/acp/adapter/models.ts) and exits 0; 3 if the agent needs a sign-in (said on its stderr), 1 for
// any other failure.

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

const listing = process.argv[2] === "--list-models"
const specPath = listing ? process.argv[3] : process.argv[2]
const exe = process.env["HUNTAWAY_EXE"] ?? ""
const writeLine = (line: string) => writeAll(1, `${line}\n`)
const warn = (text: string) => writeAll(2, `${text}\n`)

const main = Effect.gen(function* () {
  if (specPath === undefined || specPath === "") return yield* Effect.fail("usage: huntaway acp-run [--list-models] <spec.json>")
  if (listing) yield* listModels(specPath, { writeLine, warn, version: VERSION }).pipe(Effect.scoped)
  else {
    yield* runAdapter(specPath, {
      stdin: Stream.fromAsyncIterable(process.stdin, (e) => e),
      writeLine,
      warn,
      version: VERSION,
      exe: exe === "" ? null : exe,
    }).pipe(Effect.scoped)
  }
  return 0
}).pipe(
  Effect.catch((e) =>
    writeAll(2, `huntaway acp-run: ${typeof e === "string" ? e : e.reason}\n`).pipe(Effect.as(typeof e !== "string" && e._tag === "SignInRequired" ? 3 : 1)),
  ),
  // Its stdin may still be open (the board's input file): the process ends here, once its scope has closed.
  Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
  Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(main)
