// Port of server/src/integrations/push/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, verify, type ECDH } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import * as testing from "../../testing.ts";
import * as db from "../../db.ts";
import * as api from "../../api.ts";
import * as hub from "../../hosts/hub.ts";
import { API_VERSION } from "../../hosts/proto.ts";
import type { AppState } from "../../state.ts";
import { sleep } from "../../util.ts";
import * as assistant from "../../agent/assistant.ts";
import {
  RECORD_SIZE,
  STOPPED,
  authorization,
  content_keys,
  ecdh,
  encrypt,
  encrypt_with,
  REPLY_EVENT,
  notification_text,
  report_text,
  start,
  task_event,
  vapid,
} from "../push.ts";

const b64 = (s: string) => Buffer.from(s, "base64url");
const enc = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A device's key (as its browser makes one). */
function device_key(): ECDH {
  const k = createECDH("prime256v1");
  k.generateKeys();
  return k;
}

function key_from(priv: Buffer): ECDH {
  const k = createECDH("prime256v1");
  k.setPrivateKey(priv);
  return k;
}

/** What a browser does with a push it gets (RFC 8291 section 3.4, the other way round). */
function decrypt(ua: ECDH, auth: Uint8Array, body: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), RECORD_SIZE);
  const idlen = body[20];
  const as_public = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const [cek, nonce] = content_keys(ecdh(ua, as_public), auth, ua.getPublicKey(), as_public, salt);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(-16));
  let plain = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]);
  // The last record ends in 2, then any padding of zeros.
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  assert.equal(plain[end - 1], 2);
  return plain.subarray(0, end - 1);
}

test("encryption_matches_the_rfc_8291_example", () => {
  // RFC 8291, section 5 and appendix A.
  const as_secret = key_from(b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
  const salt = b64("DGv6ra1nlYgDCS1FRnbzlw");
  const ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
  const body = encrypt_with(as_secret, salt, ua_public, auth, Buffer.from("When I grow up, I want to be a watermelon"));
  const expected =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95" +
    "bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
  assert.equal(enc(body), expected);
  // And the user agent's key reads it.
  const ua = key_from(b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"));
  assert.equal(decrypt(ua, auth, body).toString(), "When I grow up, I want to be a watermelon");
});

test("each_message_gets_its_own_key_and_salt", () => {
  const ua = device_key();
  const ua_public = ua.getPublicKey();
  const auth = Buffer.alloc(16, 7);
  const [a, b] = [encrypt(ua_public, auth, Buffer.from("hello")), encrypt(ua_public, auth, Buffer.from("hello"))];
  assert.notDeepEqual(a.subarray(0, 86), b.subarray(0, 86));
  assert.equal(decrypt(ua, auth, a).toString(), "hello");
  assert.equal(decrypt(ua, auth, b).toString(), "hello");
  // Too long for one record, or a key that isn't one.
  assert.throws(() => encrypt(ua_public, auth, Buffer.alloc(4000, "x")));
  assert.throws(() => encrypt(Buffer.alloc(65, 4), auth, Buffer.from("hello")));
});

test("the_vapid_key_is_made_once_and_signs_tokens_for_the_push_service", () => {
  const s = testing.state();
  const v = vapid(s.db());
  assert.equal(vapid(s.db()).public_key(), v.public_key());
  assert.equal(v.public.length, 65);
  const header = authorization(v, "https://fcm.googleapis.com/fcm/send/abc:def", "mailto:me@example.com", 1_000_000);
  assert.ok(header.startsWith("vapid t="));
  const [t, k] = header.slice("vapid t=".length).split(", k=");
  assert.equal(k, v.public_key());
  const parts = t.split(".");
  assert.deepEqual(JSON.parse(b64(parts[0]).toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(b64(parts[1]).toString()), { aud: "https://fcm.googleapis.com", exp: 1_000_000 + 12 * 3600, sub: "mailto:me@example.com" });
  const pub = b64(k);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: enc(pub.subarray(1, 33)), y: enc(pub.subarray(33, 65)) }, format: "jwk" });
  const sig = b64(parts[2]);
  assert.ok(verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, sig));
  assert.ok(!verify("sha256", Buffer.from("something else"), { key, dsaEncoding: "ieee-p1363" }, sig));
});

