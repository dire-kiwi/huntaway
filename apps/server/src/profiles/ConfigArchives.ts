import { Context, Effect, FileSystem, Layer, Option, Path, Result, Schema, Stream } from "effect"
import type { PlatformError, Scope } from "effect"
import { Base64 } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Conflict, Invalid } from "@huntaway/contracts"
import type { AgentConfigId, ConfigArchive } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { expandTilde } from "../settings/Folders.ts"
import { AgentConfigNotFound } from "./AgentConfigs.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import type { AgentConfigRow } from "./AgentConfigRepo.ts"

// 6.11: a config's login and settings as one host hands them to another (the old `api/claude_configs.ts` archives):
// a gzipped tar of a fixed list of entries, in base64. Plain calls, so that copying a config between hosts (7.5) is an
// export on one and an import on the other.

/** What makes a Claude Code config folder usable elsewhere. History, caches and snapshots stay put. */
export const CLAUDE_ENTRIES = [
  ".credentials.json",
  ".claude.json",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "keybindings.json",
  "agents",
  "commands",
  "skills",
  "plugins",
  "hooks",
  "output-styles",
] as const

/** The same for a Codex home. Sessions, logs and its databases stay put. */
export const CODEX_ENTRIES = ["auth.json", "config.toml", "AGENTS.md", "skills", "rules", "prompts"] as const

/** tar couldn't be run. */
export class ArchiveUnavailable extends Schema.TaggedError<ArchiveUnavailable, { readonly brand: unique symbol }>()("ArchiveUnavailable", {
  reason: Schema.String,
}) {}

/** Standard base64 with its padding, as the old server's decoder took it (the old Rust one; Node's is lenient). */
export const decodeArchive = (text: string): Result.Result<Uint8Array, Invalid> => {
  const s = text.trim()
  const bad = Result.fail(new Invalid({ field: "archive", reason: "bad archive: Invalid input length or symbol" }))
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return bad
  return Result.match(Base64.decode(s), { onFailure: () => bad, onSuccess: (bytes) => Result.succeed(bytes) })
}

/** Where a config's files are, which of them a copy takes, and the file holding its login. */
export const configFiles = (row: Pick<AgentConfigRow, "config_dir" | "agent">, home: string) => {
  const codex = row.agent === "codex"
  const given = row.config_dir.trim()
  return {
    dir: expandTilde(given === "" ? (codex ? "~/.codex" : "~/.claude") : given, home),
    entries: codex ? CODEX_ENTRIES : CLAUDE_ENTRIES,
    login: codex ? "auth.json" : ".credentials.json",
  }
}

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Effect.map(Stream.runCollect(stream), (chunks) => concat([...chunks]))

export interface ConfigArchivesShape {
  /** The config's files (`Invalid` `config_dir` when it has none of them). */
  readonly exportArchive: (id: AgentConfigId) => Effect.Effect<ConfigArchive, AgentConfigNotFound | Invalid | ArchiveUnavailable>
  /**
   * Unpacks `archive` into the config's folder (made, 0700). Refused (`in_use`) when the folder has a login and
   * `overwrite` isn't set. The folder it went into.
   */
  readonly importArchive: (
    id: AgentConfigId,
    archive: string,
    overwrite: boolean,
  ) => Effect.Effect<{ readonly dir: string }, AgentConfigNotFound | Invalid | Conflict | ArchiveUnavailable>
}

/** Exporting and importing an agent config's login and settings. */
export class ConfigArchives extends Context.Service<ConfigArchives, ConfigArchivesShape>()("huntaway-server/profiles/ConfigArchives") {
  static readonly layer = Layer.effect(
    ConfigArchives,
    Effect.gen(function* () {
      const repo = yield* AgentConfigRepo
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* ServerConfig

      const getRow = (id: AgentConfigId) =>
        Effect.flatMap(repo.get(id), Option.match({ onNone: () => Effect.fail(new AgentConfigNotFound({ id })), onSome: Effect.succeed }))
      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))

      /** tar with `args`, fed `input`: its exit code, stdout and stderr. */
      const tar = (args: ReadonlyArray<string>, input: Uint8Array) => {
        const once: Effect.Effect<{ code: number; stdout: Uint8Array; stderr: string }, PlatformError.PlatformError, Scope.Scope> = Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("tar", args, { stdin: Stream.make(input) }))
          const [stdout, stderr, code] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), handle.exitCode], { concurrency: 3 })
          return { code: Number(code), stdout, stderr: new TextDecoder().decode(stderr) }
        })
        return once.pipe(
          Effect.scoped,
          Effect.mapError((e) => new ArchiveUnavailable({ reason: `tar: ${e.message}` })),
          Effect.timeoutOrElse({ duration: "10 minutes", orElse: () => Effect.fail(new ArchiveUnavailable({ reason: "tar took more than 10 minutes" })) }),
        )
      }

      const exportArchive = Effect.fn("ConfigArchives.exportArchive")(function* (id: AgentConfigId) {
        const files = configFiles(yield* getRow(id), config.home)
        const present = yield* Effect.filter(files.entries, (e) => exists(path.join(files.dir, e)), { concurrency: 4 })
        if (present.length === 0) return yield* new Invalid({ field: "config_dir", reason: `nothing to copy in ${files.dir}` })
        const out = yield* tar(["czf", "-", "-C", files.dir, ...present], new Uint8Array(0))
        if (out.code !== 0) return yield* new Invalid({ field: "config_dir", reason: `tar failed: ${out.stderr}` })
        return { archive: Base64.encode(out.stdout), files: present, bytes: out.stdout.length }
      })

      const importArchive = Effect.fn("ConfigArchives.importArchive")(function* (id: AgentConfigId, archive: string, overwrite: boolean) {
        const files = configFiles(yield* getRow(id), config.home)
        if (!overwrite && (yield* exists(path.join(files.dir, files.login)))) {
          return yield* new Conflict({ reason: "in_use", detail: `${files.dir} already has a login; choose overwrite to replace it` })
        }
        const bytes = yield* Effect.fromResult(decodeArchive(archive))
        yield* fs.makeDirectory(files.dir, { recursive: true }).pipe(Effect.mapError((e) => new ArchiveUnavailable({ reason: e.message })))
        yield* fs.chmod(files.dir, 0o700).pipe(Effect.ignore)
        const out = yield* tar(["xzf", "-", "-C", files.dir], bytes)
        if (out.code !== 0) return yield* new Invalid({ field: "archive", reason: `tar failed: ${out.stderr}` })
        return { dir: files.dir }
      })

      return ConfigArchives.of({ exportArchive, importArchive })
    }),
  )
}
