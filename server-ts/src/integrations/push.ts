// Port of server/src/integrations/push.rs: Web Push: the board's notifications (a task needs attention, is ready to
// review, and so on; the same events and words as the UI's, in app/src/notifications.ts) sent to the devices that turned
// push on in Settings → Notifications, such as a phone with the board installed on its home screen.
//
// Each device's browser gives a subscription (an endpoint at its push service, and keys), which is kept with the events
// it wants. This board watches the task events of every host on it (as the UI does), and sends each subscription the
// ones it wants, encrypted for it (RFC 8291) and signed with the board's VAPID key (RFC 8292), whose public half the
// browser subscribed with. Tapping one opens the task (app/public/sw.js).
//
// So are the assistant's routines' reports, as each is posted on its thread, and its replies, for the devices that choose
// them, as the assistant's host says its turn ended (`REPLY_EVENT`). A reply says only "Replied"; a report its first
// line.
//
// A permission prompt is pushed too (the assistant's, or any task's, as each device chooses), with a one-time token
// (push_answers.ts) for its Allow and Deny actions, which answer it from the notification without the board's token.
import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH, type KeyObject } from "node:crypto";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { background, err_str, new_id, now } from "../util.ts";
import * as hub from "../hosts/hub.ts";
import type { LinkConn } from "../hosts/hub.ts";
import * as permissions from "../mcp/permissions.ts";
import * as push_answers from "./push_answers.ts";

/** Where the board's VAPID private key is kept (in the settings table), made the first time it's needed. */
const KEY_SETTING = "vapid_private_key";

/**
 * Who runs the board, for push services to contact (RFC 8292's `sub`): `IA_PUSH_SUBJECT`, a `mailto:` or `https:`
 * URL. Apple's push service turns away a token without one.
 */
function subject(): string {
  const s = process.env.IA_PUSH_SUBJECT;
  return s && s.trim() ? s : "https://github.com/dire-kiwi/huntaway";
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** URL-safe base64 without padding, strictly (as Rust's `URL_SAFE_NO_PAD`). */
function unb64(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  return Buffer.from(s, "base64url");
}

// ---------- keys ----------

/** The board's VAPID key pair: subscriptions are made for its public key, and pushes signed with it. */
export class Vapid {
  key: KeyObject;
  /** The public key, an uncompressed point (65 bytes), as browsers take it (`applicationServerKey`). */
  public: Buffer;

  constructor(key: KeyObject, pub: Buffer) {
    this.key = key;
    this.public = pub;
  }

  /** From its private key, a P-256 scalar (32 bytes). */
  static from_private(priv: Buffer): Vapid {
    let pub: Buffer;
    try {
      const e = createECDH("prime256v1");
      e.setPrivateKey(priv);
      pub = e.getPublicKey();
    } catch {
      throw new Error("not a P-256 private key");
    }
    const jwk = { kty: "EC", crv: "P-256", d: b64(priv), x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) };
    return new Vapid(createPrivateKey({ key: jwk, format: "jwk" }), pub);
  }

  public_key(): string {
    return b64(this.public);
  }
}

/** A P-256 key's private scalar, 32 bytes (node leaves out leading zeros). */
function scalar(e: ECDH): Buffer {
  const k = e.getPrivateKey();
  return k.length >= 32 ? k : Buffer.concat([Buffer.alloc(32 - k.length), k]);
}

/** The board's VAPID key, made and stored the first time. */
export function vapid(c: Conn): Vapid {
  const saved = db.get_setting(c, KEY_SETTING);
  if (saved !== null) {
    const priv = unb64(saved.trim());
    try {
      if (!priv) throw new Error("not base64");
      return Vapid.from_private(priv);
    } catch (e) {
      throw new Error("reading the VAPID key", { cause: e });
    }
  }
  const e = createECDH("prime256v1");
  e.generateKeys();
  const priv = scalar(e);
  db.set_setting(c, KEY_SETTING, b64(priv));
  return Vapid.from_private(priv);
}

// ---------- encryption (RFC 8291) ----------

/** The size of the one record a push message is (RFC 8188's `rs`), which is at most 4096. */
export const RECORD_SIZE = 4096;

/**
 * `plaintext` encrypted for a subscription, with its public key (`p256dh`, an uncompressed point) and its
 * authentication secret: the body of the push request (`Content-Encoding: aes128gcm`).
 */
export function encrypt(ua_public: Uint8Array, auth: Uint8Array, plaintext: Uint8Array): Buffer {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return encrypt_with(key, randomBytes(16), ua_public, auth, plaintext);
}

/** HKDF-SHA-256: `len` bytes from `ikm` with `salt` and `info`. */
function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, len));
}

/** The ECDH secret of `key` and the public key `peer`, if it's one. */
export function ecdh(key: ECDH, peer: Uint8Array): Buffer {
  try {
    return key.computeSecret(peer);
  } catch {
    throw new Error("the subscription's key isn't a P-256 public key");
  }
}

