import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import type { PlatformError } from "effect"
import type { RunId } from "@huntaway/contracts"
import type { LaunchSpec, McpRunSettings } from "../agents/AgentDriver.ts"
import { specFromJson } from "../agents/codex/spec.ts"
import type { CodexSpec } from "../agents/codex/spec.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"

// A run's folder, `<data dir>/runs/<run id>/` (docs/plan/07-agents.md, The run folder; inventory 01, section 3): the
// interface between the server and a run's ia-shim. This is the one module that reads and writes it, with a schema
// for each file. The format is stable: shims and agents started by an older build keep running after an upgrade, so
// a change must be additive, and one older readers cannot follow needs a new `RUN_FORMAT`.

/** The format of the folders this build writes: 6, the first of this code base. */
export const RUN_FORMAT = 6
/** The oldest format this build follows: 5, the old server's last (formats 1 to 4 need no run to be going to switch). */
export const OLDEST_RUN_FORMAT = 5

/** How much of a run's output is read at a time, unless a line is longer. */
export const OUTPUT_CHUNK = 1 << 20
/** How much of the end of `err.log` a failure quotes. */
export const ERROR_TAIL = 4000

/** `run.json`. Missing is format 1. */
export const RunHeader = Schema.Struct({
  boot: Schema.optional(Schema.NullOr(Schema.String)),
  format: Schema.optional(Schema.Unknown),
  version: Schema.optional(Schema.String),
})
export type RunHeader = typeof RunHeader.Type

/** The format a header says, as the old server read it: a missing or odd one is 1. */
export const headerFormat = (header: RunHeader | null): number => {
  const format = header?.format
  return typeof format === "number" && Number.isInteger(format) && format >= 0 ? format : 1
}

/** Whether this build follows a run of that header: `newer` was started by a newer huntaway. */
export const formatSupport = (header: RunHeader | null): "supported" | "newer" | "older" => {
  const format = headerFormat(header)
  return format > RUN_FORMAT ? "newer" : format < OLDEST_RUN_FORMAT ? "older" : "supported"
}

/** `exit`, as the shim (or the server, for a vanished shim) writes it: `{"code":N|null,"signal":N|null[,"error":"…"]}`. */
export const RunExit = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.Int),
  error: Schema.optional(Schema.String),
})
export type RunExit = typeof RunExit.Type

/** `exit` read leniently: a field that is not an integer (or a string, for `error`) is not there. */
const ExitFile = Schema.fromJsonString(
  Schema.Struct({ code: Schema.optional(Schema.Unknown), signal: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Unknown) }),
)

/** `spec.json`: what the shim was (or is about to be) started with. Its existence means "the shim may start". */
export const RunSpec = Schema.Struct({
  args: Schema.Array(Schema.String),
  config_dir: Schema.NullOr(Schema.String),
  cwd: Schema.String,
})
export type RunSpec = typeof RunSpec.Type

/** `mcp-run.json`, read leniently as the old server did. */
const McpRunFile = Schema.Struct({
  cwd: Schema.optional(Schema.Unknown),
  github_account: Schema.optional(Schema.Unknown),
  review: Schema.optional(Schema.Unknown),
  in_process: Schema.optional(Schema.Unknown),
  desktop: Schema.optional(Schema.Unknown),
})

/** The markers of a kill to carry on after a restart: of a launch given up on (`reap`), of a vanished shim's agent (`orphan`). */
export type RunMarker = "reap" | "orphan"

/** What `readOutput` found. */
export interface OutputChunk {
  /** Whole lines (and, once the run has exited, a last line without its newline), without their newlines. */
  readonly lines: ReadonlyArray<string>
  /** The byte offset after each line (its newline included): what is applied once that line is. */
  readonly ends: ReadonlyArray<number>
  /** The byte offset after them. */
  readonly end: number
  /** The `exit` file, if it existed before the output was read. */
  readonly exit: RunExit | null
  /** It has exited and everything it wrote has been read. */
  readonly drained: boolean
}

