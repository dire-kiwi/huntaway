// Giving back what a burst of work left (HA-181). After a burst of requests (the board loading every thread, say),
// the garbage they left holds on to malloc'd memory outside V8's heap too (response bodies, query results, strings),
// which only a full GC frees. V8's memory reducer runs one once the heap has been quiet a while, but not reliably: in
// `scripts/ram-compare.mjs --live`, a minute after the same load, a server is sometimes back to 110 MB and sometimes
// still at 180 MB. So every TICK, a server whose RSS has grown by SLACK since the last full GC has one (`gc`, from
// `--expose-gc`, which bin/huntaway gives node; without it, this does nothing). A GC of the server's 20 to 30 MB heap
// takes some 10 to 20 ms, at most once a TICK, and only after RSS grew.
const TICK = 30_000;
const SLACK = 32 << 20;

/**
 * One tick: whether a server at `rss` bytes should have a full GC, given `after`, what the last one left it at; and what
 * to measure from next. That goes down when RSS went down by itself (V8's memory reducer, or after a GC taken in the
 * middle of a burst, which left it high).
 */
export function tick(after: number, rss: number): { collect: boolean; after: number } {
  after = Math.min(after, rss);
  return { collect: rss - after >= SLACK, after };
}

let started = false;

/** Start checking (once per process). */
export function start() {
  const gc = (globalThis as any).gc as (() => void) | undefined;
  if (started || typeof gc !== "function") return;
  started = true;
  let after = process.memoryUsage.rss();
  setInterval(() => {
    const t = tick(after, process.memoryUsage.rss());
    after = t.after;
    if (!t.collect) return;
    gc();
    after = process.memoryUsage.rss();
  }, TICK).unref();
}
