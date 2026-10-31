// The board's service worker (registered by push.ts): it shows the board's push notifications (see
// server/src/push.rs) and opens the task when one is tapped. It caches nothing, and has no fetch
// handler: pages, the UI's scripts and the API all come from the server as they would without it, so
// a new UI build is never hidden behind an old copy (see uiVersion.ts).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const windows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("push", (e) => {
  let msg = null;
  try {
    msg = e.data && e.data.json();
  } catch {
    /* not one of the board's */
  }
  if (msg && msg.title) e.waitUntil(show(msg));
});

async function show(msg) {
  // The board open in front on this device shows the task itself (and notifies, if it's set to: notifier.ts).
  if (msg.task_id && (await windows()).some((w) => w.focused && w.visibilityState === "visible")) return;
  await self.registration.showNotification(msg.title, {
    body: msg.body,
    // A task's notification replaces the one before it.
    tag: msg.tag,
    renotify: true,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url: msg.url, task_id: msg.task_id },
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(open(new URL(data.url || "/", self.location.origin).href, data.task_id));
});

/** Opens `url` (a task's page): in the board's window if one is open, where the page opens the task itself (main.tsx). */
async function open(url, taskId) {
  const board = (await windows()).find((w) => new URL(w.url).origin === self.location.origin);
  if (!board) return self.clients.openWindow(url);
  await board.focus();
  board.postMessage(taskId ? { type: "open-task", task_id: taskId } : { type: "open", url });
}

// The push service replaced the subscription: subscribe again with the same key. The page sends the new
// one to the board the next time it's opened (push.ts), and the board drops the old one when it's refused.
self.addEventListener("pushsubscriptionchange", (e) => {
  const options = e.oldSubscription && e.oldSubscription.options;
  if (options && options.applicationServerKey) e.waitUntil(self.registration.pushManager.subscribe(options).catch(() => {}));
});
