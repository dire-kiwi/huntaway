import { readyToCheck, type Status, type Task } from "./api";

/**
 * What tasks notify of, and the settings for it: kept apart from how a browser shows them (notifier.ts), so that other
 * ways of telling the user (such as push to a phone) can use the same triggers and settings.
 */
export type NotifyEvent = "attention" | "review" | "merge" | "done";

export const NOTIFY_EVENTS: { id: NotifyEvent; label: string; hint: string }[] = [
  { id: "attention", label: "Needs attention", hint: "Its agent asks a question or for permission, or its run fails" },
  { id: "review", label: "Ready to review", hint: "In review, once its automatic review passes (or with none to wait for)" },
  { id: "merge", label: "Ready for merge", hint: "Moved to Ready for merge" },
  { id: "done", label: "Done", hint: "Merged, or moved to Done" },
];

/** Off, system notifications, a sound, or both. */
export type NotifyMode = "off" | "notify" | "sound" | "both";

export const NOTIFY_MODES: { id: NotifyMode; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "notify", label: "Notifications" },
  { id: "sound", label: "Sound" },
  { id: "both", label: "Both" },
];

export const showsNotifications = (m: NotifyMode) => m === "notify" || m === "both";
export const playsSound = (m: NotifyMode) => m === "sound" || m === "both";

export interface NotifySettings {
  mode: NotifyMode;
  /** Which events notify. */
  events: Record<NotifyEvent, boolean>;
  /** The number of tasks that need attention in the tab title and icon, and on the desktop app's badge. */
  count: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = { mode: "off", events: { attention: true, review: true, merge: false, done: false }, count: true };

const KEY = "ia.notifications";

/** The settings when this browser has no storage, for this page only. */
let unsaved: string | null = null;

function readSaved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return unsaved;
  }
}

function parseSettings(raw: string | null): NotifySettings {
  try {
    const saved = JSON.parse(raw ?? "{}") ?? {};
    return {
      mode: NOTIFY_MODES.some((m) => m.id === saved.mode) ? saved.mode : DEFAULT_NOTIFY.mode,
      events: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e.id, typeof saved.events?.[e.id] === "boolean" ? saved.events[e.id] : DEFAULT_NOTIFY.events[e.id]])) as NotifySettings["events"],
      count: typeof saved.count === "boolean" ? saved.count : DEFAULT_NOTIFY.count,
    };
  } catch {
    return DEFAULT_NOTIFY;
  }
}

let cached: { raw: string | null; settings: NotifySettings } | null = null;

/** The settings saved in this browser, with the defaults for the rest: the same object while they don't change. */
export function notifySettings(): NotifySettings {
  const raw = readSaved();
  if (!cached || cached.raw !== raw) cached = { raw, settings: parseSettings(raw) };
  return cached.settings;
}

const listeners = new Set<() => void>();

export function saveNotifySettings(s: NotifySettings) {
  const raw = JSON.stringify(s);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    unsaved = raw;
  }
  listeners.forEach((l) => l());
}

/** Calls `cb` when the settings change, in this tab or another one. */
export function onNotifySettings(cb: () => void) {
  const storage = (e: StorageEvent) => e.key === KEY && cb();
  listeners.add(cb);
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", storage);
  };
}

/** What the server says when the user stopped the run: their own doing, so it doesn't notify. */
const STOPPED = "Stopped by user";

/** What a change of task `prev` to `next` notifies of, if anything. */
export function taskEvent(prev: Task, next: Task): NotifyEvent | null {
  if (next.kind !== "task") return null;
  if (next.status === "needs_attention" && prev.status !== "needs_attention") return next.attention_reason === STOPPED ? null : "attention";
  if (readyToCheck(next) && !readyToCheck(prev)) return "review";
  if (next.status === "ready_for_merge" && prev.status !== "ready_for_merge") return "merge";
  if (next.status === "done" && prev.status !== "done") return "done";
  return null;
}

/** The column an event is about: a task the user moved there themselves doesn't notify (see movedHere). */
export const EVENT_STATUS: Record<NotifyEvent, Status> = { attention: "needs_attention", review: "in_review", merge: "ready_for_merge", done: "done" };

/** Whether task `t` is still as event `e` said, so its notification still applies. */
export function stillApplies(e: NotifyEvent, t: Task) {
  return e === "review" ? readyToCheck(t) : t.status === EVENT_STATUS[e];
}

const RESOLUTIONS: Record<string, string> = { done: "Done", not_done: "Closed: not done", wont_fix: "Closed: won't fix" };

/** A notification's title and text: the task's key and title, and what happened. */
export function notificationText(e: NotifyEvent, t: Task, key: string): { title: string; body: string } {
  const body =
    e === "attention"
      ? t.attention_reason
        ? `Needs attention: ${t.attention_reason}`
        : "Needs attention"
      : e === "review"
        ? t.review?.state === "passed"
          ? "Ready to review: its review passed"
          : "Ready to review"
        : e === "merge"
          ? "Ready for merge"
          : (RESOLUTIONS[t.resolution ?? "done"] ?? "Done");
  return { title: `${key} ${t.title}`, body: body.length > 200 ? `${body.slice(0, 199)}…` : body };
}

/** How many tasks need attention. */
export function attentionCount(tasks: Iterable<Task>) {
  let n = 0;
  for (const t of tasks) if (t.kind === "task" && t.status === "needs_attention") n++;
  return n;
}

/**
 * How long a task that's ready to review has to stay so before it notifies. A review starts a moment after the run
 * ends (it reads the worktree first), and a run can carry on straight away, so either would make a false alarm.
 */
export const REVIEW_GRACE_MS = 5_000;

/**
 * Turns task changes into notifications: at once for most, but for "ready to review" only once it has stayed so for
 * `graceMs` (asking `current` for the task as it is then). Keyed by host and task id.
 */
export function notifyGate(notify: (t: Task, e: NotifyEvent) => void, current: (t: Task) => Task | undefined, graceMs = REVIEW_GRACE_MS) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const cancel = (key: string) => {
    clearTimeout(pending.get(key));
    pending.delete(key);
  };
  return {
    observe(prev: Task, next: Task) {
      const key = `${next.host_id}:${next.id}`;
      if (!readyToCheck(next)) cancel(key);
      const e = taskEvent(prev, next);
      if (!e) return;
      if (e !== "review") return notify(next, e);
      if (pending.has(key)) return;
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          const t = current(next);
          if (t && readyToCheck(t)) notify(t, "review");
        }, graceMs),
      );
    },
    clear() {
      for (const key of [...pending.keys()]) cancel(key);
    },
  };
}
