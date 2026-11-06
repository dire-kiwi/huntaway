// Port of server/src/integrations/push/expo_tests.rs (HA-137, from the HA-117 branch at bb59d8a; ported by HA-209): the
// mobile app's push, through a fake of Expo's push service.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as testing from "../../testing.ts";
import * as db from "../../db.ts";
import * as api from "../../api.ts";
import * as hub from "../../hosts/hub.ts";
import type { AppState } from "../../state.ts";
import { sleep } from "../../util.ts";
import * as assistant from "../../agent/assistant.ts";
import { check_receipts, list, noted, RECEIPT_AFTER, send_all, start, type Message, type Subscription } from "../push.ts";
import { answer_from_push, call as api_call, device, emit, next_push, push_service, raise, running_task, subscribe_device, task, withf } from "./testing.ts";

const cleanups: Array<() => void> = [];
after(() => {
  for (const f of cleanups.splice(0)) f();
});

/** What one side of the fake Expo was posted, in order: `recv` waits for the next, `try_recv` takes one if there is. */
function channel() {
  const got: any[] = [];
  const waiting: Array<(v: any) => void> = [];
  return {
    push(v: any) {
      const w = waiting.shift();
      if (w) w(v);
      else got.push(v);
    },
    recv(): Promise<any> {
      if (got.length) return Promise.resolve(got.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("nothing was sent to Expo")), 10_000);
        waiting.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
    },
    try_recv: () => got.shift() ?? null,
  };
}

/**
 * Expo's push service on this machine. Each message is taken (its ticket's id is `ticket:<token>`) unless its token says
 * otherwise: `Gone` isn't registered, `Slow` is over its rate. Receipts are what the test puts in `receipts`, and `status`
 * is what it answers with (200, or a failure).
 */
