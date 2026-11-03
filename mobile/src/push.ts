// Native push (API 102), apart from Expo's modules so it can be tested: the app's subscription on each paired board
// (a board's hub watches every host on it, so one per board), and what a notification does. Tapping one opens its task
// on the board it came from. A prompt's Allow and Deny answer it with the push's own one-time token
// (`POST /api/permissions/{id}/push-answer`), which needs no device token, so they work from the lock screen, where
// the keychain can't be read. Pushes pass through Expo, Apple and Google, so they carry the task's key and title and
// the event only; the rest is fetched over the app's own connection. See notifications.ts for the Expo side.
import { EXPO_PUSH_API, type Client, type Fetch, type PushDevice, type PushEvents, type PushPrompts } from "@huntaway/client";
import type { Board, SecretStore } from "./boards";

/** The notification category of prompts that can be answered from the notification (the server's `categoryId`). */
export const PROMPT_CATEGORY = "prompt";
export const ALLOW = "allow";
export const DENY = "deny";
/** What a plain tap on a notification is (expo-notifications' DEFAULT_ACTION_IDENTIFIER). */
export const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

/** The events a phone can be pushed, as the web board names them (app/src/notifications.ts). */
export const PUSH_EVENTS: { id: "attention" | "review" | "merge" | "done"; label: string }[] = [
  { id: "attention", label: "Needs attention" },
  { id: "review", label: "Ready to review" },
  { id: "merge", label: "Ready for merge" },
  { id: "done", label: "Done" },
];

export const PUSH_PROMPTS: { id: PushPrompts; label: string }[] = [
  { id: "off", label: "None" },
  { id: "assistant", label: "The assistant's" },
  { id: "all", label: "Every task's" },
];

/** What a push from a board carries (server: integrations/push.rs, `expo_message`). */
export interface PushData {
  /** The board's host id: the paired board's id. */
  board: string;
  /** The task's host. */
  host?: string;
  task_id?: string;
  event?: string;
  request_id?: string;
  /** For a prompt answerable from the notification: where Allow and Deny post, and the token that answers it. */
  answer?: { url: string; token: string };
}

/** Whether a board can push to the app, and the phone hasn't turned it off there. */
export const pushable = (b: Board) => b.apiVersion >= EXPO_PUSH_API && b.push !== false;