function task(status: string): any {
  return { id: "t1", kind: "task", number: 3, title: "Fix the login", status, running: false, review: null, attention_reason: null };
}

const withf = (t: any, fields: any) => ({ ...t, ...fields });

test("task_changes_notify_as_the_ui_does", () => {
  const working = withf(task("in_progress"), { running: true });
  const asks = withf(task("needs_attention"), { running: true, attention_reason: "Approve Bash?" });
  assert.equal(task_event(working, asks), "attention");
  // Not again while it stays there, nor for a run the user stopped, nor for a review thread.
  assert.equal(task_event(asks, withf(asks, { attention_reason: "Approve Write?" })), null);
  assert.equal(task_event(working, withf(task("needs_attention"), { attention_reason: STOPPED })), null);
  assert.equal(task_event(working, withf(asks, { kind: "review" })), null);
  // In review: once its agent stopped and its review passed (or with none).
  const reviewing = withf(task("in_review"), { review: { state: "running" } });
  assert.equal(task_event(working, reviewing), null);
  assert.equal(task_event(reviewing, withf(task("in_review"), { review: { state: "issues" } })), null);
  const passed = withf(task("in_review"), { review: { state: "passed" } });
  assert.equal(task_event(reviewing, passed), "review");
  assert.equal(task_event(working, task("in_review")), "review");
  assert.equal(task_event(working, withf(task("in_review"), { running: true })), null);
  assert.equal(task_event(passed, task("ready_for_merge")), "merge");
  assert.equal(task_event(task("ready_for_merge"), task("done")), "done");
  assert.equal(task_event(task("done"), task("done")), null);

  assert.deepEqual(notification_text("attention", asks, "WEB-3"), ["WEB-3 Fix the login", "Needs attention: Approve Bash?"]);
  assert.equal(notification_text("review", passed, "WEB-3")[1], "Ready to review: its review passed");
  assert.equal(notification_text("done", withf(task("done"), { resolution: "wont_fix" }), "WEB-3")[1], "Closed: won't fix");
  const long = notification_text("attention", withf(asks, { attention_reason: "x".repeat(300) }), "WEB-3")[1];
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.endsWith("…"));
});

