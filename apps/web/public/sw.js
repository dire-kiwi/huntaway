// The board's service worker (registered by components/layout/push.ts): it shows the board's push notifications (see
// apps/server/src/push) and opens the task when one is tapped. It caches nothing, and has no fetch handler: pages, the
// UI's scripts and the API all come from the server as they would without it, so a new UI build is never hidden behind
// an old copy. (Answering a prompt from its notification, with Allow and Deny, waits for the phone app's push answers.)

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()))

const windows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true })

self.addEventListener("push", (e) => {
  let msg = null
  try {
    msg = e.data && e.data.json()
  } catch {
    // Not one of the board's.
  }
  if (msg && msg.title) e.waitUntil(show(msg))
})

/** Shows push `msg`, unless the board is open in front on this device, which shows the task itself (and notifies, if it's set to). */
function show(msg) {
  return windows().then((all) => {
    if (msg.task_id && all.some((w) => w.focused && w.visibilityState === "visible")) return undefined
    return self.registration.showNotification(msg.title, {
      body: msg.body,
      // A task's notification replaces the one before it.
      tag: msg.tag,
      renotify: true,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: msg.url, task_id: msg.task_id },
    })
  })
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const data = e.notification.data || {}
  e.waitUntil(open(new URL(data.url || "/", self.location.origin).href, data.task_id))
})

/** Opens `url` (a task's page): in the board's window if one is open, where the page opens the task itself. */
function open(url, taskId) {
  return windows().then((all) => {
    const board = all.find((w) => new URL(w.url).origin === self.location.origin)
    if (!board) return self.clients.openWindow(url)
    // Focus is only allowed while handling a tap; the task opens in the board either way.
    return board
      .focus()
      .catch(() => undefined)
      .then(() => board.postMessage(taskId ? { type: "open-task", task_id: taskId } : { type: "open", url }, []))
  })
}

// The push service replaced the subscription: subscribe again with the same key. The page sends the new one to the
// board the next time it's opened (push.ts), and the board drops the old one when it's refused.
self.addEventListener("pushsubscriptionchange", (e) => {
  const options = e.oldSubscription && e.oldSubscription.options
  if (options && options.applicationServerKey) e.waitUntil(self.registration.pushManager.subscribe(options).catch(() => {}))
})