async function expo() {
  const sent = channel();
  const asked = channel();
  const fake = { url: "", sent, asked, receipts: {} as Record<string, any>, status: 200 };
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const answer = (code: number, v: any) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.url === "/--/api/v2/push/send") {
        sent.push(body);
        if (fake.status < 200 || fake.status >= 300) return answer(fake.status, { errors: [{ code: "INTERNAL", message: "Expo is down" }] });
        const tickets = body.map((m: any) => {
          const to: string = m.to;
          if (to.includes("Gone")) {
            return { status: "error", message: `"${to}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } };
          }
          if (to.includes("Slow")) return { status: "error", message: "too many", details: { error: "MessageRateExceeded" } };
          return { status: "ok", id: `ticket:${to}` };
        });
        return answer(fake.status, { data: tickets });
      }
      if (req.url === "/--/api/v2/push/getReceipts") {
        asked.push(body);
        const data: Record<string, any> = {};
        for (const id of body.ids) if (fake.receipts[id] !== undefined) data[id] = fake.receipts[id];
        return answer(fake.status, { data });
      }
      answer(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(srv.address() as any).port}/--/api/v2/push/send`;
  cleanups.push(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return fake;
}

const token = (name: string) => `ExponentPushToken[${name}]`;

/** Subscribes the app (with the board's token) for `events`. */
async function subscribe_app(s: AppState, t: string, events: any): Promise<any> {
  const [status, sub] = await api_call(s, "POST", "/api/push/subscriptions", { kind: "expo", endpoint: t, name: "Pixel", events });
  assert.equal(status, 200, JSON.stringify(sub));
  return sub;
}

const subscriptions = (s: AppState): Subscription[] => list(s.db());

const sub_for = (s: AppState, t: string) => subscriptions(s).find((x) => x.endpoint === t);

/** A task in project WEB, as the board shows it. */
function project_task(s: AppState): any {
  const profile = db.insert_profile(s.db(), "work", [], null);
  const x = "/x";
  const p = { id: "p1", profile_id: profile.id, name: "Web", key: "WEB", repo_path: x, scratch_path: x, worktrees_root: x, base_branch: null, use_worktrees: false };
  const project = db.insert_project(s.db(), p);
  const newt = { profile_id: profile.id, project_id: project.id, kind: "task", title: "Fix the login", description: "", status: "in_progress", use_worktree: false };
  return JSON.parse(JSON.stringify(db.insert_task(s.db(), newt)));
}

test("the_app_subscribes_with_its_expo_token_and_is_pushed_through_expo", async () => {
  const s = testing.state();
  const fake = await expo();
  s.push.expo_url = fake.url;
  const phone = token("phone-1");
  const sub = await subscribe_app(s, phone, { attention: true, review: false, merge: false, done: false });
  assert.deepEqual([sub.kind, sub.endpoint, sub.device_id], ["expo", phone, null]);
  // Its token, not a URL or keys; and a browser's subscription still needs its keys.
  for (const bad of ["https://exp.host/x", "ExponentPushToken[]", "ExponentPushToken[a b]", "ExponentPushToken[abc", "phone"]) {
    const [status, err] = await api_call(s, "POST", "/api/push/subscriptions", { kind: "expo", endpoint: bad });
    assert.equal(status, 400, `${bad}: ${JSON.stringify(err)}`);
  }
  assert.equal((await api_call(s, "POST", "/api/push/subscriptions", { endpoint: "https://push.example.com/x" }))[0], 400);
  assert.equal((await api_call(s, "POST", "/api/push/subscriptions", { kind: "carrier-pigeon", endpoint: phone }))[0], 422);
  // The same token again is the same subscription; as a browser's, it's refused.
  const again = await subscribe_app(s, phone, { attention: true, review: false, merge: true, done: false });
  assert.deepEqual([again.id, again.events.merge], [sub.id, true]);
  const [, keys] = device();
  assert.equal((await api_call(s, "POST", "/api/push/subscriptions", { endpoint: "https://push.example.com/y", keys }))[0], 200);
  assert.equal((await api_call(s, "POST", "/api/push/subscriptions", { kind: "expo", endpoint: "https://push.example.com/y" }))[0], 400);
  db.run(s.db(), "DELETE FROM push_subscriptions WHERE endpoint='https://push.example.com/y'");
  // A browser wants the same events.
  const web = await push_service({ code: 201 });
  cleanups.push(web.close);
  const ua = await subscribe_device(s, web.url, { attention: true });

  const t = project_task(s);
  start(s);
  emit(s, withf(t, { status: "needs_attention", attention_reason: "It printed the database password", running: true }));
  const sent = await fake.sent.recv();
  const id = t.id;
  assert.equal(sent.length, 1, JSON.stringify(sent));
  const m = sent[0];
  const collapse: string = m.collapseId;
  assert.equal(collapse.length, 32);
  assert.deepEqual(m, {
    to: phone,
    title: `WEB-${t.number} Fix the login`,
    // Expo can read it: not the reason, which can quote the agent.
    body: "Needs attention",
    data: { board: "h", host: "h", task_id: id, url: `/t/${id}`, tag: `h:${id}`, event: "attention" },
    ttl: 86400,
    priority: "high",
    sound: "default",
    channelId: "default",
    collapseId: collapse,
    tag: collapse,
  });
  // The browser's is encrypted for it, with the reason; each kind gets only its own.
  assert.equal((await next_push(web, ua)).body, "Needs attention: It printed the database password");
  await sleep(200);
  assert.ok(fake.sent.try_recv() === null && web.try_recv() === null);
  const phone_sub = sub_for(s, phone)!;
  assert.ok(phone_sub.last_sent_at !== null && phone_sub.last_error === null);
  assert.deepEqual(s.push.tickets.map((x) => x.id), [`ticket:${phone}`]);

  // A test from Settings goes through Expo too.
  const [status, v] = await api_call(s, "POST", `/api/push/subscriptions/${sub.id}/test`);
  assert.equal(status, 200, JSON.stringify(v));
  assert.equal((await fake.sent.recv())[0].body, "Push notifications work on this device.");
});

test("pushes_to_many_phones_go_to_expo_in_batches_of_100", async () => {
  const s = testing.state();
  const fake = await expo();
  s.push.expo_url = fake.url;
  for (let i = 0; i < 150; i++) await subscribe_app(s, token(`p${i}`), { attention: true });
  start(s);
  emit(s, withf(task("needs_attention"), { running: true }));
  // (The first sight of a task notifies of nothing: it's the board's baseline.)
  emit(s, withf(task("in_progress"), { running: true }));
  emit(s, withf(task("needs_attention"), { running: true }));
  const [a, b] = [await fake.sent.recv(), await fake.sent.recv()];
  assert.deepEqual([a.length, b.length], [100, 50]);
  assert.equal(new Set([...a, ...b].map((m: any) => m.to)).size, 150);
});

/** A message pushed to every subscription, as a test from each would be. */
async function test_all(s: AppState) {
  const msg: Message = { title: "t", body: "b", url: "/", tag: "x" };
  await send_all(s, subscriptions(s), msg, false);
}

test("tickets_and_receipts_drop_unregistered_phones_and_note_other_failures", async () => {
  const s = testing.state();
  const fake = await expo();
  s.push.expo_url = fake.url;
  for (const n of ["ok1", "ok2", "ok3", "Gone", "Slow"]) await subscribe_app(s, token(n), { attention: true });
  await test_all(s);
  assert.equal((await fake.sent.recv()).length, 5);
  // Its ticket says one isn't registered (the app was uninstalled): it's dropped. Another failed, and says why.
  assert.equal(sub_for(s, token("Gone")), undefined);
  const slow = sub_for(s, token("Slow"))!;
  assert.ok(slow.last_error!.includes("MessageRateExceeded"), JSON.stringify(slow));
  assert.equal(s.push.tickets.length, 3);

  // Receipts aren't asked for until they're due.
  await check_receipts(s, RECEIPT_AFTER);
  assert.equal(fake.asked.try_recv(), null);
  assert.equal(s.push.tickets.length, 3);

  // Apple or Google turned one down as unregistered, and another as too big; the third's isn't ready yet.
  fake.receipts = {
    [`ticket:${token("ok1")}`]: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    [`ticket:${token("ok2")}`]: { status: "error", message: "too big", details: { error: "MessageTooBig" } },
  };
  await check_receipts(s, 0);
  const ids = [...(await fake.asked.recv()).ids].sort();
  assert.deepEqual(ids, ["ok1", "ok2", "ok3"].map((n) => `ticket:${token(n)}`));
  assert.equal(sub_for(s, token("ok1")), undefined);
  assert.ok(sub_for(s, token("ok2"))!.last_error!.includes("MessageTooBig"));
  assert.equal(sub_for(s, token("ok3"))!.last_error, null);
  // Asked for again next time.
  assert.deepEqual(s.push.tickets.map((t) => t.id), [`ticket:${token("ok3")}`]);
  fake.receipts = { [`ticket:${token("ok3")}`]: { status: "ok" } };
  await check_receipts(s, 0);
  await fake.asked.recv();
  assert.deepEqual(s.push.tickets, []);
  assert.equal(sub_for(s, token("ok3"))!.last_error, null);

  // Expo itself failing: each push notes why, and the receipts are kept for later.
  fake.status = 503;
  await test_all(s);
  await fake.sent.recv();
  for (const n of ["ok2", "ok3"]) {
    const e = sub_for(s, token(n))!.last_error!;
    assert.ok(e.includes("503") && e.includes("Expo is down"), e);
  }
  fake.status = 200;
  await test_all(s);
  await fake.sent.recv();
  assert.equal(sub_for(s, token("ok3"))!.last_error, null);
  fake.status = 500;
  await check_receipts(s, 0);
  await fake.asked.recv();
  assert.equal(s.push.tickets.length, 2);
});

test("a_prompt_reaches_the_app_with_allow_and_deny_but_not_the_tools_input", async () => {
  const s = testing.state();
  const fake = await expo();
  s.push.expo_url = fake.url;
  await subscribe_app(s, token("phone"), { attention: true, prompts: "all" });
  hub.start(s);
  start(s);
  const t = running_task(s, null);
  const [request, told] = await raise(s, t, "c1", "Bash", { command: "cat ~/.ssh/id_ed25519" });
  const sent = await fake.sent.recv();
  const m = sent[0];
  assert.ok(!JSON.stringify(sent).includes("id_ed25519"), JSON.stringify(sent));
  assert.deepEqual([m.body, m.categoryId, m.channelId], ["Approve Bash?", "prompt", "prompts"]);
  assert.deepEqual([m.data.event, m.data.request_id, m.data.task_id, m.data.host], ["prompt", request, t.id, "h"]);
  assert.equal(m.data.answer.url, `/api/permissions/${request}/push-answer`);
  // Not told again that it needs attention: the prompt is the notification.
  await sleep(300);
  assert.equal(fake.sent.try_recv(), null);
  const answer_token: string = m.data.answer.token;
  let [status, v] = await answer_from_push(s, request, answer_token, "allow");
  assert.deepEqual([status, v.result], [200, "allowed"], JSON.stringify(v));
  assert.equal((await told).behavior, "allow");
  [status, v] = await answer_from_push(s, request, answer_token, "deny");
  assert.deepEqual([status, v.result, v.message], [409, "answered", "It was already allowed."]);

  // A question opens the app instead: no category for Allow and Deny.
  await raise(s, t, "c2", "AskUserQuestion", { questions: [] });
  const q = (await fake.sent.recv())[0];
  assert.ok(!("categoryId" in q) && !("answer" in q.data), JSON.stringify(q));
});

// ---------- paired devices ----------

const BOARD = "board-token";

function board(): AppState {
  const s = testing.state_as({ host_id: "h", host_name: "desktop", token: BOARD, hub_token: "", internal_url: "" });
  api.router(s);
  return s;
}

/** Status and JSON body of a request to `s`'s API with `token` as its bearer token (none for ""). */
async function call(s: AppState, method: string, path: string, t: string, body: any = null): Promise<[number, any]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (t) headers.authorization = `Bearer ${t}`;
  const a = await api.dispatch(s, api.makeReq(method, path, headers, body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))));
  try {
    return [a.status, JSON.parse(a.body.toString())];
  } catch {
    return [a.status, null];
  }
}

/** Pairs a device: its token and id. */
async function pair(s: AppState, name: string): Promise<[string, string]> {
  const [, code] = await call(s, "POST", "/api/devices/pairing", BOARD, {});
  const [status, paired] = await call(s, "POST", "/api/devices/pair", "", { code: code.code, name });
  assert.equal(status, 200, JSON.stringify(paired));
  return [paired.token, paired.device.id];
}

test("a_paired_phone_has_only_its_own_subscriptions_which_go_when_its_revoked", async () => {
  const s = board();
  const [phone, phone_id] = await pair(s, "phone");
  const [tablet, tablet_id] = await pair(s, "tablet");
  // Only the app's kind, from a device.
  const [, keys] = device();
  const [status, err] = await call(s, "POST", "/api/push/subscriptions", phone, { endpoint: "https://push.example.com/x", keys });
  assert.equal(status, 403, JSON.stringify(err));
  const [st, mine] = await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("phone"), name: "phone" });
  assert.deepEqual([st, mine.device_id], [200, phone_id], JSON.stringify(mine));
  const [, theirs] = await call(s, "POST", "/api/push/subscriptions", tablet, { kind: "expo", endpoint: token("tablet") });
  assert.equal(theirs.device_id, tablet_id);

  // It sees and changes its own; the board sees them all.
  const [ls, l] = await call(s, "GET", "/api/push", phone);
  assert.equal(ls, 200);
  assert.deepEqual(l.subscriptions.map((x: any) => x.id), [mine.id]);
  assert.equal((await call(s, "GET", "/api/push", BOARD))[1].subscriptions.length, 2);
  const events = { events: { attention: false, review: true, merge: true, done: true, prompts: "all" } };
  const [cs, changed] = await call(s, "PATCH", `/api/push/subscriptions/${mine.id}`, phone, events);
  assert.deepEqual([cs, changed.events.prompts], [200, "all"]);
  for (const [m, p] of [["PATCH", `/api/push/subscriptions/${theirs.id}`], ["DELETE", `/api/push/subscriptions/${theirs.id}`], ["POST", `/api/push/subscriptions/${theirs.id}/test`]]) {
    assert.equal((await call(s, m, p, phone, events))[0], 404, `${m} ${p}`);
  }
  assert.equal(subscriptions(s).length, 2);
  // Not a host's route.
  assert.equal((await call(s, "GET", "/api/h/h/push", phone))[0], 403);
  // The answer from a notification needs no token, but a device's doesn't keep it from getting there.
  const [as, v] = await call(s, "POST", "/api/permissions/r1/push-answer", phone, { token: "x", decision: "allow" });
  assert.deepEqual([as, v.result], [403, "invalid"], JSON.stringify(v));

  // Re-registering the same token from another pairing of the phone takes it over.
  const [again, again_id] = await pair(s, "phone again");
  const [, took] = await call(s, "POST", "/api/push/subscriptions", again, { kind: "expo", endpoint: token("phone") });
  assert.deepEqual([took.id, took.device_id, took.events.prompts], [mine.id, again_id, "all"]);
  assert.deepEqual((await call(s, "GET", "/api/push", phone))[1].subscriptions, []);

  // Revoking a device drops its subscriptions, and only its.
  assert.equal((await call(s, "DELETE", `/api/devices/${again_id}`, BOARD))[0], 200);
  assert.deepEqual(subscriptions(s).map((x) => x.id), [theirs.id]);
  // A device can unsubscribe itself.
  assert.equal((await call(s, "DELETE", `/api/push/subscriptions/${theirs.id}`, tablet))[0], 200);
  assert.deepEqual(subscriptions(s), []);
});

