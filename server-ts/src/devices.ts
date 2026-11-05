// Port of server/src/devices.rs (HA-136, from the HA-117 branch at bb59d8a; ported by HA-208).
//
// Devices paired with this board, such as the mobile app on a phone (API 116). Each has a token of its own, kept only as
// its SHA-256 in `device_tokens`, which the API takes as well as the board's own token (`auth_token`), and which can be
// revoked: that cuts the device off at once, open websockets included. A lost phone is then no reason to replace
// `auth_token`.
//
// A device pairs from Settings → Network access → Phones, which shows a QR code of
// `huntaway://pair?url=<board>&code=<code>`. The code is good for five minutes and one pairing (`POST /devices/pair`
// swaps it and the device's name for its token), and is only kept in memory, so a restart forgets it. The QR code never
// holds `auth_token`.
//
// Paired devices can only use the routes the mobile app needs (see `HUB`): profiles, projects, tasks and their threads,
// attachments, permission prompts, the board's events and hosts, and the devices list, from which they may only unpair
// themselves. Nothing that would outlast revoking them: not the routes that hand out the board's or hub's token or a
// Claude login, linking hosts, terminals (a shell on the host), settings or admin.
//
// Revoking a device stops the device. It doesn't undo what was done with it before: whoever held it could have had an
// agent read the board's files (its `auth_token` among them), as any agent run can. After a phone is lost and may have
// been used, replace `auth_token` too (delete the file and restart: a new one is made).
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { WebSocket } from "ws";
import * as db from "./db.ts";
import { ApiError, type Req } from "./http.ts";
import type { AppState } from "./state.ts";
import { new_id, new_token, now } from "./util.ts";
import { API_VERSION } from "./hosts/proto.ts";

type Shared = AppState;

/** How long a pairing code is good for, in ms. */
export const CODE_TTL = 5 * 60 * 1000;

/** Codes waiting to be used at once, at most (older ones go first). */
export const MAX_CODES = 20;

/** A device's last use is written at most this often, in ms. */
const LAST_USED_EVERY = 60 * 1000;

/**
 * What the board keeps about pairing besides the table: the codes waiting to be used (each with when it stops being good,
 * on `performance.now()`'s clock, as Rust's `Instant`), and a counter that goes up whenever a device is revoked, which the
 * open websockets of paired devices watch.
 */
export class Devices {
  codes = new Map<string, number>();
  revoked = 0;
  private watchers = new Set<() => void>();

  /** Calls `f` after each revocation, until the function it returns is called. */
  watch(f: () => void): () => void {
    this.watchers.add(f);
    return () => void this.watchers.delete(f);
  }

  /** Rust's `revoked.send_modify(|n| *n += 1)`. */
  note_revoked() {
    this.revoked++;
    for (const f of [...this.watchers]) {
      try {
        f();
      } catch (e) {
        console.error("watching revoked devices:", e);
      }
    }
  }
}

/** A request made with a device's token (`Req.device`, set by the token check in api.ts). */
export interface DeviceAuth {
  id: string;
  /** `Devices.revoked` when the token was checked, so a revocation after that is seen. */
  revoked: number;
}

/** Whether `device` was revoked: its row is gone (checked only once a revocation happened since `seen`). */
function gone(s: Shared, id: string): boolean {
  try {
    return db.value<number>(s.db(), "SELECT COUNT(*) = 0 FROM device_tokens WHERE id=?1", id) === 1;
  } catch {
    return false;
  }
}

/**
 * Closes `ws` (a websocket's loop) when, for a paired device's request, that device is revoked. (Rust wraps each
 * websocket handler's future in it; here serve.ts calls it for every websocket a device opens, and the hub's proxy for
 * those it relays to a linked host.)
 */
export function until_revoked(s: Shared, device: DeviceAuth | null | undefined, ws: WebSocket): void {
  if (!device) return;
  let seen = device.revoked;
  let off = () => {};
  const check = () => {
    if (s.devices.revoked === seen) return;
    seen = s.devices.revoked;
    if (!gone(s, device.id)) return;
    off();
    console.info(`closed a websocket of device ${device.id}, which was revoked`);
    ws.close(1008, "this device was unpaired");
    // As dropping the connection: a client that doesn't answer the close doesn't keep it.
    setTimeout(() => ws.terminate(), 1000).unref();
  };
  off = s.devices.watch(check);
  ws.once("close", () => off());
  // Revoked between the token check and the upgrade.
  check();
}

