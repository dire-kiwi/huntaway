// Port of the tests in rust/broker/src/proto.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Ctl_from_json, DATA, TEXT, WINDOW, Window, decode, encode, slug, valid_name } from "./proto.ts";

test("data_frames_round_trip", () => {
  const f = encode(0x0102030405060708, TEXT, Buffer.from("hi"));
  assert.deepEqual(decode(f), [0x0102030405060708, TEXT, Buffer.from("hi")]);
  assert.deepEqual(decode(encode(1, DATA, Buffer.alloc(0))), [1, DATA, Buffer.alloc(0)]);
  assert.equal(decode(Buffer.alloc(8)), null);
});

test("names", () => {
  assert.ok(valid_name("desktop") && valid_name("pc-2") && valid_name("2pc"));
  assert.ok(!valid_name("") && !valid_name("-pc") && !valid_name("Desktop") && !valid_name("a/b") && !valid_name("a".repeat(49)));
  assert.equal(slug("Ivan's Desktop"), "ivan-s-desktop");
  assert.equal(slug("--x--"), "x");
  assert.equal(slug("ŵ"), "host");
  assert.equal(slug(`${"a".repeat(47)}-b`), "a".repeat(47));
  assert.ok(valid_name(slug("é1".repeat(40))));
});

test("window_gives_room_back_up_to_its_size", async () => {
  const w = new Window();
  assert.ok(await w.take(WINDOW - 10));
  const short = await Promise.race([w.take(20).then(() => "took"), sleep(50).then(() => "timeout")]);
  assert.equal(short, "timeout", "took more than the window");
  assert.notEqual(w.blocked_for(), null);
  // The waiter above gets its 20 of this, and the rest stays.
  w.credit(Number.MAX_SAFE_INTEGER);
  await sleep(0);
  assert.equal(w.available_permits(), WINDOW - 20);
  w.credit(Number.MAX_SAFE_INTEGER);
  assert.equal(w.available_permits(), WINDOW);
  // A message bigger than the window waits for all of it, then goes.
  assert.ok(await w.take(WINDOW * 3));
  assert.equal(w.available_permits(), 0);
  w.close();
  assert.ok(!(await w.take(1)));
});

test("ctl_wire_format", () => {
  const req = { t: "req", id: 3, method: "GET", path: "/api/info", headers: [], body: false, ws: false };
  assert.deepEqual(JSON.parse(JSON.stringify(req)), { t: "req", id: 3, method: "GET", path: "/api/info", headers: [], body: false, ws: false });
  assert.deepEqual(Ctl_from_json(`{"t":"close","id":3}`), { t: "close", id: 3, code: null, reason: null });
  assert.deepEqual(Ctl_from_json(`{"t":"welcome","name":"desktop"}`), { t: "welcome", name: "desktop" });
  const hello: any = Ctl_from_json(`{"t":"hello","name":"desktop","host_id":"id","version":"0","protocol":1}`);
  assert.ok(hello.t === "hello" && hello.origin_port === undefined && hello.key === undefined);
});
