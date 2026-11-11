import { Context, Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"
import type { HostId } from "@huntaway/contracts"
import { HostId as HostIdSchema } from "@huntaway/contracts"
import { DataDir } from "./DataDir.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { StartupError } from "./StartupError.ts"

export interface IdentityShape {
  readonly hostId: HostId
  readonly hostName: string
  /** The board token: every scope but `link`. `--token` if given, else the data folder's `auth_token`. */
  readonly token: Redacted.Redacted
  /** Whether the token came from `--token` (then the ready line does not print it). */
  readonly tokenGiven: boolean
  /** The token other hosts use to dial in. */
  readonly hubToken: Redacted.Redacted
}

/** 64 hex characters, as the old `new_token` made (two UUIDs without dashes). */
export const newToken = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom
  return Hex.encode(yield* random.randomBytes(32))
})

const fail = (what: string) => (e: { readonly message: string }) => new StartupError({ reason: `can't read or make ${what}: ${e.message}` })

/**
 * This host's identity: `host_id`, `auth_token` and `hub_token` files in the data folder (0600, made on first start),
 * and its name.
 */
export class Identity extends Context.Service<Identity, IdentityShape>()("huntaway-server/platform/Identity") {
  static readonly layer = Layer.effect(
    Identity,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      // Reads a one-line file, or makes it with a new token. The old files are made the same way, so a value is kept.
      const loadOrMake = Effect.fnUntraced(function* (name: string) {
        const file = dataDir.file(name)
        const existing = yield* fs.readFileString(file).pipe(
          Effect.map((text) => text.trim()),
          Effect.option,
        )
        if (Option.isSome(existing) && existing.value !== "") return existing.value
        const value = yield* newToken
        yield* fs.writeFileString(file, `${value}\n`, { mode: 0o600 })
        yield* fs.chmod(file, 0o600)
        return value
      })
      const hostId = yield* loadOrMake("host_id").pipe(Effect.mapError(fail("host_id")))
      const hubToken = yield* loadOrMake("hub_token").pipe(Effect.mapError(fail("hub_token")))
      const token = config.token === null ? yield* loadOrMake("auth_token").pipe(Effect.mapError(fail("auth_token"))) : Redacted.value(config.token)
      const hostName =
        config.name ??
        (yield* fs.readFileString("/proc/sys/kernel/hostname").pipe(
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => ""),
        )) ??
        "host"
      return Identity.of({
        hostId: HostIdSchema.make(hostId),
        hostName: hostName === "" ? "host" : hostName,
        token: Redacted.make(token),
        tokenGiven: config.token !== null,
        hubToken: Redacted.make(hubToken),
      })
    }),
  )
}
