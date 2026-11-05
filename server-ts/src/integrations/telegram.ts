// Port of server/src/integrations/telegram.rs: Telegram: talking to a profile's assistant from a Telegram bot, and the
// assistant reaching you there.
//
// It runs on the host the assistant runs on (its assistant host, see agent/assistant.ts), and long-polls the Bot API's
// `getUpdates`, so it needs no inbound port, and carries on while that host's link to the hub is down. Each profile can
// have a bot of its own:
//
// - **The bot token** is a secret in the settings (`telegram_token:<profile id>`), set in the assistant's details and
//   never returned by the API. It goes in the Bot API's URLs, so it must look like one.
// - **Linking:** the board shows a one-time code (`POST /profiles/{id}/telegram/link`, ten minutes), and `/start <code>`
//   sent to the bot from a private chat makes that chat the owner. Messages and button presses from anyone else are
//   dropped, logged and counted.
// - **In:** the owner's messages go to the assistant thread as theirs (`assistant.send`), with photos, voice notes and
//   files saved as attachments, listed as the board lists them.
// - **Out:** the assistant's replies to them (or to every message, as chosen), its routines' reports, its questions and
//   its permission prompts, the last with Allow and Deny buttons. Those are answered as the board's own buttons answer
//   (permissions.answer_by, `telegram` in the action log), so the approval rules and expiry hold the same; the message is
//   edited to say how the prompt ended, however it did. Each kind of message can be turned off (`events`). Push (push.ts,
//   chosen per device) can send each of them too: the replies it's told of here (`announce_reply`), as only this host
//   knows which were asked for on Telegram, and those go back there alone.
// - **Sending** goes through a queue per profile, kept in the settings until Telegram takes each item: one that fails for
//   a while (Telegram unreachable, failing or rate-limiting) is tried again, waiting longer each time, and after a
//   restart; one Telegram refuses outright is dropped. One profile's queue doesn't hold up another's.
// - **Moving the assistant** to another host removes the bot from the one it left (`assistant_moved`).
//
// Nothing here takes an address or a token from what arrives in a chat: the API's address is fixed (or
// `IA_TELEGRAM_API` in the server's environment, for tests), files are fetched by the ids Telegram gives, and replies go
// only to the owner's chat.
//
// Settings, by profile: the secret token; `telegram:<id>` (the bot, owner, events, pending code and the last error),
// `telegram_state:<id>` (the update offset, so a restart carries on where it was, and the prompts sent with buttons, to
// edit when they end) and `telegram_outbox:<id>` (what's waiting to be sent).
//
// Rust aborted a profile's poller and sender tasks to stop them; here each pair shares an AbortSignal, which ends their
// waits (the long poll included) and which they check before writing what they did.
import { createHash } from "node:crypto";
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { Shared } from "../state.ts";
import { err_str, new_token, now, same_secret } from "../util.ts";
import * as assistant from "../agent/assistant.ts";
import * as approval_rules from "../agent/approval_rules.ts";
import * as attachments from "../attachments.ts";
import * as hub from "../hosts/hub.ts";
import * as permissions from "../mcp/permissions.ts";
import * as push from "./push.ts";
import * as push_answers from "./push_answers.ts";
import { MAX_CHARS, PIECE_CHARS, cut, escape, split, to_html } from "./telegram/format.ts";

/** The Bot API's address. */
const API = "https://api.telegram.org";

/** How long each `getUpdates` waits for something to arrive, in seconds. */
const POLL_SECS = 50;

/** How long a linking code lasts. */
const CODE_MINUTES = 10;

/** Prompts sent with buttons that are remembered (to edit when they end), at most. */
const MAX_PROMPTS = 200;

/** What `getUpdates` asks for. */
const UPDATES = ["message", "callback_query"];

/** The API version from which a host has Telegram. */
export const TELEGRAM_API = 117;

function token_key(profile_id: string): string {
  return `telegram_token:${profile_id}`;
}

function config_key(profile_id: string): string {
  return `telegram:${profile_id}`;
}

function progress_key(profile_id: string): string {
  return `telegram_state:${profile_id}`;
}

function outbox_key(profile_id: string): string {
  return `telegram_outbox:${profile_id}`;
}

/** Every setting a profile's bot keeps. */
function keys(profile_id: string): string[] {
  return [token_key(profile_id), config_key(profile_id), progress_key(profile_id), outbox_key(profile_id)];
}

// ---------- settings ----------

/** A profile's bot and who it talks to. */
export interface Config {
  /** The bot the token is for, from `getMe` when the token was set. */
  bot: Bot | null;
  /** The chat that linked with a code: the only one the bot listens to and writes to. */
  owner: Owner | null;
  events: Events;
  /** The linking code waiting to be sent, by its hash. */
  link: Link | null;
  /** Why talking to Telegram last failed, until it works again. */
  last_error: string | null;
  /** Messages and button presses from others, dropped. */
  dropped: Dropped | null;
}

export interface Bot {
  id: number;
  username: string;
}

export interface Owner {
  chat_id: number;
  user_id: number;
  name: string;
  username: string | null;
  linked_at: string;
}

export interface Link {
  code_hash: string;
  expires_at: string;
}

export interface Dropped {
  count: number;
  /** Who sent the last one: their name and Telegram id. */
  last_from: string;
  last_at: string;
}

/** What the bot sends you, besides the replies to what you send it (which always come back). */
export interface Events {
  /** The assistant's replies to messages sent from the board too. */
  replies: boolean;
  /** Its routines' reports. */
  reports: boolean;
  /** Its permission prompts (with Allow and Deny) and its questions, and its routines' prompts. */
  prompts: boolean;
  /** It needs attention (its run failed, say). */
  attention: boolean;
}

export function Events_default(): Events {
  return { replies: false, reports: true, prompts: true, attention: true };
}

export function Config_default(): Config {
  return { bot: null, owner: null, events: Events_default(), link: null, last_error: null, dropped: null };
}

/** Where the poller and the outbox are, kept apart from `Config` as it changes with each update. */
export interface Progress {
  /** The next update to ask for: the ones before it have been handled. */
  offset: number;
  /** A message from Telegram went to the assistant, and its reply goes back. */
  awaiting: boolean;
  /** The last turn's end (a `result` message's id) whose reply was looked at. */
  replied: number;
  /** The prompts sent with buttons, by request id: their Telegram message and text. */
  prompts: Record<string, SentPrompt>;
}

export interface SentPrompt {
  message_id: number;
  html: string;
}

export function Progress_default(): Progress {
  return { offset: 0, awaiting: false, replied: 0, prompts: {} };
}

const is_obj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
const is_int = (v: any): v is number => Number.isSafeInteger(v);
const is_uint = (v: any): v is number => Number.isSafeInteger(v) && v >= 0;
const opt_str = (v: any): string | null => (typeof v === "string" ? v : null);

/** Events from JSON, as serde reads them: fields left out take their defaults; one of another type fails. */
function Events_from_json(v: any): Events {
  if (!is_obj(v)) throw new Error("events must be an object");
  const out = Events_default();
  for (const k of ["replies", "reports", "prompts", "attention"] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== "boolean") throw new Error(`events.${k} must be true or false`);
    out[k] = v[k];
  }
  return out;
}

/** A stored config, as serde would read it (or the default, as `read` falls back to, when it can't). */
function Config_from_json(v: any): Config {
  if (!is_obj(v)) throw new Error("not an object");
  const bot = v.bot == null ? null : { id: v.bot.id, username: v.bot.username };
  if (bot && (!is_int(bot.id) || typeof bot.username !== "string")) throw new Error("bot");
  const o = v.owner;
  const owner =
    o == null ? null : { chat_id: o.chat_id, user_id: o.user_id, name: o.name, username: opt_str(o.username), linked_at: o.linked_at };
  if (owner && (!is_int(owner.chat_id) || !is_int(owner.user_id) || typeof owner.name !== "string" || typeof owner.linked_at !== "string")) {
    throw new Error("owner");
  }
  const link = v.link == null ? null : { code_hash: v.link.code_hash, expires_at: v.link.expires_at };
  if (link && (typeof link.code_hash !== "string" || typeof link.expires_at !== "string")) throw new Error("link");
  const d = v.dropped;
  const dropped = d == null ? null : { count: d.count, last_from: d.last_from, last_at: d.last_at };
  if (dropped && (!is_uint(dropped.count) || typeof dropped.last_from !== "string" || typeof dropped.last_at !== "string")) throw new Error("dropped");
  return { bot, owner, events: v.events === undefined ? Events_default() : Events_from_json(v.events), link, last_error: opt_str(v.last_error), dropped };
}