/**
 * What a paired device may do: the routes the mobile app uses, by method and path after `/api`, with `*` for one path
 * parameter. Everything else gets a 403, so a route added to the API is closed to devices until it's added here. It's an
 * allowlist rather than a list of what to refuse because that list missed routes twice (`hosts/copy-claude-config` moves
 * a Claude login to another host, and an encoded path got past it), and what a device must not reach (tokens, Claude
 * logins, terminals, host linking, settings, admin) is most of the API.
 *
 * `HUB` routes are the board's own (`/api/<route>`), `HOST` routes a host's, also reached through the hub as
 * `/api/h/<host>/<route>`, where the request is made with the board's or the link's token.
 */
const HUB: Array<[string, string]> = [
  ["GET", "ws"],
  ["GET", "hosts"],
  ["GET", "devices"],
  // Only itself (see `revoke`).
  ["DELETE", "devices/*"],
];
const HOST: Array<[string, string]> = [
  ["GET", "profiles"],
  ["GET", "profiles/*/projects"],
  ["GET", "profiles/*/tasks"],
  ["GET", "projects/*"],
  ["GET", "projects/*/tasks"],
  ["POST", "projects/*/tasks"],
  ["GET", "tasks/*"],
  ["PATCH", "tasks/*"],
  ["GET", "tasks/*/messages"],
  ["POST", "tasks/*/messages"],
  ["POST", "tasks/*/questions/*"],
  ["POST", "tasks/*/stop"],
  ["POST", "attachments"],
  ["GET", "attachments/*/*"],
  ["GET", "permissions"],
  ["POST", "permissions/*"],
];

/**
 * The segments of `path` (an `/api/...` path as the client sent it) as the router sees them, percent-decoded, or `null`
 * where that's in doubt: an encoded `/`, `\` or `%` (a proxied request is decoded once more on its host, so `%252F` would
 * become a `/` there), an encoded `?` or `#` (the hub's proxy puts the decoded path back in a URL, where either would
 * cut it short), an empty segment, `.` or `..`, or bytes that aren't UTF-8.
 */
function segments(path: string): string[] | null {
  if (!path.startsWith("/api/")) return null;
  const out: string[] = [];
  for (const raw of path.slice(5).split("/")) {
    const seg = percent_decode(raw);
    if (seg === null || seg === "" || seg === "." || seg === ".." || /[/\\%?#]/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function percent_decode(s: string): string | null {
  const b = Buffer.from(s, "utf8");
  const out: number[] = [];
  const hex = (c: number | undefined) => c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66));
  for (let i = 0; i < b.length; ) {
    if (b[i] === 0x25 && hex(b[i + 1]) && hex(b[i + 2])) {
      out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16));
      i += 3;
    } else {
      out.push(b[i]);
      i += 1;
    }
  }
  try {
    return UTF8.decode(Uint8Array.from(out));
  } catch {
    return null;
  }
}

/** Whether segments match a route pattern of `HUB` or `HOST`. */
function matches(segs: string[], pattern: string): boolean {
  const p = pattern.split("/");
  return p.length === segs.length && p.every((x, i) => x === "*" || x === segs[i]);
}

/**
 * Why a paired device can't make this request, if it can't (see `HUB`): `path` is the whole path, as the client sent it,
 * `/api/...` or `/api/h/<host>/...`. The token check checks it, and the hub's proxy again on the path it forwards with its
 * own token.
 */
export function refused(method: string, path: string): string | null {
  const segs = segments(path);
  if (!segs) return "a paired device's request must be a plain path: no encoded '/', '\\', '%', '?' or '#', empty segments, '.' or '..'";
  const allowed =
    segs.length >= 2 && segs[0] === "h"
      ? HOST.some(([m, p]) => m === method && matches(segs.slice(2), p))
      : [...HUB, ...HOST].some(([m, p]) => m === method && matches(segs, p));
  return allowed ? null : "a paired device can't use this part of the API (tokens, Claude logins, terminals, hosts, settings): use the web board";
}

/** `refused` for the path the hub's proxy forwards to a host (`rest`, after `/api/h/<host>/`, as decoded by the router). */
export function refused_on_host(method: string, rest: string): string | null {
  return refused(method, `/api/h/-/${rest}`);
}

/**
 * The second check, in the handlers of what must never reach a device whatever `refused` lets through: the board's
 * tokens, Claude logins, terminals and linking hosts. Through the hub's proxy, the request to this host carries the device
 * too (but a linked host's, made with the link's token, doesn't: there it's `refused` alone).
 */
export function board_only(device: DeviceAuth | null | undefined, what: string): void {
  if (device) throw new ApiError(403, `a paired device can't ${what}: use the web board`);
}

export const TABLE = `
CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);`;