test("a_move_made_from_the_phone_isnt_pushed_to_it", async () => {
  const s = board();
  const fake = await expo();
  s.push.expo_url = fake.url;
  const [phone] = await pair(s, "phone");
  const events = { attention: true, review: true, merge: true, done: true };
  assert.equal((await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("phone"), events }))[0], 200);
  const t = project_task(s);
  hub.start(s);
  start(s);
  // The app moves tasks through the hub's proxy, as the web board does.
  const [status, moved] = await call(s, "PATCH", `/api/h/h/tasks/${t.id}`, phone, { status: "done" });
  assert.deepEqual([status, moved.status], [200, "done"], JSON.stringify(moved));
  await sleep(300);
  assert.equal(fake.sent.try_recv(), null, "the phone's own move was pushed to it");
  // What happens next, not of its doing, is.
  s.update_task(t.id, [["status", "needs_attention"], ["attention_reason", "Merge failed"]]);
  const m = (await fake.sent.recv())[0];
  assert.deepEqual([m.data.event, m.body], ["attention", "Needs attention"]);
});

test("a_new_token_for_the_same_phone_keeps_its_subscription_and_events", async () => {
  const s = board();
  const [phone, phone_id] = await pair(s, "phone");
  const quiet = { attention: false, review: false, merge: false, done: false, prompts: "off", replies: false, reports: true };
  const [, first] = await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("old"), name: "phone", events: quiet });
  // Expo's token rotated: the app subscribes again with the new one, and no events (it keeps what's there).
  const [status, next] = await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("new"), name: "phone" });
  assert.equal(status, 200, JSON.stringify(next));
  assert.deepEqual([next.id, next.endpoint, next.events], [first.id, token("new"), quiet]);
  const all = subscriptions(s);
  assert.deepEqual([all.length, all[0].device_id], [1, phone_id]);
  // Another phone's subscription is left alone, and a phone that had two (from before) is left with the one.
  const [tablet] = await pair(s, "tablet");
  await call(s, "POST", "/api/push/subscriptions", tablet, { kind: "expo", endpoint: token("tablet") });
  db.run(
    s.db(),
    "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at,kind,device_id) VALUES ('x',?1,'','','{}','0','expo',?2)",
    token("stale"),
    phone_id,
  );
  await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("new") });
  assert.deepEqual(subscriptions(s).map((x) => x.endpoint).sort(), [token("new"), token("tablet")]);
});