/** The content encryption key and nonce of a message with `salt`, for the subscription's key and auth secret. */
export function content_keys(secret: Uint8Array, auth: Uint8Array, ua_public: Uint8Array, as_public: Uint8Array, salt: Uint8Array): [Buffer, Buffer] {
  // IKM = HKDF(auth secret, ECDH secret, "WebPush: info" 0 ua_public as_public), then the key and nonce from the salt (RFC 8188).
  const key_info = Buffer.concat([Buffer.from("WebPush: info\0"), ua_public, as_public]);
  const ikm = hkdf(auth, secret, key_info, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  return [cek, nonce];
}

/** `encrypt` with the sender's (one-off) key and the salt given. */
export function encrypt_with(as_key: ECDH, salt: Uint8Array, ua_public: Uint8Array, auth: Uint8Array, plaintext: Uint8Array): Buffer {
  const as_public = as_key.getPublicKey();
  const [cek, nonce] = content_keys(ecdh(as_key, ua_public), auth, ua_public, as_public, salt);
  // One record, the last: the text and its padding delimiter (2), and no padding.
  if (plaintext.length + 1 + 16 > RECORD_SIZE - 86) throw new Error("the message is too long to push");
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  // salt, record size, the sender's public key as the key id, then the record.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([as_public.length]), as_public, sealed]);
}

// ---------- VAPID (RFC 8292) ----------

/**
 * The `Authorization` header for a push to `endpoint`: a token signed with the board's key, for the push service's
 * origin, valid for 12 hours from `now` (a Unix time).
 */
export function authorization(v: Vapid, endpoint: string, sub: string, now: number): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (e) {
    throw new Error("the endpoint isn't a URL", { cause: e });
  }
  const header = b64(Buffer.from('{"typ":"JWT","alg":"ES256"}'));
  const claims = b64(Buffer.from(JSON.stringify({ aud: url.origin, exp: now + 12 * 3600, sub })));
  const signed = `${header}.${claims}`;
  const sig = sign("sha256", Buffer.from(signed), { key: v.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signed}.${b64(sig)}, k=${v.public_key()}`;
}

// ---------- subscriptions ----------

/**
 * Which events a device gets: HA-8's (app/src/notifications.ts), with the same defaults, permission prompts, and the
 * assistant's replies and its routines' reports.
 */
export interface Events {
  attention: boolean;
  review: boolean;
  merge: boolean;
  done: boolean;
  /** Whose permission prompts it gets, with Allow and Deny (API 112). */
  prompts: Prompts;
  /** The assistant finished a reply. Off unless chosen, also for the subscriptions from before there was a choice. */
  replies: boolean;
  /**
   * The reports the assistant's routines post in its thread. On for a new subscription, unless it says otherwise; off for
   * one stored before it could choose (HA-162), so a device that never chose isn't suddenly sent them.
   */
  reports: boolean;
}

/**
 * Whose permission prompts a device gets pushed: `off`; `assistant`, the assistant's (its thread's, and its routines'),
 * whose prompts are for actions outside the board, and which isn't on the board's columns to notify otherwise (the
 * default); or `all`, every task's.
 */
export type Prompts = "off" | "assistant" | "all";

const PROMPTS: Prompts[] = ["off", "assistant", "all"];

export function Events_default(): Events {
  return { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: true };
}

/** What serde takes for an event a stored or given value leaves out (not Events_default: see `reports`). */
const MISSING: Events = { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: false };

/** Events from JSON, missing fields defaulted (as serde reads them); null for something that isn't events. */
function events_from(v: any): Events | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: any = {};
  for (const k of Object.keys(MISSING) as Array<keyof Events>) {
    if (v[k] === undefined) out[k] = MISSING[k];
    else if (k === "prompts" ? PROMPTS.includes(v[k]) : typeof v[k] === "boolean") out[k] = v[k];
    else return null;
  }
  return out;
}

/**
 * Events `patch` (an object of some of them) over `old`: what it leaves out stays as it was. A page from before an event
 * was added sends the others without it, which mustn't turn it off.
 */
function merged_events(old: Events, patch: any): Events {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw ApiError.bad("events must be an object");
  const e = events_from({ ...old, ...patch });
  if (!e) throw ApiError.bad("events: invalid type, expected a boolean (or for prompts, off, assistant or all)");
  return e;
}

function wants(ev: Events, e: Event): boolean {
  if (e === "reply") return ev.replies;
  if (e === "report") return ev.reports;
  // Depends on the task: see wants_prompt.
  if (e === "prompt") return false;
  return ev[e];
}

/** Whether it wants task `t`'s permission prompts. */
function wants_prompt(ev: Events, t: any): boolean {
  if (ev.prompts === "assistant") return is_assistant(t);
  if (ev.prompts === "all") return t?.kind === "task";
  return false;
}

/** Whether task `t` is the assistant's (personal mode): its thread, or one of its routines' runs. */
function is_assistant(t: any): boolean {
  return t?.kind === "task" && (t?.task_type === "assistant" || t?.task_type === "routine");
}

/** A device's subscription, as the API shows it: its endpoint's push service, but not its keys. */
export interface Subscription {
  id: string;
  endpoint: string;
  /** What the device calls itself ("Chrome on Android"), to tell them apart. */
  name: string;
  events: Events;
  created_at: string;
  last_sent_at: string | null;
  /** Why the last push to it failed, until one works. */
  last_error: string | null;
  // `p256dh` and `auth` are non-enumerable, so they aren't serialized.
  p256dh: Buffer;
  auth: Buffer;
}

function Subscription_from_row(r: any): Subscription {
  let events: Events | null = null;
  try {
    events = events_from(JSON.parse(r.events));
  } catch {}
  const s: any = {
    id: r.id,
    endpoint: r.endpoint,
    name: r.name,
    events: events ?? Events_default(),
    created_at: r.created_at,
    last_sent_at: r.last_sent_at ?? null,
    last_error: r.last_error ?? null,
  };
  Object.defineProperty(s, "p256dh", { value: unb64(r.p256dh ?? "") ?? Buffer.alloc(0), enumerable: false });
  Object.defineProperty(s, "auth", { value: unb64(r.auth ?? "") ?? Buffer.alloc(0), enumerable: false });
  return s;
}

export function list(c: Conn): Subscription[] {
  return db.all(c, "SELECT * FROM push_subscriptions ORDER BY created_at").map(Subscription_from_row);
}

function get(c: Conn, id: string): Subscription | null {
  const r = db.one(c, "SELECT * FROM push_subscriptions WHERE id=?1", id);
  return r ? Subscription_from_row(r) : null;
}

/** Push services' endpoints are HTTPS; plain HTTP only to this machine (for tests). */
function check_endpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw ApiError.bad("endpoint must be a URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local))) throw ApiError.bad("endpoint must be an https: URL");
}

// ---------- sending ----------

/**
 * What a push says: the notification's title and text, the page tapping it opens, and its tag (a task's notification
 * replaces the one before it). `task_id` and `event` are left out when there are none.
 */
export interface Message {
  title: string;
  body: string;
  url: string;
  tag: string;
  task_id?: string;
  event?: Event;
  /** For a permission prompt, the request. */
  request_id?: string;
  /** For a prompt that can be answered from the notification: where its Allow and Deny post, with the token that answers it (see push_answers.ts). */
  answer?: Answer;
}

/** How a notification answers its prompt: `POST url` with `{"token", "decision"}`. */
export interface Answer {
  url: string;
  token: string;
}

/**
 * Sends `msg` to `sub`, and notes how it went. A subscription its push service says is gone (the device unsubscribed,
 * or the browser's data was cleared) is deleted.
 */
export async function send(s: AppState, sub: Subscription, msg: Message, urgent: boolean): Promise<void> {
  const result = await deliver(s, sub, msg, urgent);
  const c = s.db();
  if (result === null) {
    db.run(c, "UPDATE push_subscriptions SET last_sent_at=?1, last_error=NULL WHERE id=?2", now(), sub.id);
    return;
  }
  if (result.gone) {
    console.error(`push subscription ${sub.id} (${sub.name}) is gone; deleting it`);
    db.run(c, "DELETE FROM push_subscriptions WHERE id=?1", sub.id);
  } else {
    console.error(`push to ${sub.id} (${sub.name}) failed: ${result.error}`);
    db.run(c, "UPDATE push_subscriptions SET last_error=?1 WHERE id=?2", result.error, sub.id);
  }
  throw new Error(result.error);
}

/** Why a push wasn't delivered: `gone` when the push service no longer has the subscription. */
interface Undelivered {
  gone: boolean;
  error: string;
}

async function deliver(s: AppState, sub: Subscription, msg: Message, urgent: boolean): Promise<Undelivered | null> {
  const failed = (error: string): Undelivered => ({ gone: false, error });
  let body: Buffer, auth: string;
  try {
    body = encrypt(sub.p256dh, sub.auth, Buffer.from(JSON.stringify(msg)));
  } catch (e) {
    return failed(err_str(e));
  }
  try {
    auth = authorization(vapid(s.db()), sub.endpoint, subject(), Math.floor(Date.now() / 1000));
  } catch (e) {
    return failed(err_str(e));
  }
  // A newer message about the same task replaces one still waiting to be delivered.
  const topic = createHash("sha256").update(msg.tag).digest().subarray(0, 16).toString("hex");
  let res: Response;
  try {
    res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // Kept for a day while the device is offline.
        TTL: "86400",
        Urgency: urgent ? "high" : "normal",
        Topic: topic,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return failed(`couldn't reach the push service: ${err_str(e)}`);
  }
  if (res.ok) {
    await res.arrayBuffer().catch(() => {});
    return null;
  }
  const text = Array.from(await res.text().catch(() => "")).slice(0, 300).join("");
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  const error = `the push service answered ${status}${text.trim() ? `: ${text.trim()}` : ""}`;
  return { gone: res.status === 404 || res.status === 410, error };
}

