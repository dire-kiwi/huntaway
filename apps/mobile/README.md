# Huntaway on your phone

`apps/mobile` is Huntaway's phone app: an Expo SDK 58 / React Native 0.88 app on `@huntaway/client`, so its sessions,
board and threads are the web app's own atoms ([docs/plan/09-frontend.md](../../docs/plan/09-frontend.md#the-phone-app)).

It shows one board, in five tabs:

- **Inbox**: what waits on you. Prompts to allow or deny (with what the tool would do), questions and plans, the tasks
  in Needs attention, then the tasks new in In review. Its tab counts what waits on an answer.
- **Tasks**: the shown profile's tasks by status, across its projects or in the one picked at the top, with a search,
  Backlog and Done folded until tapped, and **+** for a new task.
- **Assistant**: your assistant's thread and composer.
- **Docs**: the board's documents (the docs plugin's pages, as the board shows them): read, comment, answer a
  document's form fields and send them to its task.
- **Board**: where the board is and whether it is live, its hosts, the profile shown, its plugins' other pages,
  connecting another board, forgetting this one.

A task opens over them: its status (a tap moves it), its agent, its pull request, its thread with its prompt, question
and plan cards (a run of tool calls folded into one line, a published document as a card that opens it), and a composer
whose button sends, or stops the agent when nothing is typed. Its microphone (and New task's) dictates into the field
with the phone's own speech recognition: tap to start, tap again to stop. **⋯** has Start or Stop, Move, Details (description,
todos, the documents the task published) and the ways out to the web. A link to a document or a task opens in the app;
a link out of the app that a document's page asked for is asked about first.

## Connecting

Connect lists the boards on the phone's Wi-Fi (every address of its /24 asked for `/api/health` on port 7879; the port
can be changed). Tap one, then on the board choose Settings → Network access → Pair a phone and type the PIN it shows:
the phone gets a device token of its own (`read` and `operate` only), which Unpair there revokes. A board it doesn't
find is typed in by address, with its PIN; or its link with the board token (`http://<host>:<port>/?token=…`, full
control). A board started with `--open-token` (test servers) needs only its address.

## Running it

From the top of the checkout, after `pnpm install`:

```sh
pnpm --filter huntaway-mobile start      # Metro; open it with Expo Go (SDK 58) or a development build
pnpm --filter huntaway-mobile android    # build and run it on an Android phone or emulator (needs the Android SDK)
pnpm --filter huntaway-mobile ios        # the same on iOS (needs Xcode)
```

The phone must reach the board's address: `127.0.0.1` is the phone itself (an Android emulator reaches the computer at
`10.0.2.2`).

## Checking it

- `pnpm check` type-checks and lints it with the rest; `pnpm test` runs its tests (`tests/`, the pure logic in
  `src/logic`).
- Its screens can be driven in a browser: build the web version and serve it on a free port, then use
  `scripts/ui-check.mjs` against a test server (`--size 412x880 --touch`, `--url` the served build):

  ```sh
  scripts/test-server.sh --seed --demo --fake-claude > $TMPDIR/server-env
  pnpm --filter huntaway-mobile export:web --output-dir $TMPDIR/mobile-web
  ```

  The web build keeps the board in `localStorage` (the keychain is the phone's), and is for checks only. A plugin's
  page (a document) is a sandboxed `<iframe>` there and a web view on a phone (`src/components/frameView.web.tsx`,
  `frameView.tsx`): `ui-check.mjs`' text steps don't look inside a frame, so drive one with its module (`open`, then
  `ui.page.frameLocator("iframe").last()`). The tabs stay mounted, so a text on two of them matches twice: pick the
  last (`text=… >> nth=-1`). Its Connect
  looks for boards on this machine only (`127.0.0.1`): type the test server's port beside the list, start pairing with
  `huntaway rpc hub.devices.startPairing` (or on the board), and tap the board.
