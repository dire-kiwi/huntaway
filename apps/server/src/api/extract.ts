// What axum's extractors did for the Rust handlers: reading a JSON body into a struct (with serde's defaults) and a
// query string into one, with axum's rejections (a 422 for a body of the wrong shape, a 400 for a bad query) thrown as
// a Reply. (No Rust file of its own: the api part's helpers.)
import { realpathSync } from "node:fs";
import { Reply, type Req } from "../http.ts";

/** serde's description of a JSON value, as in "invalid type: integer `3`, expected a string". */
function unexpected(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return `boolean \`${v}\``;
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (Array.isArray(v)) return "sequence";
  return "map";
}

/** axum's `Json` rejection for a body that doesn't fit its type (422, plain text). */
export function body_rejection(msg: string): Reply {
  return new Reply(422, `Failed to deserialize the JSON body into the target type: ${msg}`);
}

/** axum's `Query` rejection (400, plain text). */
export function query_rejection(msg: string): Reply {
  return new Reply(400, `Failed to deserialize query string: ${msg}`);
}

const invalid = (k: string, v: any, expected: string) => body_rejection(`${k}: invalid type: ${unexpected(v)}, expected ${expected}`);

/** The body as a JSON object (`Json<Map<String, Value>>`, or a struct's fields). */
export function json_map(r: Req): Record<string, any> {
  const b = r.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw body_rejection(`invalid type: ${unexpected(b)}, expected a map`);
  return b;
}

/** A required `String` field. */
export function req_str(b: Record<string, any>, k: string): string {
  if (!Object.hasOwn(b, k)) throw body_rejection(`missing field \`${k}\``);
  if (typeof b[k] !== "string") throw invalid(k, b[k], "a string");
  return b[k];
}

/** A `#[serde(default)] String` field. */
export function def_str(b: Record<string, any>, k: string, def = ""): string {
  if (!Object.hasOwn(b, k)) return def;
  if (typeof b[k] !== "string") throw invalid(k, b[k], "a string");
  return b[k];
}

/** An `Option<String>` field: null when it's missing or null. */
export function opt_str(b: Record<string, any>, k: string): string | null {
  const v = b[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw invalid(k, v, "a string");
  return v;
}

/** An `Option<bool>` field. */
export function opt_bool(b: Record<string, any>, k: string): boolean | null {
  const v = b[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") throw invalid(k, v, "a boolean");
  return v;
}

/** A `#[serde(default)] bool` field (`def` for `#[serde(default = "yes")]`). */
export function def_bool(b: Record<string, any>, k: string, def = false): boolean {
  if (!Object.hasOwn(b, k)) return def;
  if (typeof b[k] !== "boolean") throw invalid(k, b[k], "a boolean");
  return b[k];
}

/** An `Option<Vec<String>>` field. */
export function opt_strings(b: Record<string, any>, k: string): string[] | null {
  const v = b[k];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw invalid(k, v, "a sequence");
  for (const x of v) if (typeof x !== "string") throw invalid(k, x, "a string");
  return v;
}

/** An `Option<Value>` field: null when it's missing or null. */
export function opt_value(b: Record<string, any>, k: string): any {
  const v = b[k];
  return v === undefined ? null : v;
}

/** A `#[serde(default)] Value` field. */
export function def_value(b: Record<string, any>, k: string): any {
  const v = b[k];
  return v === undefined ? null : v;
}

/** An optional whole number in the query string (`Option<i64>`, `Option<usize>`, …). */
export function query_int(r: Req, k: string, min = -(2 ** 63), max = 2 ** 63): number | null {
  const v = r.query[k];
  if (v === undefined) return null;
  if (!/^[+-]?\d+$/.test(v)) throw query_rejection(`${k}: invalid digit found in string`);
  const n = Number(v);
  if (n < min || n > max) throw query_rejection(`${k}: number too large to fit in target type`);
  return n;
}

/** An optional boolean in the query string. */
export function query_opt_bool(r: Req, k: string): boolean | null {
  const v = r.query[k];
  if (v === undefined) return null;
  if (v === "true") return true;
  if (v === "false") return false;
  throw query_rejection(`${k}: provided string was not \`true\` or \`false\``);
}

/** A `#[serde(default)] bool` in the query string. */
export function query_bool(r: Req, k: string): boolean {
  return query_opt_bool(r, k) ?? false;
}

/** Rust's `{:?}` of a list of strings. */
export function debug_list(l: readonly string[]): string {
  return `[${l.map((x) => JSON.stringify(x)).join(", ")}]`;
}

/** A path's own components, as Rust's `Path::components().collect()` makes it: no `.`, repeated or trailing `/`. */
export function components(p: string): string {
  const abs = p.startsWith("/");
  const parts = p.split("/").filter((x, i) => x !== "" && !(x === "." && (i > 0 || !abs)));
  const out = parts.join("/");
  return abs ? `/${out}` : out || (p.startsWith(".") ? "." : "");
}

/** `canonicalize`, or the path as it is. */
export function canonical_or(p: string, f: (p: string) => string = (x) => x): string {
  try {
    return realpathSync(p);
  } catch {
    return f(p);
  }
}

/** Rust's `Path::starts_with`: whether `root`'s components begin `p`'s. */
export function path_starts_with(p: string, root: string): boolean {
  const a = components(p), b = components(root);
  if (a === b) return true;
  if (b === "/") return a.startsWith("/");
  return a.startsWith(`${b}/`);
}

/** Rust's `Path::parent`, as a string (null for `/`, or a path with nothing above it). */
export function parent(p: string): string | null {
  const c = components(p);
  if (c === "/" || c === "") return null;
  const i = c.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : c.slice(0, i);
}

/** Rust's `Path::file_name`. */
export function file_name(p: string): string | null {
  const c = components(p);
  if (c === "/" || c === "") return null;
  const name = c.slice(c.lastIndexOf("/") + 1);
  return name === ".." ? null : name;
}

/** An RFC 3339 time (as chrono's `parse_from_rfc3339` takes it) in UTC with milliseconds and a Z, or null. */
export function rfc3339_utc(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 60) return null;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > days) return null;
  const ms = m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0;
  let t = Date.UTC(y, mo - 1, d, h, mi, Math.min(se, 59), ms);
  if (m[8] !== "Z" && m[8] !== "z") {
    const sign = m[8][0] === "-" ? -1 : 1;
    const [oh, om] = m[8].slice(1).split(":").map(Number);
    if (oh > 23 || om > 59) return null;
    t -= sign * (oh * 60 + om) * 60_000;
  }
  const out = new Date(t);
  if (Number.isNaN(out.getTime())) return null;
  return out.toISOString();
}

/** The number of chars (code points) in a string, as Rust's `chars().count()`. */
export const char_count = (s: string) => Array.from(s).length;

/** A guard's drop: a release function, or an object with `drop()` or `release()`. */
export function drop_guard(g: any) {
  if (!g) return;
  if (typeof g === "function") g();
  else if (typeof g.drop === "function") g.drop();
  else if (typeof g.release === "function") g.release();
}