// ---------- events ----------

/**
 * HA-8's events (`NotifyEvent` in app/src/notifications.ts), `prompt` (a permission prompt was raised, see
 * `observe_prompt`), `reply` (the assistant finished a reply, see `observe_reply`) and `report` (a routine posted a report
 * in the assistant's thread, see `observe_report`).
 */
export type Event = "attention" | "review" | "merge" | "done" | "prompt" | "reply" | "report";

/** The column it's about, where a move the user made doesn't notify (see `PushState.moved`). Not a column for a reply or report. */
function event_status(e: Event): string {
  return { attention: "needs_attention", review: "in_review", merge: "ready_for_merge", done: "done", prompt: "needs_attention", reply: "", report: "" }[e];
}

/** What the server says when the user stopped the run: their own doing, so it doesn't notify. */
export const STOPPED = "Stopped by user";

/** How long a task that's ready to review has to stay so before it notifies (`REVIEW_GRACE_MS`). */
const REVIEW_GRACE = 5000;

/** How long a move the user made keeps its notification away (`MOVE_MS` in app/src/api/tasks.ts). */
const MOVE_GRACE = 15_000;

function status(t: any): string {
  return typeof t?.status === "string" ? t.status : "";
}

/** In review, with its agent stopped and its review passed or none running (`readyToCheck`). */
function ready_to_check(t: any): boolean {
  return status(t) === "in_review" && t?.running !== true && (t?.review === null || t?.review === undefined || t.review?.state === "passed");
}

