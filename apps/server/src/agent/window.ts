// Port of server/src/agent/window.rs.
/**
 * Restarting 5-hour windows. A plan's session limit (Claude's `five_hour`, Codex's 300-minute
 * window) runs for five hours from the first message after the last window ended, so a window
 * that ends while nothing is running leaves the next one to start whenever work does, and then
 * run five hours from there. For each config with `restart_window` on whose plan has the window,
 * the board sends one short prompt just after it ends (`GRACE` late): Haiku with no tools for
 * Claude, a low-effort turn for Codex, with no session kept. That starts the next window.
 *
 * What it knows of the window is the config's usage (see agent/usage.rs): fetched when the config is
 * first seen with the setting on, again before and after each prompt (another host or a run may
 * have started the window since, and the prompt's own rate limits can still show the window that
 * ended), and kept up to date by agent runs' `rate_limit_event`s, the prompt's own included. A
 * plan whose usage has never shown a session limit is sent nothing, nor is a config that's out of
 * usage. Once a plan has shown one it counts as having it, as its usage may leave the limit out
 * while no window runs; a prompt whose own rate limits show no 5-hour window at all, with usage
 * that doesn't show one either, stops the restarts until the setting is turned on again (or the
 * server restarts). A prompt that fails, or that doesn't leave a window running, is tried again later, backing off
 * from `RETRY` up to `MAX_RETRY`.
 */
import { spawn } from "node:child_process";
import * as db from "../db.ts";
import type { ClaudeConfig } from "../db.ts";
import * as calls from "./tokens/calls.ts";
import type { Spent } from "./tokens/calls.ts";
import * as usage from "./usage.ts";
import * as codex from "./codex.ts";
import type { Shared } from "../state.ts";
import { background, context, err_str, expand_tilde } from "../util.ts";

/** How often the loop looks at the windows (ms). */
const TICK = 30_000;
/** How long after a window's reset the prompt is sent, for clocks that disagree. */
const GRACE = 60_000;
/** How long after a failed prompt the next is tried, doubling each time up to `MAX_RETRY`. */
const RETRY = 5 * 60_000;
const MAX_RETRY = 60 * 60_000;

const SYSTEM_PROMPT = "Reply with only the word OK.";
const PROMPT = "OK";

const log = {
  info: (...a: any[]) => console.error(new Date().toISOString(), " INFO window:", ...a),
  warn: (...a: any[]) => console.error(new Date().toISOString(), " WARN window:", ...a),
};

/** What the loop knows of one config, while its setting is on. */
export interface Watch {
  /** Its usage has been fetched since the setting was seen on. */
  fetched: boolean;
  /** Its plan has shown a session limit. */
  has_window: boolean;
  /** A prompt's own rate limits showed no 5-hour window. */
  no_window: boolean;
  failures: number;
  /** When to try again (ms since the epoch). */
  retry_at: number | null;
}

export function Watch_default(): Watch {
  return { fetched: false, has_window: false, no_window: false, failures: 0, retry_at: null };
}

/**
 * The plan has no 5-hour window (or none has been seen yet): `None`; running until then: `{ open: ms }`; ended
 * (`GRACE` ago), and not started again: `Ended`.
 */
export type Window = "None" | "Ended" | { open: number };

/** Start the loop that restarts windows. */
export function start(s: Shared) {
  const watches = new Map<string, Watch>();
  const tick = async () => {
    let configs: ClaudeConfig[];
    try {
      // Not through a proxy: it picks the account, so there's no one window to restart.
      configs = db.list_claude_configs(s.db()).filter((c) => c.restart_window && db.proxy(c) === null);
    } catch (e) {
      log.warn(`restarting 5-hour windows: ${err_str(e)}`);
      return;
    }
    // A setting turned off forgets what it knew, so turning it on again starts afresh.
    for (const id of [...watches.keys()]) if (!configs.some((c) => c.id === id)) watches.delete(id);
    for (const c of configs) {
      let w = watches.get(c.id);
      if (!w) watches.set(c.id, (w = Watch_default()));
      await check(s, c, w, Date.now());
    }
  };
  background(
    "restarting 5-hour windows",
    (async () => {
      for (;;) {
        await tick().catch((e) => log.warn(`restarting 5-hour windows: ${err_str(e)}`));
        await new Promise((r) => setTimeout(r, TICK).unref());
      }
    })(),
  );
}

export function window(s: Shared, c: ClaudeConfig, w: Watch, now: number): Window {
  const session = usage.session_reset(s, c.id);
  w.has_window ||= session !== undefined;
  if (!w.has_window || w.no_window) return "None";
  if (session != null && session + GRACE > now) return { open: session };
  return "Ended";
}