function Progress_from_json(v: any): Progress {
  if (!is_obj(v)) throw new Error("not an object");
  const prompts: Record<string, SentPrompt> = {};
  for (const [k, p] of Object.entries(is_obj(v.prompts) ? v.prompts : {})) {
    if (is_obj(p) && is_int((p as any).message_id) && typeof (p as any).html === "string") prompts[k] = { message_id: (p as any).message_id, html: (p as any).html };
  }
  return { offset: is_int(v.offset) ? v.offset : 0, awaiting: v.awaiting === true, replied: is_int(v.replied) ? v.replied : 0, prompts };
}

function Outbox_from_json(v: any): Outbox {
  if (!is_obj(v)) throw new Error("not an object");
  const items: Queued[] = [];
  for (const q of Array.isArray(v.items) ? v.items : []) {
    if (is_obj(q) && is_uint(q.id) && is_obj(q.item) && typeof q.item.kind === "string") items.push({ id: q.id, item: q.item, sent: is_uint(q.sent) ? q.sent : 0 });
  }
  return { next: is_uint(v.next) ? v.next : 0, items };
}

/** The setting `key`, read with `from`, or `fallback()` if it's missing or can't be read. */
function read<T>(c: Conn, key: string, from: (v: any) => T, fallback: () => T): T {
  try {
    const v = db.get_setting(c, key);
    return v === null ? fallback() : from(JSON.parse(v));
  } catch {
    return fallback();
  }
}

function write(c: Conn, key: string, v: any) {
  db.set_setting(c, key, JSON.stringify(v));
}

export function config(c: Conn, profile_id: string): Config {
  return read(c, config_key(profile_id), Config_from_json, Config_default);
}

export function progress(c: Conn, profile_id: string): Progress {
  return read(c, progress_key(profile_id), Progress_from_json, Progress_default);
}

export function token(c: Conn, profile_id: string): string | null {
  try {
    return db.get_setting(c, token_key(profile_id));
  } catch {
    return null;
  }
}

/** Changes profile `profile_id`'s config with `f`, with nothing in between: what `f` returns. */
function update_config<R>(s: Shared, profile_id: string, f: (c: Config) => R): R {
  const c = s.db();
  const cfg = config(c, profile_id);
  const r = f(cfg);
  write(c, config_key(profile_id), cfg);
  return r;
}

/** Changes profile `profile_id`'s progress with `f`, with nothing in between: what `f` returns. */
export function update_progress<R>(s: Shared, profile_id: string, f: (p: Progress) => R): R {
  const c = s.db();
  const p = progress(c, profile_id);
  const r = f(p);
  write(c, progress_key(profile_id), p);
  return r;
}

/** `f`, with a failure logged rather than thrown (Rust's `let _ = …`). */
function quietly(profile_id: string, what: string, f: () => void) {
  try {
    f();
  } catch (e) {
    console.warn(`telegram: ${what} (profile ${profile_id}): ${err_str(e)}`);
  }
}

/** The token and owner of profile `profile_id`'s bot, if it has both: the bot is linked. */
function linked(c: Conn, profile_id: string): [string, Config, Owner] | null {
  const t = token(c, profile_id);
  if (t === null) return null;
  const cfg = config(c, profile_id);
  return cfg.owner ? [t, cfg, cfg.owner] : null;
}

/** Whether `token` looks like a bot token (`<bot id>:<secret>`), which goes in the API's URLs as it is. */
export function valid_token(token: string): boolean {
  const i = token.indexOf(":");
  if (i < 0) return false;
  const id = token.slice(0, i), secret = token.slice(i + 1);
  return /^[0-9]{1,20}$/.test(id) && /^[A-Za-z0-9_-]{20,100}$/.test(secret);
}

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Tells the board's UI that profile `profile_id`'s Telegram settings changed (linked, say). */
function changed(s: Shared, profile_id: string) {
  s.emit({ type: "telegram", profile_id });
}

// ---------- the Bot API ----------

