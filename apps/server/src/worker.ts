// Work that would hold the server's one thread for long, run on a thread of its own (HA-183). The Rust server answered
// requests on several threads, so a slow one held up only itself; here, everything waits for whatever is running. So
// what takes seconds (walking every worktree for the disk usage page, copying the database before an update) runs in a
// worker thread made for it, which ends when it's done: none is kept around, as each costs memory (a V8 heap, and the
// modules it loads) and is only wanted now and then.
//
// The worker imports the module it's given and calls one of its exported functions with arguments that are copied over
// (plain data: no connections, no AppState), so the function opens what it needs itself (a database file by path, say:
// a connection of its own sees what the server's has committed, WAL included).
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

interface Job {
  /** The module's URL. */
  module: string;
  fn: string;
  args: unknown[];
}

/**
 * Call `fn`, exported by the module at `url` (`new URL("./disk.ts", import.meta.url)`), with `args` in a new worker
 * thread, and resolve with what it returns (or resolves with), copied back. Rejects with what it throws.
 */
export function in_worker<T>(url: URL, fn: string, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: Job = { module: url.href, fn, args };
    const w = new Worker(new URL(import.meta.url), { workerData: { huntaway_job: job } });
    let settled = false;
    w.once("message", (m: { ok: true; value: T } | { ok: false; error: unknown }) => {
      settled = true;
      if (m.ok) resolve(m.value);
      else reject(m.error);
    });
    w.once("error", (e) => {
      settled = true;
      reject(e);
    });
    w.once("exit", (code) => {
      if (!settled) reject(new Error(`the worker for ${fn} exited with ${code} before it answered`));
    });
  });
}

/** The worker's side: run the job and post what came of it. */
async function work(job: Job) {
  try {
    const m = await import(job.module);
    if (typeof m[job.fn] !== "function") throw new Error(`${job.module} has no function ${job.fn}`);
    parentPort!.postMessage({ ok: true, value: await m[job.fn](...job.args) });
  } catch (e) {
    // Errors are copied with their message, stack and cause; anything else as it is.
    parentPort!.postMessage({ ok: false, error: e });
  }
}

// Not awaited: the job's module may import this one, which has to have finished loading first.
if (!isMainThread && workerData?.huntaway_job) work(workerData.huntaway_job as Job).catch((e) => console.error("worker:", e));