interface Got {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A push service on this machine: it takes what's posted to it, answering with `status.code`. */
async function push_service(status: { code: number }) {
  const got: Got[] = [];
  const waiting: Array<(g: Got) => void> = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const g = { headers: req.headers, body: Buffer.concat(chunks) };
      const w = waiting.shift();
      if (w) w(g);
      else got.push(g);
      res.writeHead(status.code).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/push/device-1`;
  return {
    url,
    recv: (): Promise<Got> => (got.length ? Promise.resolve(got.shift()!) : new Promise((r) => waiting.push(r))),
    try_recv: () => got.shift() ?? null,
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

async function call(s: AppState, method: string, path: string, body: any = null): Promise<[number, any]> {
  if (!s.local_router) api.router(s);
  const raw = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const a = await api.dispatch(s, api.makeReq(method, path, { authorization: "Bearer ", "content-type": "application/json" }, raw));
  let v: any = null;
  try {
    v = JSON.parse(a.body.toString());
  } catch {}
  return [a.status, v];
}

function device(): [ECDH, any] {
  const ua = device_key();
  return [ua, { p256dh: enc(ua.getPublicKey()), auth: enc(Buffer.alloc(16, 9)) }];
}

test("devices_subscribe_change_their_events_and_unsubscribe", async () => {
  const s = testing.state();
  const [status, info] = await call(s, "GET", "/api/push");
  assert.equal(status, 200);
  assert.equal(b64(info.public_key).length, 65);
  assert.deepEqual(info.subscriptions, []);

  const [, keys] = device();
  const endpoint = "https://push.example.com/send/abc";
  const [st, sub] = await call(s, "POST", "/api/push/subscriptions", { endpoint, keys, name: "Pixel" });
  assert.equal(st, 200, JSON.stringify(sub));
  assert.deepEqual(sub.events, { attention: true, review: true, merge: false, done: false, replies: false, reports: true });
  assert.equal(sub.name, "Pixel");
  assert.ok(!("auth" in sub) && !("p256dh" in sub));
  const id = sub.id;

  // The same endpoint again (a browser that subscribed again) is the same device, keeping its events.
  const [, events] = await call(s, "PATCH", `/api/push/subscriptions/${id}`, { events: { attention: true, review: false, merge: true, done: false } });
  assert.equal(events.events.merge, true);
  const [, again] = await call(s, "POST", "/api/push/subscriptions", { endpoint, keys, name: "Pixel 8" });
  assert.deepEqual([again.id, again.name, again.events.merge], [id, "Pixel 8", true]);
  assert.equal((await call(s, "GET", "/api/push"))[1].subscriptions.length, 1);

  // Endpoints are HTTPS (HTTP only on this machine), and keys have to be real.
  for (const [body, why] of [
    [{ endpoint: "http://push.example.com/x", keys }, "https"],
    [{ endpoint: "not a url", keys }, "URL"],
    [{ endpoint, keys: { p256dh: enc(Buffer.alloc(65, 4)), auth: enc(Buffer.alloc(16, 1)) } }, "p256dh"],
    [{ endpoint, keys: { p256dh: keys.p256dh, auth: enc(Buffer.alloc(8, 1)) } }, "auth"],
  ] as Array<[any, string]>) {
    const [code, err] = await call(s, "POST", "/api/push/subscriptions", body);
    assert.equal(code, 400);
    assert.ok(err.error.includes(why), JSON.stringify(err));
  }

  assert.equal((await call(s, "DELETE", `/api/push/subscriptions/${id}`))[0], 200);
  assert.equal((await call(s, "DELETE", `/api/push/subscriptions/${id}`))[0], 404);
  assert.deepEqual((await call(s, "GET", "/api/push"))[1].subscriptions, []);
});

/** The board's task event for task `t` on this host. */
function emit(s: AppState, t: any) {
  s.hub_events.send({ type: "task", task: t, host_id: s.host_id });
}

test("a_link_is_connected_only_after_its_initial_push_snapshot", async () => {
  const s = testing.state();
  const service = await push_service({ code: 201 });
  try {
    const [ua, keys] = device();
    await call(s, "POST", "/api/push/subscriptions", { endpoint: service.url, keys });
    let entered!: () => void;
    const began = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const remote = createServer(async (req, res) => {
      if (req.url === "/api/profiles") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: "p" }]));
      if (req.url === "/api/profiles/p/tasks") {
        // The second snapshot, from the initial resync, used to swallow a change made after /api/hosts had already
        // advertised the link as connected.
        if (reads++ === 1) {
          entered();
          await gate;
        }
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([task("in_progress")]));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
    try {
      hub.link_http(s, "remote", `http://127.0.0.1:${(remote.address() as any).port}`, API_VERSION);
      db.upsert_link(s.db(), "remote", "remote", "outbound", null, null);
      start(s);
      s.hub_events.send({ type: "hosts_changed" });
      s.hub_events.send({ type: "resync", host_id: "remote" });
      await began;
      const connected = () => hub.list_hosts(s).find((h: any) => h.id === "remote").connected === true;
      assert.ok(!connected(), "link advertised before its task snapshot was ready");
      release();
      while (!connected()) await sleep(10);
      assert.equal(reads, 2);
      s.hub_events.send({ type: "task", host_id: "remote", task: task("needs_attention") });
      const { body } = await service.recv();
      const msg = JSON.parse(decrypt(ua, Buffer.alloc(16, 9), body).toString());
      assert.equal(msg.event, "attention");
      assert.equal(msg.tag, "remote:t1");
      // Readiness belongs to this connection, not just the host id reused on reconnect.
      hub.link_http(s, "remote", "http://127.0.0.1:1", API_VERSION);
      assert.ok(!connected());
    } finally {
      remote.closeAllConnections();
      remote.close();
    }
  } finally {
    service.close();
  }
});

