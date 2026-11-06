// The helpers of server/src/integrations/push/tests.rs that its expo_tests.rs uses too (`pub(super)` there): a push
// service on this machine, a browser's keys and what it reads of a push, the board's API, and prompts raised from a task.
// The tests are in tests.test.ts and expo_tests.test.ts.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, type ECDH } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import * as db from "../../db.ts";
import * as api from "../../api.ts";
import type { AppState } from "../../state.ts";
import { sleep } from "../../util.ts";
import * as permissions from "../../mcp/permissions.ts";
import * as push_answers from "../push_answers.ts";
import { new_id } from "../../util.ts";
import { RECORD_SIZE, content_keys, ecdh } from "../push.ts";

export const enc = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A device's key (as its browser makes one). */
export function device_key(): ECDH {
  const k = createECDH("prime256v1");
  k.generateKeys();
  return k;
}

/** What a browser does with a push it gets (RFC 8291 section 3.4, the other way round). */
export function decrypt(ua: ECDH, auth: Uint8Array, body: Buffer): Buffer {
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

export function task(status: string): any {
  return { id: "t1", kind: "task", number: 3, title: "Fix the login", status, running: false, review: null, attention_reason: null };
}

export const withf = (t: any, fields: any) => ({ ...t, ...fields });

export interface Got {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A push service on this machine: it takes what's posted to it, answering with `status.code`. */
export async function push_service(status: { code: number }) {
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

export async function call(s: AppState, method: string, path: string, body: any = null): Promise<[number, any]> {
  if (!s.local_router) api.router(s);
  const raw = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const a = await api.dispatch(s, api.makeReq(method, path, { authorization: "Bearer ", "content-type": "application/json" }, raw));
  let v: any = null;
  try {
    v = JSON.parse(a.body.toString());
  } catch {}
  return [a.status, v];
}

export function device(): [ECDH, any] {
  const ua = device_key();
  return [ua, { p256dh: enc(ua.getPublicKey()), auth: enc(Buffer.alloc(16, 9)) }];
}

/** The board's task event for task `t` on this host. */
export function emit(s: AppState, t: any) {
  s.hub_events.send({ type: "task", task: t, host_id: s.host_id });
}

/** Subscribes a device at `endpoint` with `events`; its key, to read what it's sent. */
export async function subscribe_device(s: AppState, endpoint: string, events: any): Promise<ECDH> {
  const [ua, keys] = device();
  const [status, sub] = await call(s, "POST", "/api/push/subscriptions", { endpoint, keys, events });
  assert.equal(status, 200, JSON.stringify(sub));
  return ua;
}

/** The next push the service got, decrypted for device `ua`. */
export async function next_push(service: Awaited<ReturnType<typeof push_service>>, ua: ECDH): Promise<any> {
  const { body } = await service.recv();
  return JSON.parse(decrypt(ua, Buffer.alloc(16, 9), body).toString());
}

/** A task with a run going (so it can raise prompts), of `task_type` if given. */
export function running_task(s: AppState, task_type: string | null): db.Task {
  const profile = db.insert_profile(s.db(), `p${new_id()}`, [], null);
  const task = db.insert_task(s.db(), {
    profile_id: profile.id,
    project_id: null,
    kind: "task",
    title: "Send the invoice",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  if (task_type !== null) db.run(s.db(), "UPDATE tasks SET task_type=?1 WHERE id=?2", task_type, task.id);
  const run = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.runs.set(task.id, { run_id: run.id, cancel: null });
  return s.update_task(task.id, [["running", true]])!;
}

/** Raises a prompt for `tool` from `task` and waits until it's asked: its request id, and what the agent is told. */
export async function raise(s: AppState, task: db.Task, call: string, tool: string, input: any): Promise<[string, Promise<any>]> {
  const told = permissions.prompt(s, task, call, tool, input, null);
  told.catch(() => {});
  for (;;) {
    const id = db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id=?1", call);
    if (id !== undefined) return [id, told];
    await sleep(5);
  }
}

export async function answer_from_push(s: AppState, request: string, token: string, decision: string): Promise<[number, any]> {
  if (!s.local_router) api.router(s);
  const raw = Buffer.from(JSON.stringify({ token, decision }));
  // Without the board's token.
  const a = await api.dispatch(s, api.makeReq("POST", `/api/permissions/${request}/push-answer`, { "content-type": "application/json" }, raw));
  let v: any = null;
  try {
    v = JSON.parse(a.body.toString());
  } catch {}
  return [a.status, v];
}

/** Waits until the board has noted prompt `request`'s tokens as `status`. */
export async function settled_as(s: AppState, request: string, status: string) {
  for (let i = 0; i < 500; i++) {
    if (push_answers.status_of(s.db(), request) === status) return;
    await sleep(10);
  }
  assert.fail(`prompt ${request}'s tokens never became ${status}`);
}
