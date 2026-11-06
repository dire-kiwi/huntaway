// Port of server/src/attachments.rs.
//
// Files attached to prompts (pasted, dropped or picked in the UI). Each is saved on the host that runs the agent, under
// `<data-dir>/attachments/<id>/<name>`, and the UI lists their paths at the end of the message; agents get read access
// to the folder (`--add-dir`). Uploads and downloads are JSON with base64 data, so they travel through a hub like any
// other request.
//
// A task's files are removed with it, and files nothing refers to any more (abandoned drafts, removed chips) are pruned
// after a while.
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as db from "./db.ts";
import type { Conn } from "./db.ts";
import { ApiError, type Req } from "./http.ts";
import type { AppState } from "./state.ts";
import { err_str, path_str } from "./util.ts";
import { json_map, req_str } from "./api/extract.ts";
import { decode_base64 } from "./api/claude_configs.ts";

/** Heads the list of files at the end of a message (app: attachments.ts). */
export const HEADER = "Attached files:";

/** Largest file we take. Its base64 has to fit in one hub tunnel frame (16 MB). */
export const MAX_BYTES = 10 << 20;

export function dir(state: AppState): string {
  return join(state.data_dir, "attachments");
}

/** A name that's safe as a path segment and easy to quote: letters, digits, `.`, `-`, `_`. */
export function clean_name(name: string): string {
  const parts = name.split(/[/\\]/);
  const base = parts[parts.length - 1] ?? "";
  let out = Array.from(base)
    .map((c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : "_"))
    .join("");
  out = out.replace(/^\.+/, "");
  if (out.length > 100) {
    // Keep the extension.
    const i = out.lastIndexOf(".");
    const ext = i >= 0 && out.length - i <= 10 ? out.slice(i) : "";
    out = `${out.slice(0, 100 - ext.length)}${ext}`;
  }
  return out || "file";
}

export function mime(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "pdf":
      return "application/pdf";
    case "json":
      return "application/json";
    case "txt":
    case "md":
    case "log":
    case "csv":
    case "diff":
    case "patch":
      return "text/plain";
    // Voice notes from the app (API 120), and audio shared into it.
    case "wav":
      return "audio/wav";
    case "m4a":
    case "mp4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
    case "oga":
    case "opus":
      return "audio/ogg";
    case "caf":
      return "audio/x-caf";
    default:
      return "application/octet-stream";
  }
}

/** `POST /attachments`: save a file and return where it is. Takes `{name, data}`, the data base64. */
export async function upload(s: AppState, r: Req) {
  const b = json_map(r);
  const name_given = req_str(b, "name");
  const data_b64 = req_str(b, "data");
  let data: Buffer;
  try {
    data = decode_base64(data_b64.trim());
  } catch {
    throw ApiError.bad("data must be base64");
  }
  const [id, name, path] = await save(s, name_given, data);
  return { id, name, path: path_str(path), size: data.length, mime: mime(name) };
}

/**
 * Saves `data` as an attachment called `name` (made safe): its id, name and path, which a message lists after `HEADER`
 * (see `listed`). Files from elsewhere (Telegram's, say) are saved this way too.
 */
export async function save(s: AppState, name_given: string, data: Uint8Array): Promise<[string, string, string]> {
  if (data.length > MAX_BYTES) throw ApiError.bad(`${name_given} is larger than ${MAX_BYTES >> 20} MB`);
  const id = randomUUID().replaceAll("-", "");
  const name = clean_name(name_given);
  const folder = join(dir(s), id);
  const path = join(folder, name);
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path, data);
  } catch (e) {
    throw ApiError.bad(`saving ${name}: ${err_str(e)}`);
  }
  return [id, name, path];
}

/** `text` with the files at `paths` listed after it, as the UI sends them (apps/web/src/attachments.ts). */
export function listed(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const list = `${HEADER}\n${paths.map((p) => `- ${path_str(p)}`).join("\n")}`;
  return text.trim() === "" ? list : `${text.trimEnd()}\n\n${list}`;
}

/** `GET /attachments/{id}/{name}`: a saved file, base64. */
export async function download(s: AppState, r: Req) {
  const { id, name } = r.params;
  if (!/^[0-9A-Fa-f]+$/.test(id) || name !== clean_name(name)) throw ApiError.not_found("attachment");
  let data: Buffer;
  try {
    data = await readFile(join(dir(s), id, name));
  } catch {
    throw ApiError.not_found("attachment");
  }
  return { name, size: data.length, mime: mime(name), data: data.toString("base64") };
}