// ---------- what a notification carries ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function parsed(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try {
      return parsed(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The data of a notification (expo-notifications' `Notification`), or null if it isn't a board's push. It's usually
 * `request.content.data`; Android's background payload has it as a JSON `dataString`, and the raw push as `body`.
 */
export function pushData(notification: Any): PushData | null {
  const req = notification?.request;
  const candidates = [req?.content?.data, req?.content?.data?.dataString, req?.trigger?.remoteMessage?.data?.body, req?.trigger?.payload?.body, notification?.data?.dataString];
  for (const c of candidates) {
    const d = parsed(c);
    if (d && typeof d.board === "string" && d.board) {
      const str = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : undefined);
      const a = parsed(d.answer);
      const answer = a && typeof a.url === "string" && typeof a.token === "string" && a.token ? { url: a.url, token: a.token } : undefined;
      return { board: d.board, host: str("host"), task_id: str("task_id"), event: str("event"), request_id: str("request_id"), answer };
    }
  }
  return null;
}

/** The task screen a push opens, if it's about a task. */
export function taskRoute(d: PushData): { pathname: "/task/[board]/[host]/[id]"; params: { board: string; host: string; id: string } } | null {
  if (!d.host || !d.task_id) return null;
  return { pathname: "/task/[board]/[host]/[id]", params: { board: d.board, host: d.host, id: d.task_id } };
}

// ---------- answering from the notification ----------

/** What an answer from a notification came to (the server's `result`), with a line to show for it. */
export interface Answered {
  result: "allowed" | "denied" | "answered" | "expired" | "closed" | "invalid" | "offline" | "failed" | "unreachable";
  message: string;
}

/** Only the board's own route for it: a push can't send the app anywhere else. */
const ANSWER_PATH = /^\/api\/permissions\/[^/?#]+\/push-answer$/;

/** Answers the prompt in push `d` from board `boardUrl` with `decision`, using the push's token alone. */
export async function answerPrompt(fetch: Fetch, boardUrl: string, d: PushData, decision: "allow" | "deny"): Promise<Answered> {
  if (!d.answer || !ANSWER_PATH.test(d.answer.url)) return { result: "invalid", message: "This notification can't answer it: open the app." };
  try {
    const res = await fetch(`${boardUrl.replace(/\/+$/, "")}${d.answer.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: d.answer.token, decision }),
    });
    const body = await res.json().catch(() => null);
    if (body && typeof body.result === "string" && typeof body.message === "string") return { result: body.result, message: body.message };
    return { result: "failed", message: `It couldn't be answered (the board answered ${res.status}): open the app.` };
  } catch {
    return { result: "unreachable", message: "The board couldn't be reached: open the app to answer it." };
  }
}

/** What answering from a notification needs from the app: kept apart so the background task can run it too. */
export interface ResponseDeps {
  /** A paired board's address, by its id (readable while the phone is locked: see `saveBoardUrls`). */
  boardUrl(id: string): Promise<string | null>;
  fetch: Fetch;
  /** Opens a task (only in the app, not in the background). */
  open?(route: NonNullable<ReturnType<typeof taskRoute>>): void;
  /** Shows how it went, in place of the notification answered. */
  show(title: string, body: string, data: PushData): Promise<void>;
  dismiss(notificationId: string): Promise<void>;
}

/** A tap on a notification, or on one of its actions (expo-notifications' `NotificationResponse`). */
export interface Response {
  actionIdentifier: string;
  notification: Any;
}

/**
 * Handles taps on notifications: a plain one opens its task; Allow or Deny answer its prompt, then replace it with what
 * happened. On Android, a tap made while the app is in the background reaches both its listener and its background
 * task, so each is handled once.
 */
export function responseHandler(deps: ResponseDeps) {
  const handled = new Set<string>();
  return async (r: Response): Promise<Answered | null> => {
    const id: string = r.notification?.request?.identifier ?? "";
    const key = `${id}:${r.actionIdentifier}`;
    if (id && handled.has(key)) return null;
    if (id) handled.add(key);
    const d = pushData(r.notification);
    if (!d) return null;
    if (r.actionIdentifier !== ALLOW && r.actionIdentifier !== DENY) {
      const route = taskRoute(d);
      if (route && deps.open) deps.open(route);
      return null;
    }
    const title: string = r.notification?.request?.content?.title ?? "Huntaway";
    const url = await deps.boardUrl(d.board);
    const answered: Answered = url ? await answerPrompt(deps.fetch, url, d, r.actionIdentifier) : { result: "invalid", message: "That board isn't paired with this phone any more." };
    if (id) await deps.dismiss(id).catch(() => {});
    const { answer: _, ...rest } = d;
    await deps.show(title, answered.message, rest).catch(() => {});
    return answered;
  };
}

// ---------- the boards' addresses, for the lock screen ----------

export const URLS_KEY = "push.boards";

/**
 * Keeps each paired board's address where it can be read while the phone is locked (`store` must be readable then),
 * for Allow and Deny on the lock screen. Addresses aren't secret; the boards' tokens stay in the keychain.
 */
export async function saveBoardUrls(store: SecretStore, list: Board[]) {
  await store.set(URLS_KEY, JSON.stringify(Object.fromEntries(list.map((b) => [b.id, b.url]))));
}

export async function savedBoardUrl(store: SecretStore, id: string): Promise<string | null> {
  try {
    const all = parsed(await store.get(URLS_KEY));
    const url = all?.[id];
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

// ---------- subscribing ----------

/** This phone's subscription on a board (a paired device sees only its own), for its Expo push token. */
export async function subscriptionOn(client: Pick<Client, "push">, token: string | null): Promise<PushDevice | null> {
  const { subscriptions } = await client.push();
  const apps = subscriptions.filter((x) => x.kind === "expo");
  return apps.find((x) => x.endpoint === token) ?? apps[0] ?? null;
}

/** What subscribing came to on each board: its subscription, or why it failed. */
export type Subscribed = Record<string, { device?: PushDevice; error?: string }>;

/**
 * Subscribes this phone (Expo push token `token`, named `name`) on each board that can push to it, keeping the events
 * it had there. `done` holds the boards already subscribed with this token (by `subscribedKey`), which are skipped.
 */
export async function subscribeAll(
  list: Board[],
  token: string,
  name: string,
  clientFor: (b: Board) => Pick<Client, "pushSubscribeApp">,
  done: Set<string> = new Set(),
): Promise<Subscribed> {
  const out: Subscribed = {};
  await Promise.all(
    list.filter(pushable).map(async (b) => {
      const key = subscribedKey(b, token);
      if (done.has(key)) return;
      try {
        out[b.id] = { device: await clientFor(b).pushSubscribeApp({ token, name }) };
        done.add(key);
      } catch (e) {
        out[b.id] = { error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return out;
}

/** A board's subscription is made again when the phone pairs again there (a new device) or its token changes. */
export const subscribedKey = (b: Board, token: string) => `${b.id}|${b.deviceId}|${b.url}|${token}`;

/** Events with one changed. */
export function withEvent(e: PushEvents, id: (typeof PUSH_EVENTS)[number]["id"], on: boolean): PushEvents {
  return { ...e, [id]: on };
}