/** Waits for `notify_one` (Rust's tokio `Notify`): one that came while nobody waited is kept for the next wait. */
class Notify {
  private permit = false;
  private waiters: Array<() => void> = [];
  notify_one() {
    const w = this.waiters.shift();
    if (w) w();
    else this.permit = true;
  }
  /** Resolves when notified, or when `signal` aborts. */
  notified(signal: AbortSignal): Promise<void> {
    if (this.permit) {
      this.permit = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

/** A profile's poller and sender, while it has a token: stopped together. */
interface Pollers {
  stop: AbortController;
  /** The poller has returned (its token went). */
  poller_done: boolean;
}

/** What the board keeps for Telegram while it runs. */
export class TelegramState {
  /** Each profile's poller and sender, while it has a token. */
  pollers = new Map<string, Pollers>();
  /** What wakes each profile's sender when something is queued for it. */
  wakers = new Map<string, Notify>();
  started = false;
  /** Stops watching the host's events (see `stop`). */
  unwatch: (() => void) | null = null;
  /** The Bot API's address: `API`, or `IA_TELEGRAM_API` (a fake one, in tests). */
  api: string;
  poll_secs = POLL_SECS;

  constructor() {
    const env = process.env.IA_TELEGRAM_API ?? "";
    this.api = (env.trim() ? env : API).replace(/\/+$/, "");
  }

  waker(profile_id: string): Notify {
    let w = this.wakers.get(profile_id);
    if (!w) this.wakers.set(profile_id, (w = new Notify()));
    return w;
  }

  /** Talks to a fake Bot API at `url` instead, polling for `poll_secs` at a time (for tests). */
  use_api(url: string, poll_secs: number) {
    this.api = url.replace(/\/+$/, "");
    this.poll_secs = poll_secs;
  }
}

/** Why a call to the Bot API failed. Never with its URL, which has the token in it. */
export class CallError extends Error {
  /** `api`: Telegram said no (`code` and `description`). `net`: it couldn't be reached, or answered with something else. */
  kind: "api" | "net";
  code: number;
  description: string;
  retry_after: number | null;

  constructor(kind: "api" | "net", code: number, description: string, retry_after: number | null = null) {
    super(CallError.text(kind, code, description));
    this.kind = kind;
    this.code = code;
    this.description = description;
    this.retry_after = retry_after;
  }

  static net(e: string): CallError {
    return new CallError("net", 0, e);
  }

  private static text(kind: "api" | "net", code: number, description: string): string {
    if (kind === "net") return `couldn't reach Telegram: ${description}`;
    if (code === 401) return "Telegram doesn't know this bot token (it may have been revoked): set it again";
    if (code === 409) return "something else is reading this bot's messages (another board, or a webhook): a bot can be read by one at a time";
    return `Telegram said ${code}: ${description}`;
  }

  is_api(code?: number): boolean {
    return this.kind === "api" && (code === undefined || this.code === code);
  }
}

/** Thrown out of a wait or a call when the profile's poller and sender are stopped (Rust aborted them). */
class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

/** Waits `ms`, or throws `Stopped` once `signal` aborts. */
function sleep_or_stop(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped());
    const done = () => {
      clearTimeout(t);
      reject(new Stopped());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** What an error says, without the bot's token (which is in the URLs). */
function without_token(e: unknown, token: string): string {
  const text = err_str(e);
  return token ? text.replaceAll(token, "<token>") : text;
}

/** Calls `method` with `body`, as bot `token`: its `result`. Throws `CallError`, or `Stopped` once `signal` aborts. */
export async function call(s: Shared, token: string, method: string, body: any, timeout_ms: number, signal?: AbortSignal): Promise<any> {
  const url = `${s.telegram.api}/bot${token}/${method}`;
  const timeout = AbortSignal.timeout(timeout_ms);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw new Stopped();
    throw CallError.net(timeout.aborted ? "it didn't answer in time" : without_token(e, token));
  }
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  let v: any;
  try {
    v = JSON.parse(await res.text());
  } catch (e) {
    if (signal?.aborted) throw new Stopped();
    throw CallError.net(`${status}: ${without_token(e, token)}`);
  }
  if (v?.ok === true) return v.result ?? null;
  const retry = v?.parameters?.retry_after;
  throw new CallError(
    "api",
    is_int(v?.error_code) ? v.error_code : res.status,
    typeof v?.description === "string" ? v.description : "no reason given",
    is_uint(retry) ? retry : null,
  );
}

/** `call`, trying once more after the wait Telegram asks for when there are too many requests. */
async function call_patiently(s: Shared, token: string, method: string, body: any): Promise<any> {
  try {
    return await call(s, token, method, body, 30_000);
  } catch (e) {
    if (!(e instanceof CallError) || e.kind !== "api" || e.retry_after === null || e.retry_after > 60) throw e;
    await new Promise((r) => setTimeout(r, e.retry_after! * 1000));
    return await call(s, token, method, body, 30_000);
  }
}

/**
 * Sends `html` to `chat`, with `markup` (buttons) if any: its message id. Telegram refusing the HTML sends `plain` instead,
 * if there is one.
 */
async function send_html(s: Shared, token: string, chat: number, html: string, plain: string | null, markup: any | null): Promise<number> {
  const body: any = { chat_id: chat, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  if (markup) body.reply_markup = markup;
  let sent: any;
  try {
    sent = await call_patiently(s, token, "sendMessage", body);
  } catch (e) {
    const unparsed = e instanceof CallError && e.is_api(400) && (e.description.includes("parse entities") || e.description.includes("can't parse"));
    if (!unparsed || plain === null) throw e;
    const body: any = { chat_id: chat, text: cut(plain, MAX_CHARS), link_preview_options: { is_disabled: true } };
    if (markup) body.reply_markup = markup;
    sent = await call_patiently(s, token, "sendMessage", body);
  }
  return is_int(sent?.message_id) ? sent.message_id : 0;
}

/** Sends plain `text` to `chat`, noting a failure. */
async function say(s: Shared, profile_id: string, token: string, chat: number, text: string) {
  try {
    await send_html(s, token, chat, escape(text), null, null);
  } catch (e) {
    if (e instanceof CallError) note_error(s, profile_id, e);
    else console.warn(`telegram: sending (profile ${profile_id}): ${err_str(e)}`);
  }
}

/** Notes that talking to Telegram failed (or with null, that it works again): whether that's news. */
function set_error(s: Shared, profile_id: string, error: string | null): boolean {
  // Read first, as most polls have nothing to change.
  if (config(s.db(), profile_id).last_error === error) return false;
  let news = false;
  try {
    news = update_config(s, profile_id, (c) => {
      const news = c.last_error !== error;
      c.last_error = error;
      return news;
    });
  } catch {}
  if (news) changed(s, profile_id);
  return news;
}

/** Notes a failure, logged when it's a new one (not each retry of the same). */
function note_error(s: Shared, profile_id: string, e: CallError) {
  if (set_error(s, profile_id, e.message)) console.warn(`telegram: ${e.message} (profile ${profile_id})`);
}

// ---------- polling ----------

/** Starts Telegram for every profile with a bot: their pollers, and what passes the assistants' messages on to them. */
export function start(s: Shared) {
  if (s.telegram.started) return;
  s.telegram.started = true;
  watch(s);
  let profiles: string[] = [];
  try {
    profiles = db.list_profiles(s.db()).map((p) => p.id);
  } catch {}
  for (const p of profiles) restart(s, p);
}

/** Stops every profile's poller and sender, and the watching of events (for tests; the server stops with its process). */
export function stop(s: Shared) {
  for (const h of s.telegram.pollers.values()) h.stop.abort();
  s.telegram.pollers.clear();
  s.telegram.unwatch?.();
  s.telegram.unwatch = null;
  s.telegram.started = false;
}

/** (Re)starts profile `profile_id`'s poller and sender, or stops them if it has no token. */
export function restart(s: Shared, profile_id: string) {
  const has_token = token(s.db(), profile_id) !== null;
  const old = s.telegram.pollers.get(profile_id);
  if (old) {
    old.stop.abort();
    s.telegram.pollers.delete(profile_id);
  }
  if (!has_token) return;
  const h: Pollers = { stop: new AbortController(), poller_done: false };
  s.telegram.pollers.set(profile_id, h);
  const signal = h.stop.signal;
  const ended = (what: string) => (e: unknown) => {
    if (!(e instanceof Stopped)) console.error(`telegram: the ${what} stopped (profile ${profile_id}): ${err_str(e)}`);
  };
  poll(s, profile_id, signal)
    .finally(() => (h.poller_done = true))
    .catch(ended("poller"));
  sender(s, profile_id, signal).catch(ended("sender"));
}

/** Whether profile `profile_id`'s poller is running. */
export function polling(s: Shared, profile_id: string): boolean {
  const h = s.telegram.pollers.get(profile_id);
  return !!h && !h.poller_done;
}

/** Profile `profile_id` was deleted: its bot stops and its settings go. */
export function forget_profile(s: Shared, profile_id: string) {
  const h = s.telegram.pollers.get(profile_id);
  if (h) {
    h.stop.abort();
    s.telegram.pollers.delete(profile_id);
  }
  const c = s.db();
  for (const key of keys(profile_id)) {
    try {
      db.set_setting(c, key, null);
    } catch {}
  }
}

/**
 * Removes profile `profile_id`'s bot from this host: its token, chat, offset and queued sends (its choice of events
 * stays), and stops it.
 */
export function remove_bot(s: Shared, profile_id: string) {
  const c = s.db();
  const events = config(c, profile_id).events;
  for (const key of keys(profile_id)) db.set_setting(c, key, null);
  write(c, config_key(profile_id), { ...Config_default(), events });
  restart(s, profile_id);
  changed(s, profile_id);
}

/**
 * Profile `profile_id`'s assistant moved off `old_host` (null: this host): its bot there is removed, so that it doesn't go
 * on reading the owner's messages for an assistant that's no longer there. It's set up again on the assistant's new
 * host. A host that's offline (or too old for Telegram) keeps it.
 */
export async function assistant_moved(s: Shared, name: string, profile_id: string, old_host: string | null) {
  const host = old_host && old_host !== s.host_id ? old_host : null;
  if (host === null) {
    if (token(s.db(), profile_id) !== null) {
      console.info(`telegram: the assistant moved to another host: removing its bot here (profile ${profile_id})`);
      try {
        remove_bot(s, profile_id);
      } catch (e) {
        console.warn(`telegram: removing the bot (profile ${profile_id}): ${err_str(e)}`);
      }
    }
    return;
  }
  const api: number | undefined = s.links.get(host)?.version?.api_version;
  if (api === undefined || api < TELEGRAM_API) {
    if (api === undefined) console.warn(`telegram: ${host}, which the assistant moved off, is offline: remove its bot there (profile ${profile_id})`);
    return;
  }
  let profiles: any;
  try {
    profiles = await hub.host_request(s, host, "GET", "/api/profiles");
  } catch (e) {
    return void console.warn(`telegram: reading ${host}'s profiles to remove its bot (profile ${profile_id}): ${err_str(e)}`);
  }
  const there = (Array.isArray(profiles) ? profiles : []).find((r: any) => r?.name === name)?.id;
  if (typeof there !== "string") return;
  try {
    await hub.host_request(s, host, "PATCH", `/api/profiles/${there}/telegram`, { token: null });
  } catch (e) {
    console.warn(`telegram: removing the bot on ${host} (profile ${profile_id}): ${err_str(e)}`);
  }
}

/**
 * Reads profile `profile_id`'s bot's updates for as long as it has its token, handling each in turn and noting after
 * each that it's done, so that a restart carries on after it.
 */
async function poll(s: Shared, profile_id: string, signal: AbortSignal) {
  let backoff = 1;
  for (;;) {
    if (signal.aborted) return;
    const t = token(s.db(), profile_id);
    if (t === null) return;
    const offset = progress(s.db(), profile_id).offset;
    const wait = s.telegram.poll_secs;
    let updates: any;
    try {
      updates = await call(s, t, "getUpdates", { offset, timeout: wait, allowed_updates: UPDATES }, (wait + 15) * 1000, signal);
    } catch (e) {
      if (!(e instanceof CallError)) throw e;
      note_error(s, profile_id, e);
      // A token Telegram doesn't know won't start working: wait longer.
      const secs = e.is_api(401) ? 300 : e.kind === "api" && e.retry_after !== null ? Math.min(e.retry_after, 300) : backoff;
      await sleep_or_stop(secs * 1000, signal);
      backoff = Math.min(backoff * 2, 60);
      continue;
    }
    if (!Array.isArray(updates)) continue;
    backoff = 1;
    set_error(s, profile_id, null);
    for (const u of updates) {
      const id = u?.update_id;
      if (!is_int(id) || id < offset) continue;
      if (signal.aborted) return;
      await handle(s, profile_id, t, u, signal);
      if (signal.aborted) return;
      quietly(profile_id, "saving the update offset", () => update_progress(s, profile_id, (p) => void (p.offset = Math.max(p.offset, id + 1))));
    }
  }
}

/** The code in a `/start <code>` (or `/start@bot <code>`), if it's one. */
export function start_code(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("/start")) return null;
  let rest = t.slice("/start".length);
  if (rest.startsWith("@")) {
    const after = rest.slice(1);
    const ws = after.search(/\s/u);
    rest = ws < 0 ? "" : after.slice(ws + 1);
  } else if (!(rest === "" || /^\s/u.test(rest))) {
    return null;
  }
  return rest.trim();
}

/** Someone's name, as Telegram gives it. */
function name_of(user: any): string {
  const name = [user?.first_name, user?.last_name].filter((n) => typeof n === "string").join(" ");
  if (name.trim() === "") return typeof user?.username === "string" ? user.username : "someone";
  return name;
}

/** A message or a button press from someone other than the owner: dropped, logged and counted. */
function drop_stranger(s: Shared, profile_id: string, user: any, chat: any, what: string) {
  const who = `${name_of(user)} (${is_int(user?.id) ? user.id : 0})`;
  console.warn(`telegram: dropped a ${what} from ${who}, who isn't linked to this bot (profile ${profile_id}, chat ${is_int(chat?.id) ? chat.id : 0})`);
  quietly(profile_id, "counting a dropped message", () =>
    update_config(s, profile_id, (c) => {
      const d = (c.dropped ??= { count: 0, last_from: "", last_at: "" });
      d.count += 1;
      d.last_from = who;
      d.last_at = now();
    }),
  );
  changed(s, profile_id);
}

/** Handles one update. */
async function handle(s: Shared, profile_id: string, token: string, u: any, signal: AbortSignal) {
  if (u?.callback_query !== undefined) return await button(s, profile_id, token, u.callback_query);
  const m = u?.message;
  if (m === undefined) return;
  const chat = m?.chat, from = m?.from;
  const chat_id = chat?.id, user_id = from?.id;
  if (!is_int(chat_id) || !is_int(user_id)) return;
  const text: string = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
  const cfg = config(s.db(), profile_id);
  const is_owner = !!cfg.owner && cfg.owner.chat_id === chat_id && cfg.owner.user_id === user_id;
  const code = start_code(text);
  if (code) {
    if (await link(s, profile_id, token, m, code)) return;
    // Silently, as anything else from a stranger: the bot doesn't say whose it is.
    if (!is_owner) return drop_stranger(s, profile_id, from, chat, "linking code that isn't valid");
  }
  if (!is_owner) return drop_stranger(s, profile_id, from, chat, "message");
  if (code !== null) return await say(s, profile_id, token, chat_id, "This chat is linked to your assistant: what you send here goes to it.");
  await forward(s, profile_id, token, chat_id, m, text, signal);
}

/** `/start <code>` from message `m`: links its chat if the code is the one waiting. Whether it did. */
async function link(s: Shared, profile_id: string, token: string, m: any, code: string): Promise<boolean> {
  const chat_id: number = is_int(m.chat?.id) ? m.chat.id : 0;
  const is_private = m.chat?.type === "private";
  const owner: Owner = {
    chat_id,
    user_id: is_int(m.from?.id) ? m.from.id : 0,
    name: name_of(m.from),
    username: opt_str(m.from?.username),
    linked_at: now(),
  };
  let ok: boolean;
  try {
    ok = update_config(s, profile_id, (c) => {
      const ok = !!c.link && c.link.expires_at > now() && same_secret(c.link.code_hash, hash(code));
      // Spent either way: a code sent in a group has been seen by everyone there, any of whom could send it privately
      // (HA-207 review).
      if (ok) c.link = null;
      if (ok && is_private) c.owner = owner;
      return ok;
    });
  } catch {
    return false;
  }
  if (!ok) return false;
  if (!is_private) {
    console.warn(`telegram: a linking code was sent from a chat that isn't private, so it no longer works (profile ${profile_id}, chat ${chat_id})`);
    changed(s, profile_id);
    await say(
      s,
      profile_id,
      token,
      chat_id,
      "Link your assistant from a private chat with this bot, not a group. That code no longer works: make a new one on the board and send it here privately.",
    );
    return true;
  }
  console.info(`telegram: linked to ${owner.name} (profile ${profile_id}, chat ${chat_id})`);
  // What was sent or queued for a chat before isn't for this one.
  quietly(profile_id, "forgetting the last chat's prompts", () =>
    update_progress(s, profile_id, (p) => {
      p.prompts = {};
      p.awaiting = false;
    }),
  );
  quietly(profile_id, "emptying the queue", () => update_outbox(s, profile_id, (o) => void (o.items = [])));
  changed(s, profile_id);
  let name = "";
  try {
    name = db.get_profile(s.db(), profile_id)?.name ?? "";
  } catch {}
  await say(s, profile_id, token, chat_id, `Linked to the ${name} profile's assistant. What you send here goes to it, and it can reach you here.`);
  return true;
}

/** The files in message `m`: each one's Telegram id, a name to save it as, and its size if known. */
function files_of(m: any): Array<[string, string, number | null]> {
  const out: Array<[string, string, number | null]> = [];
  const add = (f: any, name: string) => {
    if (typeof f?.file_id === "string") out.push([f.file_id, name, is_uint(f.file_size) ? f.file_size : null]);
  };
  // Its sizes, smallest first.
  if (Array.isArray(m.photo) && m.photo.length) add(m.photo[m.photo.length - 1], "photo.jpg");
  const named = (f: any, fallback: string) => (typeof f.file_name === "string" && f.file_name.trim() !== "" ? f.file_name : fallback);
  const kinds: Array<[string, string]> = [
    ["voice", "voice-note.ogg"],
    ["audio", "audio.mp3"],
    ["document", "file"],
    ["video", "video.mp4"],
    ["video_note", "video-note.mp4"],
  ];
  for (const [field, fallback] of kinds) if (is_obj(m[field])) add(m[field], named(m[field], fallback));
  return out;
}

function too_big(): string {
  return `it's larger than ${attachments.MAX_BYTES >> 20} MB`;
}

/** Fetches file `file_id` from Telegram, if it's no bigger than an attachment can be. Throws the reason it couldn't. */
async function download(s: Shared, token: string, file_id: string): Promise<Buffer> {
  let f: any;
  try {
    f = await call(s, token, "getFile", { file_id }, 30_000);
  } catch (e) {
    throw new Error(e instanceof CallError ? e.message : without_token(e, token));
  }
  const path: string = typeof f?.file_path === "string" ? f.file_path : "";
  // A path on Telegram's file server, as it gave it: nothing that could lead elsewhere.
  if (path === "" || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "") || /[?#\\%]/.test(path)) {
    throw new Error("Telegram gave no file to fetch");
  }
  if (is_uint(f.file_size) && f.file_size > attachments.MAX_BYTES) throw new Error(too_big());
  const url = `${s.telegram.api}/file/bot${token}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new Error(without_token(e, token));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Telegram answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (res.body) for await (const chunk of res.body) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      // Leaving the loop cancels the rest.
      if (size > attachments.MAX_BYTES) throw new Error(too_big());
    }
  } catch (e) {
    throw new Error(without_token(e, token));
  }
  return Buffer.concat(chunks);
}

/** The owner's message `m` (`text`, and its files) goes to the assistant as theirs. */
async function forward(s: Shared, profile_id: string, token: string, chat_id: number, m: any, text: string, signal: AbortSignal) {
  const paths: string[] = [];
  const notes: string[] = [];
  for (const [id, name, size] of files_of(m)) {
    if (size !== null && size > attachments.MAX_BYTES) {
      notes.push(`(${name} wasn't passed on: ${too_big()})`);
      continue;
    }
    try {
      const data = await download(s, token, id);
      const [, , path] = await attachments.save(s, name, data);
      paths.push(path);
    } catch (e) {
      notes.push(`(${name} wasn't passed on: ${err_str(e)})`);
    }
  }
  if (signal.aborted) return;
  let body = text.trim();
  for (const n of notes) body = body === "" ? n : `${body}\n\n${n}`;
  const message = attachments.listed(body, paths);
  if (message.trim() === "") return await say(s, profile_id, token, chat_id, "Send text, photos, voice notes or files: they go to your assistant.");
  // Before it's sent, so a reply that comes at once still goes back.
  quietly(profile_id, "noting a reply is awaited", () => update_progress(s, profile_id, (p) => void (p.awaiting = true)));
  try {
    assistant.send(s, profile_id, message);
  } catch (e) {
    quietly(profile_id, "noting no reply is awaited", () => update_progress(s, profile_id, (p) => void (p.awaiting = false)));
    console.warn(`telegram: passing a message on to the assistant (profile ${profile_id}): ${err_str(e)}`);
    return await say(s, profile_id, token, chat_id, `That didn't reach the assistant: ${err_str(e)}`);
  }
  if (notes.length) await say(s, profile_id, token, chat_id, notes.join("\n"));
  await call(s, token, "sendChatAction", { chat_id, action: "typing" }, 10_000).catch(() => {});
}

/**
 * A press of a prompt's Allow or Deny (`allow:<request id>` or `deny:<request id>`), answered as the board's buttons
 * answer it, if it's the owner's.
 */
async function button(s: Shared, profile_id: string, token: string, cb: any) {
  const reply = (text: string) => ({ callback_query_id: cb?.id, text });
  const cfg = config(s.db(), profile_id);
  const user = cb?.from?.id, chat = cb?.message?.chat?.id;
  if (!cfg.owner || !is_int(user) || !is_int(chat) || cfg.owner.user_id !== user || cfg.owner.chat_id !== chat) {
    drop_stranger(s, profile_id, cb?.from, cb?.message?.chat, "button press");
    await call(s, token, "answerCallbackQuery", reply("Only the person this bot is linked to can answer."), 10_000).catch(() => {});
    return;
  }
  const data: string = typeof cb.data === "string" ? cb.data : "";
  const i = data.indexOf(":");
  const verb = i < 0 ? "" : data.slice(0, i), id = data.slice(i + 1);
  if (verb !== "allow" && verb !== "deny") return;
  const allow = verb === "allow";
  let text: string;
  try {
    answer(s, profile_id, id, allow);
    text = allow ? "Allowed." : "Denied.";
  } catch (e) {
    // It ended some other way: say how on its message, if it hasn't been.
    const settled = settled_prompt(s, id);
    if (settled !== null) queue(profile_id, s, { kind: "settled", request_id: id, outcome: settled });
    text = err_str(e);
  }
  await call(s, token, "answerCallbackQuery", reply(text), 10_000).catch(() => {});
}

/**
 * Answers prompt `id` of profile `profile_id`'s assistant (or one of its routines), as the board's buttons do: a prompt
 * that has expired by now is expired first, so it can't be allowed late. Throws what to tell the user if it can't.
 */
export function answer(s: Shared, profile_id: string, id: string, allow: boolean): "allowed" | "denied" {
  const not_ours = "That prompt isn't this assistant's.";
  const row = db.one<{ task_id: string; tool_name: string; kind: string }>(s.db(), "SELECT task_id, tool_name, kind FROM permission_requests WHERE id=?1", id);
  if (!row) throw new Error(not_ours);
  const task = db.get_task(s.db(), row.task_id);
  if (!task || task.profile_id !== profile_id || !db.is_assistants(task)) throw new Error(not_ours);
  // Only what its buttons were offered for: questions, plans and changes to the board are answered there.
  if (!push_answers.answerable({ tool_name: row.tool_name, kind: row.kind })) throw new Error("Answer this one on the board.");
  permissions.expire_due(s, new Date());
  try {
    return permissions.answer_by(s, id, allow, false, null, {}, "telegram");
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new Error("It isn't waiting for an answer any more.");
    throw new Error(`It couldn't be answered: ${err_str(e)}`);
  }
}

/** How prompt `id` ended, as its message is edited to say, if it has. */
function settled_prompt(s: Shared, id: string): string | null {
  const row = db.one<{ status: string; note: string | null }>(s.db(), "SELECT status, note FROM permission_requests WHERE id=?1", id);
  return row && row.status !== "pending" ? outcome(row.status, row.note ?? null) : null;
}

/** What a prompt that ended with `status` says at its end. */
function outcome(status: string, note: string | null): string {
  switch (status) {
    case "allowed":
      return "✅ Allowed";
    case "denied":
      return "❌ Denied";
    case "expired":
      return note === permissions.EXPIRED_UNANSWERED ? "⌛ Expired: nobody answered in time, so it was denied" : "⌛ Ended: the run stopped before it was answered";
    default:
      return `Ended (${status})`;
  }
}

// ---------- what goes out ----------

/** Something to send to a profile's owner. */
export type Item =
  /** The assistant's words, in Markdown. */
  | { kind: "markdown"; md: string }
  /** Made here, in Telegram's HTML. */
  | { kind: "html"; html: string }
  /** A permission prompt, with Allow and Deny if `buttons`. */
  | { kind: "prompt"; request_id: string; html: string; buttons: boolean }
  /** A prompt sent before ended (`outcome`): its message is edited to say so. */
  | { kind: "settled"; request_id: string; outcome: string };

export interface Queued {
  id: number;
  item: Item;
  /** The pieces of a long message sent already. */
  sent: number;
}

/**
 * A profile's sends that haven't gone yet, oldest first: kept (in `telegram_outbox:<id>`) until Telegram takes each, so
 * that a failure or a restart doesn't lose them.
 */
export interface Outbox {
  next: number;
  items: Queued[];
}

/** The most sends kept for a profile while Telegram can't be reached: the oldest go past it. */
const MAX_QUEUED = 300;

/** The longest wait between tries of a send that failed. */
const MAX_BACKOFF = 300;

export function outbox(c: Conn, profile_id: string): Outbox {
  return read(c, outbox_key(profile_id), Outbox_from_json, () => ({ next: 0, items: [] }));
}

function update_outbox<R>(s: Shared, profile_id: string, f: (o: Outbox) => R): R {
  const c = s.db();
  const o = outbox(c, profile_id);
  const r = f(o);
  write(c, outbox_key(profile_id), o);
  return r;
}

/** Queues `item` for profile `profile`'s owner, and wakes its sender. */
function queue(profile: string, s: Shared, item: Item) {
  try {
    update_outbox(s, profile, (o) => {
      o.next += 1;
      o.items.push({ id: o.next, item, sent: 0 });
      while (o.items.length > MAX_QUEUED) o.items.shift();
    });
  } catch (e) {
    return void console.warn(`telegram: queueing a send (profile ${profile}): ${err_str(e)}`);
  }
  s.telegram.waker(profile).notify_one();
}

/**
 * Whether a failed call may work if tried again later: Telegram unreachable or failing, too many requests, or a token
 * that may be set again.
 */
function transient(e: CallError): boolean {
  return e.kind === "net" || e.code === 429 || e.code === 401 || e.code >= 500;
}

/**
 * Sends profile `profile_id`'s queue, in order (a prompt's edit after the prompt), for as long as it has a bot: each item
 * stays queued until Telegram takes it, and one that failed for a while is tried again later, waiting longer each time.
 * One Telegram refuses outright is dropped.
 */
async function sender(s: Shared, profile_id: string, signal: AbortSignal) {
  reconcile(s, profile_id);
  const waker = s.telegram.waker(profile_id);
  let backoff = 1;
  for (;;) {
    if (signal.aborted) return;
    const q = outbox(s.db(), profile_id).items[0];
    if (!q) {
      await waker.notified(signal);
      continue;
    }
    const l = linked(s.db(), profile_id);
    if (!l) {
      // Nobody to send to: what was queued was for a chat that's gone.
      quietly(profile_id, "emptying the queue", () => update_outbox(s, profile_id, (o) => void (o.items = [])));
      continue;
    }
    const [t, , owner] = l;
    let failed: unknown = null;
    try {
      await deliver(s, profile_id, t, owner.chat_id, q, signal);
    } catch (e) {
      failed = e;
    }
    if (signal.aborted) return;
    if (failed === null) {
      backoff = 1;
      set_error(s, profile_id, null);
      quietly(profile_id, "taking a send off the queue", () => update_outbox(s, profile_id, (o) => void (o.items = o.items.filter((x) => x.id !== q.id))));
      continue;
    }
    if (!(failed instanceof CallError)) throw failed;
    const e = failed;
    note_error(s, profile_id, e);
    if (transient(e)) {
      const wait = e.kind === "api" && e.retry_after !== null ? Math.min(Math.max(e.retry_after, 1), MAX_BACKOFF) : e.is_api(401) ? MAX_BACKOFF : backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      // Something newly queued doesn't hurry it: the queue goes in order.
      await sleep_or_stop(wait * 1000, signal);
      continue;
    }
    console.warn(`telegram: dropped a send Telegram refused (profile ${profile_id}): ${e.message}`);
    quietly(profile_id, "dropping a send", () => update_outbox(s, profile_id, (o) => void (o.items = o.items.filter((x) => x.id !== q.id))));
    if (q.item.kind === "settled") {
      const request = q.item.request_id;
      quietly(profile_id, "forgetting a prompt", () => update_progress(s, profile_id, (p) => void delete p.prompts[request]));
    }
  }
}

/** Sends one queued item. */
async function deliver(s: Shared, profile_id: string, token: string, chat: number, q: Queued, signal: AbortSignal) {
  const item = q.item;
  switch (item.kind) {
    case "markdown": {
      // Carrying on after the pieces sent already.
      const pieces = split(item.md, PIECE_CHARS);
      for (let i = q.sent; i < pieces.length; i++) {
        await send_html(s, token, chat, to_html(pieces[i]), pieces[i], null);
        if (signal.aborted) return;
        quietly(profile_id, "noting a piece sent", () =>
          update_outbox(s, profile_id, (o) => {
            for (const x of o.items) if (x.id === q.id) x.sent = i + 1;
          }),
        );
      }
      return;
    }
    case "html":
      await send_html(s, token, chat, item.html, null, null);
      return;
    case "prompt": {
      const markup = item.buttons
        ? {
            inline_keyboard: [
              [
                { text: "✅ Allow", callback_data: `allow:${item.request_id}` },
                { text: "❌ Deny", callback_data: `deny:${item.request_id}` },
              ],
            ],
          }
        : null;
      const message_id = await send_html(s, token, chat, item.html, null, markup);
      if (item.buttons && !signal.aborted) {
        quietly(profile_id, "remembering a prompt", () =>
          update_progress(s, profile_id, (p) => {
            p.prompts[item.request_id] = { message_id, html: item.html };
            while (Object.keys(p.prompts).length > MAX_PROMPTS) {
              let oldest: string | null = null;
              for (const [k, v] of Object.entries(p.prompts)) if (oldest === null || v.message_id < p.prompts[oldest].message_id) oldest = k;
              if (oldest === null) break;
              delete p.prompts[oldest];
            }
          }),
        );
      }
      return;
    }
    case "settled": {
      // Its message is forgotten only once it's edited, so a failed edit is tried again.
      const sent = progress(s.db(), profile_id).prompts[item.request_id];
      if (!sent) return;
      const body = {
        chat_id: chat,
        message_id: sent.message_id,
        text: `${sent.html}\n\n<b>${escape(item.outcome)}</b>`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      };
      try {
        await call_patiently(s, token, "editMessageText", body);
      } catch (e) {
        if (!(e instanceof CallError && e.is_api(400) && e.description.includes("not modified"))) throw e;
      }
      if (signal.aborted) return;
      quietly(profile_id, "forgetting a prompt", () => update_progress(s, profile_id, (p) => void delete p.prompts[item.request_id]));
      return;
    }
  }
}

/** Prompts whose messages still have their buttons but that ended while nobody was sending (the board was down, say): their edits are queued. */
function reconcile(s: Shared, profile_id: string) {
  const sent = Object.keys(progress(s.db(), profile_id).prompts);
  const queued = new Set<string>();
  for (const q of outbox(s.db(), profile_id).items) if (q.item.kind === "prompt" || q.item.kind === "settled") queued.add(q.item.request_id);
  for (const id of sent) {
    if (queued.has(id)) continue;
    let row: { status: string; note: string | null } | undefined;
    try {
      row = db.one(s.db(), "SELECT status, note FROM permission_requests WHERE id=?1", id);
    } catch {
      continue;
    }
    if (row?.status === "pending") continue;
    // Gone with its thread, if there's no row.
    const ended = row ? outcome(row.status, row.note ?? null) : "Ended";
    queue(profile_id, s, { kind: "settled", request_id: id, outcome: ended });
  }
}

/**
 * Watches this host's events for what the assistants' owners hear of on Telegram. Each is handled after the code that
 * emitted it has carried on (as Rust's receiver task saw it), in order.
 */
function watch(s: Shared) {
  // The assistants' statuses and whether they run, to tell when one comes to need attention or stops.
  const statuses = new Map<string, [string, boolean]>();
  const pending: any[] = [];
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    while (pending.length) {
      const ev = pending.shift();
      try {
        observe(s, ev, statuses);
      } catch (e) {
        console.error(`telegram: ${err_str(e)}`);
      }
    }
  };
  s.telegram.unwatch = s.events.subscribe((ev) => {
    pending.push(ev);
    if (!scheduled) {
      scheduled = true;
      setImmediate(drain);
    }
  });
}

/** What event `ev` sends to Telegram, if anything. */
export function observe(s: Shared, ev: any, statuses: Map<string, [string, boolean]>) {
  switch (ev?.type) {
    case "message":
      return on_message(s, ev.message);
    case "message_updated": {
      const m = ev.message;
      const status = typeof m?.data?.status === "string" ? m.data.status : "pending";
      if (m?.kind !== "permission" || status === "pending") return;
      const task_id = m.task_id, request = m.data?.request_id;
      if (typeof task_id !== "string" || typeof request !== "string") return;
      const t = assistants_task(s, task_id);
      if (!t) return;
      const note = typeof m.data.note === "string" ? m.data.note : null;
      return queue(t.profile_id, s, { kind: "settled", request_id: request, outcome: outcome(status, note) });
    }
    case "task": {
      const t = ev.task;
      if (t?.task_type !== "assistant") return;
      const id = t.id, status = t.status;
      if (typeof id !== "string" || typeof status !== "string") return;
      const running = t.running === true;
      const before = statuses.get(id);
      statuses.set(id, [status, running]);
      if (!before) return;
      const [was, ran] = before;
      if (ran && !running) {
        const task = db.get_task(s.db(), id);
        if (task) run_ended(s, task);
      }
      if (status !== "needs_attention" || was === "needs_attention") return;
      const task = db.get_task(s.db(), id);
      if (task) on_attention(s, task);
      return;
    }
    case "task_deleted":
      if (typeof ev.id === "string") statuses.delete(ev.id);
      return;
  }
}

/** Task `task_id`, if it's an assistant's or its routine's and its profile's bot is linked. */
function assistants_task(s: Shared, task_id: string): Task | null {
  const t = db.get_task(s.db(), task_id);
  if (!t || !db.is_assistants(t)) return null;
  return linked(s.db(), t.profile_id) ? t : null;
}

function events_of(s: Shared, profile_id: string): Events {
  return config(s.db(), profile_id).events;
}

/** The key a task goes by (`A-3`). */
function key(t: Task): string {
  return `${db.ASSISTANT_TASK_KEY}-${t.number}`;
}

function on_message(s: Shared, m: any) {
  const kind: string = typeof m?.kind === "string" ? m.kind : "";
  const data = m?.data ?? {};
  const relevant = kind === "claude" ? data.type === "result" : kind === "report" ? true : kind === "permission" || kind === "question" ? data.status === "pending" : false;
  if (!relevant) return;
  const task_id = m.task_id;
  if (typeof task_id !== "string") return;
  if (kind === "claude") {
    // Every assistant's, for push (push.REPLY_EVENT), whether or not it has a bot.
    const task = db.get_task(s.db(), task_id);
    if (task && db.is_assistant(task)) on_turn_end(s, task, is_int(m.id) ? m.id : 0, TurnEnd_of(data));
    return;
  }
  const task = assistants_task(s, task_id);
  if (!task) return;
  const events = events_of(s, task.profile_id);
  if (kind === "report" && events.reports && db.is_assistant(task)) {
    const name = typeof data.automation === "string" ? data.automation : "A routine";
    const text = typeof data.text === "string" ? data.text : "";
    const head = data.outcome === "failed" ? `⚠️ **${name}** failed:` : data.outcome === "asked" ? `❓ **${name}** needs you:` : `📋 **${name}**`;
    queue(task.profile_id, s, { kind: "markdown", md: `${head}\n\n${text}` });
  } else if (kind === "permission" && events.prompts) {
    on_prompt(s, task, data);
  } else if (kind === "question" && events.prompts && db.is_assistant(task)) {
    let html = `❓ <b>${escape(key(task))}</b> asks:\n\n${escape(typeof data.question === "string" ? data.question : "")}`;
    (Array.isArray(data.options) ? data.options : []).forEach((o: any, i: number) => {
      html += `\n${i + 1}. ${escape(typeof o?.label === "string" ? o.label : "")}`;
    });
    html += "\n\n<i>Reply here to answer.</i>";
    queue(task.profile_id, s, { kind: "html", html });
  }
}

/**
 * How the assistant's turn ended, from its `result`: only a turn that went as it should is a reply. `compact`: a
 * compaction's end (a `/compact` run's, the user's or the board's after the thread was idle a while), which answers
 * nothing. `failed`: it failed (an error, or the usage limit) or was stopped part way: its needs attention says so.
 */
export type TurnEnd = "reply" | "compact" | "failed";

export function TurnEnd_of(result: any): TurnEnd {
  if (result?.compact === true) return "compact";
  if (result?.is_error === true || result?.interrupted === true || (typeof result?.subtype === "string" && result.subtype.startsWith("error"))) return "failed";
  return "reply";
}

/**
 * The assistant's turn ended (its `result`, message `message_id`): its reply goes back if a message from Telegram was
 * waiting for one, or if every reply is to. Either way it's announced for push (`announce_reply`), which sends the replies
 * that weren't asked for on Telegram. A turn that isn't a reply (`TurnEnd`) is only noted as looked at: a compaction
 * leaves a message from Telegram waiting for the next turn, and a failed turn has answered it (with the attention it
 * needs, see `on_attention`).
 */
function on_turn_end(s: Shared, task: Task, message_id: number, end: TurnEnd) {
  const text = end === "reply" ? reply_text(s, task, message_id) : null;
  const l = linked(s.db(), task.profile_id);
  if (!l) {
    // No bot: nothing came from Telegram, and the turn's result comes once.
    if (text !== null) announce_reply(s, task, message_id, false);
    return;
  }
  const cfg = l[1];
  // A message queued or steered in that this turn didn't take is answered by the next.
  const now_task = db.get_task(s.db(), task.id);
  const more = !!now_task && (now_task.queued_message !== null || now_task.steering.length > 0);
  let seen: [boolean, boolean] | null = null;
  try {
    seen = update_progress(s, task.profile_id, (p): [boolean, boolean] | null => {
      if (message_id <= p.replied) return null;
      p.replied = message_id;
      if (end === "compact") return null;
      const asked = p.awaiting;
      p.awaiting = asked && more;
      return end === "reply" ? [asked || cfg.events.replies, asked] : null;
    });
  } catch {}
  if (!seen || text === null) return;
  const [send, asked] = seen;
  announce_reply(s, task, message_id, asked);
  if (send) queue(task.profile_id, s, { kind: "markdown", md: text });
}

/**
 * What the assistant said in the turn that ended with message `message_id`: since the user's last message, and since the
 * turn before ended (so a turn that said nothing doesn't say the last one's reply again). Null if it said nothing.
 */
function reply_text(s: Shared, task: Task, message_id: number): string | null {
  const c = s.db();
  let asked = 0;
  try {
    asked =
      db.value<number>(
        c,
        `SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND id < ?2
           AND (kind='user' OR (kind='claude' AND json_extract(data,'$.type')='result'))`,
        task.id,
        message_id,
      ) ?? 0;
  } catch {}
  let text: string | null = null;
  try {
    text = db.last_assistant_text_after(c, task.id, asked);
  } catch {}
  return text !== null && text.trim() !== "" ? text : null;
}

/**
 * Tells the board (its push, push.REPLY_EVENT) that the assistant replied, and whether to a message sent on Telegram,
 * which is the one thing only this host knows: the board's push sends the others.
 */
function announce_reply(s: Shared, task: Task, message_id: number, telegram: boolean) {
  s.emit({ type: push.REPLY_EVENT, task_id: task.id, profile_id: task.profile_id, message_id, telegram });
}

/**
 * The assistant's run ended. A turn it ended with is answered as its `result` comes (once, whichever is seen first), and
 * a run that stopped without one (it failed, or was stopped) leaves nothing to answer: a message from Telegram no longer
 * waits for a reply, so the next turn's isn't sent for it.
 */
function run_ended(s: Shared, task: Task) {
  if (!db.is_assistant(task) || !linked(s.db(), task.profile_id)) return;
  let last: { id: number; data: string } | undefined;
  try {
    last = db.one(
      s.db(),
      "SELECT id, data FROM messages WHERE task_id=?1 AND kind='claude' AND json_extract(data,'$.type')='result' ORDER BY id DESC LIMIT 1",
      task.id,
    );
  } catch {}
  const replied = progress(s.db(), task.profile_id).replied;
  if (last && last.id > replied) {
    let data: any = null;
    try {
      data = JSON.parse(last.data);
    } catch {}
    const end = TurnEnd_of(data);
    on_turn_end(s, task, last.id, end);
    // A compaction answered nothing: as a run that stopped without a turn's end.
    if (end !== "compact") return;
  }
  const more = task.queued_message !== null || task.steering.length > 0;
  if (!more) quietly(task.profile_id, "noting no reply is awaited", () => update_progress(s, task.profile_id, (p) => void (p.awaiting = false)));
}

const two = (n: number) => String(n).padStart(2, "0");

/** A prompt the assistant (or one of its routines) raised: with Allow and Deny if those can answer it. */
function on_prompt(s: Shared, task: Task, data: any) {
  const request = data?.request_id;
  if (typeof request !== "string") return;
  const buttons = push_answers.answerable(data);
  let html = `🔐 <b>${escape(key(task))} ${escape(cut(task.title, 80))}</b>\n${escape(push.prompt_text(data))}`;
  if (buttons) {
    const summary = approval_rules.summarize(data.input);
    if (summary.trim() !== "") html += `\n<code>${escape(cut(summary, 500))}</code>`;
    if (typeof data.rule?.tool === "string") html += `\n<i>Asked by the rule ${escape(data.rule.tool)}</i>`;
    const at = typeof data.expires_at === "string" ? new Date(data.expires_at) : null;
    // In this host's time zone.
    if (at && !Number.isNaN(at.getTime())) html += `\n<i>Denied if not answered by ${two(at.getHours())}:${two(at.getMinutes())}</i>`;
  } else {
    html += "\n<i>Answer it on the board.</i>";
  }
  queue(task.profile_id, s, { kind: "prompt", request_id: request, html, buttons });
}

/** The assistant came to need attention: said, unless it's for a prompt or question that was sent already, or the user stopped it. */
function on_attention(s: Shared, task: Task) {
  if (!linked(s.db(), task.profile_id) || !events_of(s, task.profile_id).attention) return;
  const reason = task.attention_reason ?? "";
  if (reason === push.STOPPED) return;
  let waiting = 0;
  try {
    waiting =
      db.value<number>(
        s.db(),
        `SELECT (SELECT COUNT(*) FROM permission_requests WHERE task_id=?1 AND status='pending')
              + (SELECT COUNT(*) FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data,'$.status')='pending')`,
        task.id,
      ) ?? 0;
  } catch {}
  if (waiting > 0) return;
  const why = reason === "" ? "" : `: ${escape(cut(reason, 300))}`;
  queue(task.profile_id, s, { kind: "html", html: `⚠️ <b>${escape(key(task))}</b> needs attention${why}` });
}

// ---------- API ----------

/** What the API shows of profile `profile_id`'s bot: never its token. */
function view(s: Shared, profile_id: string): any {
  const c = s.db();
  const has_token = token(c, profile_id) !== null;
  const cfg = config(c, profile_id);
  const linking = cfg.link && cfg.link.expires_at > now() ? { expires_at: cfg.link.expires_at } : null;
  return {
    configured: has_token,
    bot: cfg.bot,
    owner: cfg.owner ? { name: cfg.owner.name, username: cfg.owner.username, linked_at: cfg.owner.linked_at } : null,
    events: cfg.events,
    linking,
    last_error: cfg.last_error,
    dropped: cfg.dropped,
    polling: has_token && polling(s, profile_id),
    queued: outbox(c, profile_id).items.length,
  };
}

function check_profile(s: Shared, id: string) {
  if (!db.get_profile(s.db(), id)) throw ApiError.not_found("profile");
}

/** `GET /profiles/{id}/telegram` (API 117): the profile's bot, who it's linked to and what it sends. */
export async function get(s: Shared, r: Req) {
  check_profile(s, r.params.id);
  return view(s, r.params.id);
}

const unreadable = (e: string) => new ApiError(422, `Failed to deserialize the JSON body into the target type: ${e}`);

/**
 * `PATCH /profiles/{id}/telegram`: sets the bot's token (checked with Telegram) or removes the bot, and what it sends. A
 * new bot is linked again. `token`: a bot token from @BotFather, or null to remove the bot; left out, it stays.
 */
export async function update(s: Shared, r: Req) {
  const id = r.params.id;
  check_profile(s, id);
  const b = is_obj(r.body) ? r.body : {};
  let events: Events | null = null;
  if (b.events != null) {
    try {
      events = Events_from_json(b.events);
    } catch (e) {
      throw unreadable(err_str(e));
    }
  }
  if (Object.hasOwn(b, "token") && b.token !== null && typeof b.token !== "string") throw unreadable("token must be a string or null");
  if (typeof b.token === "string") {
    const t = b.token.trim();
    if (!valid_token(t)) throw ApiError.bad("that isn't a bot token: @BotFather gives one like 123456789:AAH…");
    // Another of this host's profiles already reads this bot (by its id, the token's first part, as a bot's token can be
    // replaced): only one can.
    const bot_id = (t: string) => t.split(":")[0];
    const check_free = () => {
      const taken = db.list_profiles(s.db()).some((p) => {
        const o = p.id !== id ? token(s.db(), p.id) : null;
        return o !== null && bot_id(o) === bot_id(t);
      });
      if (taken) throw ApiError.conflict("another profile's assistant already uses this bot: make one for each");
    };
    check_free();
    let me: any;
    try {
      me = await call(s, t, "getMe", {}, 20_000);
    } catch (e) {
      throw ApiError.bad(`checking the token: ${e instanceof CallError ? e.message : without_token(e, t)}`);
    }
    const bot: Bot = { id: is_int(me?.id) ? me.id : 0, username: typeof me?.username === "string" ? me.username : "" };
    // Again, as another profile may have taken it while Telegram was asked (HA-207).
    check_free();
    const c = s.db();
    const same_bot = config(c, id).bot?.id === bot.id;
    db.set_setting(c, token_key(id), t);
    const cfg = config(c, id);
    if (!same_bot) {
      // Another bot: its chats and updates are its own.
      cfg.owner = null;
      cfg.link = null;
      cfg.dropped = null;
      write(c, progress_key(id), Progress_default());
      db.set_setting(c, outbox_key(id), null);
    }
    cfg.bot = bot;
    cfg.last_error = null;
    write(c, config_key(id), cfg);
    restart(s, id);
  } else if (Object.hasOwn(b, "token") && b.token === null) {
    remove_bot(s, id);
  }
  if (events) {
    const chosen = events;
    update_config(s, id, (c) => void (c.events = chosen));
  }
  changed(s, id);
  return view(s, id);
}

/**
 * `POST /profiles/{id}/telegram/link`: a new one-time code to send the bot as `/start <code>`, which links the chat it's
 * sent from (in place of the one linked before, if any).
 */
export async function new_link(s: Shared, r: Req) {
  const id = r.params.id;
  check_profile(s, id);
  if (token(s.db(), id) === null) throw ApiError.conflict("set the bot's token first");
  const code = Array.from(new_token())
    .filter((ch) => /^[A-Za-z0-9]$/.test(ch))
    .slice(0, 16)
    .join("");
  const expires_at = new Date(Date.now() + CODE_MINUTES * 60_000).toISOString();
  const bot = update_config(s, id, (c) => {
    c.link = { code_hash: hash(code), expires_at };
    return c.bot;
  });
  changed(s, id);
  const url = bot && bot.username !== "" ? `https://t.me/${bot.username}?start=${code}` : null;
  return { code, command: `/start ${code}`, url, expires_at };
}

/** `DELETE /profiles/{id}/telegram/owner`: unlinks the chat; the bot then listens to nobody until it's linked again. */
export async function unlink(s: Shared, r: Req) {
  const id = r.params.id;
  check_profile(s, id);
  update_config(s, id, (c) => {
    c.owner = null;
    c.link = null;
  });
  update_progress(s, id, (p) => {
    p.prompts = {};
    p.awaiting = false;
  });
  update_outbox(s, id, (o) => void (o.items = []));
  changed(s, id);
  return view(s, id);
}