/** A file of a run's folder could not be written. */
export class RunFileError extends Schema.TaggedError<RunFileError, { readonly brand: unique symbol }>()("RunFileError", {
  run: Schema.String,
  file: Schema.String,
  reason: Schema.String,
}) {}

const textDecoder = new TextDecoder()

/**
 * Lines of output, as the old server split them (a `\r` before a newline dropped), each with the offset after it:
 * `bytes` were read from `offset`.
 */
const splitLines = (bytes: Uint8Array, offset: number): { readonly lines: ReadonlyArray<string>; readonly ends: ReadonlyArray<number> } => {
  const lines: Array<string> = []
  const ends: Array<number> = []
  let start = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const stop = newline < 0 ? bytes.length : newline
    const line = textDecoder.decode(bytes.subarray(start, stop))
    lines.push(line.endsWith("\r") ? line.slice(0, -1) : line)
    start = newline < 0 ? bytes.length : newline + 1
    ends.push(offset + start)
  }
  return { lines, ends }
}

/** `value` with its objects' keys sorted, as `mcp.json` is written. */
export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    )
  }
  return value
}

const failed = (run: RunId, name: string) => (e: PlatformError.PlatformError | Schema.SchemaError) => new RunFileError({ run, file: name, reason: e.message })

const integer = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : null)

const encodeJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, pretty = false) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.toType(schema), pretty ? { space: 2 } : {}))

const decodeJson = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))

const Pid = /^[+-]?\d+$/

const parsePid = (text: string): number | null => {
  const trimmed = text.trim()
  if (!Pid.test(trimmed)) return null
  const n = Number(trimmed)
  return n >= -2147483648 && n <= 2147483647 ? n : null
}

export interface RunDirShape {
  /** The folder of every run. */
  readonly root: string
  /** A run's folder. */
  readonly path: (run: RunId) => string
  /** This boot of the machine's id, if it can be told: what `run.json` records, so pids are never trusted after a reboot. */
  readonly boot: string | null
  /** The names of the folders under `runs/` (for the pruner). */
  readonly list: Effect.Effect<ReadonlyArray<string>>
  readonly exists: (run: RunId) => Effect.Effect<boolean>
  /** Its shim started it (it has `out.jsonl` or `exit`). */
  readonly started: (run: RunId) => Effect.Effect<boolean>
  readonly remove: (run: RunId) => Effect.Effect<void, RunFileError>
  readonly make: (run: RunId) => Effect.Effect<void, RunFileError>

  /** Write `run.json` for this boot, at `RUN_FORMAT`. */
  readonly writeHeader: (run: RunId) => Effect.Effect<void, RunFileError>
  /** `run.json`; null when missing or unreadable (format 1). */
  readonly header: (run: RunId) => Effect.Effect<RunHeader | null>
  /** The machine has rebooted since the run started, so its recorded pids may be other processes now. */
  readonly rebooted: (run: RunId) => Effect.Effect<boolean>
  /**
   * Everything the shim needs, in the old order: the folder, `run.json`, `prompt`, `input.jsonl` (when it takes
   * input), `awaited`, `mcp-run.json`, `mcp.json`, `system-prompt.md`, and `spec.json` last (`reap` goes by it).
   */
  readonly prepare: (run: RunId, spec: LaunchSpec) => Effect.Effect<void, RunFileError>

  readonly writePrompt: (run: RunId, prompt: string) => Effect.Effect<void, RunFileError>
  /** An empty `input.jsonl`: the shim relays it to the agent after its prompt. */
  readonly createInput: (run: RunId) => Effect.Effect<void, RunFileError>
  /**
   * Send the agent a line of input (`line` trimmed at the end, plus a newline), in one append so the shim never
   * relays half a line. False, writing nothing, when it takes none: no `input.jsonl`, or `input.closed` or `exit`.
   */
  readonly appendInput: (run: RunId, line: string) => Effect.Effect<boolean, RunFileError>
  /** End the agent's input (`input.closed`): it exits once it has dealt with what it was sent. Idempotent. */
  readonly closeInput: (run: RunId) => Effect.Effect<void, RunFileError>
  readonly inputClosed: (run: RunId) => Effect.Effect<boolean>
  /** Whether the agent still reads input (`input.jsonl`, and neither `input.closed` nor `exit`). */
  readonly acceptsInput: (run: RunId) => Effect.Effect<boolean>
  /** What the agent has written to its input file so far (tests). */
  readonly input: (run: RunId) => Effect.Effect<string>

