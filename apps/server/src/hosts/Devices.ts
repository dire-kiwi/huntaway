import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Ref, Stream, SubscriptionRef } from "effect"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { DeviceId, Invalid, NotFound, PIN_DIGITS, PIN_TRIES, PIN_TTL_SECS, Timestamp, Unavailable } from "@huntaway/contracts"
import type { Device, DeviceList, Paired, Pairing } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { DeviceRepo } from "./DeviceRepo.ts"
import type { StoredDevice } from "./DeviceRepo.ts"

// Paired devices (HE-91; docs/plan/08-hosts.md, Paired devices). Pairing mode is a PIN the board shows: one at a time,
// good for `PIN_TTL_SECS` and for one phone, and ended by `PIN_TRIES` wrong ones, so a guesser on the network has 5 in a
// million. It lives in memory only: a restart ends it. A paired device's token is kept as its SHA-256 only; the hashes
// of every paired device are in memory too (a `SubscriptionRef`), so a call with a device's token reads no row, and
// whoever waits on a device's unpairing (its calls, its relayed sockets) sees it go.

const encoder = new TextEncoder()

/** How often a device's `last_used_at` is written, at most. */
const TOUCH_EVERY = Duration.minutes(1)

/** Pairing mode while it is on: the PIN, when it ends (ms since the epoch), the wrong ones it takes still. */
export interface Mode {
  readonly pin: string
  readonly expires: number
  readonly tries: number
}

/** What a PIN given to `public.pair` came to. */
type Tried = { readonly _tag: "Off" } | { readonly _tag: "Wrong"; readonly left: number } | { readonly _tag: "Right" }

/** A PIN as typed: its digits, with any spaces or dashes a phone's keyboard put between them dropped (pure). */
export const normalPin = (given: string): string => given.replace(/[\s-]/g, "")

/** What a PIN given at `now` comes to in pairing `mode`, and the mode after it (pure). One right PIN ends the mode. */
export const tryPin = (mode: Mode | null, given: string, now: number): readonly [Tried, Mode | null] => {
  if (mode === null || mode.expires <= now) return [{ _tag: "Off" }, null]
  if (samePin(normalPin(given), mode.pin)) return [{ _tag: "Right" }, null]
  const left = mode.tries - 1
  return left <= 0
    ? [{ _tag: "Wrong", left: 0 }, null]
    : [
        { _tag: "Wrong", left },
        { ...mode, tries: left },
      ]
}

/** Two PINs compared in constant time. */
const samePin = (a: string, b: string): boolean => {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  return x.length === y.length && Mac.timingSafeEqual(x, y)
}

const shown = ({ token_hash: _hash, ...device }: StoredDevice): Device => device

export class Devices extends Context.Service<
  Devices,
  {
    /** The paired devices and pairing mode; `current` is the device asking, if one is. */
    readonly list: (current: DeviceId | null) => Effect.Effect<DeviceList>
    /** Pairing mode on, with a new PIN. */
    readonly startPairing: Effect.Effect<Pairing>
    readonly stopPairing: Effect.Effect<void>
    /** `public.pair`: the PIN showing gives a device and its token. */
    readonly pair: (pin: string, name: string) => Effect.Effect<Paired, Invalid | Unavailable>
    readonly rename: (id: DeviceId, name: string) => Effect.Effect<Device, NotFound | Invalid>
    /** Unpairs a device: its token is refused from now on, and `revoked` ends for it. */
    readonly revoke: (id: DeviceId) => Effect.Effect<void, NotFound>
    /** The paired device whose token this is, if one is (noting when it was used, once a minute). */
    readonly byToken: (token: string) => Effect.Effect<Option.Option<DeviceId>>
    /** Done once `id` is not (or no longer) a device paired here. A device of another board's is never paired here. */
    readonly revoked: (id: DeviceId) => Effect.Effect<void>
  }
