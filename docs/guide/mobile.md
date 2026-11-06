# Phones: notifications and the mobile app

## Push notifications on a phone

The board can push its notifications to a phone (or any browser) even while the board isn't open
there, and tapping one opens the task (API 74). Browsers only allow this for a page on HTTPS (or
localhost), so the phone needs the board at an HTTPS address it can reach. With
[Tailscale](https://tailscale.com) on the machine and the phone:

```sh
tailscale serve --bg 7878     # https://<machine>.<tailnet>.ts.net → 127.0.0.1:7878
```

(or any TLS reverse proxy in front of port 7878, such as Caddy's `reverse_proxy`). Open
`https://<machine>.<tailnet>.ts.net/?token=<huntaway token>` on the phone, then install it:

- **Android** (Chrome): menu → _Install app_ (or _Add to Home screen_).
- **iPhone and iPad** (iOS 16.4 or later): Safari's Share → _Add to Home Screen_. iOS only pushes
  to the board opened from the Home Screen, which keeps its own storage, so paste the token there
  when it asks.

Then, in the installed app, Settings → Notifications → _Push to this device_ → **Turn on push for
this device** (it asks for permission) and _Send a test_. Each device picks its own events (the
same ones as the browser's notifications: needs attention, ready to review, ready for merge,
done; and, API 110, the assistant's replies, which say only that it replied, and its routines'
reports, which say their first line); the list there shows the other devices, with their last error,
and removes them. A new device gets reports but not replies; one that subscribed before there was a
choice gets neither until it chooses, and a page that sends only some events keeps the others. Nothing is
pushed for a move made from this board, and a device shows nothing while the board is open in
front on it (the page has the task, and its own notifications if they're on). The
section says why push isn't available where it isn't: a plain-HTTP page, an iPhone's browser
rather than the Home Screen app, or a browser without push.

The board keeps a VAPID key (in its settings table) that subscriptions are made for, and one row
per device in `push_subscriptions` (`GET /push` gives the key and the devices; `POST
/push/subscriptions` takes a `PushSubscription.toJSON()` with `name` and `events`, and updates the
one with its endpoint; `PATCH` and `DELETE /push/subscriptions/{id}`; `POST
/push/subscriptions/{id}/test`). It watches the task events of every host on it, so subscribe
on the board you use (a hub, for several machines). `IA_PUSH_SUBJECT` sets the contact it gives
push services (a `mailto:` or `https:` URL; the default is this project's page). The installed app
is a PWA (`manifest.webmanifest`, `sw.js`): its service worker caches nothing, so it always loads
the board's current UI.

**Permission prompts** (API 115) are pushed too, with **Allow** and **Deny** on the notification, so
you can answer one from the lock screen. Each device picks whose: _None_, _The assistant's_ (the
default) or _Every task's_. A device that gets a task's prompt isn't also told the task needs
attention. Questions, plans and approvals of changes to the board (projects, deletions,
automations) are pushed without the buttons: tapping opens the thread. A push carries the task's
key and title and the tool's name, but never the tool's input, as it passes through the push
service. Android's Chrome shows the buttons; iOS doesn't show buttons on web notifications, so
there you tap through to the board.

The buttons don't use the board's token. Each push about a prompt carries a one-time token that
answers only that prompt: the service worker posts it to `POST /api/permissions/{id}/push-answer`
(`{"token", "decision": "allow" | "deny"}`, no `Authorization`), and shows what came of it in
the notification's place (`result` is `allowed` or `denied`, or `answered`, `expired`, `closed`,
`invalid`, `offline` or `failed`, with a `message`). The board that sends the push mints the
token and keeps only its hash (`push_answer_tokens`, see `apps/server/src/integrations/push_answers.ts`), so that's
where it's checked; a prompt on a linked host is then answered through the link, as the UI's
`/api/h/<host>/permissions/{id}` is. The first answer settles it: a token stops working once its prompt has been
answered (from a notification, the board or anywhere else) or has expired with its run, or at its `expires_at` (a
routine run's, see the assistant's approval rules) even if the hub hasn't heard yet. If the host is offline the
token still works later, and the notification keeps its buttons.

## The mobile app

`apps/mobile` is an Expo app for Android and iOS (API 118) that follows and drives your tasks on several
boards at once, a work hub and a personal board say. Its home tab is the **Assistant** (from API
120): the selected board's assistant for its picked profile, on the host the profile's assistant is
on (an assistant host of its own, perhaps, which the tab says is offline when it is), with the
board and profile switchers above it; on an older board the tab is hidden and the Inbox is home.
Then an **Inbox** of what's waiting for you on every
paired board together, each item labelled with its board (tasks that need attention, permission
prompts to allow or deny, and agents' questions to answer, in place); **Projects** with each
project's tasks by status and a sheet to add one; and each task's **thread**, with the agent's
reply streaming in, the composer, photos from the camera or library as attachments, and start,
stop and move. A **Boards** tab lists the paired boards, picks the profile shown on each, and opens
a board on the web for what the app leaves out (terminals, diffs and commits, settings,
analytics). It keeps a websocket to each board, and reconnects when it comes back to the front or
the network changes.

What you **share** from another app (a link, text, photos or a file, from Android's share sheet or
the iOS share extension, _Huntaway Share_) opens the Assistant with its composer filled in, after
whatever was typed there, and the files uploading as attachments to the assistant's host. With
several boards that can take it, the app asks which, with the last one picked first. A share only
ever becomes a draft: it's never taken as an address or a token. Every composer (the assistant's and
each task's) has a **mic** button: tap it to dictate into the field with the phone's own speech
recognition (on the phone where it can be, else Apple's or Google's service), and hold it to
record a **voice note** (iOS, and Android 13 or later), which is attached as a WAV file with what
the phone heard of it in the message, since agents read text and not audio. Voice notes stop at
four minutes, well under an attachment's 10 MB.

**Installing it.** Nothing needs building:

- **Android**: each GitHub release has the app as `huntaway-<version>.apk`, once the repository has
  its signing key (see _Building the mobile app_: until then, releases have no APK). Open the release page on
  the phone, download it, and allow your browser to install apps when Android asks (Settings →
  Apps → Special app access → Install unknown apps). A later release's APK installs over it, keeping
  the paired boards; Android refuses one signed with another key, or an older version.
- **iPhone**: not yet. It's to come through TestFlight, but the Apple and Expo accounts it needs
  aren't set up, so there are no iPhone builds for now. Until then, use the board on the iPhone
  as a web app.

The app works with a board of the same API or newer: a board older than the app's minimum (API 118,
`MIN_API` in `apps/mobile/src/pairing.ts`) says so in the app, both when pairing and on a paired board
that's later found older (after a rollback, say), rather than failing somewhere later. Update that
board's Huntaway to use it again.

**HTTPS.** The phone reaches a board over HTTPS: iOS and Android refuse plain HTTP, and the app
adds no exception. With [Tailscale](https://tailscale.com) on the board's machine and the phone,
run this on the board's machine:

```sh
tailscale serve --bg 7878     # https://<machine>.<tailnet>.ts.net → 127.0.0.1:7878
```

(or put any TLS reverse proxy in front of port 7878, such as Caddy's `reverse_proxy`). The QR code
carries the address the phone will use, so pair from the board opened at that URL, or type the URL
into the pairing's address field.

**Pairing.**

1. On the board, Settings → Network access → **Pair a phone**, and check the address it shows
   (the host's public address if it has one, else the page's own if that's HTTPS).
2. In the app, Boards → **Pair a board**, and scan the QR code (or paste the link under it).

The QR code holds `huntaway://pair?url=<board>&code=<code>`: a code that works once, for five
minutes, never the board's token. `POST /devices/pair` (which needs no token) swaps it and the
phone's name for a token of the phone's own, which the app keeps in the keychain (Android's
keystore). The board keeps only its SHA-256, in `device_tokens`, and takes it as it takes
`auth_token`, on REST, `/ws` and `/api/h/<host>/…`.

**Several boards.** Pair each board the same way (a work hub and a personal board, say): the app
keeps a token for each, the Inbox shows them all together with each item labelled, and Boards
lists them, with the profile shown on each, and removes one. A hub's linked hosts come with it, so
pair the hub rather than each host. Pairing the same board again unpairs the phone's old token
there.

**Revoking a device.** Settings → Network access lists the paired devices, with their last use,
to rename or revoke; revoking one cuts it off at once, open websockets included, and the app then
says it was unpaired. A device can't pair others or manage them (`POST /devices/pairing`, `PATCH`
and `DELETE /devices/{id}` are for the board's own token), but it can list them and unpair itself,
which removing the board in the app does. A device can only use the routes the app does (`HUB`
and `HOST` in `apps/server/src/devices.ts`): profiles, projects, tasks and their threads, each profile's
assistant (API 120, but not its memory), attachments, permission prompts, the board's events and
hosts, the devices list and its own push subscriptions, on every profile, on the
board or through it on a linked host. Everything else gets a 403, so a new route is closed to
devices until it's added there. That keeps out what would outlast revoking a device: the board's
and hub's tokens (`GET /hosts/join`), Claude logins (exporting, importing, copying one to another
host), linking hosts, terminals (a shell on the host), settings and admin. A device's path is
checked percent-decoded, and refused with an encoded `/`, `\`, `%`, `?` or `#`, an empty segment,
`.` or `..`; the hub's proxy checks again the path it forwards, and the handlers of tokens, Claude logins,
host linking and terminals refuse a device's request themselves.

**Push to the app** (API 120). The app subscribes on each paired board (a board's hub watches all
its hosts' events, so once per board) with its Expo push token, and the board sends its pushes
through [Expo's push service](https://docs.expo.dev/push-notifications/sending-notifications/):
one HTTPS call, with no Apple or Google keys kept on the board. Boards → a board → **Notifications**
turns it on or off for that board and picks the events, as the web's Settings does for a browser
(needs attention, ready to review, ready for merge, done, the assistant's replies and its routines'
reports, and whose permission prompts); tapping a notification opens the task on the board it came
from, and tapping the assistant's reply opens the Assistant tab on that board, with the profile
whose assistant it is (or its thread, on a board without the tab). A routine's report opens the
routine's own thread. A prompt that can be answered from the
notification has **Allow** and **Deny** (on iOS and Android, also on the lock screen; Allow asks to
unlock the phone on iOS), which post the push's one-time token as the web's do, without opening the
app or reading the keychain, and then show what came of it (allowed, denied, already answered,
expired). Expo, Apple and Google can read these pushes (Web Push is encrypted for the browser;
Expo's aren't), so they carry the task's key and title and the event, not the attention reason,
what the agent wrote, a report's text or a tool's input; the app fetches the rest over its own
connection. As for the web, nothing is pushed for a move made from the app.

The app's subscriptions are `push_subscriptions` rows with `kind` `expo` (`POST /push/subscriptions`
with `{"kind": "expo", "endpoint": "ExponentPushToken[…]", "name", "events"}`), whose
`device_id` is the paired device that made them: a device sees and changes only its own, and they
go when it's revoked. When Expo's token for the phone changes, its subscription takes the new one
and keeps its events. The board batches pushes to Expo (100 a request), reads its tickets, and asks
for the receipts about 15 minutes later: a phone Expo says isn't registered any more (the app was
uninstalled) is dropped, and other failures show as the subscription's last error (see
`apps/server/src/integrations/push.ts`). `IA_EXPO_PUSH_URL` sends them somewhere else (a fake, for
tests), and `IA_EXPO_ACCESS_TOKEN` is the token for a project with Expo's enhanced push security
on. The app needs a build with its EAS project id (`extra.eas.projectId` in `app.json`, from
`eas init`) for its push token, and Android builds need Firebase Cloud Messaging set up for it (a
`google-services.json`, and FCM's key given to Expo: see _Building the mobile app_).

Revoking a phone stops the phone, not what was done with it before: whoever held it could have
started an agent that read the board's files, `auth_token` among them, as any agent can. If a lost
phone may have been used, replace `auth_token` as well: delete `<data-dir>/auth_token` and restart
the server, which makes a new one (browsers, and hubs that link this host, then need the new one).

### Building the mobile app

The app is `nz.net.ivan.huntaway` on both platforms, as the desktop app is, and takes the release's
version: `apps/mobile/scripts/release-version.js` writes it into `app.json` before a release build, with
Android's `versionCode` worked out from it (1.2.3 → 10203999, 1.2.3-rc.2 → 10203002), so each
release installs over the one before. The repository keeps 1.0.0. Its icons and launch screen
(`expo-splash-screen`) are rendered from the board's icon (`apps/web/public/icon.svg`) by
`apps/mobile/scripts/icons.sh`.

**Android** is built by the release workflow's `android` job (`.github/workflows/release.yml`) on
GitHub's runner, with `pnpm exec expo prebuild` and Gradle, rather than on EAS: it needs no Expo account
or EAS build quota, it's attached to the release with the other files, and the signing key stays
in this repository's secrets. Pull requests don't build it (as the rest of the release, HA-244): a
change to the app's packaging (`apps/mobile/app.json`, `eas.json`, its `package.json`) is first built by
the release that ships it, or by hand (Actions → Release → Run workflow) on a tag of its own. A
release's APK needs the release key, made once and kept:

```sh
keytool -genkeypair -v -storetype PKCS12 -keystore huntaway-release.jks -alias huntaway \
  -keyalg RSA -keysize 4096 -validity 10000          # asks for its password
gh secret set ANDROID_KEYSTORE_BASE64 --body "$(base64 -w0 huntaway-release.jks)"
gh secret set ANDROID_KEYSTORE_PASSWORD             # each asks for its value
gh secret set ANDROID_KEY_ALIAS --body huntaway
gh secret set ANDROID_KEY_PASSWORD                  # a PKCS12 key's is the keystore's
```

Keep a copy of `huntaway-release.jks` and its password somewhere safe outside the repository
(`*.jks` is ignored there): phones only update the app from an APK signed with the same key, so
losing it means everyone uninstalling and pairing again. Until all four secrets are set, a release
skips the `android` job (its `android-key` job says so in a notice) and has the other files without
an APK.

The app's push on Android goes through Firebase Cloud Messaging, which Expo's push
service hands it to, so the APK needs a Firebase app's config: in the
[Firebase console](https://console.firebase.google.com), make a project and add an Android app with the package `nz.net.ivan.huntaway`, download its
`google-services.json`, and keep it as the repository secret `GOOGLE_SERVICES_JSON` (`gh secret
set GOOGLE_SERVICES_JSON < google-services.json`). The `android` job writes it into `apps/mobile/` and
names it in `app.json` (`android.googleServicesFile`) for that build only, since it isn't
committed. Then give Expo the project's FCM V1 key, so it can send: Firebase → Project settings →
Service accounts → **Generate new private key**, and `npx eas-cli credentials --platform android`
→ production → Google Service Account → _Manage your Google Service Account Key for Push
Notifications (FCM V1)_, with that file. Without the secret the APK builds with a warning, but
can't register for push.

**iOS** isn't built yet: TestFlight builds through EAS wait for an Apple Developer Program
membership and an Expo account (HA-258, in the backlog), and this repository has no workflow for
them yet.

`eas.json`'s other profiles are for EAS builds by hand: `development` (a dev build, below) and
`preview` (a release build for phones registered with `eas device:create`, and an APK on Android).
EAS counts the iOS build numbers itself (`appVersionSource: "remote"`).

**Developing** (Node 24, as the rest of the workspace):

```sh
pnpm install                    # at the top of the checkout: the workspace, the mobile app's dependencies too
cd apps/mobile
pnpm exec expo start --web      # in a browser, to try it against a board (CORS is open)
pnpm exec expo run:android      # a dev build on an emulator or a phone (needs the Android SDK)
pnpm dlx eas-cli build --profile development --platform ios   # or android: a dev build from EAS
pnpm run typecheck && pnpm test # what CI's Tests / mobile runs
```

It uses native modules that Expo Go lacks (the camera's scanner, secure storage, notifications,
share intents and speech recognition), so it runs as a dev build (`expo-dev-client`). The share
extension is an iOS target of its own (`HuntawayShare`, bundle `nz.net.ivan.huntaway.share-extension`,
in the app group `group.nz.net.ivan.huntaway`), which `expo-share-intent`'s config plugin adds at
prebuild and `extra.eas` in `app.json` declares for EAS Build's credentials. A dev build lets the
app pair with a board on plain HTTP (an
emulator's `10.0.2.2`, say); release builds won't.
