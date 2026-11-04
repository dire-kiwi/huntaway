import { enc, type Http } from "./http";

/** Whose permission prompts a device gets by push, with Allow and Deny on them (API 106): the assistant's by default. */
export type PushPrompts = "off" | "assistant" | "all";

/** Which of the board's notifications a device gets by push (see notifications.ts), and its permission prompts (left as they are, or the default, without). */
export type PushEvents = Record<"attention" | "review" | "merge" | "done", boolean> & {
  prompts?: PushPrompts;
  /** The assistant's replies, but for those to what was sent it on Telegram, which go back there. Off unless chosen; a
   *  board from before it doesn't have it, and keeps what a change leaves out. */
  replies?: boolean;
  /** The reports the assistant's routines post, such as the morning brief's (API 115): on for a new device, off for one
   *  subscribed before it could choose. */
  reports?: boolean;
};

/** The assistant's events a device can be pushed, besides the board's (`NOTIFY_EVENTS` in the web app): those a board
 *  has are in its devices' events. */
export const ASSISTANT_PUSH_EVENTS: { id: "replies" | "reports"; label: string; hint: string }[] = [
  { id: "replies", label: "Assistant's replies", hint: "It finished a reply (those to what you sent on Telegram go back there)" },
  { id: "reports", label: "Routine reports", hint: "What its routines post, such as the morning brief: its first line" },
];

/** The mobile app's push, through Expo's push service (API 113): its subscriptions are `kind` `expo`. */
export const EXPO_PUSH_API = 113;

/** How a device is pushed to: Web Push (a browser), or the mobile app through Expo (API 113; `web` before). */
export type PushKind = "web" | "expo";

/** A device that gets the board's notifications by Web Push (API 74; see server/src/integrations/push.rs), or the app. */
export interface PushDevice {
  id: string;
  /** Its push service's URL for it, which tells this browser's own from the others; for the app, its Expo push token. */
  endpoint: string;
  /** API 113. */
  kind?: PushKind;
  /** The paired device that subscribed (API 113), whose subscriptions go when it's revoked. */
  device_id?: string | null;
  name: string;
  events: PushEvents;
  created_at: string;
  last_sent_at: string | null;
  /** Why the last push to it failed, until one works. */
  last_error: string | null;
}

export const pushApi = ({ del, get, patch, post }: Http) => ({
  // Push to devices (API 74): the board's key to subscribe with, and the devices that have.
  push: () => get<{ public_key: string; subscriptions: PushDevice[] }>("/push"),
  /** Adds this browser's subscription (`PushSubscription.toJSON()`), or updates it; events are kept unless given. */
  pushSubscribe: (b: { endpoint: string; keys: { p256dh: string; auth: string }; name: string; events?: PushEvents }) =>
    post<PushDevice>("/push/subscriptions", b),
  /** Adds the app's subscription, its Expo push token (API 113), or updates it; events are kept unless given. A paired device sees only its own. */
  pushSubscribeApp: (b: { token: string; name: string; events?: PushEvents }) =>
    post<PushDevice>("/push/subscriptions", { kind: "expo", endpoint: b.token, name: b.name, ...(b.events && { events: b.events }) }),
  updatePushDevice: (id: string, b: { name?: string; events?: PushEvents }) => patch<PushDevice>(`/push/subscriptions/${enc(id)}`, b),
  removePushDevice: (id: string) => del(`/push/subscriptions/${enc(id)}`),
  testPush: (id: string) => post(`/push/subscriptions/${enc(id)}/test`),
});
