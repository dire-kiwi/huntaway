# 11. Mobile app, scripts, CI, packaging and releases

Source: `the huntaway repository` (master). Read: `apps/mobile/**`, `scripts/**`, `.github/workflows/*`, `.cargo/*`,
root `package.json` / `pnpm-workspace.yaml` / `vite.config.ts` / `Cargo.toml` / `AGENTS.md` / `CLAUDE.md`,
`apps/server/bin/*`, `apps/server/{tsconfig*.json,vite.config.ts,package.json}`, `apps/web/{package.json,vite.config.ts}`,
`apps/web/tests/ui/{vitest.config.ts,harness.mjs}`, `apps/web/electron/{boot,stamp}.cjs` (headers),
`packages/client/{package.json,tsconfig.json,src/http.ts,devices.ts,push.ts}`, `docs/development.md`,
`docs/guide/{desktop,mobile,server}.md`.

## 1. Purpose

Four things live here. (a) **The mobile app** (`apps/mobile`, Expo/React Native, Android + iOS): a second client of the
same HTTP+websocket API as the web board, paired with one or more boards by QR code, showing an Assistant thread, an Inbox
across all boards, projects/tasks/threads, and receiving native push with Allow/Deny actions. (b) **The release
pipeline**: a GitHub release builds a self-contained server tarball (compiled JS + its own Node + `ia-shim` + UI), desktop
packages (AppImage, Arch `.pacman`, mac dmg/zip), an Android APK and a release manifest; installed copies update
themselves from GitHub releases. (c) **Developer/agent workflow tooling**: scratch test servers, an API CLI, a headless
browser driver, fake agents, profiling and e2e scripts, which `CLAUDE.md` instructs every agent to use. (d) **The
toolchain and CI**: pnpm workspace + Vite+ (`vp`) for format/lint/typecheck/test, Jest for mobile, cargo for the one Rust
crate, and a GitHub Actions workflow with a "tree already passed" skip.

## 2. Capabilities

### 2.1 Mobile app: structure and screens (`apps/mobile/src/app/**`, expo-router file routes)
- Entry `index.ts`: calls `startNotifications()` **before** `expo-router/entry`, so a notification action that starts the
  app headless (Android background task / iOS response listener) finds its handler without any screen.
- Root layout `app/_layout.tsx`: `ShareIntentProvider` > `SafeAreaProvider`; loads boards from the keychain
  (`boards.load()`), shows a spinner until `loaded`, then mounts three renderless components for the app's lifetime
  (`LiveUpdates`, `PushSetup`, `ShareHandler`) and a `Stack`: `(tabs)`, `pair` (modal), `project/[board]/[host]/[id]`,
  `task/[board]/[host]/[id]`, `notifications/[board]`, `share` (modal). Dark UI only (`userInterfaceStyle: dark`),
  portrait only, no tablet layout.
- Tabs `app/(tabs)/_layout.tsx`: **Assistant** (`index`, hidden with `href: null` when the selected board has no
  assistant for the app), **Inbox**, **Projects**, **Boards**. Tab icons are text glyphs.
- **Assistant tab** (`(tabs)/index.tsx`, `assistant.ts`): the selected board's assistant for the picked profile; redirects
  to `/inbox` when the board is missing / unusable / API < 120. Resolves where the assistant lives with the client's
  `assistantHome(profiles, hosts, name)` (may be a separate "assistant host", possibly offline); opens it with
  `client.assistant(hostId, profileId, {here: true})` (the host makes the task on first ask). Keeps the opened assistant
  mounted while its host is merely unreachable (`stillOpen`) so the thread and draft survive; another profile/host
  remounts (`key=board/host/task`). Shows amber notes for `offline` / `old` / `no_profile` (`unavailableNote`), a
  "working + Stop" bar, the thread, the composer (placeholder "Ask your assistant"), and takes a pending share as prefill.
  Refetches profiles on `profiles_changed`, `hosts_changed`, `resync`.
- **Inbox** (`(tabs)/inbox.tsx`, `inbox.ts`): for every usable board, for its picked profile on every host that has it:
  `profileTasks(host, profile, withAssistant=true)`, `projects`, `pendingPermissions({profile_id})`; plus tasks that have a
  pending prompt but aren't in the list (assistant routine threads; fetched one by one and kept only if
  `profile_id` matches); plus the open question of each `needs_attention` task (from `thread(…,20).requests` when
  `thread_source === "items"`, else from the last 20 messages). Items: `permission` | `question` | `attention`, a task
  with a prompt or question shows once as that. Merged across boards, newest first (`at`), de-duplicated by key
  `board/host/{perm|q|task}/id`. Prompts and questions are answered in place; answered ones vanish at once (local set)
  before events confirm. Cards for unusable boards (unpaired / too old) and per-board read errors head the list.
  Refetch (throttled 600 ms) on `task`, `task_deleted`, `resync`, `profiles_changed`, `hosts_changed`, and
  `message`/`message_updated` of kind `permission|question|user`. Pull to refresh.
- **Projects** (`(tabs)/projects.tsx`, `boardData.ts`): selected board's projects for the picked profile on every host
  (sorted by name, host name shown when >1 host); board + profile chips (`boardPicker.tsx`, shown only when >1).
- **Project screen** (`project/[board]/[host]/[id].tsx`, `tasks.ts`): tasks grouped by status in the order
  `needs_attention, in_progress, in_review, ready_for_merge, todo, backlog, done` (only `kind === "task"`; Done limited
  to the latest 20 by `done_at`; others by `position`); live upsert from `task` / `task_deleted` events, reload on
  `resync`. "New task" sheet: optional title, description, "Start its agent now" switch (default on) ->
  `createTask(host, project, {title?, description, status: start ? "in_progress" : "todo"})`, then opens the task.
- **Task screen** (`task/[board]/[host]/[id].tsx`): status dot + label, "agent running" / "agent idle, its background work
  goes on" (`task.background_work.idle`), PR link (`pr_url`), header buttons **Stop** (`client.stop`) / **Start** (PATCH
  status `in_progress` if todo/backlog, then send empty message: moving alone doesn't start an agent) / **Move** (sheet of
  all `STATUSES`, via the client's `moveTask(client, {…task, host_id}, status, host)`), the thread and the composer.
