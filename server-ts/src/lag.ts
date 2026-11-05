// How long the server's one thread is kept busy (HA-183). The Rust server answered requests on several threads; this one
// answers everything on one, and `node:sqlite` is synchronous, so a slow query or a big JSON body holds up every other
// request, websocket and agent's output until it ends. This measures that:
//
// - `monitorEventLoopDelay`'s histogram of how late timers ran (the lag any request saw);
// - the time each API route spent on the thread (its handler's synchronous part and its JSON), by route, with the
//   slowest few kept;
// - stalls: any time the thread was held for more than STALL_MS, logged with what was running then (`busy`).
//
// `GET /api/debug/event-loop` shows them (`?reset=1` starts them again), and `IA_LAG_LOG_MS` sets the stall that's
// logged (0: none; default 250).
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Router } from "./http.ts";

const log_ms = () => {
  const v = Number(process.env.IA_LAG_LOG_MS ?? 250);
  return Number.isFinite(v) && v >= 0 ? v : 250;
};

interface RouteStats {
  count: number;
  /** Milliseconds on the thread, in all. */
  total: number;
  max: number;
  /** The request that took `max` (its path). */
  max_path: string;
}

interface Stall {
  at: string;
  ms: number;
  busy: string | null;
}

let hist: ReturnType<typeof monitorEventLoopDelay> | null = null;
let routes = new Map<string, RouteStats>();
let stalls: Stall[] = [];
let since = new Date().toISOString();
/** What's running on the thread now, for a stall's log line. */
let busy: string | null = null;
let ticker: NodeJS.Timeout | null = null;
const TICK = 20;

/** Start measuring (once per process). */
export function start() {
  if (hist) return;
  hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  // A timer that should fire every TICK ms: when it fires late, the thread was busy for the difference.
  let last = performance.now();
  // The longest work since the last tick: `busy` is cleared when it ends, before the timer sees the stall.
  let longest: { what: string; ms: number } | null = null;
  ticker = setInterval(() => {
    const t = performance.now();
    const late = t - last - TICK;
    last = t;
    if (late >= log_ms() && log_ms() > 0) stalled(late, longest?.what ?? busy);
    longest = null;
  }, TICK);
  ticker.unref();
  note = (what, ms) => {
    if (!longest || ms > longest.ms) longest = { what, ms };
  };
}

let note: (what: string, ms: number) => void = () => {};

function stalled(ms: number, what: string | null) {
  const s: Stall = { at: new Date().toISOString(), ms: Math.round(ms), busy: what };
  stalls.push(s);
  if (stalls.length > 50) stalls.shift();
  console.error(`${s.at}  WARN huntaway: the event loop was blocked for ${s.ms} ms${what ? ` (${what})` : ""}`);
}

/** Run `f` (synchronous work) as `what`, for stalls' log lines. Returns what it returns. */
export function busy_with<T>(what: string, f: () => T): T {
  const outer = busy;
  busy = what;
  const t0 = performance.now();
  try {
    return f();
  } finally {
    const ms = performance.now() - t0;
    if (ms >= 1) note(what, ms);
    busy = outer;
  }
}

/** Count `ms` on the thread for `route` (`GET /tasks/{id}/messages`), from a request for `path`. */
export function record(route: string, path: string, ms: number) {
  let r = routes.get(route);
  if (!r) routes.set(route, (r = { count: 0, total: 0, max: 0, max_path: "" }));
  r.count++;
  r.total += ms;
  if (ms > r.max) {
    r.max = ms;
    r.max_path = path;
  }
  if (ms >= 1) note(`${route} ${path}`, ms);
}

const round = (n: number) => Math.round(n * 10) / 10;
const ms = (ns: number) => round(ns / 1e6);

/** What's been measured since the start (or the last reset). */
export function snapshot() {
  const h = hist;
  return {
    since,
    stall_log_ms: log_ms(),
    delay_ms: h
      ? { count: h.count, min: ms(h.min), mean: ms(h.mean), p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p99: ms(h.percentile(99)), max: ms(h.max) }
      : null,
    stalls: [...stalls].reverse(),
    // The slowest routes first.
    routes: [...routes.entries()]
      .map(([route, r]) => ({ route, count: r.count, total_ms: round(r.total), mean_ms: round(r.total / r.count), max_ms: round(r.max), max_path: r.max_path }))
      .sort((a, b) => b.max_ms - a.max_ms),
  };
}

export function reset() {
  hist?.reset();
  routes = new Map();
  stalls = [];
  since = new Date().toISOString();
}

/** `GET /api/debug/event-loop[?reset=1]`. */
export function debug_route(r: Router) {
  r.route("/debug/event-loop", {
    GET: (_s, req) => {
      const out = snapshot();
      if (["1", "true"].includes(req.query.reset ?? "")) reset();
      return out;
    },
  });
}
