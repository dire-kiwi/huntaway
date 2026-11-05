// What the Rust server got from tokio for free (HA-182): a panic in a spawned task ended that task, and the server kept
// serving. Node exits on a rejected promise nobody handles, and on a throw in a timer or an event's callback, which
// would take the whole board down for one background job's bug. `install` keeps the server up instead: each is logged
// (with its stack) to the server log, and the server carries on without the callback or promise chain that failed.
//
// Uncaught exceptions are carried on from too, rather than exiting for bin/huntaway to start the server again. Node's
// docs warn that the process may be left in an undefined state, but a throw here leaves what a Rust panic in a task
// left: the server is single-threaded and its database calls are synchronous, with transactions that roll back on a
// throw (db.ts's `transaction`), so a throw can't leave one open or interleave with another request; what it can leave
// is that callback's own work half done, as a panic left its task's. Exiting would cost more: every websocket and
// request in flight dropped, and a gap of seconds in which the board is down, for something that may be thrown again
// at once (a timer's tick) and so would only restart the server over and over. bin/huntaway still starts the server
// again when it exits some other way (see its comments), such as running out of memory.
import { inspect } from "node:util";
import { ApiError, type Req, type Router } from "./http.ts";

/** An error logged again within this long (ms) is counted rather than logged: a timer's throw would fill the log. */
const QUIET = 60_000;

/** Errors logged lately, by their text: when, and how many times they've happened since without being logged. */
const recent = new Map<string, { at: number; more: number }>();

/** Log `e`, which nothing handled, and carry on (unless it's been logged within `QUIET`, which counts it). */
export function report(what: "unhandled rejection" | "uncaught exception", e: unknown, now = Date.now()) {
  const text = inspect(e, { depth: 4 });
  const key = `${what}\n${text}`;
  const last = recent.get(key);
  if (last && now - last.at < QUIET) {
    last.more++;
    return;
  }
  // Forget the errors not seen for a while, so a server up for months doesn't keep every one it ever logged.
  if (recent.size >= 100) for (const [k, v] of recent) if (now - v.at >= QUIET) recent.delete(k);
  recent.set(key, { at: now, more: 0 });
  const again = last?.more ? ` (and ${last.more} more time${last.more === 1 ? "" : "s"} since it was last logged)` : "";
  console.error(`${new Date(now).toISOString()} ERROR huntaway: ${what}${again}, carrying on: ${text}`);
}

let installed = false;

/** Log unhandled rejections and uncaught exceptions rather than exiting on them (see above). Once per process. */
export function install() {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (e) => report("unhandled rejection", e));
  process.on("uncaughtException", (e) => report("uncaught exception", e));
}

/**
 * With `IA_DEBUG_FAULTS=1`, `POST /api/debug/fault {"kind": …}` makes the server fail as a bug would, for tests and for
 * checking a build by hand: `reject` (a promise nobody handles rejects after the answer), `throw` (a timer throws),
 * `loop` (a timer throws every second from then on: a background loop's bug) and `exit` (the server exits with 1 after
 * answering, as a crash would). Nothing is added without it.
 */
export function debug_route(r: Router) {
  if (process.env.IA_DEBUG_FAULTS !== "1") return;
  console.error(`${new Date().toISOString()}  WARN huntaway: IA_DEBUG_FAULTS: POST /api/debug/fault makes this server fail on purpose`);
  r.route("/debug/fault", { POST: fault });
}

function fault(_s: unknown, r: Req) {
  const kind = r.body?.kind;
  switch (kind) {
    case "reject":
      // As a handler that started something in the background and forgot its `.catch`.
      setImmediate(() => void Promise.reject(new Error("IA_DEBUG_FAULTS: a rejection nobody handles")));
      break;
    case "throw":
      setTimeout(() => {
        throw new Error("IA_DEBUG_FAULTS: a timer that throws");
      }, 10);
      break;
    case "loop":
      setInterval(() => {
        throw new Error("IA_DEBUG_FAULTS: a background loop that throws on every tick");
      }, 1000).unref();
      break;
    case "exit":
      setTimeout(() => process.exit(1), 10);
      break;
    default:
      throw ApiError.bad(`kind: one of reject, throw, loop or exit, not ${JSON.stringify(kind)}`);
  }
  return { ok: true };
}
