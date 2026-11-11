import { Effect, FileSystem, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"

// The recorded agent sessions (docs/plan/10-testing.md, Recorded agent sessions): agent-threads' 22 Claude and 20 Codex
// scenarios, copied unchanged from the old threads/fixtures, the conformance suite for the two translators and the
// thread reducer. Each scenario's folder has `fixture.json` (what it is and the steps it took), `session.jsonl` (every
// line the CLI read and wrote, with the board's own lines: `{dir: "meta" | "spawn" | "in" | "out", run, t, msg | line…}`)
// and `expected.jsonl` (the thread events agent-threads made of it, with `{{placeholders}}` for its own ids, and the
// events the thread protocol no longer declares: `thread.updated`, `turn.*`, `items.removed`, `turn_id`…). `examples/`
// beside them is agent-threads' spec examples of the protocol (`thread.events.jsonl`, `thread.snapshot.json`…).

/** The folder the recorded sessions are in. */
export const threadFixturesDir = fileURLToPath(new URL("../fixtures/threads", import.meta.url))

export type ThreadHarness = "claude" | "codex"

export interface ThreadScenario {
  readonly harness: ThreadHarness
  /** The folder's name: `plain-reply`, `subagent`… */
  readonly name: string
  readonly dir: string
}

/** A JSON object, as recorded. */
export type JsonObject = Readonly<Record<string, unknown>>

export interface ThreadScenarioData extends ThreadScenario {
  /** `fixture.json`: its description, what it was recorded with, its permission policy and its steps. */
  readonly fixture: JsonObject
  /** `session.jsonl`, a line each. */
  readonly session: ReadonlyArray<JsonObject>
  /** `expected.jsonl`, an event each, as agent-threads made them. */
  readonly expected: ReadonlyArray<JsonObject>
}

const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const parse = Schema.decodeUnknownEffect(JsonObjectFromString)

/** A recorded JSON file's object. */
export const readJsonFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* parse(yield* fs.readFileString(file))
  }).pipe(Effect.orDie)

/** A recorded JSON Lines file's objects, a line each (blank lines skipped). */
export const readJsonLines = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    return yield* Effect.forEach(lines, (line) => parse(line), { concurrency: 1 })
  }).pipe(Effect.orDie)

/** Every scenario, the Claude ones then the Codex ones, each sorted by name. */
export const threadScenarios = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const harnesses: ReadonlyArray<ThreadHarness> = ["claude", "codex"]
  const lists = yield* Effect.forEach(
    harnesses,
    (harness) =>
      Effect.map(fs.readDirectory(path.join(threadFixturesDir, harness)), (names) =>
        names.toSorted().map((name): ThreadScenario => ({ harness, name, dir: path.join(threadFixturesDir, harness, name) })),
      ),
    { concurrency: 1 },
  )
  return lists.flat()
}).pipe(Effect.orDie)

/** A scenario's files, read and parsed. */
export const readThreadScenario = (scenario: ThreadScenario) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fixture = yield* readJsonFile(path.join(scenario.dir, "fixture.json"))
    const session = yield* readJsonLines(path.join(scenario.dir, "session.jsonl"))
    const expected = yield* readJsonLines(path.join(scenario.dir, "expected.jsonl"))
    return { ...scenario, fixture, session, expected } satisfies ThreadScenarioData
  })