- **Thread** (`threadView.tsx`, `thread.ts`, `markdown.tsx`): two sources. Legacy: `messagePage(host, id, {limit: 60})`
  with "Earlier messages" paging by `before`. Items (`task.thread_source === "items"`): window `thread(host,id,150)`
  (a `Snapshot`), earlier pages `threadItems(host,id,start,150)` merged with `with_page`, live `thread_event`s folded with
  `apply_event`, `is_gap` -> reload (debounced 500 ms), `thread_resync` -> reload; a task that moves onto items reloads.
  Rows: user bubble (attachments split out by name), assistant text as markdown (mdast parse, drawn as RN views; images
  not fetched; links open the browser), tool call as one line (name coloured running/done/failed + `toolSummary`), notices
  /events, error results, pending permission card or one-line answered state, question card, routine report card
  (name, outcome `reported|asked|failed|stopped`, text, link to the routine's thread). Subagents' own items and a
  window's context items are left out; empty user messages hidden. Streaming reply: `delta` events accumulated and
  flushed once per animation frame, shown as **plain text** (not markdown) until the stored assistant message arrives
  (`endsDelta`) or `delta_reset`. Inverted FlatList.
- **Composer** (`composer.tsx`, `attachments.ts`, `files.ts`): text; camera photo; library photos (multi, max 5,
  `quality 0.7`, base64); files from a share; voice notes. Each file is uploaded immediately with
  `client.uploadAttachment(host, name, base64)` (limit `MAX_ATTACHMENT_BYTES` = 10 MB, checked before reading) and listed
  as a removable chip; send = `client.send(host, task, withAttachments(text, files))`. After send, only the sent text is
  removed from the field (`afterSend`), so a draft typed meanwhile stays. Send disabled while sending, uploading, or mic on.
- **Dictation / voice notes** (`dictation.ts`, `expo-speech-recognition`): tap mic = dictate into the field (after what
  was typed); hold 400 ms = record a voice note. On-device recognition when supported, falling back once to the platform
  service on `language-not-supported` / `service-not-allowed`. Language = phone locale. Voice notes: 16 kHz 16-bit PCM,
  persisted, stop at `MAX_NOTE_MS` = 4 min, attached as `voice-note-<ms>.wav` (`.caf` if iOS gave one) plus message text
  `Voice note, as the phone heard it: <transcript>`. Continuous mode except Android < 13 (API < 33), which also can't
  record notes. One recognizer session module-wide with an `owner` composer; dropped sessions' late `end` events are
  swallowed (counter with a 3 s expiry); a second composer gets "The microphone is still busy".
- **Prompts** (`prompts.tsx`): `PermissionCard` Allow/Deny via `resolvePermission(host, id, decision, message?, reply?)`;
  question tools (`QUESTION_TOOLS`: Claude's AskUserQuestion, Codex's `request_user_input` prompt) are answered with
  `{answers: string[][]}` on "allow", or "Dismiss" = deny with a fixed note; supports options, multi-select, typed "other"
  (`takesTypedAnswer`), secret entry. `QuestionCard` (board's `request_user_input` question message):
  `answerQuestion(host, task, messageId, {choices, text})`; a tap answers directly when single-select with no "other".
- **Boards tab** (`(tabs)/boards.tsx`): each paired board with status (Live / Connecting… / Unpaired / Too old), URL,
  profile chips (pick the profile shown for that board everywhere), buttons Pair again, Notifications, Open on the web
  (`Linking.openURL(board.url)`), Remove (confirm; unpairs on the board too).
- **Pair screen** (`pair.tsx`, `pairing.ts`): scan QR (`expo-camera`, QR only), paste link (clipboard button), or deep
  link `huntaway://pair?url=…&code=…` (route params). Shows target URL, editable device name (default
  `Device.deviceName || modelName || "iPhone"/"Android phone"`), Pair.
- **Notifications screen** (`notifications/[board].tsx`): per-board push on/off, the four `NOTIFY_EVENTS` switches,
  assistant events (`replies`, `reports`; shown only if the board's events object has them), permission prompts chips
  (`off|assistant|all`, default `assistant`), "Send a test", last error, "couldn't be told yet" note, problem text
  (`denied` + Open settings / `no_project` / `unsupported`).
- **Share screen** (`share.tsx`) and `+native-intent.tsx` (maps the iOS share extension's `huntaway://dataUrl=<key>` to
  `/`), `+not-found.tsx`.

### 2.2 Mobile app: pairing and several boards (`boards.ts`, `pairing.ts`, `secrets.ts`, `session.tsx`)
- Pair: parse link (`parsePairingLink` from the client; url must be http(s)); refuse plain HTTP unless host is
  `localhost|127.0.0.1|10.0.2.2` or `allowHttp` (`__DEV__`); `GET /api/health` (no token) -> `api_version` must be >=
  `MIN_API` = 118 **before the one-time code is spent**; `POST /api/devices/pair {code, name}` (no token) ->
  `{token, device{id,created_at}, host_id, host_name, api_version, capabilities?}`. Errors typed
  `link|insecure|unreachable|too_old|code(403)|other` (404 on pair = too old).
- A board's identity is its `host_id` (stable across restarts and re-pairing). Re-pairing replaces the token, keeps the
  locally picked `profile` and `push` flag, and best-effort revokes the previous device **with the old token**
  (`unpairPrevious`: a device may only delete itself).
- One `Client` (`createClient`) per board, cached by id+url, with `getToken` reading the in-memory token map,
  `setToken` no-op, `storage` an in-memory map (no open-token logic). A 401 on a request made with the current token sets
  the board's status `unauthorized`.
- All hosts behind a hub come with it: every host-scoped call goes `/api/h/<host>/…` (client `on(h)`), so the app pairs
  the hub, not each host. Profiles are merged **by name** across a board's hosts (`loadProfiles`, using the client's
  `boardHosts` filter); the picked profile is a name (`pickedProfile`: picked if present, else first).
- Board status (`connected`, `unauthorized`, `tooOld`) kept in a module store; `usable = !unauthorized && !tooOld`.
  `checkBoard`: `health()` -> update stored `apiVersion` and sorted `capabilities` (`boardHas(board, name)`), then
  `devices()` to prove the token; run at start, on app foreground, and whenever a socket drops.
- Capability gates used: `MIN_API 118` (pairing), `ASSISTANT_TAB_API 120`, `EXPO_PUSH_API 120`, `thread_source` (API 122)
  by field; named capabilities stored but no gate currently reads one in the app.

### 2.3 Mobile app: live updates (`live.ts`, `session.tsx`, `load.ts`)
- One websocket per usable board to `wss://…/api/ws?token=<device token>` carrying the events of every host on it.
  Ignores `hello`; `tick` only arms the silence watchdog; everything else with a string `type` is handed to listeners with
  the board id. After every reconnect (not the first open) it synthesises `{type: "resync"}`.
- `useBoardEvents`, `useRefetchOn(matches, fn, ms=600)` (throttle), `useLoad(load, deps)` + `Snapshot` (see invariants).

### 2.4 Mobile app: push (`push.ts` pure logic, `notifications.ts` Expo glue)
- Subscribes once per board (the hub watches all its hosts): `POST /api/push/subscriptions {kind:"expo",
  endpoint:"ExponentPushToken[…]", name}` without `events` (the board keeps/defaults them). `PushRegistrar.sync()` runs at
  start, when any board's socket connects, on app foreground, on token rotation, and self-retries.
- Turning push off for a board or removing a board is recorded as **pending work** persisted in the keychain
  (`push.pending`: `{kind:"unsubscribe",board}` | `{kind:"revoke",board,url,deviceId,token}`) and executed when the board
  is reachable; 401/403/404 mean "nothing left to undo".
- Notification tap: default action opens the task screen, except event `reply` on a board with the Assistant tab, which
  selects the board, sets its picked profile to the assistant task's profile (looked up by `client.task` +
  `client.profiles`) and navigates to `/`. Reports open the routine's own thread.
- Allow/Deny actions (category `prompt`): `POST <boardUrl><answer.url> {token, decision}` with **no Authorization**;
  `answer.url` must match `^/api/permissions/[^/?#]+/push-answer$`; the result (`allowed|denied|answered|expired|closed|
  invalid|offline|failed` + client-side `unreachable`) replaces the notification (dismiss + schedule a local one on
  channel `prompts`). Allow has `isAuthenticationRequired: true` (iOS unlock), neither opens the app.
- Android channels created by the app: `default` ("Tasks", DEFAULT importance) and `prompts` ("Permission prompts", HIGH).
  Foreground handler shows banner + list + sound, no badge.
- Expo push token needs notification permission (asked at most once per run) and an EAS `projectId`
  (`Constants.expoConfig.extra.eas.projectId ?? Constants.easConfig.projectId`); **`app.json` in the repo has none**, so a
  build without `eas init` reports problem `no_project` and never subscribes.

### 2.5 Mobile app: sharing in (`share.ts`, `shareHandler.tsx`, `shareCard.tsx`, `app/share.tsx`)
- `expo-share-intent`: Android intent filters `text/*`, `image/*`, `audio/*`, `application/pdf` (multi: `image/*`); iOS
  share extension "Huntaway Share" (target `HuntawayShare`, bundle `nz.net.ivan.huntaway.share-extension`, app group
  `group.nz.net.ivan.huntaway`; text, 1 URL, 1 web page, 5 images, 5 files).
- A share becomes a `SharedDraft {text, files[{uri,name,mime,size}]}`: text + URL (if not already in the text), page title
  before a lone URL; file names sanitised to `[A-Za-z0-9._-]`, extension from a mime table, fallback
  `photo|audio|shared-<ms>[-n].<ext|bin>`. One pending share at a time (`PendingShares`, newer replaces).
- Target: boards with `showsAssistant`; exactly one -> select it and go to `/`; several -> `/share` picker with the
  last-used board first (`boards.shared`), reusing an already-open share screen. The Assistant tab's composer takes it as
  `Prefill` (text appended after the draft, files uploaded to the assistant's host) and clears it; a `WaitingShare` card
  explains a share waiting for an offline assistant / another board / no board, with "Pick a board" and "Drop it".
- A share is only ever a draft + attachments: never parsed as an address, pairing link or token.

### 2.6 Shared with the web app (`packages/client`, `@huntaway/client`, `workspace:*`)
- No build step: `exports` point at TS sources (`.` -> `src/index.ts`, `./labels`, `./protocol`). `tsconfig` has
  `lib: ES2023`, `types: []` (no DOM) so it type-checks for React Native. `./protocol` re-exports the **server's**
  `apps/server/src/threads/protocol.ts` by relative path (that file has no imports): the thread reducer
  (`apply_event`, `is_gap`, `with_page`, `Snapshot`, `ItemPage`, `ThreadEvent`) is one file for server, web and phone.
- The app uses: `createClient`/`ClientAdapter` (`baseUrl`, `getToken`, `setToken`, `storage`, optional `fetch`, `wsBase`),
  `ApiError`, `Fetch`; types `Task, Message, Project, Profile, Host, PendingPermission, PermissionReply, Attachment,
  BoardEvent, PushDevice, PushEvents, NotifyEvent, Status, AssistantHome`; constants `STATUSES, NOTIFY_EVENTS,
  ASSISTANT_PUSH_EVENTS, PUSH_PROMPTS, EXPO_PUSH_API, QUESTION_TOOLS, MAX_ATTACHMENT_BYTES`; helpers `pairingLink,
  parsePairingLink, boardHosts, assistantHome, taskKey, moveTask, withAttachments, splitAttachments, afterSend,
  takesTypedAnswer`.
- Client methods called: `health, pair, devices, revokeDevice, hosts, profiles, projects, getProject, projectTasks,
  profileTasks, createTask, task, updateTask, send, stop, messagePage, thread, threadItems, uploadAttachment,
  pendingPermissions, resolvePermission, answerQuestion, assistant, push, pushSubscribeApp, updatePushDevice,
  removePushDevice, testPush, wsUrl, setUnauthorizedHandler`.
- Metro: Expo's default config (monorepo aware: watches the workspace root, resolves from both `node_modules`).
- Not shared: the web app's store, thread view model (`threadModel.ts`/`itemModel.ts` are re-cut smaller in
  `thread.ts`), markdown renderer, theme (colours copied into `theme.ts`, asserted equal by `tests/theme.test.ts`).

### 2.7 Mobile build and release (`app.json`, `eas.json`, `scripts/`, `release.yml` job `android`)
- Ids: `nz.net.ivan.huntaway` (both platforms), scheme `huntaway`, slug `huntaway`, splash/background `#0f0f13`.
- `scripts/release-version.js <version> [--ios]`: writes `app.json` `version` and Android `versionCode` =
  `major*10^7 + minor*10^5 + patch*10^3 + (999 | last numeric prerelease part, max 998)`; minor/patch must be < 100;
  limit 2,100,000,000. iOS gets `major.minor.patch` only. Repo keeps `1.0.0`.
- `scripts/icons.sh`: renders all icons from an inline SVG copy of `apps/web/public/icon.svg` with `rsvg-convert` +
  `magick` (iOS icon must have no alpha).
- Android APK: built **in GitHub Actions, not on EAS** (see 2.9). iOS: not built at all (no Apple/Expo accounts).
- `eas.json` (manual EAS builds only): `cli.version >= 16.0.0`, `appVersionSource: remote`; profiles `development`
  (`developmentClient`, internal, apk), `preview` (internal, apk), `production` (`autoIncrement`, apk);
  `submit.production.ios {}`. The app needs a dev build (`expo-dev-client`), not Expo Go (native modules).

### 2.8 Server launcher and packaging (`apps/server/bin/huntaway`, `issue-agent`, `scripts/package-server.sh`)
- `bin/huntaway` (POSIX sh) is both the checkout's launcher and a release's `huntaway` binary: resolves itself through
  symlinks; picks `server-ts/src/main.js` (release) else `server-ts/src/main.ts` else `../src/main.ts` (checkout); exports
  `IA_TS_EXE=<self>`; picks Node: `$IA_NODE`, `./node/bin/node`, PATH, then well-known install dirs (sshd's short PATH).
- Node flags: `--disable-warning=ExperimentalWarning --expose-gc`, `--max-semi-space-size=2` and
  `--max-old-space-size=1024` unless `NODE_OPTIONS` sets them; `MALLOC_MMAP_THRESHOLD_=131072` (+ marker
  `IA_MALLOC_MMAP=1`) unless already set.
- Subcommand routing: `approval-hook` -> `agent/approval_rules/hook_main.<ext>`; anything but `serve`/empty -> exec
  `main.<ext>`; `serve` -> **supervisor loop** (see 6 and 9).
- `bin/issue-agent`: execs the `huntaway` beside it (old name; kept for SSH forced commands and desktop configs).
- `package-server.sh <out> [node]`: produces `<out>/{huntaway, issue-agent, ia-shim, ui/, node/bin/node, node/LICENSE,
  server-ts/{src/**/*.js, package.json, build.json, node_modules/}}`. Server compiled by **tsrs** with
  `tsconfig.build.json` (`rewriteRelativeImportExtensions`, `removeComments`, `rootDir: src`, excluding `*.test.ts`,
  `src/testing.ts`, `src/**/tests.ts`); tsrs type-checks, so a type error fails packaging. Prod deps via
  `pnpm --filter huntaway-server deploy --prod --config.inject-workspace-packages=true --config.node-linker=hoisted`
  (plain folders; `.bin`, `.pnpm`, `.modules.yaml` removed). Node = `process.execPath` of the given node (not a version
  manager's shim; verified by running the copy). `VERSION` env stamps `server-ts/package.json`; `build.json` =
  `{"commit": IA_BUILD_COMMIT | HEAD}`. Fails if the tree contains any symlink (installing a release refuses them).
- Why compiled JS: run as `.ts`, every process (server and each agent's hook) loads Node's TS stripper (~20 MB each).

### 2.9 Release workflow (`.github/workflows/release.yml`)
- Trigger: GitHub release `published`, or `workflow_dispatch` with `tag` (rebuilds and replaces an existing release's
  files). Tag = version (`v1.2.3` or `1.2.3`, semver). Never runs on PRs. Concurrency group per tag, not cancelled.
- Job `build`, matrix `ubuntu-latest` -> `linux/x64`, `macos-latest` -> `mac/arm64` (60 min): checkout the tag; rustup
  stable; rust-cache; `setup-vp` (Node 24, `run-install: false`); linux: `libarchive-tools` (bsdtar for fpm); set
  `VERSION` and write it into `apps/web/package.json`; `pnpm install --frozen-lockfile --filter 'huntaway-server...'
  --filter 'huntaway-app...'`; `pnpm --filter huntaway-app run build && cargo build --release --locked -p ia-shim`;
  `IA_BUILD_COMMIT=$(git rev-parse HEAD) scripts/package-server.sh release-server "$(command -v node)"`; smoke test
  (compiled `.js` only, `huntaway --version` == `huntaway $VERSION`, `issue-agent --version` too, start `serve --host
  127.0.0.1 --port 0 --data-dir … --demo` with agents `/bin/false`, wait for `IA_READY`, GET `/api/health`, `/`, and
  `/api/info` with the token); `electron-builder --<os> --<arch> --publish never`; check the packaged resources
  (`huntaway --version`, `server-ts/node_modules/ws`, `ia-shim`, `issue-agent`, `ui/index.html`);
  `node scripts/desktop-app-check.mjs <exe> --version $VERSION`; mac: codesign/spctl report as a notice, and a
  quarantined-copy start (warning only); linux: write `huntaway-<v>-release.json` `{version, shell: frameStamp, electron}`
  and verify the stamp against the packaged `app.asar`; build the server tarball
  `huntaway-server-<v>-<os>-<arch>.tar.gz` = `release-server/` + `electron/*.cjs` + `electron/shell.json`
  `{electron, boot: 1}`, top folder `huntaway-server-<v>-<os>-<arch>/`; upload artifacts (1 day).
- Job `android-key`: outputs whether all four `ANDROID_*` secrets exist (a job `if` can't read secrets); notice if not.
- Job `android` (only when set; ubuntu, 60 min): checkout tag; setup-vp; JDK 17 (temurin); setup-gradle;
  `pnpm install --frozen-lockfile --filter 'huntaway-mobile...'`; `node scripts/release-version.js $version`; optional
  secret `GOOGLE_SERVICES_JSON` written to `apps/mobile/google-services.json` and named in `app.json`
  (`android.googleServicesFile`) for this build only; `pnpm exec expo prebuild --platform android --no-install`
  (`CI=1`); append `android.injected.signing.{store.file,store.password,key.alias,key.password}` to
  `android/gradle.properties`; `./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=armeabi-v7a,arm64-v8a`;
  copy to `huntaway-<v>.apk`; fail if `apksigner verify --print-certs` shows `CN=Android Debug`.
- Job `attach` (the only one with `contents: write`; runs nothing from the repo; `if: !cancelled()`): downloads
  `huntaway-*` artifacts, `gh release upload $TAG … --clobber`.
- Release assets: `huntaway-<v>-linux-x86_64.AppImage`, `huntaway-<v>-linux-x64.pacman`, `huntaway-<v>-mac-arm64.dmg`,
  `.zip`, `huntaway-<v>.apk`, `huntaway-server-<v>-{linux-x64,mac-arm64}.tar.gz`, `huntaway-<v>-release.json`.

### 2.10 Desktop packaging (`apps/web/package.json` `build`, `apps/web/build/icon.png`)
- electron-builder 26.18, Electron 45: `appId nz.net.ivan.huntaway`, `productName Huntaway`, `main: electron/boot.cjs`,
  `files: ["electron/**", "!node_modules/**"]` (the shell has no npm deps), `extraResources: ../../release-server -> .`
  (so `resources/{huntaway,issue-agent,ia-shim,node/,server-ts/,ui/}`), `artifactName
  huntaway-${version}-${os}-${arch}.${ext}`, output `apps/web/release/`.
- Linux targets `AppImage` + `pacman`; `executableName huntaway-desktop`; `desktopName huntaway-app.desktop`; pacman
  `packageName huntaway`, depends `gtk3 nss alsa-lib libxss libxtst libnotify libsecret at-spi2-core xdg-utils git`
  (installs to `/opt/Huntaway`).
- mac targets `dmg` + `zip`, `identity: "-"` (ad hoc), `hardenedRuntime: false`, not notarized (users must clear
  quarantine). No Windows build, though `allowBuilds` mentions electron-winstaller and `boot.cjs` has a win32 exe name.
- `pnpm run dist` in `apps/web` = build UI, `cargo build --release --locked -p ia-shim`, package-server, electron-builder.

### 2.11 Updates (summary; mechanics in `apps/server/src/update/*`, `apps/web/electron/{boot,versions,shellupdate}.cjs`)
- **Checkout installs** ("Rebuild & restart"): `pnpm install --frozen-lockfile` (server + web filters), UI build,
  `cargo build --release -p ia-shim` (skipped without cargo when a prebuilt `apps/server/bin/ia-shim` exists), then
  re-exec `bin/huntaway` with the same args. `--update-from <url>`: poll the deployment's `/api/health` commit every
  5 min, fetch from `origin`, offer "N new commits · Update" (fast-forward only; refuses dirty/diverged).
- **Release installs** (`--release-updates OWNER/REPO` / `IA_RELEASE_UPDATES`): check GitHub releases 30 s after start,
  every 6 h, and on `POST /api/admin/release/check` (ETag reuse; `IA_RELEASE_API` overrides `https://api.github.com`);
  pick highest semver non-draft (prereleases only with setting `release_prereleases`) that has this platform's tarball
  **with a `sha256:` digest**; download to `<data dir>/app/<v>.partial/`, verify sha256, untar with system `tar`
  (refusing entries outside and links), smoke-test `huntaway --version`, rename to `app/<v>/` = "staged".
  `POST /api/admin/release/update {version}` and `/rollback` restart in place. `app/state.json` =
  `{current, previous, staged, trying, bad}` shared between server and desktop shell (temp file + rename, unknown keys
  kept). Only current/previous/staged are kept (~40 MB each).
- **Which version starts**: desktop app (and a tarball's own `huntaway` when restarted by a supervisor) runs `current`
  (else `previous`) if newer than the packaged one and not `bad`; a version that exits before listening is marked bad
  and the previous/packaged one runs. `IA_BUNDLED_SERVER` = the packaged server, passed down so Roll back can return.
- **Desktop shell**: `electron/*.cjs` other than `boot.cjs` ride in the server tarball (`electron/` + `shell.json`);
  `boot.cjs` loads them from the running version if `shell.json.electron` major matches and `boot <= BOOT_API (1)`; a
  shell that throws or dies within `SURVIVED_MS` = 20 s is marked bad in `app/shell-state.json`. A new package is needed
  only when the **frame stamp** (sha256 of `boot.cjs` + Electron version) differs from the release manifest's `shell`;
  AppImage self-replaces (download beside, verify, rename, relaunch), pacman via `pkexec pacman -U --noconfirm`, mac
  manual dmg.
- `scripts/install.sh` (curl | bash; Linux/macOS): source install into `~/.local/share/huntaway-app` (clone/ff, pnpm via
  `npx <packageManager>` if absent, filters as above, UI build, cargo build or **prebuilt ia-shim** extracted from the
  latest release tarball with sha256 check into `apps/server/bin/ia-shim` via rename), launcher
  (`~/.local/bin/huntaway-desktop` + `huntaway-app.desktop` on Linux; a renamed re-signed copy of Electron.app with a stub
  `main.cjs` on macOS, bundle id `nz.dire.huntaway`), bakes tool dirs into `PATH`, optional `IA_UPDATE_FROM`,
  `HUNTAWAY_LAUNCHER`. Options `--dir --branch --repo --update-from --no-update-from --no-shortcut --shortcut-only --open`.
  Needs git, Node >= 24, npm; Rust >= 1.89 + cc to build the shim.
- `scripts/install-release-host.sh [--version --dir --data-dir --repo]`: download + sha256-verify + unpack the tarball to
  `~/.local/share/huntaway-server/<v>/`, symlink `current`, print the `install-service`, `serve` and SSH forced-command
  lines with `IA_RELEASE_UPDATES` set. Maps `Linux-aarch64` to `linux-arm64`, **which no release builds**.

### 2.12 Developer and agent tooling (`scripts/`)
- `test-server.sh [start] [--seed] [--fake-claude] [--no-agents] [serve args…] | restart [dir] | stop [dir]`: scratch
  server on `127.0.0.1`, port 0 (free), fresh `mktemp -d -t ia-test-XXXXXX` data dir with marker `.ia-test-server`,
  `--name test`, `--open-token` added unless `IA_TEST_OPEN_TOKEN=0`; every `IA_*` serve variable unset
  (`IA_HUB, IA_HUB_TOKEN, IA_TOKEN, IA_OPEN_TOKEN, IA_DEMO, IA_UI_DIR, IA_PROFILES, IA_SOURCE_DIR, IA_UPDATE_FROM,
  IA_RELEASE_UPDATES, IA_NAME, IA_HOST, IA_PORT, IA_DATA_DIR, IA_RECOPY_DB`), `TMPDIR=<dir>/tmp`, `setsid`, log
  `<dir>/server.log`, pid `<dir>/server.pid`; waits up to 30 s for `IA_READY {"port":…}`; writes `<dir>/env`
  (`IA_TEST_URL, IA_TEST_TOKEN, IA_TEST_PID, IA_TEST_DATA_DIR, IA_TEST_ENV` + seed vars) and symlinks `.ia-test-env` in the
  checkout to it; `<dir>/launch` records binary, serve args and selected env for `restart` (same port; log appended to
  `server.prev.log`). `--seed` (needs jq, curl): git repo `<dir>/repo` (branch `main`, one commit), profile `test` on
  `$IA_TEST_CLAUDE_CONFIG` (default `~/.claude-personal`) with `$IA_TEST_MODEL` (default `haiku`), project "Test"; adds
  `IA_TEST_PROFILE/PROJECT/REPO`. Builds a debug `ia-shim` when missing or `rust/shim`, `Cargo.toml`, `Cargo.lock` are
  newer (then `touch`es it). `stop` kills the server and each run's agent process group and shim (from
  `runs/*/{shim.pid,pid}`, guarded by `/proc/<pid>/cmdline` containing the data dir), removes the dir.
  `IA_TEST_BIN` runs another build (e.g. a release package).
- `ia-api` (Python, stdlib): `get|post|patch|put|delete <path> [json]`, `env`, `task`, `new-task`, `start`, `send`,
  `pending`, `approve-all [--deny-pattern]`, `wait-idle [--timeout 300] [--grace 5] [--approve]` (exit 0 idle / 2 needs
  attention / 124 timeout; polls 1 s, 0.5 s while approving), `thread [--limit|--before|--events [--after]] [--brief]`
  (exit 3 on resync). Task refs by key (`TES-3`, `S-3`, `G-3`). **Refuses port 7878 and any non-loopback host unless
  `GET /api/open-token` returns a token.** Detects a wrong route by the UI's `text/html` fallback. Tests:
  `ia-api-test.py` (fake Api + clock).
- `ui-check.mjs`: CLI and module (`open`, `launch`, `readEnv`, `launchOptions`, `defaultChromium`) on `playwright-core`
  from `apps/web/node_modules`. Steps `goto click rclick dblclick hover type press wait gone text eval assert sleep size
  shot`; target = selector or case-insensitive text then `title|aria-label|placeholder`; viewport 1900x1000, `--touch`,
  step timeout 5 s; token injected as `localStorage["ia.token"]` by an init script (top frame, app origin only); fails on
  page/console errors except allowed regexes (the 404 of `/api/open-token` is always allowed); failure screenshot
  `<tmp>/ui-check-<pid>-failed.png`; private TMPDIR per process for Chromium.
- `fake-claude` (Python): stand-in `claude` speaking stream-json: init, assistant, result; title generation for
  `--output-format json|text`; env knobs `IA_FAKE_CLAUDE_{SLEEP,TEXT,RESULT,EXIT,TITLE,LIMIT,USAGE,WINDOW,COST,LOGIN,
  SESSIONS,STREAM_SLEEP,LOG}`; prompt markers `fake-ask-permission|question|plan` (control request `can_use_tool`),
  `fake-board-call <tool> <json>` (in-process SDK MCP `mcp_message` to server `huntaway`), `fake-subagent`,
  `out-of-usage`, `on-extra-usage`, `/compact`; echoes steered messages (`isReplay`), honours `interrupt`, `--resume`.
- `fake-cua-driver` (Node; `IA_CUA_DRIVER`), `stub-google-mcp.py`: MCP-over-stdio stubs with canned results and JSON
  logs (`FAKE_CUA_LOG`, `FAKE_CUA_FAIL`, `STUB_GOOGLE_LOG`).
- `copy-live-board.sh <env|dir>`: `sqlite3 .backup` of the live DB into a `--no-agents` test server, scrubbed (runs
  exited, paths under `/nonexistent`, scripts blanked, configs, prompts, links, automations, PR watches, telegram,
  asana, docs sign-ins, telemetry removed), then restart. `--source`, `--scrub` for its test.
- `ui-profile.mjs` (main-thread time under synthetic websocket events via `page.routeWebSocket`), `event-loop-probe.mjs`
  (health + ws ping every 5 ms while heavy GETs run; `GET /api/debug/event-loop`), `browser-pane-e2e.mjs` (Electron
  `<webview>` checks, not in CI), `desktop-app-check.mjs` (packaged app starts its bundled server and runs a fake-claude
  turn), `release-update-e2e.{sh,mjs}` (builds 0.9.0/0.9.1/0.9.3 + fake 0.9.2 broken + 0.9.4-rc.1, fake GitHub, headless
  packaged app; `--pacman` in docker; ~2 GB in `~/.cache/huntaway-release-e2e`), `clean-worktree.sh` (Done status script:
  removes `target`, `release-server`, `apps/web/{dist,release,*.tsbuildinfo}` in linked worktrees only),
  `ask-eval/` (offline prompt-wording evaluation, not CI).

### 2.13 Toolchain
- Node >= 24 (`engines`; CI and releases use 24; the server relies on type stripping and `node:sqlite`); pnpm 10.34.9
  (`packageManager`); workspace `apps/*`, `packages/*`; one lockfile. `catalog`: `vite-plus: 1.5.0`,
  `vite: npm:@voidzero-dev/vite-plus-core@1.5.0`; `overrides`: `vite@* -> vite-plus-core@1.5.0`, `vitest@* -> 5.1.0`;
  `peerDependencyRules.allowAny: [vite]`; `allowBuilds`: `@parcel/watcher: false`, `electron-winstaller: false`.
- Vite+ `vp` 1.5.0 bundles Vite 8.3.5 (as vite-plus-core), Vitest 5.1.0, Oxfmt 0.76.0, Oxlint 1.91.0,
  oxlint-tsgolint 7.0.2005 (TypeScript 7 native type check). Root `vite.config.ts`: `fmt.printWidth: 160`,
  `fmt.ignorePatterns: ["**/fixtures/**", "apps/server/src/threads/examples/**"]`, `lint.options: {typeAware: true,
  typeCheck: true}` (no rule overrides), `test.projects: ["apps/server", "apps/web"]`.
- Commands: `pnpm check` = `vp check` (fmt check + lint + typecheck with each file's tsconfig; lint warnings don't fail,
  errors and type errors do); `pnpm fix` = `vp check --fix`; `pnpm typecheck` = `vp check --no-fmt --no-lint`;
  `pnpm test` = `vp test`; `vp fmt <files>`; `pnpm test:ui`; `pnpm test:mobile`; `pnpm dev` (Vite at 5173, `/api` and
  websockets proxied to `$IA_SERVER` or `127.0.0.1:7878`); `pnpm build`; `pnpm electron`.
- `typescript` (6.0.3) exists **only** in `apps/mobile` (Expo's); everything else is type-checked by tsgolint. The server
  additionally has `tsrs 0.22.0-ts7.1.0-beta` for release compilation and for `tests/floating_promises.test.ts`.
- Server tsconfig: `target/lib es2024`, `module nodenext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `strict` but `noImplicitAny: false`, `useUnknownInCatchVariables: false`, `types: [node]`.
- Vitest projects: server (`src/**/*.test.ts`, `tests/**/*.test.ts`, `pool: forks`, 60 s test/hook timeouts); web `unit`
  (`tests/*.test.ts`, Node, 60 s) and `browser` (`tests/browser/*.test.tsx`, Vitest browser mode on Playwright Chromium
  headless shell or `$CHROMIUM`, viewport 1400x900, 10 s test timeout, 5 s poll); separate
  `apps/web/tests/ui/vitest.config.ts` (`*.test.mjs`, forks, `maxWorkers = IA_UI_TEST_JOBS || max(8, cpus/2)`, 120 s).
- Rust: workspace root `Cargo.toml` with one member `rust/shim` (`ia-shim`, edition 2024, rust-version 1.89, dep `libc`
  only). `.cargo/config.toml`: `rustc-wrapper` (sccache if installed and reachable), no dep debuginfo, split debuginfo,
  `runner = .cargo/test-runner` (private on-disk TMPDIR per test binary under `/var/tmp/ia-cargo-test-*`, flock-swept,
  fails if anything is left behind). No rustfmt config (don't run `cargo fmt`).
- `.git-blame-ignore-revs` (the Oxfmt reformat). `.claude/` holds only an untracked empty `worktrees/`. `AGENTS.md` only
  points at `CLAUDE.md`, which holds the agent workflow rules (PR per task, merge conditions, test-server discipline,
  never touch port 7878 / the live data dir, use `ia-api` and `ui-check`, what to test).

### 2.14 CI (`.github/workflows/test.yml`, name "Tests")
- Triggers: `pull_request` (opened, synchronize, reopened), `push` to `master`, `workflow_dispatch`. Permissions
  `contents: read`. Concurrency `test-<pr number | ref>`, cancel-in-progress only for PRs.
- `tree` (ubuntu-latest, 5 min): tree sha of `$GITHUB_SHA` (for a PR, GitHub's merge commit); lists artifacts named
  `green-tree-<tree>` whose run's `head_repository_id` is this repo, and if any such run concluded `success`, sets
  `skip=true` (never for `workflow_dispatch`; any failure here means run in full).
- Every other job has `needs: tree`, `if: skip != 'true'`:

| Job | Runner | Timeout | Runs |
| --- | --- | --- | --- |
| `rust` | self-hosted `[self-hosted, huntaway]` for the owner's own runs, else ubuntu-latest | 15 | `cargo test --locked` (`CARGO_INCREMENTAL=0`, `SCCACHE_DISABLE=1`) |
| `check` | ubuntu-latest | 10 | `vp check` |
| `server` | ubuntu-latest | 25 | `vp test` in `apps/server` |
| `web` | ubuntu-latest | 15 | `playwright install --with-deps --only-shell chromium`; `vp test` in `apps/web`; uploads failure screenshots |
| `mobile` | ubuntu-latest | 15 | `pnpm run typecheck` (tsc) and `pnpm test --ci` (Jest) in `apps/mobile` |
| `ui (N/3)` x3 | as `rust` | 30 | rustup; `playwright-core install chromium chromium-headless-shell`; `cargo build --locked -p ia-shim`; `pnpm run test:ui --shard=N/3` (`IA_UI_TEST_JOBS` 4 hosted / 3 self-hosted); uploads `/tmp/ui-check-*-failed.png`; shard 1 also `python3 scripts/ia-api-test.py` and `bash scripts/copy-live-board-test.sh`; every shard `sh scripts/install-release-host-test.sh` |
| `green` | ubuntu-latest | 5 | needs all; uploads artifact `green-tree-<tree>` (30 days, overwrite) |

- Setup: `actions/checkout` (pinned by sha; `clean: false` on self-hosted + a tidy step: `git clean -ffd`, remove old
  failure screenshots, delete `target` over 20 GB), `voidzero-dev/setup-vp@v1.22.0` (Node 24, pnpm, `vp install`, store
  cache only on GitHub-hosted), `Swatinem/rust-cache` only on GitHub-hosted. Self-hosted routing needs repo variable
  `SELF_HOSTED_USER` == actor == triggering actor, and for PRs the author and a same-repo head. No secrets, so forks run it.
- Deployments and PR previews are **outside this repo**. A preview is a LAN-only board started with `--demo` and
  `--open-token`, rebuilt from the PR head, sleeping when idle, sharing one mounted Claude login.

## 3. Data

### 3.1 Mobile: persisted (expo-secure-store; web target uses `localStorage` with prefix `huntaway.`)
| Key | Accessibility | Value |
| --- | --- | --- |
| `boards` | WHEN_UNLOCKED_THIS_DEVICE_ONLY | JSON `Board[]` (no tokens) |
| `token.<id sanitised to [A-Za-z0-9._-]>` | same | the board's device token |
| `boards.selected` | same | board id |
| `boards.shared` | same | board id the last share went to |
| `push.pending` | same | JSON `Pending[]` (a `revoke` entry holds a token) |
| `push.boards` | AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY | JSON `{boardId: url}` for lock-screen answers |
| `push.handled` | AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY | JSON `string[]`, last 100 `"<notification id>:<action>"` |

- `Board {id (= host_id), url (no trailing slash), name (host name), deviceId, apiVersion, capabilities?: string[]
  (sorted), profile: string|null (a profile **name**), push?: boolean (undefined = on), pairedAt}`.
- `BoardStatus {connected, unauthorized, tooOld}` (memory only).
- `PushData` (what a push carries, set by the server's `integrations/push/expo.ts`): `{board (host id), host?, task_id?,
  event?, request_id?, answer?: {url, token}}`; also `url`, `tag` (unused by the app). Read from
  `request.content.data`, or Android's `data.dataString`, `trigger.remoteMessage.data.body`, `trigger.payload.body`.
  Expo message fields the server sets: `to, title, body, data, ttl 86400, priority high|normal, sound default,
  channelId prompts|default, collapseId/tag (sha256(tag)[:16] hex), categoryId "prompt"` when answerable.
- `PushDevice {id, endpoint, kind?: "web"|"expo", device_id?, name, events: PushEvents, created_at, last_sent_at,
  last_error}`; `PushEvents = {attention, review, merge, done: boolean, prompts?: "off"|"assistant"|"all", replies?,
  reports?}`.
- `InboxItem` base `{key, board{id,name}, hostId, taskKey, taskId, title, at}` + `permission` | `question` | `attention`.
- `ThreadItem` union: `user | text | tool | event | permission | question | report | result` (see `thread.ts`).
- `SharedDraft {text, files: SharedFile[]}`, `PendingShare {id, draft, boardId|null}`, `Prefill {id, text, files}`.
- Pairing link: `huntaway://pair?url=<encoded board url>&code=<code>`; code is one-use, 5 minutes.

### 3.2 Files on disk
- Test server data dir: `.ia-test-server` (marker), `launch` (bash `declare -p bin serve` + exported env), `env`,
  `seed.env`, `server.log`, `server.prev.log`, `server.pid`, `tmp/`, `repo/`, `fake-claude.log`,
  `fake-claude-{sessions,window,costs.json}`, plus the server's own files. Checkout: `.ia-test-env` symlink (gitignored).
- Release tarball / desktop resources: layout in 2.8/2.9. `server-ts/` keeps its historical name because installed
  releases look for it. `<data dir>/app/{<v>/, <v>.partial/, state.json, shell-state.json}`.
- Desktop config `~/.config/huntaway/desktop.json` (`port, dataDir, host, serverBin, serverUrl, token, skipDbBackup`);
  legacy dir `issue-agent` honoured.
- `huntaway-<v>-release.json`: `{version, shell, electron}`. `electron/shell.json`: `{electron, boot}`.
- CI record: artifact `green-tree-<tree sha>` containing `green-tree.txt` (the run URL).
- Supervisor scratch: `${TMPDIR:-/tmp}/huntaway-serve.XXXXXX/{next, started}`.

### 3.3 Settings keys / tables
n/a for this area directly (server side: `device_tokens`, `push_subscriptions` with `kind`, `device_id`,
`push_answer_tokens`; setting `release_prereleases`; `copy-live-board.sh` names the tables it scrubs: `runs, tasks,
projects, claude_configs, profiles, permission_requests, mcp_calls, links, automations, pr_watches, pr_states, settings
(telegram%, telemetry%), docs_site_connections, telemetry_outbox`).

## 4. In-memory state (mobile)
- `Boards` store: `{boards, selected, lastShared, loaded}` + token map; `useSyncExternalStore`. Survives restart via the
  keychain; a board whose token is missing on load is dropped and the list rewritten.
- `clients: Map<boardId, {url, client}>`; `statuses: Record<boardId, BoardStatus>`; `eventListeners: Set`.
- `LiveUpdates.sockets: Map<boardId, {socket, url}>`; each `BoardSocket` holds `attempts`, retry timer, `everOpened`,
  `heard` timestamp, silence timer.
- `PushRegistrar`: `subscribed` (per board device or error/final), `pending` (persisted), `done` and `refused` sets keyed
  `board|deviceId|url|token` (memory only: re-verified against the board each sync), `failures`, single-flight `running`
  + `again`.
- `notifications.ts`: `PushState {token, problem, subscribed, pendingOff}`, `asked` flag, `configured` promise, `opener`
  and `pendingPush` (a tap that arrived before screens exist), in-memory `handled` set + persisted `push.handled`.
- `PendingShares.current` (memory only: a share is lost if the app dies before the composer takes it; the share
  extension's copied files stay in the cache).
- Dictation: module-level `owner`, `dropped`, `droppedAt`, `subscribed`.
- Per-screen `Snapshot<T>` (generation counter + pending updates); thread stream buffer keyed `board/host/task`.
- Nothing else is cached offline: no task/thread persistence.

## 5. Outside the process
- **Mobile -> board**: HTTPS REST under `/api` and `/api/h/<host>/…`, websocket `/api/ws?token=`, unauthenticated
  `GET /api/health`, `POST /api/devices/pair`, `POST /api/permissions/{id}/push-answer`. Mobile -> Expo: push token fetch
  (`getExpoPushTokenAsync`). Board -> Expo push service `https://exp.host/--/api/v2/push/send` (`IA_EXPO_PUSH_URL`,
  `IA_EXPO_ACCESS_TOKEN`); Expo -> FCM (needs `google-services.json` in the APK and an FCM V1 key uploaded to Expo) / APNs.
- **Native modules**: expo-camera (QR), expo-image-picker, expo-secure-store, expo-notifications, expo-task-manager
  (task `huntaway-notification-response`), expo-share-intent, expo-speech-recognition, expo-file-system (`File.size`,
  `.base64()`), expo-network (network listener), expo-device, expo-clipboard, expo-linking, expo-constants.
- **Scripts spawn**: `apps/server/bin/huntaway serve --host 127.0.0.1 --port <n> --data-dir <d> --name test …`, `cargo
  build -p ia-shim`, `git`, `jq`, `curl`, `sqlite3`, `setsid`, Chromium (`$CHROMIUM`, `/usr/bin/chromium`, or
  Playwright's), Electron, `docker` (pacman e2e), `tsrs`, `pnpm deploy`, `electron-builder`, `tar`, `sha256sum`.
- **GitHub**: releases API (`/repos/<repo>/releases`, `/releases/latest`, asset `digest` field), Actions artifacts API.
- **Environment variables** (this area): launcher `IA_NODE, IA_TS_EXE, NODE_OPTIONS, MALLOC_MMAP_THRESHOLD_,
  IA_MALLOC_MMAP, IA_RESTART_FILE, IA_SUPERVISOR_PID, IA_SERVE_SIGNALS, IA_SKIP_DB_BACKUP_ONCE, IA_RECOPY_DB,
  IA_CRASH_BACKOFF`; packaging `VERSION, IA_BUILD_COMMIT`; test server `IA_TEST_BIN, IA_SHIM_BIN, IA_TEST_OPEN_TOKEN,
  IA_TEST_CLAUDE_CONFIG, IA_TEST_MODEL, IA_NEW_DB_FILE, IA_CLAUDE_BIN, IA_CODEX_BIN, IA_TELEGRAM_API, IA_CUA_DRIVER,
  IA_CUA_DRIVER_RELEASE, IA_DESKTOP_LOCKED, IA_FAKE_CLAUDE_*, FAKE_CUA_*` and outputs `IA_TEST_{URL,TOKEN,PID,DATA_DIR,
  ENV,PROFILE,PROJECT,REPO}`; tests `IA_UI_TEST_JOBS, CHROMIUM, NODE_COMPILE_CACHE, IA_KEEP_TEST_DIRS,
  IA_CARGO_TEST_TMPDIR, SCCACHE_DISABLE, RUSTC_WRAPPER, IA_API_SCRIPT`; dev `IA_SERVER, IA_DEV_URL`; live copy
  `IA_LIVE_DATA_DIR, IA_LIVE_DB`; installers `HUNTAWAY_{REPO,BRANCH,DIR,UPDATE_FROM,RELEASES,LAUNCHER}`; releases
  `IA_RELEASE_UPDATES, IA_RELEASE_API, IA_BUNDLED_SERVER, IA_UPDATE_FROM, IA_COMMIT, IA_SERVER_BIN`; CI secrets
  `ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD, GOOGLE_SERVICES_JSON`,
  variable `SELF_HOSTED_USER`.
- **Ports**: live server 7878 (never touched by tooling); Vite dev 5173; test servers and e2e pick free ports;
  sccache 4226.

## 6. Background work, timers, retries
- `BoardSocket`: reconnect backoff `min(30 s, 1 s * 2^min(n,5))` (1, 2, 4, 8, 16, 30 s…), reset on open; silence
  watchdog `SILENCE_MS` 60 s, armed only after the first `tick` (server ticks every 25 s; older boards never tick and
  are never timed out); forced reconnect (`kick(true)`) of every socket on app foreground and on network-connected.
- `useRefetchOn` throttle 600 ms; thread reload debounce 500 ms; stream flush once per animation frame; recording-bar
  tick 1 s; voice note limit 4 min; dropped speech session expiry 3 s; long-press 400 ms.
- `PushRegistrar` retry: 30 s doubling to 15 min max (`RETRY_FIRST`, `RETRY_MAX`), reset on success.
- Server side for the app's push (other area): Expo batches of 100, receipts asked ~15 min later, every 5 min.
- Launcher supervisor: crash restarts after 1, 2, 4, 8, 16 s (`IA_CRASH_BACKOFF` replaces the base), at most 5 in a row,
  counter reset after 600 s of uptime.
- Release checks 30 s after start then every 6 h; `--update-from` poll every 5 min; shell survival 20 s.
- test-server: ready wait 1500 x 20 ms (30 s); stop: TERM, 250 x 20 ms (5 s), then KILL. `ia-api` request timeout 30 s.
- CI: artifact retention 30 days (green record), 7 days (failure screenshots), 1 day (release build artifacts).

## 7. Surface

### 7.1 Board routes the mobile app depends on (must stay in the paired-device allowlist, `apps/server/src/devices.ts`)
Board-level (`HUB`): `GET /api/ws`, `GET /api/hosts`, `GET /api/devices`, `DELETE /api/devices/{id}` (self only),
`GET /api/push`, `POST /api/push/subscriptions`, `PATCH|DELETE /api/push/subscriptions/{id}`,
`POST /api/push/subscriptions/{id}/test`, `POST /api/permissions/{id}/push-answer`. No token: `GET /api/health`
(`{ok, commit, api_version, capabilities}`), `POST /api/devices/pair`.
Host-level (`HOST`, also as `/api/h/<host>/…`): `GET profiles`, `GET profiles/{id}/projects`, `GET profiles/{id}/tasks`,
`GET|POST profiles/{id}/assistant`, `GET projects/{id}`, `GET|POST projects/{id}/tasks`, `GET|PATCH tasks/{id}`,
`PATCH tasks/{id}/stack`, `GET|POST tasks/{id}/messages`, `GET tasks/{id}/thread`, `GET tasks/{id}/thread/items`,
`POST tasks/{id}/questions/{n}`, `POST tasks/{id}/stop`, `POST attachments`, `GET attachments/*/*`, `GET permissions`,
`POST permissions/{id}`. Everything else is 403 for a device.

### 7.2 Websocket events the app consumes
`hello` (ignored), `tick`, `task {host_id, task}`, `task_deleted {host_id, id}`, `message` / `message_updated`
`{host_id, task_id, message}`, `delta {task_id, text}`, `delta_reset {task_id}`, `thread_event {task_id, event}`,
`thread_resync {task_id}`, `project`, `project_deleted`, `profiles_changed`, `hosts_changed`; client-made `resync`.

### 7.3 Routes the tooling and release checks depend on
`GET /api/health`, `GET /api/info`, `GET /api/open-token` (only with `--open-token`; loopback `Host` required on a
loopback-only server; otherwise the path falls through to the UI's `index.html`), `GET /` serving HTML, stdout line
`IA_READY {"port": N, "token": …}`, `<data dir>/auth_token`; `POST /api/profiles`, `POST /api/profiles/{id}/projects`
(seed); `GET /api/profiles`, `/api/profiles/{id}/tasks|projects`, `/api/projects/{id}`, `/api/projects/{id}/tasks`,
`GET|PATCH /api/tasks/{id}` (`{task, last_message, pending_permissions}`), `POST /api/tasks/{id}/messages`,
`GET /api/permissions[?task_id=]`, `POST /api/permissions/{id}` (409 when already answered),
`GET /api/tasks/{id}/thread[?limit]`, `/thread/items?before=&limit=`, `/thread/events?after=` (`{events, seq, more,
resync}`), `GET /api/settings`, `GET /api/debug/event-loop`, `GET /api/admin/server`, `POST /api/admin/release/{check,
update,rollback}`. Task fields read by `wait-idle`: `running, merging, status, run_started_at, attention_reason`.

### 7.4 CLI
`huntaway [serve|token|google-auth|install-service|telemetry|ssh-host|title-check|threads-import|threads-rebuild|
approval-hook] …`, `--version`/`-V` (prints `huntaway <version>`), `--help`; serve flags the tooling uses: `--host
--port --data-dir --name --demo --open-token --release-updates --update-from --ui-dir --recopy-db`. Exit code 75 =
"exec what `$IA_RESTART_FILE` names".

### 7.5 Deep links
`huntaway://pair?url=&code=` -> `/pair`; `huntaway://dataUrl=<key>` (iOS share extension) -> `/`.

## 8. Events emitted
Mobile emits no server events; it calls the API. Internally: board-status changes, `resync`, push-state changes.
CI emits the `green-tree-<tree>` artifact. The launcher emits stderr lines on crash restarts.

## 9. Invariants and hard-won rules
- **Notification handlers before screens** (`index.ts`): a background action must find its handler with no UI.
- **A tap is handled once**: Android delivers a background action to both the listener and the task, and
  `getLastNotificationResponseAsync` re-delivers the launching tap on every start; hence the in-memory set plus the
  persisted last-100 list in a store readable while locked (`push.ts` `handledStore`, serialized writes).
- **Lock-screen answers never read the keychain**: board URLs are mirrored into an AFTER_FIRST_UNLOCK store; the push
  carries a one-time token; the URL path is pattern-checked so a push can't direct the app elsewhere.
- **Pushes carry no content** (they transit Expo/Apple/Google unencrypted): key, title, event only.
- **Version check precedes spending the pairing code**; plain HTTP refused in release builds.
- **Never show one board's data under another**: results are tagged with `boardId` and filtered (`profilesOf`,
  `HostProject.boardId`); `useLoad` drops previous data when deps change even if the new load fails; late responses
  are ignored by generation; `settled`/`older` check the thread key before applying.
- **Updates during a load aren't lost**: `Snapshot` replays updates made while a read is in flight onto its result
  (a message arriving during the first page joins the page).
- **Background sockets lie**: on foreground / network change every socket is replaced even if it looks open, and the
  `resync` makes screens re-read.
- **Composer**: `inFlight` ref set synchronously (double tap); sending and uploading tracked separately; only the sent
  text is removed; dictation's "before" text is rewritten after a send and when a share lands so sent text can't
  reappear; Send disabled while the mic is on.
- **One speech session**: owner claimed before the permission prompt; late `end` of a dropped session swallowed.
- **Streaming text is plain text**, parsed as markdown only once stored (re-parsing per token is quadratic).
- **Off/remove must reach the board eventually**: pending unsubscribe/revoke persisted; a removed board's token is kept
  only inside the pending `revoke`.
- **APK signing key is forever**: phones only update from the same key; CI fails an APK signed with the debug key;
  `versionCode` must increase monotonically with semver (prereleases before their release).
- **Release package has no symlinks** and the packaged Node is a real binary, not a shim (HA-270: a packaged `vp` shim
  ran the runner's Node).
- **PID stability**: `serve` runs node as a child of the sh wrapper so restart/update keeps the wrapper's PID (desktop
  app, `test-server.sh`, systemd track it). Restart = write `next=<path>` to `$IA_RESTART_FILE`, exit 75; wrapper
  sources it (only if owned by the user) and execs. Crash restart only after `started` was written and only for non-0,
  non-75 exits or fault signals (ABRT, SEGV, BUS, ILL, FPE, TRAP, SYS); `IA_SKIP_DB_BACKUP_ONCE` and `IA_RECOPY_DB`
  apply to the first start only; the wrapper re-execs itself with INT at default disposition.
- **`unset VITEST NODE_TEST_CONTEXT`** in the launcher: a server started from a test isn't itself "in test".
- **Tooling never touches the live board**: test-server strips inherited `IA_*`; `ia-api` refuses 7878 and non-open
  remote hosts; `stop`/`copy-live-board` require the `.ia-test-server` marker; copy requires `--no-agents`; pid reuse
  guarded by cmdline.
- **Test servers default to `--open-token`** because such a board never shows system notifications (so a dev's desktop
  isn't spammed); UI tests set `IA_TEST_OPEN_TOKEN=0` to test real notification behaviour.
- **UI test harness uses `connection: close`** per API call (HA-392: keep-alive races with a blocked event loop), and a
  shared `NODE_COMPILE_CACHE` halves server start time.
- **CI tree skip is keyed on the tested tree, not the head commit**, recorded as artifacts because the runs API only
  knows head commits; only same-repo runs count; "Re-run all jobs" deletes the record. `ui` uses a matrix, so its
  skipped check is literally named `ui (${{ matrix.shard }}/3)`.
- **Don't merge master into a green PR**: the post-merge run on `master` tests the combination; master runs are never
  cancelled.
- **Merge-conflict avoidance by construction**: named migrations and named capabilities are one file each so two PRs
  never edit the same line/number (`API_VERSION` frozen at 153, numbered migrations frozen at 130).
- **Jest + pnpm + ESM**: see section 10.
- **`.cargo/test-runner`**: tests filled a tmpfs `/tmp` by the thousand; now each binary gets a swept on-disk TMPDIR.
- **Formatting**: 160 columns, fixtures and recorded thread examples never reformatted.

## 10. How it is tested
- **Mobile**: Jest 30 with preset `jest-expo` 58, `@testing-library/react-native` 14, `testMatch tests/**/*.test.ts(x)`,
  `setupFilesAfterEnv tests/setup.ts`, `modulePaths ["<rootDir>/node_modules"]`. `transformIgnorePatterns` is the
  jest-expo default extended with `\.pnpm` (pnpm's nested `node_modules/.pnpm/<pkg>/node_modules/<pkg>` layout),
  `@huntaway/.*` (the workspace client is raw TypeScript) and every ESM-only package reachable from the app's imports:
  `mdast-.*, micromark.*, decode-named-character-reference, character-entities, unist-.*, ccount,
  escape-string-regexp, markdown-table, longest-streak, zwitch, devlop`. Jest runs CommonJS; anything ESM-only not on
  this list fails with a syntax error at import. **Any new ESM-only dependency of `apps/mobile` or of `packages/client`
  must be added here** (the inner `node_modules/<name>` segment is what is matched).
- `tests/setup.ts`: mocks `expo-speech-recognition` (`tests/mocks/speech.ts`: `emit`, `result`) and `expo-file-system`
  (`File` with size 3, base64 `b64:<uri>`); reads Expo's lazy globals (`TextDecoderStream, TextEncoderStream, URL,
  URLSearchParams, DOMException, __ExpoImportMetaRegistry, structuredClone, fetch`) in `afterAll`, or Jest's teardown
  fails with "require a file outside of the scope of the test code".
- Seams: `SecretStore` interface (`memoryStore`), `Fetch` injection (`fakeFetch(route)`), `BoardSocket(connect)`,
  `PushRegistrar(deps)` (`expoToken`, `clientFor`, `later`), `responseHandler(deps)`, `Composer({readFile})`, pure
  functions everywhere (`pushData`, `pushTarget`, `sharedDraft`, `heard`, `hostItems`, `threadItems`, `groupTasks`,
  `versionCode`). `appConfig.test.ts` (node env) runs the config plugins (`getPrebuildConfigAsync`, `compileModsAsync`
  introspect) to assert the share extension, app group, RECORD_AUDIO and Android share intent filters.
  `theme.test.ts` asserts colours equal the web's CSS. 23 test files.
- Typecheck twice: `tsc --noEmit` with Expo's TypeScript 6 (CI `mobile`) and tsgolint via `vp check`.
- **Scripts**: `ia-api-test.py` (unittest, fake Api and clock), `install-release-host-test.sh` (curl stub + fake tarball,
  runs the printed commands), `copy-live-board-test.sh` (which DB file is "live"). `ui-check` has tests under
  `apps/web/tests/ui/driver.test.mjs` (uses `onMiss`).
- **Release**: in-workflow smoke tests (2.9), `desktop-app-check.mjs`, and the manual `release-update-e2e.sh`.
- **Web/server tiers** (context): unit (Node), component (`tests/browser`, fake fetch + fake websocket in page), browser
  (`tests/ui`, 93 files, each with its own `--demo` test server with agents off via `harness.mjs startServer`).
  Server test helpers in `apps/server/src/testing.ts` (`temp_dir, state, git_repo, until, when, free_port` …), `IN_TEST`.

## 11. Dependencies
- Mobile -> `@huntaway/client` (all API calls, shared types/labels, thread protocol reducer) -> server's
  `threads/protocol.ts`. Mobile depends on server behaviours owned elsewhere: device tokens and the allowlist
  (`devices.ts`), pairing codes, `/api/health` shape, push subscriptions of kind `expo` and push-answer tokens
  (`integrations/push*`), the websocket event shapes and 25 s `tick`, assistant routes, thread items API.
- Web board renders the pairing QR and manages devices; nothing imports from `apps/mobile`.
- Mobile versions: Expo SDK 58 (`expo ~58.0.22`, `expo-router ~58.0.29`, `expo-notifications ~58.1.8`,
  `expo-share-intent ^9`, `expo-speech-recognition ^58.0.1`), React Native 0.88.1, React 19.3.0 (web app uses 19.3.1),
  `react-native-web ^0.21.4`, `react-native-screens ~4.30.1`, `react-native-safe-area-context ~5.10.1`,
  `mdast-util-from-markdown ^2.1`, `mdast-util-gfm ^3.1`, `micromark-extension-gfm ^3`; dev: TypeScript ~6.0.3,
  Jest ^30.5.2, jest-expo ^58.0.13, `@testing-library/react-native ^14.1`.
- Server runtime deps packaged in a release: `ws ^8.18`, `sharp ^0.35.5` (native, per-platform prebuilt), and
  `@dire-kiwi/docs-render` (a GitHub release tarball URL). Web: React 19.3.1, zustand 5, Tailwind 4, xterm 5, shiki 4,
  mermaid 12, Electron 45, electron-builder 26.18, Playwright 1.64.1.
- Scripts call the server launcher, the API, `apps/web/node_modules/{playwright-core,electron}`,
  `apps/server/node_modules/ws`. `apps/web/tests/ui/harness.mjs` imports `scripts/ui-check.mjs` and runs
  `scripts/test-server.sh`. The server's Rebuild path and `install.sh` share the same pnpm filter set.
- CI depends on external actions: checkout v7.0.1, setup-vp v1.22.0, rust-cache v2.9.3, upload-artifact v7.0.2,
  download-artifact v8.0.2, setup-java v6.1.0, gradle/actions/setup-gradle v6.4.1 (all pinned by commit sha).

## 12. Rewrite notes
**Essential (behaviour users or agents rely on):**
- The mobile app as a pure API client with per-board device tokens; board identity = host id; profile picked by name;
  hub-proxied host routes; the device allowlist as the security boundary; the lock-screen answer design; pending
  unsubscribe/revoke; resync-on-reconnect; the `Snapshot` load model.
- A release = self-contained server (own Node, no install step), per-platform, verified by sha256 digests GitHub
  publishes, staged under `<data dir>/app/`, restart in place with agents surviving (they run under `ia-shim`),
  roll back, bad-version marking, shared `state.json`, shell-in-tarball with a frame stamp.
- The agent workflow contract in `CLAUDE.md`: `test-server.sh` (flags, env file format, `.ia-test-env`),
  `ia-api` (commands, exit codes, live-board refusal), `ui-check.mjs` (step language, module API), `fake-claude`
  (markers and env knobs are used by many tests), `--demo` and `--open-token` (previews and tooling), `IA_READY` line,
  `/api/open-token`, `auth_token` file.
- CI shape: fast jobs on hosted runners, CPU-bound `ui` shards and `rust` optionally self-hosted, tree-hash skip + green
  record, no secrets in the test workflow, only `attach` can write.

**Accidental / compatibility:**
- `server-ts/` folder name, `issue-agent` wrapper and `issue-agent` data/config dir fallbacks, `IA_` prefix everywhere,
  `ia-shim`/`ia-api`/`.ia-test-env` names, web package name `huntaway-app` (Electron storage is named after it), mac
  launcher bundle id `nz.dire.huntaway` vs app id `nz.net.ivan.huntaway`.
- The sh supervisor exists only because Node can't `exec` (the Rust server exec'd itself); exit code 75 and
  `IA_RESTART_FILE` are its protocol. Restart-onto-a-Rust-release (0.3.x) support and `huntaway.db` -> `huntaway-2.db`
  handling in scripts are history.
- Two thread sources in the mobile app (legacy `messages` and items): the message path is compatibility for boards
  whose tasks haven't moved onto items; `MIN_API 118` / API 120 / 122 gates are compatibility with older boards.
- `API_VERSION` frozen at 153 with capabilities alongside; the mobile app stores capabilities but gates only on numbers.
- tsrs is used only to compile release JS and to power one lint-like test; type checking moved to `vp check`.
- `eas.json` profiles are unused by any workflow; `submit.production.ios` is a placeholder; iOS has never been built.
- `install-release-host.sh` offers `linux-arm64`, and `boot.cjs`/`allowBuilds` mention Windows: neither is built.
- `scripts/ask-eval`, `ui-profile`, `event-loop-probe`, `browser-pane-e2e` are investigation tools, not CI.

**Awkward today:**
- No EAS `projectId` is committed, so mobile push cannot work in a build that hasn't had it injected; Android push also
  needs a Firebase config secret and an FCM key uploaded to Expo by hand.
- Mobile re-implements the thread view model and markdown rendering separately from web; theme colours are duplicated
  and kept equal by a test.
- `packages/client` reaches into `apps/server/src` by relative path for the protocol file.
- Mobile needs its own TypeScript (6) and Jest while the rest uses TS 7 (tsgolint) and Vitest; the Jest ESM allowlist
  must be maintained by hand.
- Packaging changes (workflow, electron-builder, app.json) are first exercised by the release that ships them; the only
  pre-release check is the manual 2 GB `release-update-e2e.sh`.
- Mac builds are ad-hoc signed and blocked by Gatekeeper until quarantine is cleared; Linux tarballs need glibc >= 2.39.
- Tooling is a mix of bash, POSIX sh, Python and Node; `test-server.sh` depends on `/proc`, `setsid`, `mktemp -t`
  (Linux-only in practice).
