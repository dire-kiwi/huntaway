import { isOpenBoard, movedHere, type Task } from "./api";
import {
  attentionCount,
  EVENT_STATUS,
  notificationText,
  notifyGate,
  notifySettings,
  onNotifySettings,
  playsSound,
  showsNotifications,
  stillApplies,
  type NotifyEvent,
} from "./notifications";
import { onNavigate, openTask, parse } from "./router";
import { liveTaskChanges, taskKey, useStore } from "./store";

/**
 * Tells the user of task changes on every board the UI shows (see notifications.ts for which): with system
 * notifications and a sound, from one tab of the browser, and keeps the count of tasks that need attention in the
 * tab title, the icon and the desktop app's badge.
 */

declare global {
  interface Window {
    /** What the desktop app adds (electron/preload.cjs). */
    huntawayDesktop?: {
      setBadgeCount: (n: number) => void;
      focus: () => void;
      /** Installs the latest release's app package and relaunches, where the app can (HA-68). Rejects with why not. */
      updateShell?: () => Promise<unknown>;
    };
  }
}

/** Why system notifications can or can't be shown here. */
export type NotifyPermission = NotificationPermission | "insecure" | "unsupported" | "preview";

export function notifyPermission(): NotifyPermission {
  // A PR preview's agents and demo tasks would notify alongside the user's own board, from a board they're only trying.
  if (isOpenBoard()) return "preview";
  // Browsers only offer them to secure pages: HTTPS, and localhost.
  if (!window.isSecureContext) return "insecure";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** This tab, for what tabs share. */
const tab = Math.random().toString(36).slice(2);

/** Whether this tab is the one that notifies, of all of the browser's tabs (and windows) on this board. */
let leading = () => false;

/** The first tab to ask holds the lock for as long as it's open; then the next one in line has it. */
function lead() {
  if (navigator.locks) {
    let held = false;
    leading = () => held;
    navigator.locks
      .request("ia.notifications", () => {
        held = true;
        return new Promise<void>(() => {});
      })
      .catch(() => {});
    return;
  }
  // Pages that aren't secure have no locks (or notifications, but the sound still plays once): the tab that last
  // took a heartbeat over that had gone stale, or kept its own fresh. Background tabs' timers are slowed down, so
  // it's checked again before notifying.
  const KEY = "ia.notifyLeader";
  const read = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { tab: string; at: number } | null;
  const beat = () => {
    try {
      const cur = read();
      if (!cur || cur.tab === tab || Date.now() - cur.at > 6_000) localStorage.setItem(KEY, JSON.stringify({ tab, at: Date.now() }));
      return read()?.tab === tab;
    } catch {
      return true;
    }
  };
  leading = beat;
  beat();
  setInterval(beat, 2_000);
  window.addEventListener("pagehide", () => {
    try {
      if (read()?.tab === tab) localStorage.removeItem(KEY);
    } catch {
      /* it goes stale */
    }
  });
}

/** The task open in this tab: in the side panel, or on its own page. */
function openTaskId(): string | null {
  const route = parse(window.location.pathname);
  return new URLSearchParams(window.location.search).get("task") ?? (route.name === "task" ? route.taskId : null);
}

const focused = () => document.visibilityState === "visible" && document.hasFocus();

/** The task open in the focused tab, if one of the browser's tabs on this board is focused. */
const FOCUS_KEY = "ia.focusedTask";

function shareFocus() {
  try {
    const cur = JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "null") as { tab: string; task: string | null } | null;
    if (focused()) {
      const task = openTaskId();
      if (cur?.tab !== tab || cur.task !== task) localStorage.setItem(FOCUS_KEY, JSON.stringify({ tab, task }));
    } else if (cur?.tab === tab) localStorage.removeItem(FOCUS_KEY);
  } catch {
    /* only this tab's focus counts */
  }
}

/** Whether task `id` is open in a focused window: this one, or another of the browser's. */
function openInFocus(id: string) {
  if (focused()) return openTaskId() === id;
  try {
    return (JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "null") as { task: string | null } | null)?.task === id;
  } catch {
    return false;
  }
}

// ---------- notifications ----------

/** The notifications shown by this tab, by host and task id. */
const shown = new Map<string, { n: Notification; event: NotifyEvent }>();
const keyOf = (t: { host_id: string; id: string }) => `${t.host_id}:${t.id}`;

function close(key: string) {
  shown.get(key)?.n.close();
  shown.delete(key);
}

/** Closes task `id`'s notification, once it's been opened. */
function closeOpened(id: string | null | undefined) {
  if (id) for (const key of [...shown.keys()]) if (key.endsWith(`:${id}`)) close(key);
}

/** Shows `title` and `body` as a system notification; clicking it opens task `t` (if given) in this window. */
export function showNotification(title: string, body: string, t?: Task) {
  if (notifyPermission() !== "granted") return;
  try {
    // Silent: the sound is a setting of its own.
    const n = new Notification(title, { body, icon: "/icon.svg", silent: true });
    n.onclick = () => {
      n.close();
      window.focus();
      window.huntawayDesktop?.focus();
      if (t) openTask(t.id);
    };
    return n;
  } catch {
    // Some browsers have the API but only let service workers show them (Chrome on Android).
    return undefined;
  }
}

