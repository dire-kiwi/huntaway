// The board's service worker (registered by push.ts): it shows the board's push notifications (see
// apps/server/src/integrations/push.ts) and opens the task when one is tapped. A permission prompt's has Allow and
// Deny, which answer it with the one-time token that came with it (apps/server/src/integrations/push_answers.ts):
// the worker never has the board's token. It caches nothing, and has no fetch
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

/** Shows push `msg` (or, with `again`, a prompt's notification whose answer didn't go through, with why). */
async function show(msg, again = false) {
  // The board open in front on this device shows the task itself (and notifies, if it's set to: notifier.ts).
  if (!again && msg.task_id && (await windows()).some((w) => w.focused && w.visibilityState === "visible")) return;
  await self.registration.showNotification(msg.title, {
    body: msg.body,
    // A task's notification replaces the one before it.
    tag: msg.tag,
    renotify: true,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url: msg.url, task_id: msg.task_id, title: msg.title, tag: msg.tag, answer: msg.answer },
    ...(msg.answer && {
      actions: [
        { action: "allow", title: "Allow" },
        { action: "deny", title: "Deny" },
      ],
      // A prompt waits for its answer.
      requireInteraction: true,
    }),
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  if ((e.action === "allow" || e.action === "deny") && data.answer) return e.waitUntil(answer(data, e.action));
  e.waitUntil(open(new URL(data.url || "/", self.location.origin).href, data.task_id));
});

/** Opens `url` (a task's page): in the board's window if one is open, where the page opens the task itself (main.tsx). */
async function open(url, taskId) {
  const board = (await windows()).find((w) => new URL(w.url).origin === self.location.origin);
  if (!board) return self.clients.openWindow(url);
  // Focus is only allowed while handling a tap; the task opens in the board either way.
  await board.focus().catch(() => {});
  board.postMessage(taskId ? { type: "open-task", task_id: taskId } : { type: "open", url });
}

/** Answers a prompt's notification's request with its token, and shows how that went in its place. */
async function answer(data, decision) {
  let text;
  // Whether it can be tried again: the board or the prompt's host couldn't be reached, but the token still works.
  let retry = false;
  try {
    const res = await fetch(new URL(data.answer.url, self.location.origin).href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.answer.token, decision }),
    });
    const body = await res.json().catch(() => ({}));
    text = body.message || (res.ok ? (decision === "allow" ? "Allowed." : "Denied.") : `It couldn't be answered (${res.status}).`);
    retry = body.result === "offline" || body.result === "failed" || res.status >= 500;
  } catch {
    text = "The board can't be reached. Try again, or open it to answer.";
    retry = true;
  }
  if (retry) return show({ ...data, body: text }, true);
  await self.registration.showNotification(data.title || "Huntaway", {
    body: text,
    tag: data.tag,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    // Tapping it opens the task, as the prompt's did.
    data: { url: data.url, task_id: data.task_id },
  });
}

// The push service replaced the subscription: subscribe again with the same key. The page sends the new
// one to the board the next time it's opened (push.ts), and the board drops the old one when it's refused.
self.addEventListener("pushsubscriptionchange", (e) => {
  const options = e.oldSubscription && e.oldSubscription.options;
  if (options && options.applicationServerKey) e.waitUntil(self.registration.pushManager.subscribe(options).catch(() => {}));
});