  /**
   * Output from `offset`: whole lines only, unless the run has exited. Reads up to `max` bytes (1 MiB), doubling while
   * a single line is longer. A file shorter than the offset reads as nothing new.
   */
  readonly readOutput: (run: RunId, offset: number, max?: number) => Effect.Effect<OutputChunk>
  /** The last 4000 bytes of `err.log`. */
  readonly errorTail: (run: RunId) => Effect.Effect<string>
  /** `shim.pid` and `pid` (the agent's, also its process group's). */
  readonly pids: (run: RunId) => Effect.Effect<{ readonly shim: number | null; readonly agent: number | null }>
  /** `exit`, or null before it has one. One that cannot be read is an exit with nothing known. */
  readonly exit: (run: RunId) => Effect.Effect<RunExit | null>
  /** Write `exit` (for a shim that vanished without writing it). */
  readonly writeExit: (run: RunId, exit: RunExit) => Effect.Effect<void, RunFileError>

  readonly writeSpec: (run: RunId, spec: RunSpec) => Effect.Effect<void, RunFileError>
  readonly spec: (run: RunId) => Effect.Effect<RunSpec | null>
  /** `mcp.json`'s path, for `--mcp-config`. */
  readonly mcpConfigPath: (run: RunId) => string
  readonly writeMcpConfig: (run: RunId, servers: Readonly<Record<string, unknown>>) => Effect.Effect<void, RunFileError>
  readonly writeMcpRun: (run: RunId, settings: McpRunSettings) => Effect.Effect<void, RunFileError>
  readonly mcpRun: (run: RunId) => Effect.Effect<McpRunSettings | null>
  /** `system-prompt.md`'s path, for `--append-system-prompt-file`. */
  readonly systemPromptPath: (run: RunId) => string
  readonly writeSystemPrompt: (run: RunId, text: string) => Effect.Effect<void, RunFileError>
  /** `awaited`: the uuid of the prompt message whose echo the turn waits for, until it comes. */
  readonly awaited: (run: RunId) => Effect.Effect<string | null>
  readonly setAwaited: (run: RunId, id: string | null) => Effect.Effect<void, RunFileError>
  readonly marker: (run: RunId, name: RunMarker) => Effect.Effect<boolean>
  readonly setMarker: (run: RunId, name: RunMarker, on: boolean) => Effect.Effect<void, RunFileError>
  /** One of the board's own small files of the run's (`background`, `background-waited`…): null when there's none. */
  readonly readFile: (run: RunId, name: RunFile) => Effect.Effect<string | null>
  /** Write it (whole, by a rename), or remove it for null. */
  readonly writeFile: (run: RunId, name: RunFile, text: string | null) => Effect.Effect<void, RunFileError>
  /** A Codex run's `codex.json` as it was launched; null for a Claude run, or one that doesn't read. */
  readonly codexSpec: (run: RunId) => Effect.Effect<CodexSpec | null>
  /** Whether the run is Codex's (its adapter's `codex.json`). */
  readonly isCodex: (run: RunId) => Effect.Effect<boolean>
  // `background-waited` (plan task 3.5, the `background_wait` tool; the rest of the `background*` files are 2.8's).
  /** The ids of the background shells the agent said it waits on (`background_wait`); none if the file is missing or odd. */
  readonly backgroundWaited: (run: RunId) => Effect.Effect<ReadonlyArray<string>>
  /** Record them: a JSON list of ids, the file removed for none. */
  readonly setBackgroundWaited: (run: RunId, ids: ReadonlyArray<string>) => Effect.Effect<void, RunFileError>
}