/** What a change of task `prev` to `next` notifies of, if anything (`taskEvent`). */
export function task_event(prev: any, next: any): Event | null {
  if (next?.kind !== "task") return null;
  if (status(next) === "needs_attention" && status(prev) !== "needs_attention") return next?.attention_reason !== STOPPED ? "attention" : null;
  if (ready_to_check(next) && !ready_to_check(prev)) return "review";
  if (status(next) === "ready_for_merge" && status(prev) !== "ready_for_merge") return "merge";
  if (status(next) === "done" && status(prev) !== "done") return "done";
  return null;
}

/** Whether task `t` is still as event `e` said (`stillApplies`). */
function still_applies(e: Event, t: any): boolean {
  return e === "review" ? ready_to_check(t) : status(t) === event_status(e);
}

/** A notification's title and text: the task's key and title, and what happened (`notificationText`). */
export function notification_text(e: Event, t: any, key: string): [string, string] {
  let body: string;
  if (e === "attention") {
    const r = t?.attention_reason;
    body = typeof r === "string" && r ? `Needs attention: ${r}` : "Needs attention";
  } else if (e === "review") {
    body = t?.review?.state === "passed" ? "Ready to review: its review passed" : "Ready to review";
  } else if (e === "merge") {
    body = "Ready for merge";
  } else if (e === "reply") {
    body = "Replied";
  } else if (e === "report") {
    body = "Posted a report";
  } else if (e === "prompt") {
    body = "Waiting for your answer";
  } else {
    const r = typeof t?.resolution === "string" ? t.resolution : "done";
    body = r === "not_done" ? "Closed: not done" : r === "wont_fix" ? "Closed: won't fix" : "Done";
  }
  const chars = Array.from(body);
  if (chars.length > 200) body = `${chars.slice(0, 199).join("")}…`;
  return [`${key} ${typeof t?.title === "string" ? t.title : ""}`, body];
}

/**
 * What goes before a task's number (`keyPrefix`): its project's key, `G` for a group task, `S` for a scratch task, `A`
 * for a profile's assistant and its routines' threads.
 */
async function task_key(s: AppState, host_id: string, t: any): Promise<string> {
  let prefix: string | null = null;
  if (typeof t?.project_id === "string") {
    if (host_id === s.host_id) prefix = local_project_key(s, t.project_id);
    else {
      try {
        const p = await hub.host_request(s, host_id, "GET", `/api/projects/${t.project_id}`);
        prefix = typeof p?.key === "string" ? p.key : null;
      } catch {}
    }
  } else if (typeof t?.group_name === "string") prefix = "G";
  else if (t?.task_type === "scratch") prefix = "S";
  // The assistant's thread and its routines' (`isAssistants`).
  else if (t?.task_type === "assistant" || t?.task_type === "routine") prefix = db.ASSISTANT_TASK_KEY;
  return `${prefix ?? "T"}-${JSON.stringify(t?.number ?? null)}`;
}

function local_project_key(s: AppState, id: string): string | null {
  try {
    return db.get_project(s.db(), id)?.key ?? null;
  } catch {
    return null;
  }
}

// ---------- watching the board ----------

/** What the board keeps for push while it runs. */
export class PushState {
  /** A link is presented as connected after its initial task snapshot has been processed. */
  watching = false;
  ready = new Map<string, LinkConn>();
  /** The latest state of every task on the board, by `<host>:<id>`, to tell what changed. */
  tasks = new Map<string, any>();
  /** The tasks whose "ready to review" waits out its grace period. */
  pending = new Set<string>();
  /** The columns tasks were moved to by the user lately (through this board's API), by `<host>:<id>`. */
  moves = new Map<string, [string, number]>();
  /** The permission prompts raised while the board watched that are still waiting, by `<host>:<task id>`. */
  prompts = new Map<string, Set<string>>();

