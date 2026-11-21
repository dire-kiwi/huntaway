import { Effect, FileSystem, Option, Schema } from "effect"
import type { Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { toJson } from "../../../platform/columns.ts"
import { acpAgent } from "../rpc.ts"
import { modelList } from "../session.ts"
import { specFromJson } from "../spec.ts"
import { AGENT_ENV } from "./run.ts"
import { errorText, fail, initialize, newSession } from "./setup.ts"
import type { AdapterError, SignInRequired } from "./setup.ts"

// `huntaway acp-run --list-models <spec.json>`: the models an ACP agent offers, for the server's model pickers. It starts
// the agent with the spec's program and folder, opens a session there with no MCP servers, and writes one line:
// `{"models": [{"id", "name", "description"}], "current", "efforts", "default_effort"}` (session.ts' `modelList`).
// A signed-out agent is `SignInRequired` (the entry exits 3 for it).

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const listModels = (
  specPath: string,
  io: { readonly writeLine: (line: string) => Effect.Effect<void>; readonly warn: (text: string) => Effect.Effect<void>; readonly version: string },
): Effect.Effect<void, AdapterError | SignInRequired, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(specPath).pipe(Effect.mapError((e) => fail(`reading ${specPath}: ${e.message}`)))
    const spec = specFromJson(Option.getOrUndefined(parseJson(raw)))
    if (spec === null) return yield* fail(`${specPath} isn't an ACP spec`)
    const agent = yield* acpAgent({ program: spec.program, args: spec.args, cwd: spec.cwd, env: AGENT_ENV, onStderr: io.warn })
    yield* initialize(agent, io.version)
    const session = yield* newSession(agent, spec.program, spec.cwd, [])
    return yield* io.writeLine(yield* toJson(modelList(session)))
  }).pipe(Effect.catchTag("AcpError", (e) => Effect.fail(fail(errorText(e)))))
