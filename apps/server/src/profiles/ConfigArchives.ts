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
import { makeClaudeLogins } from "./claudeLogin.ts"

// 6.11: a config's login and settings as one host hands them to another (the old `api/claude_configs.ts` archives):
// a gzipped tar of a fixed list of entries, in base64. Plain calls, so that copying a config between hosts (7.5) is an
// export on one and an import on the other.
//
// HE-87: a Claude config's login goes as `.credentials.json` whichever host it's on, though on macOS Claude Code keeps
// it in the keychain (`claudeLogin.ts`): a Mac's export takes it from there, and a Mac's import puts it there. For a
// config in `~/.claude`, which a plain `claude` in a terminal uses too, its account (`oauthAccount` in `.claude.json`)
// goes into `~/.claude.json` as well, where that `claude` reads it.

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

/**
 * The same for an ACP agent's home (HE-69): Antigravity's (`GEMINI_HOME`, `~/.gemini`), its ACP sign-in and settings,
 * its own settings and instructions, and its config (skills). Conversations and temporary files stay put.
 */
export const ACP_ENTRIES = ["antigravity-acp/acp_token.json", "antigravity-acp/settings.json", "settings.json", "GEMINI.md", "config"] as const

/** Where a plain `claude` keeps its settings and account, beside a `~/.claude` folder rather than in it. */
const HOME_CLAUDE_JSON = ".claude.json"
/** What of `.claude.json` says whose login it is, and that Claude Code needn't ask for one. */
const ACCOUNT_KEYS = ["oauthAccount", "hasCompletedOnboarding"] as const

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeObject = Schema.decodeUnknownOption(JsonObject)
const encodeObject = Schema.encodeEffect(JsonObject)

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
  const given = row.config_dir.trim()
  const [fallback, entries, login]: readonly [string, ReadonlyArray<string>, string] =
    row.agent === "codex"
      ? ["~/.codex", CODEX_ENTRIES, "auth.json"]
      : row.agent === "acp"
        ? ["~/.gemini", ACP_ENTRIES, "antigravity-acp/acp_token.json"]
        : ["~/.claude", CLAUDE_ENTRIES, ".credentials.json"]
  return { dir: expandTilde(given === "" ? fallback : given, home), entries, login }
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
      const logins = yield* makeClaudeLogins

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

      /** Whether the config is a Claude one in `~/.claude`, which a plain `claude` in a terminal uses too. */
      const terminalClaude = (row: AgentConfigRow, dir: string) =>
        row.agent !== "codex" && row.agent !== "acp" && dir.replace(/\/+$/, "") === path.join(config.home, ".claude")

      const exportArchive = Effect.fn("ConfigArchives.exportArchive")(function* (id: AgentConfigId) {
        const row = yield* getRow(id)
        const files = configFiles(row, config.home)
        const present = yield* Effect.filter(files.entries, (e) => exists(path.join(files.dir, e)), { concurrency: 4 })
        // A Claude config's login is staged beside the folder: on a Mac it's in the keychain, not the file. So is a
        // plain `claude`'s `.claude.json` (in the home folder) for a `~/.claude` that has none of its own.
        const staged: Array<readonly [string, string]> = []
        if (files.login === ".credentials.json") {
          const login = yield* logins.of(row).read
          if (login !== null) staged.push([".credentials.json", login])
          if (terminalClaude(row, files.dir) && !present.includes(".claude.json")) {
            const home = yield* fs.readFileString(path.join(config.home, HOME_CLAUDE_JSON)).pipe(Effect.orElseSucceed(() => null))
            if (home !== null) staged.push([".claude.json", home])
          }
        }
        const fromDir = present.filter((e) => !staged.some(([name]) => name === e))
        if (fromDir.length + staged.length === 0) return yield* new Invalid({ field: "config_dir", reason: `nothing to copy in ${files.dir}` })
        const out = yield* Effect.scoped(
          Effect.gen(function* () {
            const args = ["czf", "-"]
            if (staged.length > 0) {
              const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-login-" })
              for (const [name, text] of staged) yield* fs.writeFileString(path.join(tmp, name), text, { mode: 0o600 })
              args.push("-C", tmp, ...staged.map(([name]) => name))
            }
            if (fromDir.length > 0) args.push("-C", files.dir, ...fromDir)
            return yield* tar(args, new Uint8Array(0))
          }).pipe(Effect.catchTag("PlatformError", (e) => Effect.fail(new ArchiveUnavailable({ reason: e.message })))),
        )
        if (out.code !== 0) return yield* new Invalid({ field: "config_dir", reason: `tar failed: ${out.stderr}` })
        const names = new Set([...staged.map(([name]) => name), ...fromDir])
        return { archive: Base64.encode(out.stdout), files: files.entries.filter((e) => names.has(e)), bytes: out.stdout.length }
      })

      /** A plain `claude`'s `~/.claude.json` told whose the copied login is (the rest of it is this host's own). */
      const tellTerminalClaude = Effect.fnUntraced(function* (dir: string) {
        const copied = Option.getOrNull(decodeObject(yield* fs.readFileString(path.join(dir, ".claude.json")).pipe(Effect.orElseSucceed(() => ""))))
        if (copied === null) return
        const file = path.join(config.home, HOME_CLAUDE_JSON)
        const own = Option.getOrElse(decodeObject(yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))), () => ({}))
        const next: Record<string, unknown> = { ...own }
        for (const key of ACCOUNT_KEYS) if (key in copied) next[key] = copied[key]
        const tmp = `${file}.huntaway-copy`
        yield* fs.writeFileString(tmp, yield* encodeObject(next), { mode: 0o600 })
        yield* fs.rename(tmp, file)
      })

      const importArchive = Effect.fn("ConfigArchives.importArchive")(function* (id: AgentConfigId, archive: string, overwrite: boolean) {
        const row = yield* getRow(id)
        const files = configFiles(row, config.home)
        const claude = files.login === ".credentials.json"
        const login = logins.of(row)
        const hasLogin = claude ? (yield* login.read) !== null : yield* exists(path.join(files.dir, files.login))
        if (!overwrite && hasLogin) {
          return yield* new Conflict({ reason: "in_use", detail: `${files.dir} already has a login; choose overwrite to replace it` })
        }
        const bytes = yield* Effect.fromResult(decodeArchive(archive))
        yield* fs.makeDirectory(files.dir, { recursive: true }).pipe(Effect.mapError((e) => new ArchiveUnavailable({ reason: e.message })))
        yield* fs.chmod(files.dir, 0o700).pipe(Effect.ignore)
        const listed = yield* tar(["tzf", "-"], bytes)
        if (listed.code !== 0) return yield* new Invalid({ field: "archive", reason: `tar failed: ${listed.stderr}` })
        const entries = new Set(
          new TextDecoder()
            .decode(listed.stdout)
            .split("\n")
            .map((l) => l.replace(/^\.\//, "").replace(/\/$/, "")),
        )
        const out = yield* tar(["xzf", "-", "-C", files.dir], bytes)
        if (out.code !== 0) return yield* new Invalid({ field: "archive", reason: `tar failed: ${out.stderr}` })
        if (claude && logins.mac && entries.has(".credentials.json")) {
          const copied = yield* fs.readFileString(login.file).pipe(Effect.mapError((e) => new ArchiveUnavailable({ reason: e.message })))
          yield* login.saveInKeychain(copied).pipe(Effect.mapError((e) => new ArchiveUnavailable({ reason: e.reason })))
          // As Claude Code does once its login is in the keychain.
          yield* fs.remove(login.file, { force: true }).pipe(Effect.ignore)
        }
        if (claude && terminalClaude(row, files.dir) && entries.has(".claude.json")) {
          yield* tellTerminalClaude(files.dir).pipe(Effect.mapError((e) => new ArchiveUnavailable({ reason: `~/.claude.json: ${e.message}` })))
        }
        return { dir: files.dir }
      })

      return ConfigArchives.of({ exportArchive, importArchive })
    }),
  )
}