  link_ready(link: LinkConn): boolean {
    return !this.watching || this.ready.get(link.id) === link;
  }

  /** The user moved task `id` on `host_id` to `status` themselves (from the UI), so that doesn't notify them. */
  note_move(host_id: string, id: string, status: string) {
    const t = Date.now();
    for (const [k, [, at]] of this.moves) if (t - at >= MOVE_GRACE) this.moves.delete(k);
    this.moves.set(`${host_id}:${id}`, [status, t]);
  }

  moved(key: string, e: Event): boolean {
    const m = this.moves.get(key);
    return !!m && m[0] === event_status(e) && Date.now() - m[1] < MOVE_GRACE;
  }
}

/** Watches the task events of every host on the board and pushes the ones devices want. */
export function start(s: AppState) {
  s.push.watching = true;
  try {
    push_answers.recover(s.db());
  } catch (e) {
    console.warn(`push: recovering prompts' answers: ${err_str(e)}`);
  }
  // The events, handled one at a time in order, as Rust's receiver loop does.
  const queue: any[] = [];
  let busy = true;
  const drain = async () => {
    busy = true;
    while (queue.length) {
      try {
        await handle(queue.shift());
      } catch (e) {
        console.error(`push: ${err_str(e)}`);
      }
    }
    busy = false;
  };
  s.hub_events.subscribe((ev) => {
    queue.push(ev);
    if (!busy) background("push notifications", drain());
  });
  // What the tasks are now: what they change from. Linked hosts' as they connect.
  const known = new Set<string>();
  const handle = async (ev: any) => {
    const host: string = typeof ev?.host_id === "string" ? ev.host_id : s.host_id;
    switch (ev?.type) {
      case "task":
        return observe(s, host, ev.task);
      case "task_deleted":
        if (typeof ev.id === "string") s.push.tasks.delete(`${host}:${ev.id}`);
        return;
      case "message":
        observe_prompt(s, host, ev.message);
        return observe_report(s, host, ev.message);
      case "message_updated":
        return prompt_settled(s, host, ev.message);
      case REPLY_EVENT:
        return observe_reply(s, host, ev);
      case "resync":
        return await sync_host(s, host);
      case "hosts_changed": {
        const now = linked(s);
        for (const id of [...s.push.ready.keys()]) if (!now.includes(id)) s.push.ready.delete(id);
        // Gone hosts are loaded again when they're back.
        for (const h of [...known]) if (h !== s.host_id && !now.includes(h)) known.delete(h);
        for (const h of now) {
          if (!known.has(h)) {
            known.add(h);
            await load_host(s, h);
          }
        }
        return;
      }
    }
  };
  (async () => {
    await load_host(s, s.host_id);
    known.add(s.host_id);
    await drain();
  })().catch((e) => console.error(`push: ${err_str(e)}`));
}

/**
 * Both kinds of link announce an initial resync after hosts_changed. Publishing connected before that snapshot
 * completed let a first change be swallowed into the baseline, rather than pushed.
 */
async function sync_host(s: AppState, host: string) {
  const link = hub.find_link(s, host);
  await load_host(s, host);
  if (link && hub.find_link(s, host) === link) {
    const was_ready = s.push.link_ready(link);
    s.push.ready.set(host, link);
    if (!was_ready) s.hub_events.send({ type: "hosts_changed" });
  }
}

/** The linked hosts that are connected. */
function linked(s: AppState): string[] {
  return [...s.links.keys()];
}

/** Takes host `host`'s tasks as they are, without notifying of them: they were so before anything here could tell. */
async function load_host(s: AppState, host: string) {
  let tasks: any[];
  if (host === s.host_id) {
    try {
      tasks = local_tasks(s);
    } catch (e) {
      return void console.error(`push: reading the tasks: ${err_str(e)}`);
    }
  } else {
    tasks = [];
    let profiles: any;
    try {
      profiles = await hub.host_request(s, host, "GET", "/api/profiles");
    } catch (e) {
      return void console.error(`push: reading ${host}'s profiles: ${e instanceof ApiError ? e.message : err_str(e)}`);
    }
    for (const p of Array.isArray(profiles) ? profiles : []) {
      if (typeof p?.id !== "string") continue;
      try {
        const ts = await hub.host_request(s, host, "GET", `/api/profiles/${p.id}/tasks`);
        if (Array.isArray(ts)) tasks.push(...ts);
      } catch {}
    }
  }
  // Prompts it raised that the board heard of may have been answered while it wasn't listening.
  for (const k of [...s.push.prompts.keys()]) if (k.startsWith(`${host}:`)) s.push.prompts.delete(k);
  for (const t of tasks) if (typeof t?.id === "string") s.push.tasks.set(`${host}:${t.id}`, t);
}

function local_tasks(s: AppState): any[] {
  return JSON.parse(JSON.stringify(db.list_all_tasks(s.db())));
}

