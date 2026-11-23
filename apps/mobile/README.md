# Huntaway on your phone

`apps/mobile` is Huntaway's phone app: an Expo SDK 58 / React Native 0.88 app on `@huntaway/client`, so its sessions,
board and threads are the web app's own atoms ([docs/plan/09-frontend.md](../../docs/plan/09-frontend.md#the-phone-app)).

It shows one board: an **Inbox** of what waits on you (prompts to allow or deny, questions, tasks in Needs attention),
your **Assistant**, your **Projects** and their tasks by status, a task's thread with its prompt, question and plan
cards, Stop / Start / Move and a composer, and the **Board** (its hosts, the profile shown, connecting another).

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

  The web build keeps the board in `localStorage` (the keychain is the phone's), and is for checks only. Its Connect
  looks for boards on this machine only (`127.0.0.1`): type the test server's port beside the list, start pairing with
  `huntaway rpc hub.devices.startPairing` (or on the board), and tap the board.