/** Ids of the attachments `text` refers to (`…/attachments/<id>/…`). */
export function ids_in(text: string): string[] {
  const out: string[] = [];
  const word = "attachments";
  let i = text.indexOf(word);
  while (i >= 0) {
    // In JSON a Windows path's separators are doubled.
    const rest = text.slice(i + word.length).replace(/^[/\\]+/, "");
    const id = rest.slice(0, 32);
    if (id.length === 32 && /^[/\\]/.test(rest.slice(32)) && /^[0-9A-Fa-f]{32}$/.test(id)) out.push(id);
    i = text.indexOf(word, i + word.length);
  }
  return out;
}

/** Collect the ids that a query's text column refers to. */
function collect(c: Conn, sql: string, args: any[], out: Set<string>) {
  for (const row of db.all(c, sql, ...args)) {
    const text = Object.values(row as any)[0];
    if (typeof text === "string") for (const id of ids_in(text)) out.add(id);
  }
}

/**
 * Attachments referred to by a task: its description, queued message, messages its agent hasn't read yet (`steering`)
 * and thread, in its messages and in its items and requests (a thread kept as items, see threads/history.ts): both, so
 * a file an items-only thread links isn't pruned once its messages stop being written (step 10 of docs/threads.md).
 */
export function of_task(c: Conn, task_id: string): Set<string> {
  const ids = new Set<string>();
  collect(
    c,
    "SELECT description FROM tasks WHERE id=?1 UNION ALL SELECT queued_message FROM tasks WHERE id=?1 UNION ALL SELECT steering FROM tasks WHERE id=?1",
    [task_id],
    ids,
  );
  for (const table of THREAD_TABLES) collect(c, `SELECT data FROM ${table} WHERE task_id=?1 AND instr(data, 'attachments') > 0`, [task_id], ids);
  return ids;
}

/** The tables a thread is kept in: its messages, and its items and requests. */
const THREAD_TABLES = ["messages", "thread_items", "thread_requests"];

/**
 * Attachments referred to by any task: in threads' messages too, which tasks from before they moved onto items still
 * have (until HA-226 deletes them).
 */
export function referenced(c: Conn): Set<string> {
  const ids = new Set<string>();
  collect(c, "SELECT description FROM tasks WHERE instr(description, 'attachments') > 0", [], ids);
  collect(c, "SELECT queued_message FROM tasks WHERE instr(queued_message, 'attachments') > 0", [], ids);
  collect(c, "SELECT steering FROM tasks WHERE instr(steering, 'attachments') > 0", [], ids);
  for (const table of THREAD_TABLES) collect(c, `SELECT data FROM ${table} WHERE instr(data, 'attachments') > 0`, [], ids);
  return ids;
}

const is_dir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Remove those of `ids` that no task refers to any more (after deleting the tasks that did). */
export function remove_unreferenced(state: AppState, ids: Set<string>) {
  if (!ids.size) return;
  const keep = referenced(state.db());
  for (const id of ids) {
    if (keep.has(id)) continue;
    const path = join(dir(state), id);
    if (is_dir(path)) rmSync(path, { recursive: true });
  }
}

/** How long a file nothing refers to is kept: long enough for a draft to be sent. */
const UNUSED_FOR = 7 * 24 * 3600 * 1000;
const PRUNE_EVERY = 6 * 3600 * 1000;

/** Remove files that no task has referred to for a while. Returns how many. */
export function prune(state: AppState): number {
  let entries: string[];
  try {
    entries = readdirSync(dir(state));
  } catch {
    return 0;
  }
  const cutoff = Date.now() - UNUSED_FOR;
  const old = entries.filter((id) => {
    try {
      return lstatSync(join(dir(state), id)).mtimeMs < cutoff;
    } catch {
      return false;
    }
  });
  if (!old.length) return 0;
  const keep = referenced(state.db());
  let removed = 0;
  for (const id of old.filter((id) => !keep.has(id))) {
    try {
      rmSync(join(dir(state), id), { recursive: true });
      removed++;
    } catch (e) {
      console.warn(`attachments: removing ${id}: ${err_str(e)}`);
    }
  }
  return removed;
}

/** Prune unused attachments now and every few hours. */
export function start_pruner(state: AppState) {
  const tick = () => {
    try {
      const n = prune(state);
      if (n) console.info(`attachments: removed ${n} no longer referred to`);
    } catch (e) {
      console.warn(`attachments: pruning failed: ${err_str(e)}`);
    }
  };
  setTimeout(tick, 0).unref();
  setInterval(tick, PRUNE_EVERY).unref();
}