/** A task as it is now: notifies of what changed since it was last seen (nothing for one first seen). */
function observe(s: AppState, host: string, t: any) {
  const id = t?.id;
  if (typeof id !== "string") return;
  const key = `${host}:${id}`;
  // Its prompts end with its run (if the board missed hearing so).
  if (t?.running === false) s.push.prompts.delete(key);
  // As JSON, as Rust has it: a task row may be changed in place later.
  t = JSON.parse(JSON.stringify(t));
  const prev = s.push.tasks.get(key);
  s.push.tasks.set(key, t);
  if (prev === undefined) return;
  const e = task_event(prev, t);
  if (e === null) return;
  if (s.push.moved(key, e)) return;
  if (e !== "review") return void notify(s, host, t, e).catch((err) => console.error(`push: ${err_str(err)}`));
  // A review starts a moment after the run ends, and a run can carry on straight away: ready to review only once it has
  // stayed so for a few seconds.
  if (s.push.pending.has(key)) return;
  s.push.pending.add(key);
  setTimeout(() => {
    s.push.pending.delete(key);
    const now = s.push.tasks.get(key);
    if (now !== undefined && still_applies("review", now)) notify(s, host, now, "review").catch((err) => console.error(`push: ${err_str(err)}`));
  }, REVIEW_GRACE);
}

/** Pushes event `e` of task `t` to the devices that want it. */
async function notify(s: AppState, host: string, t: any, e: Event) {
  const tid = typeof t?.id === "string" ? t.id : "";
  // Waiting on a prompt the devices that want it were pushed already, with its Allow and Deny.
  const prompted = e === "attention" && (s.push.prompts.get(`${host}:${tid}`)?.size ?? 0) > 0;
  let subs: Subscription[];
  try {
    subs = list(s.db()).filter((x) => wants(x.events, e) && !(prompted && wants_prompt(x.events, t)));
  } catch (err) {
    return void console.error(`push: reading the subscriptions: ${err_str(err)}`);
  }
  if (!subs.length) return;
  const [title, body] = notification_text(e, t, await task_key(s, host, t));
  const id = typeof t?.id === "string" ? t.id : "";
  const msg: Message = { title, body, url: `/t/${id}`, tag: `${host}:${id}`, task_id: id, event: e };
  await send_all(s, subs, msg, e === "attention");
}

/** Sends `msg` to each of `subs`, whatever happens to the others. */
async function send_all(s: AppState, subs: Subscription[], msg: Message, urgent: boolean) {
  for (const sub of subs) await send(s, sub, msg, urgent).catch(() => {});
}

/** Task `id` on `host` as it is now (as push has it, or asked for). */
async function find_task(s: AppState, host: string, id: string): Promise<any> {
  const t = s.push.tasks.get(`${host}:${id}`);
  if (t !== undefined) return t;
  if (host === s.host_id) {
    try {
      const local = db.get_task(s.db(), id);
      return local ? JSON.parse(JSON.stringify(local)) : null;
    } catch {
      return null;
    }
  }
  try {
    const v = await hub.host_request(s, host, "GET", `/api/tasks/${id}`);
    return v?.task && typeof v.task === "object" && !Array.isArray(v.task) ? v.task : null;
  } catch {
    return null;
  }
}

// ---------- permission prompts ----------

/** A thread message as it is now: a permission prompt that has just been raised is pushed. */
function observe_prompt(s: AppState, host: string, m: any) {
  const data = m?.data;
  if (m?.kind !== "permission" || data?.status !== "pending") return;
  const task_id = m.task_id, request = data.request_id;
  if (typeof task_id !== "string" || typeof request !== "string") return;
  const key = `${host}:${task_id}`;
  const set = s.push.prompts.get(key) ?? new Set<string>();
  set.add(request);
  s.push.prompts.set(key, set);
  notify_prompt(s, host, task_id, JSON.parse(JSON.stringify(data))).catch((e) => console.error(`push: ${err_str(e)}`));
}

/** A thread message changed: a prompt answered or expired is no longer waiting, and the tokens that would answer it from a notification stop working. */
function prompt_settled(s: AppState, host: string, m: any) {
  const data = m?.data;
  const task_id = m?.task_id, request = data?.request_id, status = data?.status;
  if (typeof task_id !== "string" || typeof request !== "string" || typeof status !== "string") return;
  if (m.kind !== "permission" || status === "pending") return;
  const key = `${host}:${task_id}`;
  const p = s.push.prompts.get(key);
  if (p) {
    p.delete(request);
    if (p.size === 0) s.push.prompts.delete(key);
  }
  try {
    push_answers.settle(s.db(), host, request, status);
  } catch (e) {
    console.warn(`push: settling prompt ${request}'s tokens: ${err_str(e)}`);
  }
}