function present(t: Task, event: NotifyEvent) {
  const settings = notifySettings();
  if (settings.mode === "off" || !settings.events[event] || !leading()) return;
  if (openInFocus(t.id) || movedHere(t.host_id, t.id, EVENT_STATUS[event])) return;
  if (playsSound(settings.mode)) chime(event);
  if (!showsNotifications(settings.mode)) return;
  const { title, body } = notificationText(event, t, taskKey(t, useStore.getState().projects));
  const key = keyOf(t);
  // A task has one notification at a time: its latest.
  close(key);
  const n = showNotification(title, body, t);
  if (!n) return;
  shown.set(key, { n, event });
  n.addEventListener("close", () => shown.get(key)?.n === n && shown.delete(key));
}

const gate = notifyGate(present, (t) => {
  const cur = useStore.getState().tasks[t.id];
  return cur?.host_id === t.host_id ? cur : undefined;
});

function taskChanged(prev: Task | undefined, next: Task) {
  // What it said is over: answered, or moved on.
  const s = shown.get(keyOf(next));
  if (s && !stillApplies(s.event, next)) close(keyOf(next));
  // A task first seen now (new, or not loaded yet) was in its column before anything here could tell.
  if (prev) gate.observe(prev, next);
}

// ---------- sound ----------

let audio: AudioContext | null = null;
let chimed = 0;

/** Browsers only let a page play sound once the user has clicked or typed on it: call it from a click or key. */
export function unlockSound() {
  if (!playsSound(notifySettings().mode) || typeof AudioContext === "undefined") return;
  audio ??= new AudioContext();
  if (audio.state !== "running") audio.resume().catch(() => {});
}

/** Two notes, falling for attention and rising otherwise. Several at once play once. */
export function chime(event: NotifyEvent) {
  unlockSound();
  if (!audio || audio.state === "closed" || Date.now() - chimed < 1_000) return;
  chimed = Date.now();
  const notes = event === "attention" ? [880, 660] : [660, 880];
  notes.forEach((f, i) => {
    const at = audio!.currentTime + 0.02 + i * 0.16;
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    osc.connect(gain).connect(audio!.destination);
    osc.start(at);
    osc.stop(at + 0.5);
  });
}

// ---------- count ----------

let icon: { link: HTMLLinkElement; href: string; type: string; image: Promise<HTMLImageElement | null> } | null = null;
let drawn = -1;

/** The tab's icon with a badge of `n` on it (or as it was for 0). */
async function setIcon(n: number) {
  const link = icon?.link ?? document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (!icon) {
    const image = new Image();
    icon = {
      link,
      href: link.href,
      type: link.type,
      image: new Promise((resolve) => {
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = link.href;
      }),
    };
  }
  const { href, type } = icon;
  if (!n) {
    link.type = type;
    link.href = href;
    return;
  }
  const image = await icon.image;
  if (drawn !== n) return; // a later count took over meanwhile
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (image) ctx.drawImage(image, 0, 0, 64, 64);
  const label = n > 99 ? "99+" : String(n);
  ctx.beginPath();
  ctx.arc(42, 42, 22, 0, Math.PI * 2);
  ctx.fillStyle = "#f59e0b";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#0b0b0e";
  ctx.stroke();
  ctx.fillStyle = "#0b0b0e";
  ctx.font = `bold ${label.length > 2 ? 18 : label.length > 1 ? 24 : 30}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 42, 44);
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}

const TITLE = "Huntaway";

function showCount() {
  const n = notifySettings().count ? attentionCount(Object.values(useStore.getState().tasks)) : 0;
  if (n === drawn) return;
  drawn = n;
  document.title = n ? `(${n}) ${TITLE}` : TITLE;
  setIcon(n);
  window.huntawayDesktop?.setBadgeCount(n);
}

// ---------- start ----------

let started = false;

export function startNotifications() {
  if (started) return;
  started = true;
  lead();
  liveTaskChanges.add(taskChanged);
  useStore.subscribe((s, prev) => {
    if (s.tasks !== prev.tasks) showCount();
  });
  onNotifySettings(showCount);
  showCount();

  for (const e of ["pointerdown", "keydown"]) document.addEventListener(e, unlockSound, { capture: true, passive: true });

  // Which task the focused tab shows, for all of them; and a task opened in it has nothing more to tell.
  const focusChanged = () => {
    shareFocus();
    if (focused()) closeOpened(openTaskId());
  };
  window.addEventListener("focus", focusChanged);
  window.addEventListener("blur", focusChanged);
  document.addEventListener("visibilitychange", focusChanged);
  onNavigate(focusChanged);
  window.addEventListener("pagehide", () => {
    try {
      if ((JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "null") as { tab: string } | null)?.tab === tab) localStorage.removeItem(FOCUS_KEY);
    } catch {
      /* it's taken over by the next tab focused */
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key !== FOCUS_KEY) return;
    try {
      closeOpened((JSON.parse(e.newValue ?? "null") as { task: string | null } | null)?.task);
    } catch {
      /* not one of ours */
    }
  });
  shareFocus();
}