/** Send the prompt if the config's window has ended. */
export async function check(s: Shared, c: ClaudeConfig, w: Watch, now: number) {
  if (w.retry_at !== null && w.retry_at > now) return;
  if (!w.fetched) {
    w.fetched = true;
    await usage.refresh(s, c);
  }
  if (window(s, c, w, now) !== "Ended" || usage.out_until(s, c.id) !== null) return;
  // Someone may have started it since the numbers were last updated.
  await usage.refresh(s, c);
  if (window(s, c, w, now) !== "Ended") return;
  let result: { ok: boolean | null } | { err: unknown };
  try {
    result = { ok: await ping(s, c) };
  } catch (e) {
    result = { err: e };
  }
  // The first request after a window ends can still report the old one, or leave the 5-hour
  // window out of its rate limits, so the usage, asked again, says whether the next started.
  const shown = (await usage.refresh(s, c)) ? usage.session_reset(s, c.id) !== undefined : null;
  let no_window = false;
  if ("ok" in result) {
    if (result.ok !== null) no_window = !result.ok && shown !== true;
    // Codex's prompt doesn't say; its usage does.
    else if (db.is_codex(c)) no_window = shown === false;
  }
  if (no_window) {
    log.info(`config=${c.name} not restarting its 5-hour window: its plan doesn't have one`);
    w.no_window = true;
    return;
  }
  const after = window(s, c, w, now);
  if ("ok" in result && typeof after === "object") {
    log.info(`config=${c.name} started the next 5-hour window, until ${new Date(after.open).toISOString()}`);
    w.failures = 0;
    w.retry_at = null;
  } else {
    const wait = Math.min(RETRY * 2 ** Math.min(w.failures, 4), MAX_RETRY);
    w.failures++;
    w.retry_at = now + wait;
    const why = "err" in result ? err_str(result.err) : "no window is running after it";
    log.warn(`config=${c.name} restarting the 5-hour window failed (${why}); trying again in ${Math.floor(wait / 60_000)} minutes`);
  }
}

/**
 * Send the prompt that starts a window: whether its rate limits showed a 5-hour window, if it
 * said. Claude's are taken in as an agent run's are. Its tokens are kept (see agent/tokens/calls.rs).
 */
async function ping(s: Shared, c: ClaudeConfig): Promise<boolean | null> {
  const spent: { value: Spent | null } = { value: null };
  try {
    return await send(s, c, spent);
  } finally {
    if (spent.value) calls.record(s, "window", null, c.id, spent.value);
  }
}

/**
 * Stands in for the prompt in tests: `output` (when not null) is what each one prints (stream-json lines), or its
 * error, and `pings` counts them. (Rust's thread-locals under `cfg(test)`.)
 */
export const test_hooks: { output: Array<{ ok: string } | { err: string }> | null; pings: number } = { output: null, pings: 0 };

async function send(s: Shared, c: ClaudeConfig, spent: { value: Spent | null }): Promise<boolean | null> {
  if (test_hooks.output !== null) {
    const out = test_hooks.output.shift();
    if (out === undefined) throw new Error("no prompt in tests");
    test_hooks.pings++;
    if ("err" in out) throw new Error(out.err);
    spent.value = calls.Spent_claude_stream(out.ok);
    return read_output(s, c.id, out.ok);
  }
  if (db.is_codex(c)) {
    // Away from any repository, as titles are.
    await codex.task_title(db.dir(c), s.data_dir, SYSTEM_PROMPT, PROMPT, spent);
    return null;
  }
  const program = process.env.IA_CLAUDE_BIN ?? "claude";
  const args = ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config"];
  args.push("--no-session-persistence", "--disable-slash-commands", "--system-prompt", SYSTEM_PROMPT);
  const out = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: s.data_dir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: expand_tilde(db.dir(c)) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(context("timed out", new Error("deadline has elapsed")));
    }, 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(context("failed to run claude", e));
    });
    child.stdout!.on("data", (b: Buffer) => stdout.push(b));
    child.stderr!.on("data", (b: Buffer) => stderr.push(b));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(PROMPT);
  });
  spent.value = calls.Spent_claude_stream(out.stdout);
  const reported = read_output(s, c.id, out.stdout);
  if (out.code !== 0) {
    const status = out.code !== null ? `exit status: ${out.code}` : `signal: ${out.signal}`;
    throw new Error(`claude exited with ${status}: ${out.stderr.trim()}`);
  }
  return reported;
}

/**
 * Take in the `rate_limit_event`s in Claude's stream-json output: whether they showed a
 * 5-hour window, if they showed any rate limits. The first request after a window ends reports
 * it as its `rateLimitType` but leaves it out of `unifiedWindows`, so either counts.
 */
function read_output(s: Shared, config_id: string, stdout: string): boolean | null {
  let reported: boolean | null = null;
  for (const l of stdout.split("\n")) {
    let v: any;
    try {
      v = JSON.parse(l);
    } catch {
      continue;
    }
    if (v?.type !== "rate_limit_event") continue;
    usage.on_rate_limit_event(s, config_id, v);
    const info = v.rate_limit_info ?? {};
    const windows = info.unifiedWindows;
    const is_obj = (x: any) => x !== null && typeof x === "object" && !Array.isArray(x);
    if (is_obj(windows) || typeof info.rateLimitType === "string") {
      reported = reported === true || is_obj(windows?.five_hour) || info.rateLimitType === "five_hour";
    }
  }
  return reported;
}