/** What a prompt's notification says it asks (not what the tool would do: pushes pass through push services, so they carry no tool inputs). */
export function prompt_text(data: any): string {
  const tool = typeof data?.tool_name === "string" ? data.tool_name : "a tool";
  switch (data?.kind) {
    case "project":
      return "Approve a project change?";
    case "delete_task":
      return "Delete a task?";
    case "automation":
      return "Approve an automation?";
  }
  if (permissions.is_question(tool)) return "The agent has questions for you";
  if (tool === permissions.EXIT_PLAN) return "Plan ready for approval";
  return `Approve ${tool}?`;
}

/**
 * Pushes prompt `data` (its thread message's) of task `task_id` to the devices that want it, with a token for its Allow
 * and Deny if it can be answered from the notification.
 */
async function notify_prompt(s: AppState, host: string, task_id: string, data: any) {
  const request = data?.request_id;
  if (typeof request !== "string") return;
  const t = await find_task(s, host, task_id);
  if (!t) return;
  let subs: Subscription[];
  try {
    subs = list(s.db()).filter((x) => wants_prompt(x.events, t));
  } catch (e) {
    return void console.warn(`push: reading the subscriptions: ${err_str(e)}`);
  }
  if (!subs.length) return;
  let answer: Answer | undefined;
  if (push_answers.answerable(data)) {
    try {
      const expires_at = typeof data.expires_at === "string" ? data.expires_at : null;
      answer = { url: `/api/permissions/${request}/push-answer`, token: push_answers.mint(s.db(), host, request, task_id, expires_at) };
    } catch (e) {
      console.warn(`push: minting a token for prompt ${request}: ${err_str(e)}`);
    }
  }
  const key = await task_key(s, host, t);
  const msg: Message = {
    title: `${key} ${typeof t.title === "string" ? t.title : ""}`,
    body: prompt_text(data),
    url: `/t/${task_id}`,
    // Each prompt its own, so that two at once can each be answered.
    tag: `${host}:${task_id}:${request}`,
    task_id,
    event: "prompt",
    request_id: request,
  };
  if (answer) msg.answer = answer;
  await send_all(s, subs, msg, true);
}

// ---------- routines' reports ----------

