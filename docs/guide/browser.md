# A task's browser

Every task has a web browser of its own. Its agent uses it to open pages, read them, click and type, and you see it
beside the thread on the board: the globe button beside the task's tabs opens it. Drag the bar between them to give it
more or less room; on a phone it takes the thread's place.

The browser runs on the task's host, so `localhost` and its ports are the host's: the dev server an agent started in
its terminal opens with just its port. Type `5173` into the address bar for `http://localhost:5173`.

## Where it runs

- **In the desktop app**, when its board's server runs on the same computer, for a task on that host, the browser is the app's own: a real browser pane, with its
  DevTools (the bug button), that the agent drives too while the pane is there. The dot in the address bar is green
  while the agent is connected to it. Closing the pane keeps its page; closing the task gives the agent's browser back
  to the host.
- **Everywhere else** (a browser tab, the phone app, a task on another host, or the desktop app showing a server on
  another computer), it is a headless Chrome on the host,
  streamed to you as pictures. Click, scroll and type in it as in any page; paste with Ctrl+V or Cmd+V. The agent keeps
  using it when nobody is watching.

When the desktop app opens the pane for a task whose agent was using the headless browser, the pane loads the page the
agent was on, and the agent carries on there. The two keep their own cookies and sign-ins.

A headless page nobody has used for half an hour closes; the next use opens it again at the same address.

## What the agent can do

The agents have a `browser` MCP server: `navigate` (an address, a host, or a port; back, forward, reload), `snapshot`
(the page as an outline with refs), `click`, `type`, `press`, `hover` and `scroll` on refs, `evaluate` (JavaScript in
the page), `screenshot`, and `close`. They use it without asking, in every mode: it is a web page, not your files. A
dialog the page shows (an `alert`) is accepted for it, and the agent is told.

## The headless Chrome

The first time a task on a host opens its browser, the host downloads Google's chrome-headless-shell from Chrome for
Testing, about 125 MB, into `<data dir>/browser/chrome`, and checks it against the size and SHA-256 the server knows. The
pane says how far the download has got. It needs `unzip` on the host. To use a Chrome or Chromium the host already has
instead, set `HUNTAWAY_CHROME` to it in the server's environment.

Chrome runs in its own sandbox. On a host where that can't start (the server runs as root or in a container, or
Ubuntu 23.10 and later, which blocks it with AppArmor), the browser says it didn't start; set
`HUNTAWAY_CHROME_SANDBOX=0` in the server's environment and restart it. When the browser can't open, the pane says why
and waits for you to press **Retry**; a download that failed isn't tried again for five minutes.

Its cookies and storage are in `<data dir>/browser/profile`, shared by every task on the host.

## Not yet

Copying text out of the streamed page to your clipboard, uploading and downloading files through it, scrolling it by
touch on a phone (tap to click works), and typing with an input method (IME) aren't there yet. A task has one page: a
link that opens a new window opens it in that page.
