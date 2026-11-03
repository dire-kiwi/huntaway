// Native push (API 103), apart from Expo's modules so it can be tested: the app's subscription on each paired board
// (a board's hub watches every host on it, so one per board), and what a notification does. Tapping one opens its task
// on the board it came from. A prompt's Allow and Deny answer it with the push's own one-time token
// (`POST /api/permissions/{id}/push-answer`), which needs no device token, so they work from the lock screen, where
// the keychain can't be read. Pushes pass through Expo, Apple and Google, so they carry the task's key and title and
// the event only; the rest is fetched over the app's own connection. See notifications.ts for the Expo side.
import { ASSISTANT_PUSH_EVENTS, EXPO_PUSH_API, type Client, type Fetch, type PushDevice, type PushEvents, type PushPrompts } from "@huntaway/client";
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

/** The assistant's events (its replies and its routines' reports) a board can push here: those it has (HA-162: a board
 *  from before shows none in the phone's events). */
export const assistantPushEvents = (e: PushEvents) => ASSISTANT_PUSH_EVENTS.filter((x) => typeof e[x.id] === "boolean");

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

/** The task screen a push opens, if it's about a task: a reply's is the assistant's thread, a report's its routine's. */
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
  /** The taps handled before, kept over restarts (see handledStore). */
  seen?: Handled;
}

