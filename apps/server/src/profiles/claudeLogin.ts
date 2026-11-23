import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import type { PlatformError, Scope } from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { expandTilde } from "../settings/Folders.ts"
import type { AgentConfigRow } from "./AgentConfigRepo.ts"

// HE-87: a Claude Code config's login, wherever Claude Code keeps it. On Linux that is `.credentials.json` in its folder.
// On macOS it is the login keychain, and the file is only where Claude Code looks when the keychain has none, and which
// it deletes once it has saved the login in the keychain. So a login copied in as the file is ignored when the
// keychain has one already, and a copied login is soon gone from the file.
//
// Claude Code names its keychain item after the config folder (as Claude Code 2.1 does, in its `secureStorage`):
// `Claude Code-credentials` with no `CLAUDE_CONFIG_DIR`, else that followed by `-` and the first 8 hex digits of the
// folder's sha256. A board config with a folder runs its agents with it as `CLAUDE_CONFIG_DIR`; a plain `claude` in a
// terminal runs with none, in `~/.claude`. So a config whose folder is `~/.claude` has two items: its agents' and the
// terminal's, and a login copied into it goes in both.

/** What Claude Code calls its keychain items' account: the user's name when it's a plain one. */
const keychainAccount = (user: string) => (/^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user")

const SERVICE = "Claude Code-credentials"

/** The `security` commands' output and exit code. */
interface Ran {
  readonly code: number
  readonly stdout: string
}

const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Effect.map(Stream.runCollect(Stream.decodeText(stream)), (chunks) => [...chunks].join(""))

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("")

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown))
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
/** Whether `s` is a JSON object, as a login is. */
const isLogin = (s: string) => Option.match(decodeJson(s), { onNone: () => false, onSome: isJsonObject })

export interface ClaudeLogin {
  /** The file Claude Code keeps the login in where there's no keychain, and reads when the keychain has none. */
  readonly file: string
  /** The login (`.credentials.json`'s JSON), from the keychain first on macOS; null when there's none. */
  readonly read: Effect.Effect<string | null>
  /** Saves `json` as the login in each keychain item the config's agents and a terminal's `claude` read (macOS only). */
  readonly saveInKeychain: (json: string) => Effect.Effect<void, { readonly reason: string }>
}

/** Reading and saving Claude configs' logins on this host. */
export const makeClaudeLogins = Effect.gen(function* () {
  const config = yield* ServerConfig
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const digest = yield* Digest.Digest
  const mac = config.platform.startsWith("mac-")
  const account = keychainAccount(config.user)

  /** `security` with `args`, fed `input`. */
  const security = (args: ReadonlyArray<string>, input = "") => {
    const once: Effect.Effect<Ran, PlatformError.PlatformError, Scope.Scope> = Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(config.securityBin, args, { stdin: Stream.make(new TextEncoder().encode(input)) }))
      const [stdout, , code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 3 })
      return { code: Number(code), stdout }
    })
    return once.pipe(
      Effect.scoped,
      Effect.mapError((e) => ({ reason: `security: ${e.message}` })),
      Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail({ reason: "security took more than 30 seconds" }) }),
    )
  }

  /** The keychain items a config's login is read from, its agents' first. */
  const services = Effect.fnUntraced(function* (row: Pick<AgentConfigRow, "config_dir">) {
    const given = row.config_dir.trim()
    if (given === "") return [SERVICE]
    const dir = expandTilde(given, config.home)
    const sum = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(dir.normalize("NFC")))
    const own = `${SERVICE}-${sum.slice(0, 8)}`
    return dir.replace(/\/+$/, "") === path.join(config.home, ".claude") ? [own, SERVICE] : [own]
  })

  const readKeychain = (service: string): Effect.Effect<string | null> =>
    security(["find-generic-password", "-a", account, "-w", "-s", service]).pipe(
      Effect.map((r) => {
        const out = r.stdout.trim()
        return r.code === 0 && isLogin(out) ? out : null
      }),
      Effect.catch((e) => Effect.as(Effect.logWarning(`reading a Claude login from the keychain: ${e.reason}`), null)),
    )

  const of = (row: Pick<AgentConfigRow, "config_dir">): ClaudeLogin => {
    const dir = expandTilde(row.config_dir.trim() === "" ? "~/.claude" : row.config_dir, config.home)
    const file = path.join(dir, ".credentials.json")
    const readFile = fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
    const read = Effect.gen(function* () {
      if (mac) {
        for (const service of yield* services(row)) {
          const found = yield* readKeychain(service)
          if (found !== null) return found
        }
      }
      return yield* readFile
    })
    const saveInKeychain = (json: string) =>
      Effect.flatMap(services(row), (list) =>
        Effect.forEach(
          list,
          (service) => {
            // In hex as Claude Code writes it, through `security -i`'s input so the login is in no process's arguments
            // (unless the line is too long for it). `security -i` can exit 0 when a command in it failed: the item read
            // back is what says it's saved.
            const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex(json)}"\n`
            const add = line.length < 4000 ? security(["-i"], line) : security(["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex(json)])
            return add.pipe(
              Effect.andThen(readKeychain(service)),
              Effect.filterOrFail(
                (saved) => saved === json.trim(),
                () => ({ reason: `couldn't save the login in the macOS keychain as "${service}" (is the keychain locked?)` }),
              ),
            )
          },
          { concurrency: 1, discard: true },
        ),
      )
    return { file, read, saveInKeychain }
  }

  return { mac, of }
})
