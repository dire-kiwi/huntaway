import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { External, Invalid, NotFound } from "../errors.ts"
import { PushDevice, PushEventsPatch, PushInfo, PushKeys, PushSubscriptionId } from "../push.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * Web Push to devices (the old `/push` routes, 15–18): the board's key and the devices subscribed, a browser's
 * subscription added or updated, a device's name and events, removing one, and a test push. `hub.push` is the hub's
 * (docs/plan/05-protocol.md): it joins `HubRpcs` when hubs come (M7); until then a host serves it with the rest.
 */
export class PushRpcs extends RpcGroup.make(
  Rpc.make("hub.push.info", { success: PushInfo }).annotate(RequiredScope, "read"),
  /**
   * Adds a browser's subscription (`PushSubscription.toJSON()`), or updates the one with its endpoint (its keys and
   * name; its events only where given, over what it had). `Invalid` for an endpoint that isn't https (http only on this
   * machine) or keys that aren't a P-256 public key and a 16-byte secret.
   */
  Rpc.make("hub.push.subscribe", {
    payload: { endpoint: Schema.String, keys: PushKeys, name: Schema.optional(Schema.String), events: Schema.optional(PushEventsPatch) },
    success: PushDevice,
    error: Invalid,
  }).annotate(RequiredScope, "operate"),
  /** A device's name, or some of its events (what's left out stays as it was). */
  Rpc.make("hub.push.update", {
    payload: { id: PushSubscriptionId, name: Schema.optional(Schema.String), events: Schema.optional(PushEventsPatch) },
    success: PushDevice,
    error: NotFound,
  }).annotate(RequiredScope, "operate"),
  Rpc.make("hub.push.unsubscribe", { payload: { id: PushSubscriptionId }, error: NotFound }).annotate(RequiredScope, "operate"),
  /** Pushes a test notification; `External` (`push`) with why the push service didn't take it (the old 502). */
  Rpc.make("hub.push.test", { payload: { id: PushSubscriptionId }, error: Schema.Union([NotFound, External]) }).annotate(RequiredScope, "operate"),
).middleware(Auth) {}