/** The taps handled already, by notification and action. */
export interface Handled {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

export const HANDLED_KEY = "push.handled";

/**
 * The taps handled, kept in `store` (the last `max`): the tap that started the app is handed over again on every start
 * (getLastNotificationResponseAsync), and mustn't open its task, or answer its prompt, each time.
 */
export function handledStore(store: SecretStore, max = 100): Handled {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<string[]> => {
    try {
      const v = JSON.parse((await store.get(HANDLED_KEY)) ?? "[]");
      return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has: async (key) => (await read()).includes(key),
    add: (key) => {
      // One at a time, so that two taps at once both stay.
      const next = queue.then(async () => {
        const keys = (await read()).filter((k) => k !== key);
        await store.set(HANDLED_KEY, JSON.stringify([...keys, key].slice(-max)));
      });
      queue = next.catch(() => {});
      return next;
    },
  };
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
    if (id && deps.seen) {
      if (await deps.seen.has(key).catch(() => false)) return null;
      await deps.seen.add(key).catch(() => {});
    }
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
export type Subscribed = Record<string, { device?: PushDevice; error?: string; /** Turned down by the board: not retried. */ final?: boolean }>;

/** A board's subscription is made again when the phone pairs again there (a new device) or its token changes. */
export const subscribedKey = (b: Board, token: string) => `${b.id}|${b.deviceId}|${b.url}|${token}`;

/**
 * What's still to be undone on a board that couldn't be reached at the time: push turned off (`unsubscribe`: this
 * phone's subscriptions there are deleted), or the board removed from the app (`revoke`: the phone is unpaired there,
 * which deletes them too, with the token it had, which the app keeps only for this).
 */
export type Pending = { kind: "unsubscribe"; board: string } | { kind: "revoke"; board: string; url: string; deviceId: string; token: string };

/** Kept with the boards' tokens (a `revoke` holds one). */
export const PENDING_KEY = "push.pending";

/** The few calls the registrar makes. */
export type PushClient = Pick<Client, "push" | "pushSubscribeApp" | "removePushDevice" | "revokeDevice">;

/** The paired boards, as the Boards store keeps them. */
export interface BoardList {
  get(): { boards: Board[] };
  board(id: string): Board | undefined;
  token(id: string): string;
  update(id: string, change: Partial<Omit<Board, "id">>): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface RegistrarDeps {
  boards: BoardList;
  /** Where pending work is kept (the keychain). */
  store: SecretStore;
  /** This phone's Expo push token, or why there's none: `retry` if it may work later (it needs the network). */
  expoToken(): Promise<{ token: string } | { retry: boolean }>;
  name(): string;
  /** A client for a board, with its token (or `token`, a removed board's). */
  clientFor(b: Pick<Board, "id" | "url">, token?: string): PushClient;
  /** Calls `fn` in `ms` (setTimeout), for retries. */
  later(fn: () => void, ms: number): () => void;
  onChange?(): void;
}

/** Retries after a failure wait this long, doubling, up to `RETRY_MAX`. */
export const RETRY_FIRST = 30_000;
export const RETRY_MAX = 15 * 60_000;

/** Whether an error means the board turned the request down for good (it's gone, or the phone is unpaired there). */
const final = (e: unknown) => typeof (e as { status?: number })?.status === "number" && [401, 403, 404].includes((e as { status: number }).status);

/** Whether the board turned a subscription down (unpaired, or not allowed): trying again won't help. */
const refusedBy = (e: unknown) => [400, 401, 403].includes((e as { status?: number })?.status ?? 0);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Keeps this phone subscribed on each paired board that can push to it, and unsubscribed where it was turned off or
 * the board removed. `sync` does what's still to do, and is called whenever it may now work: at start, when a board's
 * websocket connects (so also once the network or the app comes back), and on its own after a failure, waiting
 * longer each time.
 */
export class PushRegistrar {
  subscribed: Subscribed = {};
  pending: Pending[] = [];
  /** The boards subscribed with the token (see subscribedKey). */
  private done = new Set<string>();
  /** The boards that turned this token down (by subscribedKey): tried again with a new pairing or token. */
  private refused = new Set<string>();
  private loaded: Promise<void> | null = null;
  private failures = 0;
  private cancelRetry: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private deps: RegistrarDeps) {}

  private load() {
    this.loaded ??= (async () => {
      try {
        const v = JSON.parse((await this.deps.store.get(PENDING_KEY)) ?? "[]");
        if (Array.isArray(v)) this.pending = [...v.filter((p) => p && typeof p.board === "string"), ...this.pending];
      } catch {
        /* none */
      }
    })();
    return this.loaded;
  }

  private async save() {
    await this.deps.store.set(PENDING_KEY, JSON.stringify(this.pending)).catch(() => {});
  }

  private changed() {
    this.deps.onChange?.();
  }

  /** Whether push from board `id` was turned off here, but the board can't have been told yet. */
  pendingOn(id: string) {
    return this.pending.some((p) => p.kind === "unsubscribe" && p.board === id);
  }

  /** Does what's still to do; one run at a time (a call during one runs again after it). */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run();
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async run() {
    await this.load();
    let failed = false;
    // Undoing first: a board turned off and on again meanwhile has no pending unsubscribe (see setPush).
    for (const p of [...this.pending]) {
      try {
        if (p.kind === "revoke") await this.deps.clientFor({ id: p.board, url: p.url }, p.token).revokeDevice(p.deviceId);
        else {
          const board = this.deps.boards.board(p.board);
          if (board) {
            const client = this.deps.clientFor(board);
            for (const sub of (await client.push()).subscriptions.filter((x) => x.kind === "expo")) {
              await client.removePushDevice(sub.id).catch((e) => {
                if (!final(e)) throw e;
              });
            }
          }
        }
        this.pending = this.pending.filter((x) => x !== p);
      } catch (e) {
        // Unpaired there already, or the board is gone: nothing left to undo.
        if (final(e)) this.pending = this.pending.filter((x) => x !== p);
        else failed = true;
      }
    }
    await this.save();

    const want = this.deps.boards.get().boards.filter((b) => pushable(b) && !this.pendingOn(b.id));
    // (Kept once had, so this asks Expo only the first time.)
    const got = want.length ? await this.deps.expoToken() : null;
    if (got && "retry" in got && got.retry) failed = true;
    const token = got && "token" in got ? got.token : null;
    if (token) {
      await Promise.all(
        want.map(async (b) => {
          const key = subscribedKey(b, token);
          if (this.done.has(key)) {
            // Still there? It may have been removed on the board, or dropped there as unregistered: then again.
            try {
              const { subscriptions } = await this.deps.clientFor(b).push();
              if (subscriptions.some((x) => x.kind === "expo" && x.endpoint === token)) return;
              this.done.delete(key);
            } catch {
              return;
            }
          }
          if (this.refused.has(key)) return;
          try {
            const device = await this.deps.clientFor(b).pushSubscribeApp({ token, name: this.deps.name() });
            // Turned off while it was being made: it goes again.
            if (!pushable(this.deps.boards.board(b.id) ?? { ...b, push: false })) return;
            this.done.add(key);
            this.subscribed = { ...this.subscribed, [b.id]: { device } };
          } catch (e) {
            if (refusedBy(e)) this.refused.add(key);
            else failed = true;
            this.subscribed = { ...this.subscribed, [b.id]: { error: message(e), final: refusedBy(e) } };
          }
        }),
      );
    }
    this.changed();
    this.retry(failed);
  }

  /** After a failure, tries again by itself, waiting longer each time; after a success, stops. */
  private retry(failed: boolean) {
    this.cancelRetry?.();
    this.cancelRetry = null;
    if (!failed) {
      this.failures = 0;
      return;
    }
    const wait = Math.min(RETRY_FIRST * 2 ** this.failures, RETRY_MAX);
    this.failures++;
    this.cancelRetry = this.deps.later(() => {
      this.cancelRetry = null;
      void this.sync();
    }, wait);
  }

  /** Starts again with a new token (it changed, or notifications were allowed since). */
  tokenChanged() {
    this.done.clear();
    this.refused.clear();
    return this.sync();
  }

  /**
   * Turns push from board `id` on or off. Off is kept at once and done on the board as soon as it can be: until then,
   * the board's still pushing (see pendingOn).
   */
  async setPush(id: string, on: boolean) {
    await this.load();
    const board = this.deps.boards.board(id);
    if (!board) return;
    this.pending = this.pending.filter((p) => !(p.kind === "unsubscribe" && p.board === id));
    for (const set of [this.done, this.refused]) for (const k of [...set]) if (k.startsWith(`${id}|`)) set.delete(k);
    const { [id]: _, ...rest } = this.subscribed;
    this.subscribed = rest;
    if (!on) this.pending.push({ kind: "unsubscribe", board: id });
    await this.save();
    await this.deps.boards.update(id, { push: on });
    this.changed();
    await this.sync();
  }

  /** Removes a board from the app, and unpairs the phone there (now, or once it can be reached). */
  async removeBoard(id: string) {
    await this.load();
    const board = this.deps.boards.board(id);
    if (!board) return;
    const token = this.deps.boards.token(id);
    this.pending = this.pending.filter((p) => p.board !== id);
    if (board.deviceId && token) this.pending.push({ kind: "revoke", board: id, url: board.url, deviceId: board.deviceId, token });
    for (const set of [this.done, this.refused]) for (const k of [...set]) if (k.startsWith(`${id}|`)) set.delete(k);
    const { [id]: _, ...rest } = this.subscribed;
    this.subscribed = rest;
    await this.save();
    await this.deps.boards.remove(id);
    this.changed();
    await this.sync();
  }

  /** Notes a subscription changed elsewhere (its events). */
  noteDevice(id: string, device: PushDevice) {
    this.subscribed = { ...this.subscribed, [id]: { device } };
    this.changed();
  }
}

/** Events with one changed. */
export function withEvent(e: PushEvents, id: (typeof PUSH_EVENTS)[number]["id"] | (typeof ASSISTANT_PUSH_EVENTS)[number]["id"], on: boolean): PushEvents {
  return { ...e, [id]: on };
}