export function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The device whose token this is, if it's one (and notes that it was used). */
export function authenticate(s: Shared, token: string): DeviceAuth | null {
  if (!token) return null;
  const revoked = s.devices.revoked;
  const c = s.db();
  let row: { id: string; last_used_at: string | null } | undefined;
  try {
    row = db.one(c, "SELECT id, last_used_at FROM device_tokens WHERE token_hash=?1", hash(token));
  } catch {
    return null;
  }
  if (!row) return null;
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (Number.isNaN(last) || Date.now() - last >= LAST_USED_EVERY) {
    try {
      db.run(c, "UPDATE device_tokens SET last_used_at=?1 WHERE id=?2", now(), row.id);
    } catch {}
  }
  return { id: row.id, revoked };
}

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export function list(c: db.Conn): Device[] {
  return db.all<Device>(c, "SELECT id, name, created_at, last_used_at FROM device_tokens ORDER BY created_at, rowid");
}

function get(c: db.Conn, id: string): Device | null {
  return list(c).find((d) => d.id === id) ?? null;
}

export function clean_name(name: string): string {
  const out = Array.from(name.trim())
    .filter((c) => !/\p{Cc}/u.test(c))
    .slice(0, 100)
    .join("");
  return out || "Phone";
}

function not_from_device(device: DeviceAuth | null | undefined): void {
  if (device) throw new ApiError(403, "paired devices can't pair or manage devices: do it from the board");
}

/** A string field of a JSON body, as serde reads one (422 when it's missing or not a string, unless it has a default). */
function str_field(r: Req, field: string, dflt?: string): string {
  const v = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body[field] : undefined;
  if (typeof v === "string") return v;
  if (v === undefined && dflt !== undefined) return dflt;
  throw new ApiError(422, `Failed to deserialize the JSON body into the target type: ${v === undefined ? `missing field \`${field}\`` : `${field}: invalid type, expected a string`}`);
}

/** `POST /devices/pairing`: a new one-time code for Settings → Network access → Phones' QR code. */
export function new_code(s: Shared, r: Req) {
  not_from_device(r.device);
  const code = randomUUID().replaceAll("-", "");
  const now_i = performance.now();
  const codes = s.devices.codes;
  for (const [c, until] of codes) if (until <= now_i) codes.delete(c);
  while (codes.size >= MAX_CODES) {
    let oldest: string | null = null;
    for (const [c, until] of codes) if (oldest === null || until < codes.get(oldest)!) oldest = c;
    codes.delete(oldest!);
  }
  codes.set(code, now_i + CODE_TTL);
  const expires_at = new Date(Date.now() + CODE_TTL).toISOString();
  return { code, expires_at, ttl_secs: CODE_TTL / 1000 };
}

/** `POST /devices/pair`, without the board's token: swaps a pairing code (once) and the device's name for a token. */
export function pair(s: Shared, r: Req) {
  const code = str_field(r, "code").trim();
  const name = str_field(r, "name", "");
  const until = s.devices.codes.get(code);
  s.devices.codes.delete(code);
  if (until === undefined || until <= performance.now()) {
    throw new ApiError(403, "this pairing code has expired or was already used: show a new one on the board");
  }
  const token = new_token();
  const id = new_id();
  const c = s.db();
  db.run(c, "INSERT INTO device_tokens (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)", id, clean_name(name), hash(token), now());
  const device = get(c, id);
  if (!device) throw ApiError.not_found("device");
  console.info(`paired device ${JSON.stringify(device.name)}`);
  return { token, device, host_id: s.host_id, host_name: s.host_name, api_version: API_VERSION };
}

/** `GET /devices`: the paired devices, and which one asked (`current`, for a device). */
export function list_handler(s: Shared, r: Req) {
  return { devices: list(s.db()), current: r.device?.id ?? null };
}

export function rename(s: Shared, r: Req) {
  not_from_device(r.device);
  const name = str_field(r, "name");
  const id = r.params.id;
  const c = s.db();
  if (db.run(c, "UPDATE device_tokens SET name=?1 WHERE id=?2", clean_name(name), id).changes === 0) throw ApiError.not_found("device");
  const d = get(c, id);
  if (!d) throw ApiError.not_found("device");
  return d;
}

/** `DELETE /devices/{id}`: revokes a device (from the board, or the device itself when it's removed from the app). */
export function revoke(s: Shared, r: Req) {
  const id = r.params.id;
  if (r.device && r.device.id !== id) not_from_device(r.device);
  const n = db.run(s.db(), "DELETE FROM device_tokens WHERE id=?1", id).changes;
  if (n === 0) throw ApiError.not_found("device");
  s.devices.note_revoked();
  console.info(`revoked device ${id}`);
  return { ok: true };
}
