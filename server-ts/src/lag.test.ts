// Tests of lag.ts and worker.ts (HA-183).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { call, type Req } from "./http.ts";
import * as lag from "./lag.ts";
import * as db from "./db.ts";
import { in_worker } from "./worker.ts";

const req = (path: string): Req => ({ method: "GET", path, params: {}, query: {}, query_string: "", headers: {}, body: {}, raw: Buffer.alloc(0) });

const spin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

test("a_route_that_holds_the_thread_is_counted_and_its_stall_logged_with_it", async () => {
  process.env.IA_LAG_LOG_MS = "60";
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: any[]) => void logged.push(a.join(" "));
  try {
    lag.start();
    lag.reset();
    // Let the ticker start from now.
    await new Promise((r) => setTimeout(r, 30));
    const a = await call(() => (spin(150), { ok: true }), null as any, req("/api/tasks/t1/messages"), "GET /tasks/{id}/messages");
    assert.equal(a.status, 200);
    // An async handler: its part before the first await counts, and so does its answer's JSON.
    await call(async () => (spin(5), await Promise.resolve(), { ok: true }), null as any, req("/api/info"), "GET /info");
    await new Promise((r) => setTimeout(r, 60));
    const snap = lag.snapshot();
    const route = snap.routes.find((r) => r.route === "GET /tasks/{id}/messages")!;
    assert.ok(route.max_ms >= 150 && route.count === 1 && route.max_path === "/api/tasks/t1/messages", JSON.stringify(route));
    assert.ok(snap.routes.find((r) => r.route === "GET /info")!.max_ms >= 5);
    // The slowest first.
    assert.equal(snap.routes[0].route, "GET /tasks/{id}/messages");
    const stall = snap.stalls.find((s) => s.ms >= 100);
    assert.ok(stall, JSON.stringify(snap.stalls));
    assert.equal(stall.busy, "GET /tasks/{id}/messages /api/tasks/t1/messages");
    assert.ok(logged.some((l) => /the event loop was blocked for \d+ ms \(GET \/tasks\/\{id\}\/messages \/api\/tasks\/t1\/messages\)/.test(l)), logged.join("\n"));
    assert.ok(snap.delay_ms && snap.delay_ms.max >= 100, JSON.stringify(snap.delay_ms));
    lag.reset();
    assert.deepEqual([lag.snapshot().routes, lag.snapshot().stalls], [[], []]);
  } finally {
    console.error = error;
    delete process.env.IA_LAG_LOG_MS;
  }
});

test("a_worker_answers_with_what_its_function_returns_or_throws", async () => {
  const url = new URL("../tests/worker_jobs.ts", import.meta.url);
  assert.deepEqual(await in_worker(url, "add", [2, 3]), { sum: 5 });
  // Async functions are awaited.
  assert.equal(await in_worker(url, "later", ["x"]), "x");
  await assert.rejects(in_worker(url, "fails", []), (e: any) => e instanceof Error && e.message === "outer" && (e.cause as any)?.message === "inner");
  await assert.rejects(in_worker(url, "missing", []), /has no function missing/);
  await assert.rejects(in_worker(new URL("./nope.ts", import.meta.url), "add", []), /nope\.ts/);
});

test("statements_are_prepared_once_and_only_the_latest_are_kept", () => {
  const c = new DatabaseSync(":memory:");
  let prepares = 0;
  const spy = new Proxy(c, {
    get(target, k) {
      if (k === "prepare") return (sql: string) => (prepares++, target.prepare(sql));
      const v = (target as any)[k];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  db.run(spy, "CREATE TABLE t (x)");
  for (let i = 0; i < 5; i++) db.run(spy, "INSERT INTO t VALUES (?1)", i);
  assert.equal(db.value(spy, "SELECT count(*) FROM t"), 5);
  assert.equal(db.value(spy, "SELECT count(*) FROM t"), 5);
  // `one` and `value` don't share a statement: `value`'s returns arrays.
  assert.deepEqual({ ...db.one<object>(spy, "SELECT count(*) FROM t") }, { "count(*)": 5 });
  assert.equal(prepares, 4);
  // A statement prepared before the table changed still works after.
  db.run(spy, "ALTER TABLE t ADD COLUMN y");
  db.run(spy, "INSERT INTO t (x) VALUES (?1)", 9);
  assert.equal(db.value(spy, "SELECT count(*) FROM t"), 6);
  // Made-up SQL doesn't pile up: the oldest go.
  for (let i = 0; i < 600; i++) db.value(spy, `SELECT ${i}`);
  const before = prepares;
  db.value(spy, "SELECT count(*) FROM t");
  assert.equal(prepares, before + 1, "the count's statement was dropped as 600 others came after it");
  db.value(spy, "SELECT 599");
  assert.equal(prepares, before + 1, "the latest are kept");
  c.close();
});
