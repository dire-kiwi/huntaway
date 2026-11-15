# Huntaway on your phone

`apps/mobile` is Huntaway's phone app: an Expo SDK 58 / React Native 0.88 app on `@huntaway/client`, so its sessions,
board and threads are the web app's own atoms ([docs/plan/09-frontend.md](../../docs/plan/09-frontend.md#the-phone-app)).

It shows one board: an **Inbox** of what waits on you (prompts to allow or deny, questions, tasks in Needs attention),
your **Assistant**, your **Projects** and their tasks by status, a task's thread with its prompt, question and plan
cards, Stop / Start / Move and a composer, and the **Board** (its hosts, the profile shown, connecting another).

## Connecting

On the board, Settings → Network access shows its link, `http://<host>:<port>/?token=…`. Paste it into Connect. The
token gives full control of the board, so reach it over a network you trust (the same Wi-Fi, or Tailscale). A board
started with `--open-token` (test servers) needs only its address.

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

  The web build keeps the board in `localStorage` (the keychain is the phone's), and is for checks only.