test("what_expo_says_of_an_old_token_doesnt_touch_the_new_one", async () => {
  const s = board();
  const fake = await expo();
  s.push.expo_url = fake.url;
  const [phone] = await pair(s, "phone");
  const picked = { attention: true, review: false, merge: true, done: false, prompts: "all", replies: false, reports: true };
  const [, sub] = await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("A"), events: picked });
  // A push to A is taken...
  assert.equal((await call(s, "POST", `/api/push/subscriptions/${sub.id}/test`, BOARD))[0], 200);
  await fake.sent.recv();
  // ...the phone's token becomes B...
  const [, moved] = await call(s, "POST", "/api/push/subscriptions", phone, { kind: "expo", endpoint: token("B") });
  assert.deepEqual([moved.id, moved.endpoint], [sub.id, token("B")]);
  // ...and then A's receipt says it isn't registered, or failed.
  fake.receipts = { [`ticket:${token("A")}`]: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } };
  await check_receipts(s, 0);
  await fake.asked.recv();
  const now = sub_for(s, token("B"));
  assert.ok(now, "the new token's subscription was deleted");
  assert.deepEqual([now.events, now.last_error], [picked, null]);
  // A send to A that answers after the change is about A too.
  const old = { ...now, endpoint: token("A") };
  noted(s, old, { gone: false, error: "too late" });
  noted(s, old, { gone: true, error: "too late" });
  assert.equal(sub_for(s, token("B"))?.last_error, null);
});