test("task_events_are_pushed_encrypted_to_the_devices_that_want_them", async () => {
  const s = testing.state();
  const service = await push_service({ code: 201 });
  try {
    const [ua, keys] = device();
    const events = { attention: true, review: false, merge: true, done: true };
    const [, sub] = await call(s, "POST", "/api/push/subscriptions", { endpoint: service.url, keys, name: "phone", events });
    // A device that only wants reviews gets none of these.
    const [, other] = device();
    const none = { attention: false, review: true, merge: false, done: false };
    await call(s, "POST", "/api/push/subscriptions", { endpoint: `${service.url}-other`, keys: other, events: none });
    const profile = db.insert_profile(s.db(), "work", [], null);
    const x = "/x";
    const p = { id: "p1", profile_id: profile.id, name: "Web", key: "WEB", repo_path: x, scratch_path: x, worktrees_root: x, base_branch: null, use_worktrees: false };
    const project = db.insert_project(s.db(), p);
    const newt = { profile_id: profile.id, project_id: project.id, kind: "task", title: "Fix the login", description: "", status: "in_progress", use_worktree: false };
    const t = JSON.parse(JSON.stringify(db.insert_task(s.db(), newt)));
    start(s);

    emit(s, withf(t, { status: "needs_attention", attention_reason: "Approve Bash?", running: true }));
    let got = await service.recv();
    let msg = JSON.parse(decrypt(ua, Buffer.alloc(16, 9), got.body).toString());
    const id = t.id;
    const want = { title: `WEB-${t.number} Fix the login`, body: "Needs attention: Approve Bash?", url: `/t/${id}`, tag: `h:${id}`, task_id: id, event: "attention" };
    assert.deepEqual(msg, want);
    const header = (k: string) => String(got.headers[k]);
    assert.deepEqual([header("content-encoding"), header("ttl"), header("urgency")], ["aes128gcm", "86400", "high"]);
    const pub = (await call(s, "GET", "/api/push"))[1].public_key;
    assert.ok(header("authorization").startsWith("vapid t=") && header("authorization").endsWith(`, k=${pub}`));
    assert.equal(header("topic").length, 32);
    // Noted once the push service has answered.
    const sent = async () => (await call(s, "GET", "/api/push"))[1].subscriptions.find((x: any) => x.id === sub.id).last_sent_at !== null;
    while (!(await sent())) await sleep(10);

    // A move the user made doesn't notify them; the agent's next one does.
    s.push.note_move("h", id, "ready_for_merge");
    emit(s, withf(t, { status: "ready_for_merge" }));
    emit(s, withf(t, { status: "done", resolution: "done" }));
    got = await service.recv();
    msg = JSON.parse(decrypt(ua, Buffer.alloc(16, 9), got.body).toString());
    assert.deepEqual([msg.body, msg.event], ["Done", "done"]);
    assert.equal(got.headers.urgency, "normal");
    await sleep(100);
    assert.equal(service.try_recv(), null, "the device that only wants reviews got one");
  } finally {
    service.close();
  }
});

test("a_move_the_user_makes_through_the_board_is_noted", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "work", [], null);
  const id = db.insert_task(s.db(), { profile_id: profile.id, project_id: null, kind: "task", title: "Scratch", description: "", status: "todo", use_worktree: false }).id;
  const key = `h:${id}`;
  assert.ok(!s.push.moved(key, "merge"));
  // The UI's requests for a host go through the hub's proxy.
  const [status, t] = await call(s, "PATCH", `/api/h/h/tasks/${id}`, { status: "ready_for_merge" });
  assert.equal(status, 200, JSON.stringify(t));
  assert.ok(s.push.moved(key, "merge"));
  assert.ok(!s.push.moved(key, "done"));
  // Other changes aren't moves.
  await call(s, "PATCH", `/api/h/h/tasks/${id}`, { title: "Renamed" });
  assert.ok(s.push.moved(key, "merge"));
});

