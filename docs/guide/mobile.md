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

The phone app (`apps/mobile`, an Expo app for Android and iOS; see its README to run it) shows the board's Inbox,
assistant, projects and tasks. It doesn't push yet: for notifications, use the board in the phone's browser as above.

**Connecting a phone.** With the phone on the same Wi-Fi as the board, the app's Connect screen lists the boards it
finds there (it asks each address of the network on port 7879; change the port beside the list if yours listens on
another). Tap the board, then on the board open Settings → Network access → **Pair a phone**: it shows a 6-digit PIN.
Type it in the app. The PIN is good for 5 minutes and one phone, and 5 wrong PINs end pairing (start it again for a new
one), so someone else on the network can't guess their way in.

A paired phone gets a token of its own, which can see the board and work its tasks (answer prompts and questions,
send messages, start, stop and move tasks), on this host and every host it links, but not change settings, open
terminals, touch git or link hosts. Settings → Network access lists the paired phones; **Unpair** cuts one off at once.
_Forget this board_ in the app unpairs it too.

A board the phone can't find (over Tailscale, on another network, an older board) can be typed in under _Or type its
address_: its address and the PIN, or its link from Settings → Network access with the board's token (full control).
Plain HTTP travels unencrypted, so use your own Wi-Fi or Tailscale.