/** What a routine's report notification says: its routine, and the report's first line (or why it failed). */
export function report_text(data: any): [string, string] | null {
  const text = typeof data?.text === "string" ? data.text : "";
  const first =
    text
      .split("\n")
      .map((l: string) => l.trim().replace(/^[#*\- ]+/, ""))
      .find((l: string) => l !== "") ?? "";
  let body: string;
  if (data?.outcome === "reported") body = first !== "" ? first : "Posted a report";
  else if (data?.outcome === "failed") body = `Failed: ${first}`;
  else return null;
  const chars = Array.from(body);
  if (chars.length > 200) body = `${chars.slice(0, 199).join("")}…`;
  const name = typeof data?.automation === "string" && data.automation !== "" ? data.automation : "A routine";
  return [name, body];
}

/**
 * A thread message as it is now: a routine's report that's just been posted on the assistant's thread (one per run)
 * goes to the devices that want reports. A routine waiting on the user is pushed as its attention instead.
 */
function observe_report(s: AppState, host: string, m: any) {
  if (m?.kind !== "report") return;
  // Tapping it opens the routine's thread (its run, with what it posted), or the assistant's for a report without one.
  const task_id = typeof m.data?.task_id === "string" && m.data.task_id !== "" ? m.data.task_id : typeof m.task_id === "string" ? m.task_id : null;
  if (task_id === null) return;
  const text = report_text(m.data);
  if (!text) return;
  const [title, body] = text;
  const tag = JSON.stringify(m.id ?? null);
  (async () => {
    let subs: Subscription[];
    try {
      subs = list(s.db()).filter((x) => wants(x.events, "report"));
    } catch (e) {
      return void console.warn(`push: reading the subscriptions: ${err_str(e)}`);
    }
    const msg: Message = { title, body, url: `/t/${task_id}`, tag: `${host}:${task_id}:report:${tag}`, task_id, event: "report" };
    await send_all(s, subs, msg, false);
  })().catch((e) => console.error(`push: ${err_str(e)}`));
}

// ---------- the assistant's replies ----------

/**
 * The event the assistant's host sends when the assistant finished a reply (its turn's `result`), with the assistant's
 * `task_id`, the result's `message_id`, and `telegram`: whether it answers a message sent to it on Telegram, which the
 * reply goes back to (see runner/output.ts's `announce_reply`).
 */
export const REPLY_EVENT = "assistant_reply";

/** An `assistant_reply` event: the reply is pushed to the devices that want replies, unless it went back to Telegram. */
function observe_reply(s: AppState, host: string, ev: any) {
  if (ev?.telegram === true) return;
  if (typeof ev?.task_id !== "string") return;
  notify_reply(s, host, ev.task_id).catch((e) => console.error(`push: ${err_str(e)}`));
}

/**
 * Pushes that the assistant (task `task_id` on `host`) replied, to the devices that want it. Not what it said: that's
 * read in the thread (pushes pass through push services).
 */
async function notify_reply(s: AppState, host: string, task_id: string) {
  let subs: Subscription[];
  try {
    subs = list(s.db()).filter((x) => wants(x.events, "reply"));
  } catch (e) {
    return void console.warn(`push: reading the subscriptions: ${err_str(e)}`);
  }
  if (!subs.length) return;
  const t = await find_task(s, host, task_id);
  if (!t || t.task_type !== "assistant") return;
  const [title, body] = notification_text("reply", t, await task_key(s, host, t));
  // The assistant's page (the board sends /t/ of an assistant there). Its own tag, so a reply doesn't take the place of
  // an attention notification.
  const msg: Message = { title, body, url: `/t/${task_id}`, tag: `${host}:${task_id}:reply`, task_id, event: "reply" };
  await send_all(s, subs, msg, false);
}

// ---------- API ----------

/** The board's public key, to subscribe with, and the devices that have. */
export function info(s: AppState) {
  const c = s.db();
  return { public_key: vapid(c).public_key(), subscriptions: list(c) };
}

const missing = (field: string) => new ApiError(422, `Failed to deserialize the JSON body into the target type: missing field \`${field}\``);

/** Adds a device's subscription (`PushSubscription.toJSON()`), or updates the one with its endpoint. */
export function subscribe(s: AppState, r: Req) {
  const b = r.body ?? {};
  if (typeof b.endpoint !== "string") throw missing("endpoint");
  if (!b.keys || typeof b.keys !== "object") throw missing("keys");
  if (typeof b.keys.p256dh !== "string") throw missing("p256dh");
  if (typeof b.keys.auth !== "string") throw missing("auth");
  if (b.events !== undefined && b.events !== null && (typeof b.events !== "object" || Array.isArray(b.events))) {
    throw ApiError.bad("events must be an object");
  }
  check_endpoint(b.endpoint);
  const valid = (k: Buffer) => {
    if (k.length !== 65) return false;
    try {
      const key = createECDH("prime256v1");
      key.generateKeys();
      ecdh(key, k);
      return true;
    } catch {
      return false;
    }
  };
  const p256dh = unb64(b.keys.p256dh.replace(/=+$/, ""));
  const auth = unb64(b.keys.auth.replace(/=+$/, ""));
  if (!p256dh || !valid(p256dh) || !auth || auth.length !== 16) {
    throw ApiError.bad("keys must have the subscription's p256dh public key and 16-byte auth secret");
  }
  const name = Array.from(typeof b.name === "string" ? b.name.trim() : "").slice(0, 100).join("");
  const c = s.db();
  const old = db.value<string>(c, "SELECT id FROM push_subscriptions WHERE endpoint=?1", b.endpoint);
  let id: string;
  if (old !== undefined) {
    // Its events (see `merged_events`) over what it had.
    const events = b.events == null ? null : merged_events(get(c, old)?.events ?? Events_default(), b.events);
    db.run(
      c,
      "UPDATE push_subscriptions SET p256dh=?1, auth=?2, name=?3, events=COALESCE(?4, events), last_error=NULL WHERE id=?5",
      b64(p256dh), b64(auth), name, events ? JSON.stringify(events) : null, old,
    );
    id = old;
  } else {
    id = new_id();
    const events = b.events == null ? Events_default() : merged_events(Events_default(), b.events);
    db.run(
      c,
      "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,name,events,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
      id, b.endpoint, b64(p256dh), b64(auth), name, JSON.stringify(events), now(),
    );
  }
  const sub = get(c, id);
  if (!sub) throw ApiError.not_found("subscription");
  return sub;
}

/** Changes a device's name or the events it gets. */
export function update(s: AppState, r: Req) {
  const id = r.params.id;
  const b = r.body ?? {};
  const c = s.db();
  const sub0 = get(c, id);
  if (!sub0) throw ApiError.not_found("subscription");
  if (typeof b.name === "string") {
    db.run(c, "UPDATE push_subscriptions SET name=?1 WHERE id=?2", Array.from(b.name.trim()).slice(0, 100).join(""), id);
  }
  if (b.events !== undefined && b.events !== null) {
    // Some of its events, changed (see `merged_events`).
    const events = merged_events(sub0.events, b.events);
    db.run(c, "UPDATE push_subscriptions SET events=?1 WHERE id=?2", JSON.stringify(events), id);
  }
  const sub = get(c, id);
  if (!sub) throw ApiError.not_found("subscription");
  return sub;
}

export function unsubscribe(s: AppState, r: Req) {
  const n = db.run(s.db(), "DELETE FROM push_subscriptions WHERE id=?1", r.params.id).changes;
  if (n === 0) throw ApiError.not_found("subscription");
  return { ok: true };
}

/** Pushes a test notification to a device, and says whether its push service took it. */
export async function test(s: AppState, r: Req) {
  const sub = get(s.db(), r.params.id);
  if (!sub) throw ApiError.not_found("subscription");
  const msg: Message = { title: "Huntaway", body: "Push notifications work on this device.", url: "/settings", tag: "test" };
  try {
    await send(s, sub, msg, true);
  } catch (e) {
    throw new ApiError(502, err_str(e));
  }
  return { ok: true };
}