// HA-125: a routine's report reaches the app as well, without its text, which can quote mail, as Expo can read it.
test("a_routines_report_reaches_the_app_without_what_it_says", async () => {
  const s = testing.state();
  const fake = await expo();
  s.push.expo_url = fake.url;
  await subscribe_app(s, token("phone"), { attention: false, review: false, merge: false, done: false });
  const profile = db.insert_profile(s.db(), "personal", [], null);
  const mine = assistant.get_or_create(s, profile.id);
  hub.start(s);
  start(s);
  s.add_message(mine.id, "report", { automation: "Morning brief", outcome: "reported", text: "Kim's invoice 4411 for $1,250 is overdue" });
  let sent = await fake.sent.recv();
  let m = sent[0];
  assert.ok(!JSON.stringify(sent).includes("invoice"), JSON.stringify(sent));
  assert.deepEqual([m.title, m.body, m.data.event], ["Morning brief", "Posted a report", "report"], JSON.stringify(m));
  assert.deepEqual([m.data.task_id, m.data.host], [mine.id, s.host_id]);
  // A failed one says only that.
  s.add_message(mine.id, "report", { automation: "Morning brief", outcome: "failed", text: "Couldn't read kim@example.com's mail" });
  sent = await fake.sent.recv();
  m = sent[0];
  assert.ok(!JSON.stringify(sent).includes("kim@"), JSON.stringify(sent));
  assert.equal(m.body, "A routine failed");
});

