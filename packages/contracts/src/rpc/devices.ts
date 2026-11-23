import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { DeviceList, Pairing } from "../device.ts"
import { Invalid, NotFound, Unavailable } from "../errors.ts"
import { DeviceId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * A board's paired devices (HE-91): the list, pairing mode (a PIN a phone types in, good for `PIN_TTL_SECS` and
 * `PIN_TRIES` wrong ones), and unpairing one. The phone pairs with `public.pair`; a device unpairs itself
 * with `hub.devices.unpair`, the one call here a device may make.
 */
export class DeviceRpcs extends RpcGroup.make(
  Rpc.make("hub.devices.list", { success: DeviceList }).annotate(RequiredScope, "admin"),
  /** Turns pairing mode on with a new PIN (one that was showing is no longer good). `Unavailable` on a read-only board. */
  Rpc.make("hub.devices.startPairing", { success: Pairing, error: Unavailable }).annotate(RequiredScope, "admin"),
  /** Turns pairing mode off: the PIN is no longer good. */
  Rpc.make("hub.devices.stopPairing", {}).annotate(RequiredScope, "admin"),
  /** Unpairs a device: its token is refused from then on, and its open calls and relayed sockets end. */
  Rpc.make("hub.devices.revoke", { payload: { id: DeviceId }, error: NotFound }).annotate(RequiredScope, "admin"),
  /** The calling device unpairs itself (the phone forgetting the board). `Invalid` (`session`) for anything but a device. */
  Rpc.make("hub.devices.unpair", { error: Schema.Union([Invalid, NotFound]) }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
