# Phones: notifications and the mobile app

## Push notifications on a phone

The board can push its notifications to a phone (or any browser) even while the board isn't open
there, and tapping one opens the task. Browsers only allow this for a page on HTTPS (or
localhost), so the phone needs the board at an HTTPS address it can reach. With
[Tailscale](https://tailscale.com) on the machine and the phone:

```sh
tailscale serve --bg 7879     # https://<machine>.<tailnet>.ts.net → 127.0.0.1:7879
```

(or any TLS reverse proxy in front of port 7879, such as Caddy's `reverse_proxy`). Open
`https://<machine>.<tailnet>.ts.net/?token=<huntaway token>` on the phone (Settings → Network access shows the token),
then install it:

- **Android** (Chrome): menu → _Install app_ (or _Add to Home screen_).
- **iPhone and iPad** (iOS 16.4 or later): Safari's Share → _Add to Home Screen_. iOS only pushes
  to the board opened from the Home Screen, which keeps its own storage, so paste the token there
  when it asks.

Then, in the installed app, Settings → Notifications → _Push to this device_ → **Turn on push for
this device** (it asks for permission) and _Send a test_. Each device picks its own events (the
same ones as the browser's notifications: needs attention, ready to review, ready for merge,
done; and the assistant's replies, which say only that it replied, and its routines'
reports, which say their first line); the list there shows the other devices, with their last error,
and removes them. A new device gets reports but not replies; one that subscribed before there was a
choice gets neither until it chooses, and a page that sends only some events keeps the others. Nothing is
pushed for a move made from this board, and a device shows nothing while the board is open in
front on it (the page has the task, and its own notifications if they're on). The
section says why push isn't available where it isn't: a plain-HTTP page, an iPhone's browser
rather than the Home Screen app, or a browser without push.

The board keeps a VAPID key (in its settings table) that subscriptions are made for, and one row
per device in `push_subscriptions` (the RPCs `hub.push.info`, `subscribe`, `update`, `unsubscribe` and `test`). It
pushes about its own host's tasks: a hub doesn't watch its linked hosts' events for push yet, so subscribe on each
machine whose tasks you want pushed. The contact it gives push services is this project's GitHub page (the old
`IA_PUSH_SUBJECT` that changed it is gone). The installed app is a PWA (`manifest.webmanifest`, `sw.js`): its service
worker caches nothing, so it always loads the board's current UI.

**Permission prompts** are pushed too. Each device picks whose: _None_, _The assistant's_ (the
default) or _Every task's_. A device that gets a task's prompt isn't also told the task needs
attention. A push carries the task's key and title and the tool's name, but never the tool's input,
as it passes through the push service. Tapping it opens the thread, where you answer it: the
notification has no **Allow** or **Deny**, as answering from the lock screen waits for the phone
app (below). Questions, plans and approvals of changes to the board (projects, deletions,
automations) are pushed the same way.

## The mobile app

The phone app (`apps/mobile` in the old repository, an Expo app for Android and iOS) is not available for the new
server yet. The old app keeps working against machines that still run the old server, but it can't reach one that has
switched. What came with it waits for it too: pairing a phone and its device tokens, push through Expo, answering a
prompt from the lock screen, and the paired phones in Settings → Network access (which keeps the board's URL and
token).

Until then, use the board in the phone's browser: open it at an HTTPS address as above (or any address the phone can
reach, without push), installed on the Home Screen if you like, and turn on push there.