// HA-209: the assistant's replies (HA-162) reach the app with what the app needs to open the Assistant tab on them: the
// board, the host and the assistant's task.
test("a_reply_reaches_the_app_with_its_board_host_and_task", async () => {
  const s = testing.state();
  const fake = await expo();
  s.push.expo_url = fake.url;
  await subscribe_app(s, token("phone"), { attention: false, review: false, merge: false, done: false, replies: true, reports: false });
  const profile = db.insert_profile(s.db(), "personal", [], null);
  const mine = assistant.get_or_create(s, profile.id);
  hub.start(s);
  start(s);
  s.emit({ type: "assistant_reply", task_id: mine.id, profile_id: profile.id, message_id: 2, telegram: false });
  const m = (await fake.sent.recv())[0];
  assert.deepEqual(m.data, { board: "h", host: "h", task_id: mine.id, url: `/t/${mine.id}`, tag: `h:${mine.id}:reply`, event: "reply" });
  assert.deepEqual([m.body, m.priority, m.channelId], ["Replied", "normal", "default"]);
});

// HA-209: migration 97's rows from before (no kind) are read as browsers' (see db/tests.test.ts for the migration).
test("a_subscription_from_before_kinds_is_web_push", () => {
  const s = testing.state();
  db.run(s.db(), "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,name,events,created_at) VALUES ('s','https://push.example.com/1','k','a','Chrome','{}','1')");
  const [sub] = subscriptions(s);
  assert.deepEqual([sub.kind, sub.device_id, sub.name], ["web", null, "Chrome"]);
});
