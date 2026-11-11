import { Schema } from "effect"
import { Timestamp } from "./time.ts"

// Web Push to devices (docs/plan/inventory/06-integrations.md 2.4, 3.3): a device's subscription and the events it
// wants. The phone app's (`kind` `expo`) and answering a prompt from a notification wait for the app.

export const PushSubscriptionId = Schema.String.pipe(Schema.brand("PushSubscriptionId"))
export type PushSubscriptionId = typeof PushSubscriptionId.Type

/**
 * Whose permission prompts a device gets pushed: none; the assistant's (its thread's and its routines', whose prompts are
 * for actions outside the board, and which isn't on the board's columns to notify otherwise: the default); every task's.
 */
export const PushPrompts = Schema.Literals(["off", "assistant", "all"])
export type PushPrompts = typeof PushPrompts.Type

/** Which events a device gets: the board's (`NOTIFY_EVENTS`), whose prompts, the assistant's replies and its routines' reports. */
export const PushEvents = Schema.Struct({
  attention: Schema.Boolean,
  review: Schema.Boolean,
  merge: Schema.Boolean,
  done: Schema.Boolean,
  prompts: PushPrompts,
  replies: Schema.Boolean,
  reports: Schema.Boolean,
})
export interface PushEvents extends Schema.Schema.Type<typeof PushEvents> {}

/** Some of a device's events: what it leaves out stays as it was (a page from before an event was added mustn't turn it off). */
export const PushEventsPatch = Schema.Struct({
  attention: Schema.optional(Schema.Boolean),
  review: Schema.optional(Schema.Boolean),
  merge: Schema.optional(Schema.Boolean),
  done: Schema.optional(Schema.Boolean),
  prompts: Schema.optional(PushPrompts),
  replies: Schema.optional(Schema.Boolean),
  reports: Schema.optional(Schema.Boolean),
})
export interface PushEventsPatch extends Schema.Schema.Type<typeof PushEventsPatch> {}

/** How a device is pushed to: Web Push (a browser), or the phone app through Expo (its subscriptions are kept, not pushed to here). */
export const PushKind = Schema.Literals(["web", "expo"])
export type PushKind = typeof PushKind.Type

/** A device's subscription as the board shows it: its push service's endpoint, but not its keys. */
export const PushDevice = Schema.Struct({
  id: PushSubscriptionId,
  /** Its push service's URL for it, which tells this browser's own from the others. */
  endpoint: Schema.String,
  kind: PushKind,
  /** The paired device that subscribed (the phone app's), if one did. */
  device_id: Schema.NullOr(Schema.String),
  /** What the device calls itself ("Chrome on Android"). */
  name: Schema.String,
  events: PushEvents,
  created_at: Timestamp,
  last_sent_at: Schema.NullOr(Timestamp),
  /** Why the last push to it failed, until one works. */
  last_error: Schema.NullOr(Schema.String),
})
export interface PushDevice extends Schema.Schema.Type<typeof PushDevice> {}

/** The board's public key (VAPID, an uncompressed P-256 point in base64url) to subscribe with, and the devices that have. */
export const PushInfo = Schema.Struct({ public_key: Schema.String, subscriptions: Schema.Array(PushDevice) })
export interface PushInfo extends Schema.Schema.Type<typeof PushInfo> {}

/** A browser's subscription keys (`PushSubscription.toJSON().keys`): its P-256 public key and 16-byte auth secret, base64url. */
export const PushKeys = Schema.Struct({ p256dh: Schema.String, auth: Schema.String })
export interface PushKeys extends Schema.Schema.Type<typeof PushKeys> {}