test("ready_to_review_waits_to_see_that_it_stays_so", async () => {
  const s = testing.state();
  const service = await push_service({ code: 201 });
  try {
    const [ua, keys] = device();
    await call(s, "POST", "/api/push/subscriptions", { endpoint: service.url, keys });
    start(s);
    const working = withf(task("in_progress"), { running: true, id: "t2" });
    emit(s, working);
    // Its review starts straight after: nothing.
    emit(s, withf(working, { status: "in_review", running: false }));
    emit(s, withf(working, { status: "in_review", running: false, review: { state: "running" } }));
    // Then it passes, and stays passed.
    emit(s, withf(working, { status: "in_review", running: false, review: { state: "passed" } }));
    const started = Date.now();
    const { body } = await service.recv();
    assert.ok(Date.now() - started >= 4000);
    const msg = JSON.parse(decrypt(ua, Buffer.alloc(16, 9), body).toString());
    assert.equal(msg.body, "Ready to review: its review passed");
    assert.equal(service.try_recv(), null);
  } finally {
    service.close();
  }
});

test("a_subscription_its_push_service_has_dropped_is_deleted", async () => {
  const s = testing.state();
  const status = { code: 500 };
  const service = await push_service(status);
  try {
    const [, keys] = device();
    const [, sub] = await call(s, "POST", "/api/push/subscriptions", { endpoint: service.url, keys });
    const [code, err] = await call(s, "POST", `/api/push/subscriptions/${sub.id}/test`);
    assert.equal(code, 502);
    assert.ok(err.error.includes("500"), JSON.stringify(err));
    await service.recv();
    assert.ok((await call(s, "GET", "/api/push"))[1].subscriptions[0].last_error.includes("500"));

    status.code = 410;
    assert.equal((await call(s, "POST", `/api/push/subscriptions/${sub.id}/test`))[0], 502);
    assert.deepEqual((await call(s, "GET", "/api/push"))[1].subscriptions, []);
  } finally {
    service.close();
  }
});

// ---------- the assistant's replies and its routines' reports (HA-122, HA-162, ported by HA-205) ----------

/** Subscribes a device at `endpoint` with `events`; its key, to read what it's sent. */
async function subscribe_device(s: AppState, endpoint: string, events: any): Promise<ECDH> {
  const [ua, keys] = device();
  const [status, sub] = await call(s, "POST", "/api/push/subscriptions", { endpoint, keys, events });
  assert.equal(status, 200, JSON.stringify(sub));
  return ua;
}

/** The next push the service got, decrypted for device `ua`. */
async function next_push(service: Awaited<ReturnType<typeof push_service>>, ua: ECDH): Promise<any> {
  const { body } = await service.recv();
  return JSON.parse(decrypt(ua, Buffer.alloc(16, 9), body).toString());
}

test("a_routines_report_is_pushed_once_to_the_devices_that_want_reports", async () => {
  const s = testing.state();
  const service = await push_service({ code: 201 });
  try {
    // Reports are on unless a device turns them off.
    const ua = await subscribe_device(s, service.url, { attention: false, review: false, merge: false, done: false });
    await subscribe_device(s, `${service.url}-quiet`, { attention: false, review: false, merge: false, done: false, reports: false });
    const profile = db.insert_profile(s.db(), "personal", [], null);
    const mine = assistant.get_or_create(s, profile.id);
    hub.start(s);
    start(s);
    const report = (outcome: string, text: string) => ({ automation: "Morning brief", task_id: "t", key: "A-2", outcome, text });
    s.add_message(mine.id, "report", report("reported", "## Today\n\n**Dentist at 9:30**; two mails need you.\nMore lines"));
    const msg = await next_push(service, ua);
    assert.deepEqual([msg.title, msg.body, msg.event], ["Morning brief", "Today", "report"], JSON.stringify(msg));
    // Tapping it opens the routine's thread, not the assistant's.
    assert.deepEqual([msg.url, msg.task_id], ["/t/t", "t"]);
    assert.notEqual(mine.id, "t");
    s.add_message(mine.id, "report", report("failed", "Out of usage"));
    assert.equal((await next_push(service, ua)).body, "Failed: Out of usage");
    // One waiting on the user is pushed as its attention, not again here; other messages aren't reports.
    s.add_message(mine.id, "report", report("asked", "Which calendar?"));
    s.add_message(mine.id, "user", { text: "hi" });
    await sleep(200);
    assert.equal(service.try_recv(), null, "pushed what it shouldn't have");
  } finally {
    service.close();
  }
});

