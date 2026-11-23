import { Schema } from "effect"
import { DeviceId, HostId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// Paired devices (HE-91; docs/plan/08-hosts.md, Paired devices): a phone pairs with a board by the PIN the board shows
// while it is in pairing mode, and gets a token of its own with `read` and `operate` only. Through the board's relay
// that session reaches every host the board links, as the board's own does.

/** How many digits a pairing PIN has. */
export const PIN_DIGITS = 6

/** How many wrong PINs pairing mode takes before it ends (a new PIN is needed then). */
export const PIN_TRIES = 5

/** How long a PIN is good for, in seconds. */
export const PIN_TTL_SECS = 300

/** A phone paired with this board. */
export const Device = Schema.Struct({
  id: DeviceId,
  /** What it called itself when it paired ("Pixel 8"). */
  name: Schema.String,
  created_at: Timestamp,
  /** When its token was last taken, to the minute; null if never. */
  last_used_at: Schema.NullOr(Timestamp),
})
export interface Device extends Schema.Schema.Type<typeof Device> {}

/** Pairing mode: the PIN a phone types, until when, and how many wrong ones it takes still. */
export const Pairing = Schema.Struct({ pin: Schema.String, expires_at: Timestamp, tries_left: Schema.Int })
export interface Pairing extends Schema.Schema.Type<typeof Pairing> {}

/** The board's paired devices, and its pairing mode while it is on. */
export const DeviceList = Schema.Struct({
  devices: Schema.Array(Device),
  pairing: Schema.NullOr(Pairing),
  /** The calling device, when a device asks. */
  current: Schema.NullOr(DeviceId),
})
export interface DeviceList extends Schema.Schema.Type<typeof DeviceList> {}

/** What a phone gets for the right PIN: its token (kept on the phone, never shown again) and the board it paired with. */
export const Paired = Schema.Struct({ token: Schema.String, device: Device, host_id: HostId, host_name: Schema.String })
export interface Paired extends Schema.Schema.Type<typeof Paired> {}