>()("huntaway-server/hosts/Devices") {
  static readonly layer = Layer.effect(
    Devices,
    Effect.gen(function* () {
      const repo = yield* DeviceRepo
      const identity = yield* Identity
      const random = yield* SecureRandom.SecureRandom
      const digest = yield* Digest.Digest
      const hashOf = (token: string) => digest.digestHex(Digest.sha256, encoder.encode(token))
      const mode = yield* Ref.make<Mode | null>(null)
      /** Every paired device's token hash, and the device. */
      const tokens = yield* SubscriptionRef.make<ReadonlyMap<string, DeviceId>>(new Map((yield* repo.list).map((d) => [d.token_hash, d.id])))
      /** When each device's `last_used_at` was last written here (ms). */
      const touched = yield* Ref.make<ReadonlyMap<DeviceId, number>>(new Map())

      const pairingOf = (m: Mode): Pairing => ({
        pin: m.pin,
        expires_at: Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(m.expires))),
        tries_left: m.tries,
      })

      const list = Effect.fn("Devices.list")(function* (current: DeviceId | null) {
        const now = yield* Clock.currentTimeMillis
        const m = yield* Ref.get(mode)
        return { devices: (yield* repo.list).map(shown), pairing: m === null || m.expires <= now ? null : pairingOf(m), current }
      })

      const startPairing = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const n = yield* random.intBetween(0, 10 ** PIN_DIGITS, { halfOpen: true })
        const next: Mode = { pin: String(n).padStart(PIN_DIGITS, "0"), expires: now + PIN_TTL_SECS * 1000, tries: PIN_TRIES }
        yield* Ref.set(mode, next)
        yield* Effect.logInfo("pairing mode on")
        return pairingOf(next)
      }).pipe(Effect.withSpan("Devices.startPairing"))

      const pair = Effect.fn("Devices.pair")(function* (pin: string, name: string) {
        const now = yield* Clock.currentTimeMillis
        const tried = yield* Ref.modify(mode, (m) => tryPin(m, pin, now))
        if (tried._tag === "Off")
          return yield* new Unavailable({
            what: "pairing",
            reason: "the board isn't pairing: start pairing in Settings → Network access, then type the PIN it shows",
          })
        if (tried._tag === "Wrong") {
          yield* Effect.logWarning(`a wrong pairing PIN (${tried.left} tries left)`)
          if (tried.left === 0)
            return yield* new Unavailable({ what: "pairing", reason: "too many wrong PINs: pairing has ended. Start it again on the board for a new PIN" })
          return yield* new Invalid({ field: "pin", reason: `that isn't the PIN the board shows (${tried.left} ${tried.left === 1 ? "try" : "tries"} left)` })
        }
        const token = Base64Url.encode(yield* random.randomBytes(32))
        const device: StoredDevice = {
          id: DeviceId.make(yield* random.uuidV4().pipe(Effect.orDie)),
          name: name.trim().slice(0, 100) || "Phone",
          token_hash: yield* hashOf(token),
          created_at: yield* nowTimestamp,
          last_used_at: null,
        }
        yield* repo.insert(device)
        yield* SubscriptionRef.update(tokens, (all) => new Map(all).set(device.token_hash, device.id))
        yield* Effect.logInfo(`paired a device: ${device.name}`)
        return { token, device: shown(device), host_id: identity.hostId, host_name: identity.hostName }
      })

      const rename = Effect.fn("Devices.rename")(function* (id: DeviceId, name: string) {
        const trimmed = name.trim()
        if (trimmed === "") return yield* new Invalid({ field: "name", reason: "give it a name" })
        if (trimmed.length > 100) return yield* new Invalid({ field: "name", reason: "100 characters at most" })
        const found = yield* repo.get(id)
        if (found === null) return yield* new NotFound({ what: "device", id })
        yield* repo.rename(id, trimmed)
        return shown({ ...found, name: trimmed })
      })

      const revoke = Effect.fn("Devices.revoke")(function* (id: DeviceId) {
        if (!(yield* repo.delete(id))) return yield* new NotFound({ what: "device", id })
        yield* SubscriptionRef.update(tokens, (all) => new Map([...all].filter(([, d]) => d !== id)))
        return yield* Effect.logInfo(`unpaired device ${id}`)
      })

      const byToken = Effect.fnUntraced(function* (token: string) {
        const all = yield* SubscriptionRef.get(tokens)
        if (all.size === 0) return Option.none<DeviceId>()
        const id = all.get(yield* hashOf(token))
        if (id === undefined) return Option.none<DeviceId>()
        const now = yield* Clock.currentTimeMillis
        const due = yield* Ref.modify(touched, (seen): readonly [boolean, ReadonlyMap<DeviceId, number>] => {
          const last = seen.get(id)
          return last !== undefined && now - last < Duration.toMillis(TOUCH_EVERY) ? [false, seen] : [true, new Map(seen).set(id, now)]
        })
        if (due) yield* repo.touch(id, yield* nowTimestamp)
        return Option.some(id)
      })

      const revoked = (id: DeviceId): Effect.Effect<void> =>
        SubscriptionRef.changes(tokens).pipe(
          Stream.filter((all) => ![...all.values()].includes(id)),
          Stream.runHead,
          Effect.asVoid,
        )

      return Devices.of({ list, startPairing, stopPairing: Ref.set(mode, null), pair, rename, revoke, byToken, revoked })
    }),
  )
}