/** The board's files about a run's background work (docs/plan/07-agents.md, The run folder; `runs/background.ts`). */
export type RunFile = "background" | "background-waited" | "background-killed" | "background-ended" | "background-calls"

export class RunDir extends Context.Service<RunDir, RunDirShape>()("huntaway-server/runs/RunDir") {
  static readonly layer = Layer.effect(
    RunDir,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const proc = yield* Proc

      // Linux has it in /proc, macOS from sysctl. Read once: it does not change while the server runs.
      const linuxBoot = yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(Effect.option)
      const boot = Option.isSome(linuxBoot)
        ? linuxBoot.value.trim() || null
        : yield* proc.run("sysctl", ["-n", "kern.bootsessionuuid"], { timeout: "5 seconds" }).pipe(
            Effect.map((result) => (result.code === 0 ? result.stdout.trim() || null : null)),
            Effect.orElseSucceed(() => null),
          )

      const path = (run: RunId) => dataDir.runDir(run)
      const file = (run: RunId, name: string) => `${dataDir.runDir(run)}/${name}`
      const has = (run: RunId, name: string) => fs.exists(file(run, name)).pipe(Effect.orElseSucceed(() => false))
      const write = (run: RunId, name: string, text: string) => fs.writeFileString(file(run, name), text).pipe(Effect.mapError(failed(run, name)))
      const readText = (run: RunId, name: string) => fs.readFileString(file(run, name)).pipe(Effect.option)
      const readJson = <S extends Schema.Codec<unknown, unknown>>(run: RunId, name: string, schema: S) =>
        readText(run, name).pipe(
          Effect.flatMap(
            Option.match({ onNone: () => Effect.succeed(null), onSome: (text) => decodeJson(schema)(text).pipe(Effect.orElseSucceed(() => null)) }),
          ),
        )
      const writeJson = <S extends Schema.Codec<unknown, unknown>>(run: RunId, name: string, schema: S, value: S["Type"], pretty = false) =>
        encodeJson(
          schema,
          pretty,
        )(value).pipe(
          Effect.mapError(failed(run, name)),
          Effect.flatMap((text) => write(run, name, text)),
        )

      const make = (run: RunId) => fs.makeDirectory(path(run), { recursive: true }).pipe(Effect.mapError(failed(run, ".")))

      const header = (run: RunId) => readJson(run, "run.json", RunHeader)
      const writeHeader = (run: RunId) => writeJson(run, "run.json", RunHeader, { boot, format: RUN_FORMAT, version: config.version })

      const rebooted = (run: RunId) => header(run).pipe(Effect.map((h) => typeof h?.boot === "string" && boot !== null && h.boot !== boot))

      const exit = (run: RunId) =>
        Effect.gen(function* () {
          if (!(yield* has(run, "exit"))) return null
          const text = yield* readText(run, "exit")
          const parsed = Option.isSome(text) ? yield* Schema.decodeEffect(ExitFile)(text.value).pipe(Effect.option) : Option.none()
          if (Option.isNone(parsed)) return { code: null, signal: null } satisfies RunExit
          const { code, signal, error } = parsed.value
          return { code: integer(code), signal: integer(signal), ...(typeof error === "string" ? { error } : {}) } satisfies RunExit
        })

      const acceptsInput = (run: RunId) =>
        Effect.gen(function* () {
          return (yield* has(run, "input.jsonl")) && !(yield* has(run, "input.closed")) && !(yield* has(run, "exit"))
        })

      const appendInput = (run: RunId, line: string) =>
        Effect.gen(function* () {
          if (!(yield* acceptsInput(run))) return false
          // One write, so the shim never relays half a line followed by someone else's.
          yield* fs.writeFileString(file(run, "input.jsonl"), `${line.trimEnd()}\n`, { flag: "a" }).pipe(Effect.mapError(failed(run, "input.jsonl")))
          return true
        })

      const closeInput = (run: RunId) =>
        Effect.gen(function* () {
          if ((yield* has(run, "input.jsonl")) && !(yield* has(run, "input.closed"))) yield* write(run, "input.closed", "")
        })

      /** Up to `max` bytes of `name` from `offset`, and the file's size; nothing if it cannot be read. */
      const readFrom = (run: RunId, name: string, offset: number, max: number) =>
        Effect.gen(function* () {
          const handle = yield* fs.open(file(run, name), { flag: "r" })
          const size = Number(yield* handle.stat.pipe(Effect.map((info) => info.size)))
          const n = Math.max(0, Math.min(max, size - offset))
          if (n === 0) return { bytes: new Uint8Array(0), size }
          const bytes = new Uint8Array(n)
          let got = 0
          while (got < n) {
            const read = yield* handle.read(bytes.subarray(got), { position: BigInt(offset + got) })
            if (read === 0) break
            got += read
          }
          return { bytes: bytes.subarray(0, got), size }
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => ({ bytes: new Uint8Array(0), size: 0 })),
        )

      const decoder = new TextDecoder()

      const readOutput = (run: RunId, offset: number, max = OUTPUT_CHUNK) =>
        Effect.gen(function* () {
          // Before the output is read, so that everything written before the exit is in what is read.
          const exited = yield* exit(run)
          let want = max
          while (true) {
            const { bytes, size } = yield* readFrom(run, "out.jsonl", offset, want)
            const newline = bytes.lastIndexOf(0x0a)
            if (newline < 0 && bytes.length === want) {
              // A line longer than the chunk (a tool result with an image, say): read more of it.
              want *= 2
              continue
            }
            const take = newline >= 0 ? newline + 1 : exited !== null ? bytes.length : 0
            return {
              ...splitLines(bytes.subarray(0, take), offset),
              end: offset + take,
              exit: exited,
              drained: exited !== null && offset + take >= size,
            } satisfies OutputChunk
          }
        })

      const errorTail = (run: RunId) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(file(run, "err.log")).pipe(Effect.option)
          const size = Option.isSome(info) ? Number(info.value.size) : 0
          const { bytes } = yield* readFrom(run, "err.log", Math.max(0, size - ERROR_TAIL), ERROR_TAIL)
          return decoder.decode(bytes)
        })

      const pid = (run: RunId, name: string) => readText(run, name).pipe(Effect.map(Option.match({ onNone: () => null, onSome: parsePid })))

      const writeMcpConfig = (run: RunId, servers: Readonly<Record<string, unknown>>) =>
        writeJson(run, "mcp.json", Schema.Unknown, sortKeys({ mcpServers: servers }), true)

      const writeMcpRun = (run: RunId, settings: McpRunSettings) =>
        writeJson(
          run,
          "mcp-run.json",
          Schema.Struct({
            cwd: Schema.String,
            github_account: Schema.NullOr(Schema.String),
            review: Schema.Boolean,
            in_process: Schema.Boolean,
            desktop: Schema.Boolean,
          }),
          settings,
        )

      const setAwaited = (run: RunId, id: string | null) =>
        id === null ? fs.remove(file(run, "awaited"), { force: true }).pipe(Effect.mapError(failed(run, "awaited"))) : write(run, "awaited", id)

      const prepare = (run: RunId, spec: LaunchSpec) =>
        Effect.gen(function* () {
          yield* make(run)
          yield* writeHeader(run)
          yield* write(run, "prompt", spec.prompt)
          if (spec.input) yield* write(run, "input.jsonl", "")
          if (spec.promptId !== null) yield* setAwaited(run, spec.promptId)
          if (spec.mcpRun !== null) yield* writeMcpRun(run, spec.mcpRun)
          if (spec.mcpServers !== null) yield* writeMcpConfig(run, spec.mcpServers)
          if (spec.systemPrompt !== null) yield* write(run, "system-prompt.md", spec.systemPrompt)
          // A Codex run's spec, which its adapter reads (and which marks the run as Codex's).
          if (spec.codex !== undefined && spec.codex !== null) yield* writeJson(run, "codex.json", Schema.Unknown, spec.codex, true)
          yield* writeJson(run, "spec.json", RunSpec, { args: [...spec.args], config_dir: spec.configDir, cwd: spec.cwd }, true)
        })

      return RunDir.of({
        root: dataDir.runs,
        path,
        boot,
        list: fs.readDirectory(dataDir.runs).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
        exists: (run) => fs.exists(path(run)).pipe(Effect.orElseSucceed(() => false)),
        started: (run) => Effect.map(Effect.all([has(run, "out.jsonl"), has(run, "exit")], { concurrency: 1 }), ([out, ended]) => out || ended),
        remove: (run) => fs.remove(path(run), { recursive: true, force: true }).pipe(Effect.mapError(failed(run, "."))),
        make,
        writeHeader,
        header,
        rebooted,
        prepare,
        writePrompt: (run, prompt) => write(run, "prompt", prompt),
        createInput: (run) => write(run, "input.jsonl", ""),
        appendInput,
        closeInput,
        inputClosed: (run) => has(run, "input.closed"),
        acceptsInput,
        input: (run) => readText(run, "input.jsonl").pipe(Effect.map(Option.getOrElse(() => ""))),
        readOutput,
        errorTail,
        pids: (run) => Effect.map(Effect.all([pid(run, "shim.pid"), pid(run, "pid")], { concurrency: 1 }), ([shim, agent]) => ({ shim, agent })),
        exit,
        writeExit: (run, value) => writeJson(run, "exit", RunExit, value),
        writeSpec: (run, value) => writeJson(run, "spec.json", RunSpec, value, true),
        spec: (run) => readJson(run, "spec.json", RunSpec),
        mcpConfigPath: (run) => file(run, "mcp.json"),
        writeMcpConfig,
        writeMcpRun,
        mcpRun: (run) =>
          readJson(run, "mcp-run.json", McpRunFile).pipe(
            Effect.map((v) =>
              v === null
                ? null
                : {
                    cwd: typeof v.cwd === "string" ? v.cwd : "",
                    github_account: typeof v.github_account === "string" ? v.github_account : null,
                    review: v.review === true,
                    in_process: v.in_process === true,
                    desktop: v.desktop === true,
                  },
            ),
          ),
        systemPromptPath: (run) => file(run, "system-prompt.md"),
        writeSystemPrompt: (run, text) => write(run, "system-prompt.md", text),
        awaited: (run) => readText(run, "awaited").pipe(Effect.map(Option.match({ onNone: () => null, onSome: (text) => text.trim() || null }))),
        setAwaited,
        marker: (run, name) => has(run, name),
        setMarker: (run, name, on) => (on ? write(run, name, "") : fs.remove(file(run, name), { force: true }).pipe(Effect.mapError(failed(run, name)))),
        readFile: (run, name) => readText(run, name).pipe(Effect.map(Option.getOrNull)),
        writeFile: (run, name, text) =>
          text === null
            ? fs.remove(file(run, name), { force: true }).pipe(Effect.mapError(failed(run, name)))
            : write(run, `.${name}.tmp`, text).pipe(
                Effect.andThen(fs.rename(file(run, `.${name}.tmp`), file(run, name)).pipe(Effect.mapError(failed(run, name)))),
              ),
        codexSpec: (run) => readJson(run, "codex.json", Schema.Unknown).pipe(Effect.map((v) => (v === null ? null : specFromJson(v)))),
        isCodex: (run) => has(run, "codex.json"),
        backgroundWaited: (run) =>
          readJson(run, "background-waited", Schema.Array(Schema.Unknown)).pipe(
            Effect.map((ids) => (ids ?? []).filter((id): id is string => typeof id === "string")),
          ),
        setBackgroundWaited: (run, ids) =>
          ids.length > 0
            ? writeJson(run, "background-waited", Schema.Array(Schema.String), ids)
            : fs.remove(file(run, "background-waited"), { force: true }).pipe(Effect.mapError(failed(run, "background-waited"))),
      })
    }),
  )
}
