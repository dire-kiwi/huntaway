import { del, enc, get, patch, post } from "./http";

/** Which of the board's notifications a device gets by push (see notifications.ts). */
export type PushEvents = Record<"attention" | "review" | "merge" | "done", boolean>;

/** A device that gets the board's notifications by Web Push (API 74; see server/src/integrations/push.rs). */
export interface PushDevice {
  id: string;
  /** Its push service's URL for it, which tells this browser's own from the others. */
  endpoint: string;
  name: string;
  events: PushEvents;
  created_at: string;
  last_sent_at: string | null;
  /** Why the last push to it failed, until one works. */
  last_error: string | null;
}

export const pushApi = {
  // Push to devices (API 74): the board's key to subscribe with, and the devices that have.
  push: () => get<{ public_key: string; subscriptions: PushDevice[] }>("/push"),
  /** Adds this browser's subscription (`PushSubscription.toJSON()`), or updates it; events are kept unless given. */
  pushSubscribe: (b: { endpoint: string; keys: { p256dh: string; auth: string }; name: string; events?: PushEvents }) =>
    post<PushDevice>("/push/subscriptions", b),
  updatePushDevice: (id: string, b: { name?: string; events?: PushEvents }) => patch<PushDevice>(`/push/subscriptions/${enc(id)}`, b),
  removePushDevice: (id: string) => del(`/push/subscriptions/${enc(id)}`),
  testPush: (id: string) => post(`/push/subscriptions/${enc(id)}/test`),
};
