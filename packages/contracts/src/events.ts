import { Schema } from "effect"
import { HostId, ProfileId } from "./ids.ts"

// What a host's board stream carries (docs/plan/03-domain.md, Events): the old `HostEvent` union with a sequence
// number on every event, minus the legacy kinds. The components switch on `type`. A new kind is added here first.

const seq = { seq: Schema.Int }

/** First on every subscription: which host, which boot of it, and the sequence number the stream continues from. */
export const Hello = Schema.Struct({ type: Schema.Literal("hello"), host_id: HostId, boot: Schema.String, ...seq })
/** Events were dropped or cannot be replayed: subscribe again without `since`. The stream ends after it. */
export const Resync = Schema.Struct({ type: Schema.Literal("resync"), ...seq })
/** A profile or an agent config was made, changed or removed. */
export const ProfilesChanged = Schema.Struct({ type: Schema.Literal("profiles_changed"), ...seq })
/** The host's settings changed. */
export const SettingsChanged = Schema.Struct({ type: Schema.Literal("settings_changed"), ...seq })
/** A profile's pens changed. */
export const PensChanged = Schema.Struct({ type: Schema.Literal("pens"), profile_id: ProfileId, ...seq })

export const BoardEvent = Schema.Union([Hello, Resync, ProfilesChanged, SettingsChanged, PensChanged])
export type BoardEvent = typeof BoardEvent.Type

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event as a service emits it: `Events` numbers it. `hello` and `resync` are the stream's own. */
export type BoardEventInput = DistributiveOmit<Exclude<BoardEvent, { readonly type: "hello" | "resync" }>, "seq">