test("a_reports_notification_says_its_first_line", () => {
  const d = (outcome: string, text: string) => ({ automation: "Inbox", outcome, text });
  assert.deepEqual(report_text(d("reported", "\n\n- Two mails from the bank\nmore")), ["Inbox", "Two mails from the bank"]);
  assert.equal(report_text(d("reported", ""))![1], "Posted a report");
  assert.equal(Array.from(report_text(d("reported", "x".repeat(300)))![1]).length, 200);
  assert.equal(report_text(d("asked", "x")), null);
  assert.equal(report_text({ outcome: "reported", text: "x" })![0], "A routine");
});

// HA-162: the assistant's replies are pushed to the devices that choose them (only "Replied", not what it said), and
// not for a reply that went back to Telegram.
test("the_assistants_replies_are_pushed_to_the_devices_that_want_them", async () => {
  const s = testing.state();
  const service = await push_service({ code: 201 });
  try {
    const ua = await subscribe_device(s, service.url, { attention: false, review: false, merge: false, done: false, replies: true, reports: false });
    // A device that never chose replies isn't sent them.
    await subscribe_device(s, `${service.url}-quiet`, { attention: false, review: false, merge: false, done: false, reports: false });
    const profile = db.insert_profile(s.db(), "personal", [], null);
    const mine = assistant.get_or_create(s, profile.id);
    hub.start(s);
    start(s);
    s.emit({ type: REPLY_EVENT, task_id: mine.id, profile_id: profile.id, message_id: 1, telegram: true });
    s.emit({ type: REPLY_EVENT, task_id: mine.id, profile_id: profile.id, message_id: 2, telegram: false });
    const msg = await next_push(service, ua);
    assert.deepEqual(msg, {
      title: `A-${mine.number} Assistant`,
      body: "Replied",
      url: `/t/${mine.id}`,
      tag: `${s.host_id}:${mine.id}:reply`,
      task_id: mine.id,
      event: "reply",
    });
    // Not for another task, which isn't the assistant.
    s.emit({ type: REPLY_EVENT, task_id: "nope", profile_id: profile.id, message_id: 3, telegram: false });
    await sleep(200);
    assert.equal(service.try_recv(), null, "pushed what it shouldn't have");
  } finally {
    service.close();
  }
});

// HA-162: a page from before an event was added sends the others without it, which mustn't turn it off; a subscription
// stored before reports could be chosen reads them as off.
test("events_left_out_keep_what_they_were", async () => {
  const s = testing.state();
  const [, keys] = device();
  const [, sub] = await call(s, "POST", "/api/push/subscriptions", { endpoint: "https://push.example.com/a", keys, events: { merge: true } });
  assert.deepEqual(sub.events, { attention: true, review: true, merge: true, done: false, replies: false, reports: true });
  const [, on] = await call(s, "PATCH", `/api/push/subscriptions/${sub.id}`, { events: { replies: true, reports: false } });
  assert.deepEqual([on.events.replies, on.events.reports, on.events.merge], [true, false, true]);
  const [, kept] = await call(s, "PATCH", `/api/push/subscriptions/${sub.id}`, { events: { attention: false, review: true, merge: false, done: false } });
  assert.deepEqual(kept.events, { attention: false, review: true, merge: false, done: false, replies: true, reports: false });
  // Subscribed again (the same endpoint) without events, it keeps them.
  const [, again] = await call(s, "POST", "/api/push/subscriptions", { endpoint: "https://push.example.com/a", keys });
  assert.deepEqual(again.events, kept.events);
  assert.equal((await call(s, "PATCH", `/api/push/subscriptions/${sub.id}`, { events: { replies: "yes" } }))[0], 400);
  assert.equal((await call(s, "PATCH", `/api/push/subscriptions/${sub.id}`, { events: [true] }))[0], 400);
  // One stored before (with HA-8's events only) gets neither replies nor reports.
  db.run(s.db(), "UPDATE push_subscriptions SET events=?1 WHERE id=?2", JSON.stringify({ attention: true, review: true, merge: false, done: false }), sub.id);
  const [, info] = await call(s, "GET", "/api/push");
  assert.deepEqual(info.subscriptions[0].events, { attention: true, review: true, merge: false, done: false, replies: false, reports: false });
});
