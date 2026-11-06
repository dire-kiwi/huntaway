// Shared setup for the browser checks in this folder: a scratch test server (scripts/test-server.sh --demo,
// with agents switched off) and a browser on it (scripts/ui-check.mjs). They test the built UI, so run
// `pnpm run build` (and `pnpm install` and `cargo build -p ia-shim` at the top of the checkout) first; `pnpm run test:ui` does the UI build.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { launch, open } from "../../../../scripts/ui-check.mjs";
import { convert, Translator } from "../../../server/src/threads/translate.ts";
import { apply_events, initial_state, item_page, snapshot_window } from "../../src/threads.ts";

const script = fileURLToPath(new URL("../../../../scripts/test-server.sh", import.meta.url));

/** Start a demo test server that can't run agents. Returns { url, token, dataDir, api, stop }. */
export function startServer(...args) {
  const out = execFileSync(script, ["start", "--demo", ...args], {
    encoding: "utf8",
    env: { ...process.env, IA_TEST_OPEN_TOKEN: "0", IA_CLAUDE_BIN: "/bin/false", IA_CODEX_BIN: "/bin/false" },
  });
  const vars = Object.fromEntries([...out.matchAll(/^(?:export )?(IA_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
  const url = vars.IA_TEST_URL;
  const token = vars.IA_TEST_TOKEN;
  const api = async (method, path, body) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const stop = () => execFileSync(script, ["stop", vars.IA_TEST_DATA_DIR], { stdio: "ignore" });
  return { url, token, dataDir: vars.IA_TEST_DATA_DIR, api, stop };
}

/** A git repository at `dir` with a commit, so a project on it can have worktrees (HA-20: else its board is its setup thread). */
export function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
}

/** The demo project that `--demo` seeds. */
export async function demoProject(server) {
  const [profile] = await server.api("GET", "/profiles");
  const projects = await server.api("GET", `/profiles/${profile.id}/projects`);
  return projects.find((p) => p.name === "Demo");
}

let failures = 0;

// One browser for the file's checks, each in a context of its own (as fresh as a new browser's): launching one for each
// took longer than most checks. Launched again if it went away (a crash).
let browser;
const sharedBrowser = async () => {
  if (!(await browser)?.isConnected()) browser = launch();
  return browser;
};
afterAll(async () => (await browser)?.close());

/**
 * Run `fn` with a browser on the server (see `open` in scripts/ui-check.mjs), then close it. Page and console
 * errors that weren't allowed fail the check; if `fn` failed as well, they're added to its error, and a screenshot
 * of the page is saved to <tmp>/ui-check-<pid>-<n>-failed.png.
 */
export async function withBrowser(server, opts, fn) {
  const ui = await open({ url: server.url, token: server.token, log: () => {}, browser: await sharedBrowser(), ...opts });
  try {
    await fn(ui);
  } catch (e) {
    if (ui.errors.length) e.message += `\npage or console errors:\n${ui.errors.join("\n")}`;
    // As scripts/ui-check.mjs does for a failed step (CI keeps these).
    const shot = join(tmpdir(), `ui-check-${process.pid}-${++failures}-failed.png`);
    if (
      await ui.page.screenshot({ path: shot }).then(
        () => true,
        () => false,
      )
    )
      e.message += `\nthe page at the time: ${shot} (${ui.page.url()})`;
    throw e;
  } finally {
    await ui.close();
  }
  if (ui.errors.length) throw new Error(`page or console errors:\n${ui.errors.join("\n")}`);
}

/** Far past the events the server writes for a task itself, which the view then leaves be. */
export const SEQ = 100_000;

/**
 * The thread `messages` (stored messages, as the board kept threads before they moved onto items) make, as the thread API
 * gives it: translated into items by the server's translator (apps/server/src/threads/translate.ts), as the move did.
 */
export function itemSnapshot(taskId, messages) {
  const c = convert(messages, { finished: false });
  const thread = { id: taskId, harness: "claude", status: "idle", created_at: "2026-10-26T07:00:00.000Z" };
  const s = apply_events(
    initial_state(thread),
    c.events.map((e, i) => ({ ...e, thread_id: taskId, seq: i + 1 })),
  );
  return { ...s, seq: SEQ };
}

/**
 * A thread that goes on while it's shown: its log of saved events (numbered from SEQ on), made from the messages added
 * (translated as they come, as the server writes items live) and the events put in it. Each is sent as a `thread_event`
 * on `feed.socket` (a routeWebSocket's) once that's set. routeThread serves its snapshot and its log's events after a
 * seq (`/thread/events?after=`), so a view catching up gets what it missed.
 */
export function threadFeed(taskId, messages = []) {
  const t = new Translator();
  const thread = { id: taskId, harness: "claude", status: "idle", created_at: "2026-10-26T07:00:00.000Z" };
  const feed = {
    messages: [],
    log: [],
    socket: null,
    /** The seq of the last event in the log. */
    get seq() {
      return SEQ + feed.log.length;
    },
    /** Saved events (unnumbered) put in the log, and sent (unless `quiet`: missed, as while disconnected). */
    event(e, quiet = false) {
      const ev = { ...e, thread_id: taskId, seq: feed.seq + 1 };
      feed.log.push(ev);
      if (feed.socket && !quiet) feed.socket.send(JSON.stringify({ type: "thread_event", task_id: taskId, event: ev }));
      return ev;
    },
    /** A message added: its events go in the log. `m` has its kind and data (id and created_at are filled in). */
    add(m, quiet = false) {
      const msg = { id: feed.messages.length + 1, task_id: taskId, created_at: new Date().toISOString(), ...m };
      feed.messages.push(msg);
      for (const e of convert([msg], { from: t, finished: false }).events) feed.event(e, quiet);
      return msg;
    },
    /** A message changed in place (a prompt answered): its request's events again. */
    update(m, quiet = false) {
      for (const e of convert([m], { finished: false }).events) if (e.type.startsWith("request.")) feed.event(e, quiet);
    },
    /** Streamed text, not saved: a `delta` for `item_id`. */
    delta(item_id, offset, text) {
      const ev = { type: "delta", thread_id: taskId, seq: feed.seq, item_id, kind: "text", offset, text };
      feed.socket?.send(JSON.stringify({ type: "thread_event", task_id: taskId, event: ev }));
    },
    snapshot() {
      return { ...apply_events(initial_state(thread), feed.log), seq: feed.seq };
    },
  };
  for (const m of messages) feed.add(m);
  return feed;
}

/**
 * Serves `messages` (an array, or a function giving it, called for each request, or a threadFeed) as task `taskId`'s thread, as a host
 * serves a thread kept as items (see itemSnapshot): windows (`?limit=`), pages of earlier items (`/items?before=`), and
 * no events after it. The task is served as one on items (`thread_source`), which a new one isn't until its first
 * message, so the view asks for them. Returns the requests asked for (`thread?limit=300`, `thread/items?before=…`).
 */
export async function routeThread(page, taskId, messages) {
  const asked = [];
  const onItems = (t) => (t?.id === taskId ? { ...t, thread_source: "items" } : t);
  await page.route(new RegExp(`/(projects/[^/]+/tasks\\?.*|tasks/${taskId})$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => undefined);
    if (body === undefined) return route.fulfill({ response: res });
    const json = Array.isArray(body) ? body.map(onItems) : body?.task ? { ...body, task: onItems(body.task) } : onItems(body);
    return route.fulfill({ response: res, json });
  });
  await page.route(new RegExp(`/tasks/${taskId}/thread(/items|/events)?(\\?.*)?$`), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const q = url.searchParams;
    asked.push(url.pathname.replace(/.*\/thread/, "thread") + url.search);
    const feed = messages?.snapshot ? messages : null;
    if (url.pathname.endsWith("/events")) {
      const after = Number(q.get("after"));
      return route.fulfill({
        json: feed ? { events: feed.log.filter((e) => e.seq > after), more: false, seq: feed.seq } : { events: [], more: false, seq: SEQ },
      });
    }
    const snap = feed ? feed.snapshot() : itemSnapshot(taskId, typeof messages === "function" ? messages() : messages);
    if (url.pathname.endsWith("/items")) return route.fulfill({ json: item_page(snap, Number(q.get("before")), Number(q.get("limit") ?? 100)) });
    return route.fulfill({ json: q.has("limit") ? snapshot_window(snap, Number(q.get("limit"))) : snap });
  });
  return asked;
}
